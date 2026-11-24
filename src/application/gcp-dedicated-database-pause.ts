import crypto from 'node:crypto';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { sqlAdmin } from '../adapters/providers/gcp/gcp-data.client.js';
import { readSecretVersionValue } from '../adapters/providers/gcp/gcp-secret-manager.client.js';
import {
  DATABASE_LOGINS, DATABASE_OWNER_ROLE, connectionUrl, otherLogin, parseConnectionUrl, setCloudSqlLoginPassword, withCloudSqlSession, type DatabaseLogin,
} from './infrastructure-engine-database.js';
import { observeSecret, writeSecretVersion } from './infrastructure-engine.js';

/**
 * Pausing a database on a server of the environment's own, and undoing it.
 *
 * Paused means: the password the app holds no longer works for either of its
 * two logins, every session of theirs has ended, and nobody else is connected
 * to the database either. Both logins get new passwords through Google's API;
 * each then ends its own older sessions. The login the app does not use keeps
 * its new password as the copy login, whose URL goes to a secret of its own
 * that no service ever mounts. The other new password is thrown away.
 *
 * Undoing reads the exact connection the services are pinned to, in memory,
 * gives that login that password back through the same API that set it in the
 * first place, switches the copy login's password to one nobody has, and
 * proves the services' connection opens the database again.
 *
 * Both calls can be repeated and can follow each other in any order, whatever
 * was interrupted. Anything unusual is refused with its reason. No password
 * appears in a result, a message or an error.
 */
type Seen<T> = { state: 'present'; value: T } | { state: 'absent' } | { state: 'unknown'; reason: string };
interface Session { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

/** What the pause needs from Google. Tests replace it with a local PostgreSQL. */
export interface DedicatedPausePorts {
  observeSecret(secretId: string): Promise<Seen<{ labels: Record<string, string>; hasEnabledVersion: boolean; latestVersion?: string }>>;
  /** One exact version's value, for use in memory only. */
  readSecretVersion(secretId: string, version: string): Promise<Seen<string>>;
  /** Undefined when stored. */
  publishSecret(secretId: string, labels: Record<string, string>, value: string): Promise<ActionResult | undefined>;
  /** Sets a login's password through Google's API. Undefined when done. */
  setLoginPassword(login: DatabaseLogin, password: string): Promise<ActionResult | undefined>;
  withSession<T>(login: DatabaseLogin, password: string, work: (session: Session) => Promise<T>): Promise<T>;
}

export interface DedicatedPauseParams {
  environmentName: string;
  instanceName: string;
  /** `project:region:instance`. */
  connectionName: string;
  databaseName: string;
  /** The environment's own connection secret (DATABASE_URL), and the version its services are pinned to. */
  secret: { id: string; labels: Record<string, string>; version: string };
  /** The secret that holds the copy login's URL. Never mounted into a service. */
  copySecret: { id: string; labels: Record<string, string> };
  /** How long to wait for sessions to end. Default 5 seconds. */
  sessionWaitMs?: number;
}

class Stop extends Error {
  constructor(readonly result: ActionResult) { super(result.message); }
}
const blocked = (message: string) => new Stop({ success: false, status: 'blocked', message });
const pending = (message: string) => new Stop({ success: false, status: 'pending', message });
const newPassword = (): string => crypto.randomBytes(32).toString('base64url');
const isLogin = (value: unknown): value is DatabaseLogin => value === DATABASE_LOGINS[0] || value === DATABASE_LOGINS[1];

/** Every refusal comes back as a result. An unexpected error is reported by its class and code only: its text may quote a value. */
async function settled(work: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Stop) return error.result;
    const raw = (error as { code?: unknown } | null)?.code;
    const code = typeof raw === 'string' && /^[A-Z0-9_]{3,40}$/.test(raw) ? ` ${raw}` : '';
    return { success: false, status: 'pending', message: `A step on the database server did not finish (${error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error'}${code}). Its state is unknown until the same command, or its undo, is run again.` };
  }
}

/** Everything both calls must find before they touch a login: which login the app holds, from what Hypervibe recorded with the pinned version. */
async function appLogin(ports: DedicatedPausePorts, params: DedicatedPauseParams): Promise<DatabaseLogin> {
  const name = params.environmentName;
  if (params.secret.id === params.copySecret.id) throw blocked('The copy login needs a secret of its own, never the one the app uses.');
  const seen = await ports.observeSecret(params.secret.id);
  if (seen.state === 'unknown') throw blocked(seen.reason);
  if (seen.state === 'absent') throw blocked(`${name} has no connection secret (${params.secret.id}), so its database cannot be paused.`);
  const labels = seen.value.labels;
  if (labels['managed-by'] !== 'hypervibe' || labels['hv-environment'] !== params.secret.labels['hv-environment']) throw blocked(`Secret ${params.secret.id} is not owned by this Hypervibe environment.`);
  const login = labels['hv-db-login'];
  if (!seen.value.hasEnabledVersion || labels['hv-db-instance'] !== params.instanceName || !isLogin(login)) throw blocked(`${name}'s connection secret does not hold a login for database server ${params.instanceName}. Run hv_plan and hv_apply first.`);
  if (labels['hv-db-retire'] !== undefined) throw blocked(`${name}'s database password is still being changed: its previous login has not been switched off yet. Finish that with hv_plan and hv_apply first.`);
  if (seen.value.latestVersion !== params.secret.version) throw blocked(`${name}'s connection secret has a newer version than the one its services use (${params.secret.version}). Run hv_plan and hv_apply first.`);
  return login;
}

async function setPassword(ports: DedicatedPausePorts, login: DatabaseLogin, password: string): Promise<void> {
  const failure = await ports.setLoginPassword(login, password);
  if (failure) throw new Stop(failure);
}

/**
 * As `login`, ends every other session of that login and says how many are left. Zero is believed only when two looks,
 * a short pause apart, both find none: a connection that passed the password check just before the change can appear a moment later.
 */
async function endOwnSessions(session: Session, waitMs: number): Promise<number> {
  // A login acts as the owner role by default, and only the login itself may end the login's sessions.
  await session.query('SET ROLE NONE');
  const deadline = Date.now() + waitMs;
  for (let clear = 0; ;) {
    await session.query('SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = session_user AND pid <> pg_catalog.pg_backend_pid()');
    const open = Number((await session.query('SELECT count(*)::int AS open FROM pg_catalog.pg_stat_activity WHERE usename = session_user AND pid <> pg_catalog.pg_backend_pid()')).rows[0]?.open);
    clear = open === 0 ? clear + 1 : 0;
    if (clear >= 2) return 0;
    if (open !== 0 && Date.now() >= deadline) return open;
    await session.query('SELECT pg_catalog.pg_sleep(0.05)');
  }
}

/** Proves the login opens this database acting as its owner role, as every Hypervibe login is set up to. */
async function proves(session: Session, login: DatabaseLogin, databaseName: string): Promise<boolean> {
  const row = (await session.query('SELECT current_user::text AS role, session_user::text AS login, current_database()::text AS database')).rows[0];
  return row?.role === DATABASE_OWNER_ROLE && row.login === login && row.database === databaseName;
}

export function pauseDedicatedDatabase(ports: DedicatedPausePorts, params: DedicatedPauseParams): Promise<ActionResult> {
  return settled(async () => {
    const name = params.environmentName;
    const wait = params.sessionWaitMs ?? 5000;
    const active = await appLogin(ports, params);
    const copy = otherLogin(active);
    // From here the password the app holds opens nothing. Neither new password is written anywhere yet.
    const passwords: Record<DatabaseLogin, string> = { app_a: newPassword(), app_b: newPassword() };
    await setPassword(ports, active, passwords[active]);
    await setPassword(ports, copy, passwords[copy]);
    let open = await ports.withSession(active, passwords[active], (session) => endOwnSessions(session, wait));
    const quiet = await ports.withSession(copy, passwords[copy], async (session) => {
      const proven = await proves(session, copy, params.databaseName);
      const own = await endOwnSessions(session, wait);
      // Anyone else connected to this database (a person's own session, a worker's reader) could still be using it.
      const others = Number((await session.query(`SELECT count(*)::int AS open FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND pid <> pg_catalog.pg_backend_pid() AND usename NOT IN ('${DATABASE_LOGINS[0]}', '${DATABASE_LOGINS[1]}')`)).rows[0]?.open);
      return { own, others, proven };
    });
    open += quiet.own;
    if (open > 0 || quiet.others > 0) {
      throw pending(`The app's password for ${name}'s database no longer works, but ${open + quiet.others} session(s) are still connected to it${quiet.others ? ` (${quiet.others} of them not the app's)` : ''}. It is not paused until they are gone; run the same command again.`);
    }
    if (!quiet.proven) throw blocked(`${name}'s database is paused, but its copy login does not act as the database's owner. Undo the pause.`);
    // The active login's new password is forgotten here: nothing can log in as it until the pause is undone.
    const labels = { ...params.copySecret.labels, 'hv-db-instance': params.instanceName, 'hv-db-login': copy, 'hv-db-copy': 'true' };
    const failure = await ports.publishSecret(params.copySecret.id, labels, connectionUrl(copy, passwords[copy], params.databaseName, params.connectionName));
    if (failure) throw new Stop({ ...failure, message: `${name}'s database is paused, but the copy login could not be stored (${failure.message}) Run the same command again, or undo the pause.` });
    const stored = await ports.observeSecret(params.copySecret.id);
    const version = stored.state === 'present' ? stored.value.latestVersion : undefined;
    if (!version) throw pending(`${name}'s database is paused, but the copy login's secret could not be read back. Run the same command again.`);
    return { success: true, message: `${name}'s database is paused: the app cannot connect and no session is open. Only the copy login (${params.copySecret.id}, version ${version}) can.`,
      data: { paused: true, copySecretId: params.copySecret.id, copySecretVersion: version } };
  });
}

export function resumeDedicatedDatabase(ports: DedicatedPausePorts, params: DedicatedPauseParams): Promise<ActionResult> {
  return settled(async () => {
    const name = params.environmentName;
    const active = await appLogin(ports, params);
    const copy = otherLogin(active);
    // What must work again is exactly what the services' pinned secret version holds. It is read into memory and goes only back to the API that set it.
    const pinned = await ports.readSecretVersion(params.secret.id, params.secret.version);
    if (pinned.state !== 'present') throw blocked(pinned.state === 'unknown' ? pinned.reason : `Version ${params.secret.version} of ${params.secret.id} no longer exists, so the app's login cannot be given back.`);
    const held = parseConnectionUrl(pinned.value);
    if (!held || held.login !== active || held.databaseName !== params.databaseName || held.connectionName !== params.connectionName) {
      throw blocked(`Version ${params.secret.version} of ${params.secret.id} is not the connection to ${name}'s database that was recorded. Nothing was changed.`);
    }
    // The copy login first: once the app is back, nothing else may still be writing.
    const unused = newPassword();
    await setPassword(ports, copy, unused);
    const left = await ports.withSession(copy, unused, (session) => endOwnSessions(session, params.sessionWaitMs ?? 5000));
    if (left > 0) throw pending(`${left} session(s) of the copy login are still open on ${name}'s database. The app's login was not given back yet; run the same command again.`);
    await setPassword(ports, active, held.password);
    const works = await ports.withSession(active, held.password, (session) => proves(session, active, params.databaseName)).catch((error: unknown) => {
      if (/^28/.test(String((error as { code?: unknown } | null)?.code))) return false;
      throw error;
    });
    if (!works) return { success: false, message: `${name}'s password was set back, but the connection its services hold did not open its database. Do not treat the app as running; run hv_plan.` };
    return { success: true, message: `${name}'s database is no longer paused: the connection its services hold (${params.secret.id}, version ${params.secret.version}) works again, and the copy login's password is one nobody has.`,
      data: { paused: false } };
  });
}

/** Google Cloud behind the ports: Secret Manager, the Cloud SQL Admin API and the Cloud SQL connector, as the app's deployment identity. */
export function googleDedicatedPausePorts(access: { token: string; credentials: () => Record<string, unknown>; gcpProjectId: string; instanceName: string; connectionName: string; databaseName: string }): DedicatedPausePorts {
  const { token, gcpProjectId, instanceName } = access;
  return {
    async observeSecret(secretId) {
      const seen = await observeSecret(token, gcpProjectId, secretId);
      if (seen.state !== 'present') return seen;
      const { labels, hasEnabledVersion, latestVersion } = seen.value;
      return { state: 'present', value: { labels, hasEnabledVersion, ...(latestVersion ? { latestVersion } : {}) } };
    },
    readSecretVersion: (secretId, version) => readSecretVersionValue(token, gcpProjectId, secretId, version),
    publishSecret: (secretId, labels, value) => writeSecretVersion(token, gcpProjectId, secretId, labels, value),
    async setLoginPassword(login, password) {
      const users = await sqlAdmin(token, gcpProjectId, `instances/${instanceName}/users`);
      if (!users.ok) return { success: false, status: 'blocked', message: `Listing the database server's logins returned HTTP ${users.status}.` };
      // Both logins exist on every database Hypervibe set up; one that is missing is not a state to repair from here.
      if (!((await users.json() as { items?: Array<{ name?: string }> }).items ?? []).some((item) => item.name === login)) return { success: false, status: 'blocked', message: `Database login ${login} does not exist on ${instanceName}.` };
      const set = await setCloudSqlLoginPassword(token, gcpProjectId, instanceName, login, password, true);
      return set === 'done' ? undefined : set;
    },
    withSession: (login, password, work) => withCloudSqlSession(access.credentials(), access.connectionName, login, password, access.databaseName, (client) => work({ query: (text, values) => client.query(text, values) })),
  };
}
