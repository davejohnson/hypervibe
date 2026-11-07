import crypto from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import pg from 'pg';
import { Connector, GoogleAuth, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { isNetworkError } from '../utils/fetch-retry.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import {
  observeSecret, secretManagerFetch, sqlAdmin, waitForSqlOperation, writeSecretVersion,
} from './infrastructure-engine.js';

/**
 * Hypervibe-owned database logins with zero-downtime rotation.
 *
 * Two logins take turns (`app_a`, `app_b`). Both are members of the
 * `app_owner` role and switch to it on login, so every table belongs to
 * `app_owner` whichever login created it. A rotation sets a new password on
 * the idle login and publishes it while the running app keeps using the
 * current one; OpenTofu then rolls services onto the new secret version; only
 * afterwards is the old login's password scrambled. Passwords never enter
 * OpenTofu configuration, plans or state.
 */
export const DATABASE_LOGINS = ['app_a', 'app_b'] as const;
export const DATABASE_OWNER_ROLE = 'app_owner';
export type DatabaseLogin = typeof DATABASE_LOGINS[number];

export type DatabaseCredentialMode = 'initialize' | 'rotate' | 'revoke';

export interface DatabaseCredentialMetadata {
  operation: string;
  mode: DatabaseCredentialMode;
  gcpProjectId: string;
  instanceName: string;
  secretId: string;
  labels: Record<string, string>;
  databaseName: string;
  generation: number;
  /** rotate: the login that becomes active; revoke: the login whose password is scrambled. */
  login?: DatabaseLogin;
}

export interface DatabaseCredentialObservation {
  ready: boolean;
  login?: DatabaseLogin;
  generation: number;
  latestVersion?: string;
  retirePending?: DatabaseLogin;
}

export function otherLogin(login: DatabaseLogin): DatabaseLogin {
  return login === 'app_a' ? 'app_b' : 'app_a';
}

function isLogin(value: unknown): value is DatabaseLogin {
  return value === 'app_a' || value === 'app_b';
}

export async function observeDatabaseCredential(token: string, gcpProjectId: string, secretId: string, instanceName: string, environmentLabel: string): Promise<DatabaseCredentialObservation | { blocked: string }> {
  const observed = await observeSecret(token, gcpProjectId, secretId);
  if (observed.state === 'unknown') return { blocked: observed.reason };
  if (observed.state === 'absent') return { ready: false, generation: 0 };
  if (observed.value.labels['hv-environment'] !== environmentLabel) {
    return { blocked: `Secret Manager already has ${secretId}, but it is not owned by this Hypervibe environment.` };
  }
  const labels = observed.value.labels;
  const login = labels['hv-db-login'];
  const ready = observed.value.hasEnabledVersion && labels['hv-db-instance'] === instanceName && isLogin(login);
  return {
    ready,
    ...(isLogin(login) ? { login } : {}),
    generation: Number(labels['hv-db-generation'] ?? '1') || 1,
    ...(observed.value.latestVersion ? { latestVersion: observed.value.latestVersion } : {}),
    ...(isLogin(labels['hv-db-retire']) ? { retirePending: labels['hv-db-retire'] as DatabaseLogin } : {}),
  };
}

function password(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * An empty URL host with the socket in `?host=`: libpq, node-pg and ORMs read the
 * query; tools that parse only the URL host (sequelize-cli) fall back to PGHOST,
 * which services also receive. A `localhost` host would send those tools to TCP.
 */
export function connectionUrl(login: DatabaseLogin, secret: string, databaseName: string, connectionName: string): string {
  return `postgresql://${login}:${encodeURIComponent(secret)}@/${databaseName}?host=/cloudsql/${connectionName}`;
}

/** Runs statements in one session through the Cloud SQL connector as the deployment identity. */
async function withSession<T>(serviceAccount: Record<string, unknown>, connectionName: string, user: string, secret: string, database: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const connector = new Connector({ auth: new GoogleAuth({ credentials: serviceAccount as never, scopes: ['https://www.googleapis.com/auth/sqlservice.admin'] }) });
  const directory = await mkdtemp(path.join(tmpdir(), 'hv-sql-'));
  try {
    await connector.startLocalProxy({ instanceConnectionName: connectionName, ipType: IpAddressTypes.PUBLIC, listenOptions: { path: path.join(directory, '.s.PGSQL.5432') } });
    const client = new pg.Client({ host: directory, user, password: secret, database, connectionTimeoutMillis: 30_000 });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end().catch(() => {});
    }
  } finally {
    connector.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function setLoginPassword(token: string, gcpProjectId: string, instanceName: string, login: DatabaseLogin, secret: string, exists: boolean): Promise<'done' | ActionResult> {
  let response: Response;
  try {
    response = exists
      ? await sqlAdmin(token, gcpProjectId, `instances/${instanceName}/users?name=${login}`, { method: 'PUT', body: JSON.stringify({ name: login, password: secret }) })
      : await sqlAdmin(token, gcpProjectId, `instances/${instanceName}/users`, { method: 'POST', body: JSON.stringify({ name: login, password: secret }) });
  } catch {
    return { success: false, status: 'pending', message: `The change to database login ${login} has an unknown outcome. Run the same command again.` };
  }
  if (!response.ok) return { success: false, message: `Setting database login ${login} failed (HTTP ${response.status}).`, error: `HTTP ${response.status}` };
  const outcome = await waitForSqlOperation(token, gcpProjectId, await response.json() as { name?: string; status?: string; error?: unknown });
  if (outcome === 'failed') return { success: false, message: `Cloud SQL could not set database login ${login}.`, error: 'operation failed' };
  if (outcome === 'unknown') return { success: false, status: 'pending', message: `The change to database login ${login} has not finished. Run the same command again.` };
  return 'done';
}

/** Makes `login` act as the shared owner role on every connection, then proves it. */
async function verifyLogin(serviceAccount: Record<string, unknown>, connectionName: string, login: DatabaseLogin, secret: string, databaseName: string): Promise<boolean> {
  return withSession(serviceAccount, connectionName, login, secret, databaseName, async (client) => {
    // Setup gives each login a default of acting as app_owner. Only set it when missing, and
    // only as the login itself: SET ROLE NONE returns to the session user, whereas RESET ROLE
    // would return to that very default.
    const { rows: settings } = await client.query<{ config: string[] | null }>(`SELECT rolconfig AS config FROM pg_roles WHERE rolname = session_user`);
    if (!(settings[0]?.config ?? []).includes(`role=${DATABASE_OWNER_ROLE}`)) {
      await client.query('SET ROLE NONE');
      await client.query(`ALTER ROLE ${login} SET role = '${DATABASE_OWNER_ROLE}'`);
    }
    await client.query(`SET role = '${DATABASE_OWNER_ROLE}'`);
    const { rows } = await client.query<{ role: string }>(`SELECT current_user AS role`);
    return rows[0]?.role === DATABASE_OWNER_ROLE;
  });
}

export async function executeDatabaseCredential(token: string, serviceAccount: Record<string, unknown>, action: PlanAction): Promise<ActionResult> {
  const meta = action.metadata as unknown as DatabaseCredentialMetadata;
  const instanceResponse = await sqlAdmin(token, meta.gcpProjectId, `instances/${meta.instanceName}`);
  if (instanceResponse.status === 404) return { success: false, status: 'blocked', message: `Database instance ${meta.instanceName} does not exist yet.` };
  if (!instanceResponse.ok) return { success: false, status: 'blocked', message: `Cloud SQL returned HTTP ${instanceResponse.status} for ${meta.instanceName}.` };
  const instance = await instanceResponse.json() as { state?: string; connectionName?: string; settings?: { userLabels?: Record<string, string> } };
  if (instance.state !== 'RUNNABLE' || !instance.connectionName) return { success: false, status: 'pending', message: `Database instance ${meta.instanceName} is not ready yet.` };
  if (instance.settings?.userLabels?.['managed-by'] !== 'hypervibe') return { success: false, status: 'blocked', message: `Database instance ${meta.instanceName} is not managed by Hypervibe.` };
  const usersResponse = await sqlAdmin(token, meta.gcpProjectId, `instances/${meta.instanceName}/users`);
  if (!usersResponse.ok) return { success: false, status: 'blocked', message: `Listing database logins returned HTTP ${usersResponse.status}.` };
  const existing = new Set(((await usersResponse.json() as { items?: Array<{ name?: string }> }).items ?? []).map((item) => item.name));
  const labelsFor = (login: DatabaseLogin, retire?: DatabaseLogin) => ({
    ...meta.labels, 'hv-db-instance': meta.instanceName, 'hv-db-login': login, 'hv-db-generation': String(meta.generation),
    ...(retire ? { 'hv-db-retire': retire } : {}),
  });

  try {
    if (meta.mode === 'initialize') {
      const secrets: Record<DatabaseLogin, string> = { app_a: password(), app_b: password() };
      for (const login of DATABASE_LOGINS) {
        const set = await setLoginPassword(token, meta.gcpProjectId, meta.instanceName, login, secrets[login], existing.has(login));
        if (set !== 'done') return set;
      }
      // app_a creates the shared owner role (and so may grant it), then hands it the database.
      await withSession(serviceAccount, instance.connectionName, 'app_a', secrets.app_a, meta.databaseName, async (client) => {
        await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DATABASE_OWNER_ROLE}') THEN CREATE ROLE ${DATABASE_OWNER_ROLE} NOLOGIN; END IF; END $$`);
        await client.query(`GRANT ${DATABASE_OWNER_ROLE} TO app_a, app_b`);
        await client.query(`ALTER DATABASE ${meta.databaseName} OWNER TO ${DATABASE_OWNER_ROLE}`);
        // Cloud SQL leaves public to its admin role; the app's tables belong to the owner role.
        await client.query(`ALTER SCHEMA public OWNER TO ${DATABASE_OWNER_ROLE}`);
      });
      for (const login of DATABASE_LOGINS) {
        if (!await verifyLogin(serviceAccount, instance.connectionName, login, secrets[login], meta.databaseName)) {
          return { success: false, message: `Database login ${login} could not act as ${DATABASE_OWNER_ROLE}.` };
        }
      }
      const failure = await writeSecretVersion(token, meta.gcpProjectId, meta.secretId, labelsFor('app_a'), connectionUrl('app_a', secrets.app_a, meta.databaseName, instance.connectionName));
      if (failure) return failure;
      // app_b's password is discarded on purpose; the first rotation sets a new one.
      return { success: true, message: `Database logins are ready; the app connects as app_a through ${meta.secretId}.` };
    }

    if (meta.mode === 'rotate') {
      const next = meta.login!;
      const secret = password();
      const set = await setLoginPassword(token, meta.gcpProjectId, meta.instanceName, next, secret, existing.has(next));
      if (set !== 'done') return set;
      if (!await verifyLogin(serviceAccount, instance.connectionName, next, secret, meta.databaseName)) {
        return { success: false, message: `The new password for ${next} did not work; the app keeps using its current login.` };
      }
      const failure = await writeSecretVersion(token, meta.gcpProjectId, meta.secretId, labelsFor(next, otherLogin(next)), connectionUrl(next, secret, meta.databaseName, instance.connectionName));
      if (failure) return failure;
      return { success: true, message: `A new password for ${next} is published. The app keeps running on its current login until its services move to the new secret version.` };
    }

    // revoke: every service now runs the new secret version, so the old password can go.
    const retired = meta.login!;
    const set = await setLoginPassword(token, meta.gcpProjectId, meta.instanceName, retired, password(), true);
    if (set !== 'done') return set;
    const observed = await observeSecret(token, meta.gcpProjectId, meta.secretId);
    if (observed.state !== 'present') return { success: false, status: 'pending', message: `${meta.secretId} could not be read after revoking ${retired}.` };
    const { 'hv-db-retire': _retire, ...labels } = observed.value.labels;
    const patched = await secretManagerFetch(token, `https://secretmanager.googleapis.com/v1/projects/${meta.gcpProjectId}/secrets/${meta.secretId}?updateMask=labels`, {
      method: 'PATCH', body: JSON.stringify({ labels }),
    });
    if (!patched.ok) return { success: false, status: 'pending', message: `The old password was revoked, but ${meta.secretId} could not be updated yet.` };
    return { success: true, message: `The previous password for ${retired} no longer works. Rotation is complete.` };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
    // Only connection problems are worth simply repeating; a database refusal needs a fix.
    if (isNetworkError(error) || /timeout|ECONN|ENOTFOUND|EAI_AGAIN|Connection terminated/i.test(reason)) {
      return { success: false, status: 'pending', message: `The connection to the database dropped (${reason}). Run the same command again; the app keeps using its current login.` };
    }
    return { success: false, message: `The database refused a credential step (${reason}). The app keeps using its current login.`, error: reason };
  }
}
