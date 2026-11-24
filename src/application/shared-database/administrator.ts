import crypto from 'node:crypto';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { TenantServer, TenantSession } from '../../adapters/providers/database/tenant-database.js';
import type { SharedDatabaseCloud, SqlSession } from './ports.js';
import { ADMINISTRATOR_LOGIN, MAINTENANCE_DATABASE, type SharedServerScope } from './server.js';

/** Ends a step with the result to report. Nothing that carries a password is ever put in one. */
export class Stop extends Error {
  constructor(readonly result: ActionResult) {
    super(result.message);
    this.name = 'Stop';
  }
}
export const blocked = (message: string) => new Stop({ success: false, status: 'blocked', message });
export const pending = (message: string) => new Stop({ success: false, status: 'pending', message });

/** Said whenever two changes to the server meet. It is never a sign of damage: the second one simply runs again. */
export const SERVER_BUSY = 'Another change to the app\'s shared database server is in progress (for example another environment being applied). Nothing the app uses was changed; run the same command again.';

/** How long a statement waits for another session's lock, and how long the tenant module waits for its own. */
export const LOCK_WAIT_MS = 30_000;

export const newPassword = (): string => crypto.randomBytes(32).toString('base64url');

/** PostgreSQL turned the login away: wrong password, or the role may not log in. */
const refusedLogin = (error: unknown): boolean => ['28P01', '28000'].includes(String((error as { code?: unknown } | null)?.code));

export interface ServerAddress { instanceName: string; connectionName: string }

const tenantSession = (session: SqlSession): TenantSession => ({ query: (text, values) => session.query(text, values) });

/** No statement waits on another session's lock for longer than the tenant module itself is willing to wait. */
async function boundLockWait(session: SqlSession): Promise<void> {
  await session.query(`SELECT pg_catalog.set_config('lock_timeout', $1::text, false)`, [`${LOCK_WAIT_MS}ms`]);
}

/**
 * Runs `work` as Hypervibe's administrator on the shared server, then closes
 * every session.
 *
 * The administrator's password is never kept anywhere. Every workload of the
 * app may read the project's secrets, so a stored one would let staging's
 * code administer production's database. Instead each use sets a fresh random
 * password through Google's API, holds it in memory for this one call and
 * forgets it. Always the same login, on the same maintenance database.
 *
 * Two of these at once is expected (two environments applied together): the
 * later password replaces the earlier, and whoever is turned away is told to
 * run again.
 */
export async function withAdministrator<T>(cloud: SharedDatabaseCloud, scope: SharedServerScope, server: ServerAddress, work: (tenants: TenantServer) => Promise<T>): Promise<T> {
  const password = newPassword();
  const set = await cloud.setServerLogin(scope.gcpProjectId, server.instanceName, ADMINISTRATOR_LOGIN, password);
  if (set) throw new Stop(set);
  const target = { connectionName: server.connectionName, user: ADMINISTRATOR_LOGIN, password };
  const open = <R>(database: string, inner: (session: SqlSession) => Promise<R>) => cloud.withSession({ ...target, database }, inner).catch((error: unknown) => {
    // This password was replaced by a later one before the session opened.
    if (refusedLogin(error)) throw pending(SERVER_BUSY);
    throw error;
  });
  return open(MAINTENANCE_DATABASE, async (session) => {
    await boundLockWait(session);
    return work({
      admin: tenantSession(session),
      lockWaitMs: LOCK_WAIT_MS,
      inDatabase: (database, inner) => open(database, async (other) => {
        await boundLockWait(other);
        return inner(tenantSession(other));
      }),
    });
  });
}
