import crypto from 'node:crypto';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { sqlAdmin } from '../adapters/providers/gcp/gcp-data.client.js';
import { readSecretVersionValue } from '../adapters/providers/gcp/gcp-secret-manager.client.js';
import { observeRecordedSecret } from './gcp-secret-recorded.js';
import {
  DATABASE_LOGINS, DATABASE_OWNER_ROLE, connectionUrl, databaseCopySecretId, otherLogin, parseConnectionUrl, setCloudSqlLoginPassword, withCloudSqlSession, type DatabaseLogin,
} from './infrastructure-engine-database.js';
import { recordSecretVersionMetadata, writeSecretVersion } from './infrastructure-engine.js';

/**
 * Pausing a database on a server of the environment's own, and undoing it.
 *
 * Paused means: the password the app holds no longer works for either of its
 * two logins, every session of theirs has ended, and nobody else is connected
 * to the database either. Both logins get new passwords through Google's API;
 * each then ends its own older sessions. The login the app does not use keeps
 * its new password as the copy login, whose URL goes to one secret, named
 * after the app's own, that no service ever mounts. The other new password is
 * thrown away.
 *
 * Undoing reads the exact connection the services are pinned to, in memory,
 * gives that login that password back through the same API that set it in the
 * first place, switches the copy login's password to one nobody has, and
 * proves the services' connection opens the database again.
 *
 * Everything that can be refused is checked before the app is touched, and
 * then nothing was changed. From the moment the app's password stops working,
 * no outcome says otherwise: whatever goes wrong is reported as unfinished,
 * with the app shut out and how to let it back in.
 *
 * Both calls can be repeated and can follow each other in any order, whatever
 * was interrupted. No password appears in a result, a message or an error.
 */
type Seen<T> = { state: 'present'; value: T } | { state: 'absent' } | { state: 'unknown'; reason: string };
interface Session { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
interface SeenSecret { labels: Record<string, string>; hasEnabledVersion: boolean; latestVersion?: string; unrecorded?: boolean }

/** What the pause needs from Google. */
export interface DedicatedPausePorts {
  /** A secret as Hypervibe recorded it; `unrecorded` when its latest version is one Hypervibe never heard back about. */
  observeSecret(secretId: string): Promise<Seen<SeenSecret>>;
  /** One exact version's value, for use in memory only. */
  readSecretVersion(secretId: string, version: string): Promise<Seen<string>>;
  /** Undefined when stored. */
  publishSecret(secretId: string, labels: Record<string, string>, value: string): Promise<ActionResult | undefined>;
  /** Replaces what is recorded about an existing version. False when it could not be recorded. */
  relabelSecret(secretId: string, version: string, labels: Record<string, string>): boolean;
  /** The names of the server's logins, or why they could not be listed. */
  listLogins(): Promise<string[] | { reason: string }>;
  /** Sets an existing login's password through Google's API. Undefined when done; `pending` when the server is busy with another change. */
  setLoginPassword(login: DatabaseLogin, password: string): Promise<ActionResult | undefined>;
  withSession<T>(login: DatabaseLogin, password: string, work: (session: Session) => Promise<T>): Promise<T>;
}

export interface DedicatedPauseParams {
  environmentName: string;
  instanceName: string;
  /** `project:region:instance`. */
  connectionName: string;
  databaseName: string;
  /** The environment's own connection secret (DATABASE_URL), and the version its services are pinned to. The copy login's URL goes to the one secret named after it. */
  secret: { id: string; labels: Record<string, string>; version: string };
  /** How long to wait for sessions to end. Default 5 seconds. */
  sessionWaitMs?: number;
  /**
   * The secret's newest version already holds another database's connection (the one this database is being moved to),
   * so what is recorded about the newest version says nothing about this one. The pinned version's own content is still
   * read and must be a login of this server and database; that check alone then stands.
   */
  newestIsAnotherDatabase?: boolean;
}

class Stop extends Error {
  constructor(readonly result: ActionResult) { super(result.message); }
}
const blocked = (message: string) => new Stop({ success: false, status: 'blocked', message });
const newPassword = (): string => crypto.randomBytes(32).toString('base64url');
const isLogin = (value: unknown): value is DatabaseLogin => value === DATABASE_LOGINS[0] || value === DATABASE_LOGINS[1];
const sqlState = (error: unknown): string => String((error as { code?: unknown } | null)?.code);
/** PostgreSQL turned the login away: wrong password, or the role may not log in. */
const refusedLogin = (error: unknown): boolean => /^28/.test(sqlState(error));
/** Every connection the server allows is in use. */
const serverFull = (error: unknown): boolean => sqlState(error) === '53300';
/** How an unexpected stop is named: by class and code only. Its text may quote a statement or a value. */
function named(error: unknown): string {
  if (serverFull(error)) return 'the database server has no free connection to work through';
  const code = sqlState(error);
  const kind = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  return /^[A-Z0-9_]{3,40}$/.test(code) ? `${kind} ${code}` : kind;
}

interface Known { active: DatabaseLogin; copy: DatabaseLogin; copySecretId: string; held: { password: string } }

/** Everything both calls must find, with nothing changed, before they touch a login. */
async function known(ports: DedicatedPausePorts, params: DedicatedPauseParams): Promise<Known> {
  const name = params.environmentName;
  const owner = params.secret.labels['hv-environment'];
  if (params.secret.labels['managed-by'] !== 'hypervibe' || !owner) throw blocked(`${name}'s connection secret was not named with the environment it belongs to. Nothing was changed.`);
  const seen = await ports.observeSecret(params.secret.id);
  if (seen.state === 'unknown') throw blocked(seen.reason);
  if (seen.state === 'absent') throw blocked(`${name} has no connection secret (${params.secret.id}), so its database cannot be paused.`);
  const labels = seen.value.labels;
  if (labels['managed-by'] !== 'hypervibe' || labels['hv-environment'] !== owner) throw blocked(`Secret ${params.secret.id} is not owned by this Hypervibe environment.`);
  // What an undo must make work again is exactly what the pinned version holds. If that cannot be read and recognised now, a pause could not be undone.
  const pinned = await ports.readSecretVersion(params.secret.id, params.secret.version);
  const held = pinned.state === 'present' ? parseConnectionUrl(pinned.value) : undefined;
  const active = params.newestIsAnotherDatabase ? held?.login : labels['hv-db-login'];
  if (!params.newestIsAnotherDatabase) {
    if (seen.value.unrecorded || !seen.value.hasEnabledVersion || labels['hv-db-instance'] !== params.instanceName || !isLogin(active)) throw blocked(`${name}'s connection secret does not hold a login for database server ${params.instanceName}. Run hv_plan and hv_apply first.`);
    if (labels['hv-db-retire'] !== undefined) throw blocked(`${name}'s database password is still being changed: its previous login has not been switched off yet. Finish that with hv_plan and hv_apply first.`);
    if (seen.value.latestVersion !== params.secret.version) throw blocked(`${name}'s services use version ${params.secret.version} of its connection secret, which is not its newest (${seen.value.latestVersion}). Run hv_plan and hv_apply first.`);
  }
  if (pinned.state !== 'present') throw blocked(pinned.state === 'unknown' ? pinned.reason : `Version ${params.secret.version} of ${params.secret.id} no longer exists. Nothing was changed.`);
  if (!held || !isLogin(active) || held.login !== active || held.databaseName !== params.databaseName || held.connectionName !== params.connectionName) {
    throw blocked(`Version ${params.secret.version} of ${params.secret.id} is not the connection to ${name}'s database that was recorded. Nothing was changed.`);
  }

  // The copy login's secret: this environment's own, and holding nothing but an earlier copy login.
  const copySecretId = databaseCopySecretId(params.secret.id);
  const copySecret = await ports.observeSecret(copySecretId);
  if (copySecret.state === 'unknown') throw blocked(copySecret.reason);
  if (copySecret.state === 'absent') throw blocked(`The secret for ${name}'s copy login (${copySecretId}) does not exist yet. Nothing was changed.`);
  const copyLabels = copySecret.value.labels;
  if (copyLabels['managed-by'] !== 'hypervibe' || !copyLabels['hv-environment'] || copyLabels['hv-environment'] !== owner) throw blocked(`Secret ${copySecretId} does not belong to ${name}. Nothing was changed.`);
  if (copySecret.value.unrecorded) {
    // An earlier pause stored a copy login here and never heard back. Nobody has that password; the version is set aside so the next one can be stored.
    if (!copySecret.value.latestVersion || !ports.relabelSecret(copySecretId, copySecret.value.latestVersion, { ...params.secret.labels, 'hv-db-copy': 'true' })) {
      throw blocked(`An earlier, unfinished write to ${copySecretId} could not be set aside. Nothing else was changed.`);
    }
  } else if (copySecret.value.latestVersion !== undefined && copyLabels['hv-db-copy'] !== 'true') {
    throw blocked(`Secret ${copySecretId} holds something other than a copy login. Nothing was changed.`);
  }

  // Both logins must be there before either is touched: with one missing, the app could be shut out with no way to finish.
  const logins = await ports.listLogins();
  if (!Array.isArray(logins)) throw blocked(logins.reason);
  const missing = DATABASE_LOGINS.filter((login) => !logins.includes(login));
  if (missing.length) throw blocked(`Database login ${missing.join(' and ')} does not exist on ${params.instanceName}. Nothing was changed.`);
  return { active, copy: otherLogin(active), copySecretId, held: { password: held.password } };
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

export async function pauseDedicatedDatabase(ports: DedicatedPausePorts, params: DedicatedPauseParams): Promise<ActionResult> {
  const name = params.environmentName;
  const wait = params.sessionWaitMs ?? 5000;
  let shutOut = false;
  const unfinished = (why: string): ActionResult => ({ success: false, status: 'pending',
    message: `${name}'s app is shut out of its database, and the pause did not finish: ${why} Run the same command again to finish it, or undo the pause to let the app back in.` });
  try {
    const { active, copy, copySecretId, held } = await known(ports, params);
    const passwords: Record<DatabaseLogin, string> = { app_a: newPassword(), app_b: newPassword() };
    /** From the first of these the password the app holds opens nothing. Neither new password is written anywhere yet. */
    const lockOut = async (): Promise<ActionResult | undefined> => {
      shutOut = true;
      for (const login of [active, copy]) {
        const failure = await ports.setLoginPassword(login, passwords[login]);
        if (failure) return unfinished(`the password of ${login} could not be changed (${failure.status === 'pending' ? 'the server is busy with another change' : 'Google refused it'}).`);
      }
      return undefined;
    };
    // A session as the app's login is opened first, with the password it still has: while the server may be full of the app's
    // own sessions, this is the one connection certain to be had, and once the passwords are changed it ends all the others.
    let open: number | ActionResult | undefined;
    try {
      open = await ports.withSession(active, held.password, async (session) => await lockOut() ?? endOwnSessions(session, wait));
    } catch (error) {
      if (shutOut) throw error;
      if (serverFull(error)) throw blocked(`${name}'s database server has no free connection, so its app's sessions cannot be ended from here. Nothing was changed; try again when it is less busy.`);
      if (!refusedLogin(error)) throw error;
      // The app's password already opens nothing: an earlier pause got this far. Carry on from there.
      open = await lockOut() ?? await ports.withSession(active, passwords[active], (session) => endOwnSessions(session, wait));
    }
    if (typeof open !== 'number') return open;
    const quiet = await ports.withSession(copy, passwords[copy], async (session) => {
      const proven = await proves(session, copy, params.databaseName);
      const own = await endOwnSessions(session, wait);
      // Looked at last, with everything in place: anyone at all connected to this database but this session, the app's logins included.
      const row = (await session.query(`SELECT count(*)::int AS everyone, count(*) FILTER (WHERE usename NOT IN ('${DATABASE_LOGINS[0]}', '${DATABASE_LOGINS[1]}'))::int AS others
        FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND pid <> pg_catalog.pg_backend_pid()`)).rows[0];
      return { own, everyone: Number(row?.everyone), others: Number(row?.others), proven };
    });
    // The app's login's sessions may be on another database of the server; those are in `open` and `own`, not in `everyone`.
    const still = Math.max(quiet.everyone, open + quiet.own);
    if (still > 0) return unfinished(`${still} session(s) are still connected to its database${quiet.others ? ` (${quiet.others} of them not the app's)` : ''}.`);
    if (!quiet.proven) return unfinished('its copy login does not act as the database\'s owner.');
    // The active login's new password is forgotten here: nothing can log in as it until the pause is undone.
    const labels = { ...params.secret.labels, 'hv-db-instance': params.instanceName, 'hv-db-login': copy, 'hv-db-copy': 'true' };
    const failure = await ports.publishSecret(copySecretId, labels, connectionUrl(copy, passwords[copy], params.databaseName, params.connectionName));
    if (failure) return unfinished(`the copy login could not be stored in ${copySecretId}.`);
    const stored = await ports.observeSecret(copySecretId);
    const version = stored.state === 'present' && !stored.value.unrecorded ? stored.value.latestVersion : undefined;
    if (!version) return unfinished(`the copy login's secret (${copySecretId}) could not be read back.`);
    return { success: true, message: `${name}'s database is paused: the app cannot connect and no session is open. Only the copy login (${copySecretId}, version ${version}) can.`,
      data: { paused: true, copySecretId, copySecretVersion: version } };
  } catch (error) {
    if (error instanceof Stop) return error.result;
    if (shutOut) return unfinished(`${named(error)}.`);
    return { success: false, status: 'pending', message: `${name}'s database could not be reached to pause it (${named(error)}). Nothing was changed; run the same command again.` };
  }
}

export async function resumeDedicatedDatabase(ports: DedicatedPausePorts, params: DedicatedPauseParams): Promise<ActionResult> {
  const name = params.environmentName;
  let started = false;
  const unfinished = (why: string): ActionResult => ({ success: false, status: 'pending',
    message: `Undoing the pause of ${name}'s database did not finish: ${why} The app may still be shut out. Run the same command again.` });
  try {
    const { active, copy, held } = await known(ports, params);
    started = true;
    // The copy login first: once the app is back, nothing else may still be writing.
    const unused = newPassword();
    const scrambled = await ports.setLoginPassword(copy, unused);
    if (scrambled) return unfinished(`the copy login's password could not be changed (${scrambled.status === 'pending' ? 'the server is busy with another change' : 'Google refused it'}).`);
    const left = await ports.withSession(copy, unused, (session) => endOwnSessions(session, params.sessionWaitMs ?? 5000));
    if (left > 0) return unfinished(`${left} session(s) of the copy login are still connected, so the app's password was not given back.`);
    const given = await ports.setLoginPassword(active, held.password);
    if (given) return unfinished(`the app's password could not be given back (${given.status === 'pending' ? 'the server is busy with another change' : 'Google refused it'}).`);
    const works = await ports.withSession(active, held.password, (session) => proves(session, active, params.databaseName)).catch((error: unknown) => {
      if (refusedLogin(error)) return false;
      throw error;
    });
    if (!works) return unfinished('its password was given back, but the connection its services hold did not open the database.');
    return { success: true, message: `${name}'s database is no longer paused: the connection its services hold (${params.secret.id}, version ${params.secret.version}) works again, and the copy login's password is one nobody has.`,
      data: { paused: false } };
  } catch (error) {
    if (error instanceof Stop) return error.result;
    if (started) return unfinished(`${named(error)}.`);
    return { success: false, status: 'pending', message: `${name}'s database could not be reached to undo its pause (${named(error)}). Nothing was changed; run the same command again.` };
  }
}

/** Google Cloud behind the ports: Secret Manager, the Cloud SQL Admin API and the Cloud SQL connector, as the app's deployment identity. */
export function googleDedicatedPausePorts(access: { token: string; credentials: () => Record<string, unknown>; gcpProjectId: string; instanceName: string; connectionName: string; databaseName: string }): DedicatedPausePorts {
  const { token, gcpProjectId, instanceName } = access;
  return {
    observeSecret: (secretId) => observeRecordedSecret(token, gcpProjectId, secretId),
    readSecretVersion: (secretId, version) => readSecretVersionValue(token, gcpProjectId, secretId, version),
    publishSecret: (secretId, labels, value) => writeSecretVersion(token, gcpProjectId, secretId, labels, value),
    relabelSecret: (secretId, version, labels) => recordSecretVersionMetadata(gcpProjectId, secretId, version, labels),
    async listLogins() {
      let users: Response;
      try { users = await sqlAdmin(token, gcpProjectId, `instances/${instanceName}/users`); } catch { return { reason: `The logins of ${instanceName} could not be listed. Nothing was changed.` }; }
      if (!users.ok) return { reason: `Listing the logins of ${instanceName} returned HTTP ${users.status}. Nothing was changed.` };
      return ((await users.json() as { items?: Array<{ name?: string }> }).items ?? []).flatMap((item) => (typeof item.name === 'string' ? [item.name] : []));
    },
    async setLoginPassword(login, password) {
      const set = await setCloudSqlLoginPassword(token, gcpProjectId, instanceName, login, password, true);
      if (set === 'done') return undefined;
      // Cloud SQL runs one change per server at a time; a second one is turned away, not queued.
      return set.error === 'HTTP 409' ? { ...set, status: 'pending' } : set;
    },
    withSession: (login, password, work) => withCloudSqlSession(access.credentials(), access.connectionName, login, password, access.databaseName, (client) => work({ query: (text, values) => client.query(text, values) })),
  };
}
