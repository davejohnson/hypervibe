import crypto from 'node:crypto';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { TenantServer, TenantSession } from '../../adapters/providers/database/tenant-database.js';
import type { SharedDatabaseCloud, SqlSession } from './ports.js';
import { ADMINISTRATOR_LOGIN, MAINTENANCE_DATABASE, SHARED_SERVER_LABEL, administratorSecretId, sharedServerLabels, type SharedServerScope } from './server.js';

/** Ends a step with the result to report. Nothing that carries a password is ever put in one. */
export class Stop extends Error {
  constructor(readonly result: ActionResult) {
    super(result.message);
    this.name = 'Stop';
  }
}
export const blocked = (message: string) => new Stop({ success: false, status: 'blocked', message });
export const pending = (message: string) => new Stop({ success: false, status: 'pending', message });

/** How long a statement waits for another session's lock, and how long the tenant module waits for its own. */
export const LOCK_WAIT_MS = 30_000;

export const newPassword = (): string => crypto.randomBytes(32).toString('base64url');

/** PostgreSQL turned the login away: wrong password, or the role may not log in. */
const refusedLogin = (error: unknown): boolean => ['28P01', '28000'].includes(String((error as { code?: unknown } | null)?.code));

export interface ServerAddress { instanceName: string; connectionName: string }

/**
 * Hypervibe's own administrator login on the shared server. Its password is
 * generated here, set through Google's API and kept in Secret Manager in the
 * app's Google project; it never enters OpenTofu, plans, results or logs.
 *
 * `repair` lets a missing or rejected password be replaced with a new one.
 * Read-only callers pass false and are told the administrator is unavailable.
 */
async function administratorPassword(cloud: SharedDatabaseCloud, scope: SharedServerScope, server: ServerAddress, repair: boolean): Promise<string> {
  const secretId = administratorSecretId(server.instanceName);
  const stored = await cloud.readAdministratorSecret(scope.gcpProjectId, secretId);
  if (stored.state === 'unknown') throw blocked(stored.reason);
  if (stored.state === 'absent') throw blocked('The secret that holds Hypervibe\'s administrator password for the shared database server is missing. Run hv_plan again so it is created first.');
  const wanted = sharedServerLabels(scope);
  if (stored.value.labels['managed-by'] !== 'hypervibe' || stored.value.labels[SHARED_SERVER_LABEL] !== wanted[SHARED_SERVER_LABEL]) {
    throw blocked(`Secret ${secretId} exists but does not belong to this app's shared database server. Nothing was changed.`);
  }
  const target = { connectionName: server.connectionName, user: ADMINISTRATOR_LOGIN, database: MAINTENANCE_DATABASE };
  if (stored.value.value) {
    const password = stored.value.value;
    const accepted = await cloud.withSession({ ...target, password }, async () => true).catch((error: unknown) => {
      if (refusedLogin(error)) return false;
      throw error;
    });
    if (accepted) return password;
  }
  if (!repair) throw blocked('Hypervibe\'s administrator login on the shared database server is not set up or its saved password no longer works. Run hv_plan and hv_apply for one of the app\'s environments to restore it.');
  const password = newPassword();
  const set = await cloud.setServerLogin(scope.gcpProjectId, server.instanceName, ADMINISTRATOR_LOGIN, password);
  if (set) throw new Stop(set);
  const written = await cloud.writeAdministratorSecret(scope.gcpProjectId, secretId, password);
  if (written) throw new Stop(written);
  return password;
}

const tenantSession = (session: SqlSession): TenantSession => ({ query: (text, values) => session.query(text, values) });

/** No statement waits on another session's lock for longer than the tenant module itself is willing to wait. */
async function boundLockWait(session: SqlSession): Promise<void> {
  await session.query(`SELECT pg_catalog.set_config('lock_timeout', $1::text, false)`, [`${LOCK_WAIT_MS}ms`]);
}

/**
 * Runs `work` with the privileged sessions the tenant module needs, always as
 * the same administrator on the same maintenance database, then closes them.
 */
export async function withAdministrator<T>(cloud: SharedDatabaseCloud, scope: SharedServerScope, server: ServerAddress, options: { repair: boolean },
  work: (tenants: TenantServer) => Promise<T>): Promise<T> {
  const password = await administratorPassword(cloud, scope, server, options.repair);
  const target = { connectionName: server.connectionName, user: ADMINISTRATOR_LOGIN, password };
  return cloud.withSession({ ...target, database: MAINTENANCE_DATABASE }, async (session) => {
    await boundLockWait(session);
    return work({
      admin: tenantSession(session),
      lockWaitMs: LOCK_WAIT_MS,
      inDatabase: (database, inner) => cloud.withSession({ ...target, database }, async (other) => {
        await boundLockWait(other);
        return inner(tenantSession(other));
      }),
    });
  });
}
