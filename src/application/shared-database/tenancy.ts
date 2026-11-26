import crypto from 'node:crypto';
import {
  TENANT_WRITER_LOCK, TenantBusyError, TenantRefusedError, dropTenant, ensureTenant, listTenants, observeTenant, retireTenantLogin, setTenantLoginPassword, tenantNames,
  type TenantIdentity, type TenantNames, type TenantServer,
} from '../../adapters/providers/database/tenant-database.js';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { EngineActionSegment, EngineStateIdentity } from '../../domain/ports/infrastructure-engine.port.js';
import { gcpDatabaseOnSharedServer, type GcpDatabaseBinding } from '../gcp-database-location.js';
import { connectionUrl } from '../infrastructure-engine-database.js';
import { SERVER_BUSY, Stop, blocked, newPassword, pending, withAdministrator, type ServerAddress } from './administrator.js';
import type { Seen, SeenConnectionSecret, SharedDatabaseCloud, SharedDatabaseEngine } from './ports.js';
import { MAINTENANCE_DATABASE, findSharedServer, serverPlanReview, sharedServerState, type SharedServerScope } from './server.js';

/**
 * One environment's database on the shared server: allocation, its login and
 * password, rotation and release. All SQL goes through the tenant module; this
 * file decides when each of its calls is allowed and what gets recorded.
 */
export const SHARED_DATABASE_OPERATION = 'gcpSharedDatabase';
export type SharedDatabaseStep = 'server' | 'allocate' | 'rotate' | 'retire' | 'release' | 'unprotect-server' | 'remove-server' | 'switch' | 'confirm-moved';
export type SharedDatabaseRecord = NonNullable<GcpDatabaseBinding['database']>;

/** Everything a step needs, saved on its reviewed action. None of it is secret. */
export interface StepMetadata {
  operation: typeof SHARED_DATABASE_OPERATION;
  step: SharedDatabaseStep;
  gcpProjectId: string;
  region: string;
  instanceName: string;
  databaseName: string;
  tenantId: string;
  /** The environment's connection secret and its ownership labels. */
  secretId?: string;
  labels?: Record<string, string>;
  generation?: number;
  connectionLimit?: number;
  /** retire: the secret version every service had moved to when this was reviewed. */
  secretVersion?: string;
  /**
   * A move's steps: the environment's own server, both servers' PostgreSQL version, and the secret version holding the
   * connection the workloads are switched to (`secretVersion` above is the one they run now).
   */
  own?: { instanceName: string; secretVersion: string; majorVersion: number };
}

export interface ReviewedServerPlan { planId: string; state: EngineStateIdentity; segment: EngineActionSegment }

/**
 * Connections one environment's database may hold open. The smallest server
 * accepts few in total (25 on Google's smallest tier, per its documentation;
 * not measured here), so production gets most of them and each other
 * environment a handful: a test environment cannot use up production's.
 */
export const CONNECTION_LIMITS = { production: 15, other: 5 } as const;

const usableTenantId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);

/**
 * The environment's stable id is what proves a database is its own; the name
 * in front is only a hint for people reading the server's list. A database
 * already recorded keeps the name it was given, so renaming an environment
 * never points it at a different one.
 */
export function tenantFor(environment: { id: string; name: string }, binding: GcpDatabaseBinding | undefined): TenantIdentity {
  if (!usableTenantId(environment.id)) throw blocked('This environment\'s id cannot be used to mark its database on a shared server.');
  const recorded = gcpDatabaseOnSharedServer(binding) ? binding!.database!.databaseName : undefined;
  if (recorded !== undefined) {
    if (!/^app_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(recorded) || recorded.length > 44) throw blocked(INCOMPLETE_RECORD);
    return { names: tenantNames(recorded.slice(4)), tenantId: environment.id };
  }
  const hint = environment.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'env';
  return { names: tenantNames(`${hint}_${crypto.createHash('sha256').update(environment.id).digest('hex').slice(0, 12)}`), tenantId: environment.id };
}

const INCOMPLETE_RECORD = 'The saved record of this environment\'s database on the shared server is incomplete, so Hypervibe will not plan changes to it.';

/**
 * How far the saved record says this environment's database got.
 * - `none`: nothing recorded.
 * - `started`: written down before anything was created, so a teardown can always find what an interrupted apply left.
 * - `finished`: created, with the login its services use.
 * Anything else is refused: a record whose parts do not belong together is never acted on.
 */
export function recordedAllocation(binding: GcpDatabaseBinding | undefined, identity: TenantIdentity): 'none' | 'started' | 'finished' {
  if (!gcpDatabaseOnSharedServer(binding)) return 'none';
  const record = binding!.database!;
  if (record.placement !== 'app' || record.tenantId !== identity.tenantId || record.databaseName !== identity.names.database) throw blocked(INCOMPLETE_RECORD);
  if (record.allocation === 'started' && record.activeLogin === undefined) return 'started';
  if (record.allocation === undefined && identity.names.logins.includes(record.activeLogin ?? '')) return 'finished';
  throw blocked(INCOMPLETE_RECORD);
}

export const otherLogin = (names: TenantNames, login: string): string => (login === names.logins[0] ? names.logins[1] : names.logins[0]);

export interface CredentialState {
  /** The secret's latest version is a working credential made for this database. */
  ready: boolean;
  login?: string;
  generation: number;
  latestVersion?: string;
  /** The login a finished rotation still has to switch off. */
  retirePending?: string;
  /** A latest version nothing is recorded about; it is replaced, never used. */
  unrecorded?: string;
}

/** Reads the state of the environment's connection secret from what Hypervibe recorded with its latest version. */
export function credentialState(seen: Seen<SeenConnectionSecret>, target: { secretId: string; environmentLabel: string; instanceName: string; names: TenantNames }): CredentialState {
  if (seen.state === 'unknown') throw blocked(seen.reason);
  if (seen.state === 'absent') return { ready: false, generation: 0 };
  const labels = seen.value.labels;
  if (labels['managed-by'] !== 'hypervibe' || labels['hv-environment'] !== target.environmentLabel) {
    throw blocked(`Secret Manager already has ${target.secretId}, but it is not owned by this Hypervibe environment.`);
  }
  if (seen.value.unrecorded) return { ready: false, generation: 0, ...(seen.value.latestVersion ? { unrecorded: seen.value.latestVersion } : {}) };
  const ours = (login: string | undefined): login is string => login === target.names.logins[0] || login === target.names.logins[1];
  const login = labels['hv-db-login'];
  const ready = seen.value.hasEnabledVersion && labels['hv-db-instance'] === target.instanceName && labels['hv-db-database'] === target.names.database && ours(login);
  return {
    ready,
    ...(ready ? { login } : {}),
    generation: ready ? Number(labels['hv-db-generation'] ?? '1') || 1 : 0,
    ...(seen.value.latestVersion ? { latestVersion: seen.value.latestVersion } : {}),
    ...(ready && ours(labels['hv-db-retire']) ? { retirePending: labels['hv-db-retire'] } : {}),
  };
}

/** `unsettled`: workloads that could not be found, or whose newest revision is not the one serving. Only a step that deletes data asks. */
export type RunningSecretVersions = () => Promise<{ versions: string[]; unsettled?: string[] } | { blocked: string }>;

export interface StepContext {
  cloud: SharedDatabaseCloud;
  engine: SharedDatabaseEngine;
  scope: SharedServerScope;
  environment: { id: string; name: string };
  /** The environment's saved binding as it is now, not as it was when planned. */
  binding: GcpDatabaseBinding | undefined;
  /** Saves the binding's database record at once; null forgets it. */
  record(database: SharedDatabaseRecord | null): void;
  runningSecretVersions: RunningSecretVersions;
  metadata: StepMetadata;
  server?: ReviewedServerPlan;
}

/** The server, found by its label in Google's own list and accepting connections. Not finding it never means "removed". */
export async function runningServer(cloud: SharedDatabaseCloud, scope: SharedServerScope, instanceName: string): Promise<ServerAddress> {
  const listed = await cloud.listServers(scope.gcpProjectId);
  if (listed.state === 'unknown') throw blocked(listed.reason);
  const found = findSharedServer(listed.servers, scope);
  if (found.state === 'unclear') throw blocked(found.reason);
  if (found.state !== 'present' || found.server.instanceName !== instanceName) {
    throw blocked(`The app's shared database server (${instanceName}) was not found in ${scope.gcpProjectId}. Nothing was changed, and nothing on it is treated as removed.`);
  }
  if (!found.server.runnable) throw pending(`The app's shared database server (${instanceName}) is not ready yet. Run the same command again.`);
  return { instanceName, connectionName: `${scope.gcpProjectId}:${scope.region}:${instanceName}` };
}

async function applyEnginePlan(context: StepContext): Promise<ActionResult> {
  const reviewed = context.server!;
  const { step, instanceName } = context.metadata;
  // What the saved plan does is read from the plan itself, now, never from how its step was worded.
  const operation = step === 'server' ? 'create' : step === 'remove-server' ? 'delete' : 'update';
  let matched = true;
  const review = serverPlanReview(operation, instanceName);
  const outcome = await context.engine.apply(reviewed.state, reviewed.planId, reviewed.segment, (shown) => (matched = review(shown)));
  if (!matched) {
    return { success: false, status: 'blocked', message: `The saved plan for the app's shared database server would not ${operation} exactly ${instanceName}, the server this step was reviewed for. Nothing was changed. Run hv_plan again.` };
  }
  const states = Object.values(outcome.outcomes);
  if (states.length && states.every((state) => state === 'succeeded')) {
    return { success: true, message: step === 'remove-server' ? `The app's shared database server (${instanceName}) was deleted.`
      : step === 'unprotect-server' ? `The app's shared database server (${instanceName}) is ready to be deleted. Plan its removal again to delete it.`
        : `The app's shared database server (${instanceName}) is ready.` };
  }
  const settled = !states.includes('unknown');
  return { success: false, ...(settled ? {} : { status: 'pending' as const }),
    message: `The change to the app's shared database server was not ${settled ? 'made' : 'confirmed'}: ${outcome.diagnostics.join(' ') || 'the engine gave no reason.'} Run hv_plan again.` };
}

async function applyServer(context: StepContext): Promise<ActionResult> {
  const reviewed = context.server;
  if (!reviewed || JSON.stringify(reviewed.state) !== JSON.stringify(sharedServerState(context.scope))) {
    return { success: false, status: 'blocked', message: 'The reviewed plan for the shared database server targets a different app, Google Cloud project or region. Run hv_plan again.' };
  }
  if (context.metadata.step === 'server') return applyEnginePlan(context);
  // Removal. The server's own list is read at the last moment, and the lock every allocation needs is held from that
  // read until the change is made, so no environment's database can arrive in between.
  const server = await runningServer(context.cloud, context.scope, context.metadata.instanceName);
  return withAdministrator(context.cloud, context.scope, server, async (tenants) => {
    const lock = `(${TENANT_WRITER_LOCK[0]}, ${TENANT_WRITER_LOCK[1]})`;
    const held = await tenants.admin.query(`SELECT pg_catalog.pg_try_advisory_lock${lock} AS answer`);
    if (held.rows[0]?.answer !== true) throw pending(SERVER_BUSY);
    try {
      const marked = (await listTenants(tenants)).map((tenant) => tenant.names.database);
      // Marked or not: any database beyond the server's own is someone's data.
      const others = await tenants.admin.query(`SELECT datname::text AS name FROM pg_catalog.pg_database WHERE NOT datistemplate AND datname NOT IN ('${MAINTENANCE_DATABASE}', 'cloudsqladmin') ORDER BY 1`);
      const names = [...new Set([...marked, ...others.rows.map((row) => String(row.name))])];
      if (names.length) throw blocked(`The app's shared database server still holds ${names.length === 1 ? 'a database' : `${names.length} databases`} (${names.join(', ')}). It was not changed; a server is never deleted with a database on it.`);
      return await applyEnginePlan(context);
    } finally {
      // After a delete there is no server left to answer; the lock went with it.
      await tenants.admin.query(`SELECT pg_catalog.pg_advisory_unlock${lock}`).catch(() => {});
    }
  });
}

/** Proves the login opens this tenant's database and acts as its owner role, before anything is published. */
export async function proveLogin(cloud: SharedDatabaseCloud, server: ServerAddress, names: TenantNames, login: string, password: string,
  failure = `The new login for ${names.database} did not open that database as its owner. Nothing was published; the app keeps using its current login.`): Promise<void> {
  const refused = new Stop({ success: false, message: failure });
  const seen = await cloud.withSession({ connectionName: server.connectionName, user: login, password, database: names.database },
    (session) => session.query('SELECT current_user::text AS role, session_user::text AS login, current_database()::text AS database')).catch((error: unknown) => {
    if (/^(28|42501|3D000)/.test(String((error as { code?: unknown } | null)?.code))) throw refused;
    throw error;
  });
  const row = seen.rows[0];
  if (row?.role !== names.owner || row.login !== login || row.database !== names.database) throw refused;
}

/** Sets a new password on `login`, proves it, then publishes the connection URL with what is recorded about it. */
async function issueCredential(context: StepContext, server: ServerAddress, tenants: TenantServer, identity: TenantIdentity, login: string, retire?: string): Promise<void> {
  const { metadata, cloud } = context;
  const password = newPassword();
  await setTenantLoginPassword(tenants, { ...identity, login, password });
  await proveLogin(cloud, server, identity.names, login, password);
  const labels = { ...metadata.labels, 'hv-db-instance': server.instanceName, 'hv-db-database': identity.names.database, 'hv-db-login': login,
    'hv-db-generation': String(metadata.generation ?? 1), ...(retire ? { 'hv-db-retire': retire } : {}) };
  const failure = await cloud.publishConnectionSecret(metadata.gcpProjectId, metadata.secretId!, labels, connectionUrl(login, password, identity.names.database, server.connectionName));
  if (failure) throw new Stop(failure);
}

const recordOf = (context: StepContext, identity: TenantIdentity, state: { activeLogin: string } | { allocation: 'started' }): SharedDatabaseRecord => ({
  instanceName: context.metadata.instanceName, gcpProjectId: context.scope.gcpProjectId, region: context.scope.region,
  databaseName: identity.names.database, placement: 'app', tenantId: identity.tenantId, ...state,
});

async function applyTenantStep(context: StepContext): Promise<ActionResult> {
  const { metadata, cloud, scope } = context;
  const identity = tenantFor(context.environment, context.binding);
  if (metadata.tenantId !== identity.tenantId || metadata.databaseName !== identity.names.database) {
    return { success: false, status: 'blocked', message: 'The database this plan was reviewed for is not this environment\'s. Run hv_plan again.' };
  }
  const recorded = recordedAllocation(context.binding, identity);
  const active = recorded === 'finished' ? context.binding!.database!.activeLogin! : undefined;
  const server = await runningServer(cloud, scope, metadata.instanceName);
  const name = context.environment.name;
  const credential = async () => credentialState(await cloud.observeConnectionSecret(metadata.gcpProjectId, metadata.secretId!),
    { secretId: metadata.secretId!, environmentLabel: metadata.labels?.['hv-environment'] ?? '', instanceName: server.instanceName, names: identity.names });
  // Written down before anything exists, so whatever an interrupted apply leaves behind can always be found and removed.
  if (metadata.step === 'allocate' && recorded === 'none') context.record(recordOf(context, identity, { allocation: 'started' }));

  return withAdministrator(cloud, scope, server, async (tenants): Promise<ActionResult> => {
    if (metadata.step === 'release') {
      const dropped = await dropTenant(tenants, identity);
      if (dropped.remainingRoles.length) {
        // Still recorded, so the next run finishes the job instead of forgetting them.
        throw pending(`${name}'s database was deleted from the app's shared database server, but its logins ${dropped.remainingRoles.join(', ')} could not be deleted yet (they are switched off). Run the same command again.`);
      }
      context.record(null);
      return { success: true, message: dropped.database === 'dropped'
        ? `${name}'s database (${identity.names.database}) was deleted from the app's shared database server. The server and the other environments' databases were not touched.`
        : `${name}'s database was already gone from the app's shared database server. The server was not touched.` };
    }
    if (metadata.step === 'allocate') {
      const seen = await observeTenant(tenants, identity);
      // A finished database that is no longer there is lost data, never a reason to make an empty one.
      if (recorded === 'finished' && seen.database === 'absent') {
        throw blocked(`${name}'s database (${identity.names.database}) is recorded but is no longer on the app's shared database server. Hypervibe will not put an empty database in its place.`);
      }
      // A new database is made only when the server itself says none exists and none was ever finished for this environment.
      await ensureTenant(tenants, { ...identity, connectionLimit: metadata.connectionLimit ?? CONNECTION_LIMITS.other, allocate: recorded !== 'finished' && seen.database === 'absent' });
      const current = await credential();
      if (current.ready) {
        context.record(recordOf(context, identity, { activeLogin: current.login! }));
        return { success: true, message: `${name}'s database on the app's shared database server is ready (${identity.names.database}).` };
      }
      // A version Google stored and Hypervibe never heard back about holds a password nobody has. Mark it as holding nothing, then publish a fresh one.
      if (current.unrecorded && !cloud.relabelConnectionSecret(metadata.gcpProjectId, metadata.secretId!, current.unrecorded, metadata.labels ?? {})) {
        throw pending(`An earlier, unfinished write to ${metadata.secretId} could not be set aside. Run the same command again.`);
      }
      // Never the login the services may already hold: its password keeps working until they have moved.
      const login = active ? otherLogin(identity.names, active) : identity.names.logins[0];
      await issueCredential(context, server, tenants, identity, login, active);
      context.record(recordOf(context, identity, { activeLogin: login }));
      return { success: true, message: `${name} has its own database (${identity.names.database}) on the app's shared database server; the app connects through ${metadata.secretId}.` };
    }
    const current = await credential();
    if (!current.ready || recorded !== 'finished') throw blocked(`${name}'s database login changed since this plan. Run hv_plan again.`);
    if (metadata.step === 'rotate') {
      if (current.retirePending || current.generation >= (metadata.generation ?? 1)) throw blocked(`${name}'s database password was already changed since this plan. Run hv_plan again.`);
      const next = otherLogin(identity.names, current.login!);
      await issueCredential(context, server, tenants, identity, next, current.login);
      context.record(recordOf(context, identity, { activeLogin: next }));
      return { success: true, message: `A new password for ${name}'s database is published on its second login. The app keeps running on its current login until its services move to the new secret version.` };
    }
    // retire: switch the previous login off, but only if what was reviewed is still true right now.
    if (!current.retirePending || !current.latestVersion) throw blocked(`${name}'s database has no previous login waiting to be switched off. Run hv_plan again.`);
    const running = await context.runningSecretVersions();
    if ('blocked' in running) throw blocked(running.blocked);
    if (current.latestVersion !== metadata.secretVersion || running.versions.some((version) => version !== current.latestVersion)) {
      throw blocked(`Not every service and job of ${name} uses the new database password yet, or it changed again since this plan. The previous login was left on. Run hv_plan again.`);
    }
    const retired = await retireTenantLogin(tenants, { ...identity, login: current.retirePending });
    const seen = await cloud.observeConnectionSecret(metadata.gcpProjectId, metadata.secretId!);
    const { 'hv-db-retire': _retire, ...labels } = seen.state === 'present' ? seen.value.labels : {};
    if (seen.state !== 'present' || !cloud.relabelConnectionSecret(metadata.gcpProjectId, metadata.secretId!, current.latestVersion, labels)) {
      throw pending(`The previous login for ${name}'s database is switched off, but that could not be recorded. Run the same command again.`);
    }
    context.record(recordOf(context, identity, { activeLogin: current.login! }));
    const open = retired.remainingSessions ? ` ${retired.remainingSessions} of its sessions had not ended yet; they cannot be reopened.` : '';
    return { success: true, message: `The previous login for ${name}'s database no longer works. Rotation is complete.${open}` };
  });
}

const NETWORK = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Runs one reviewed step. Every refusal comes back as a result. An unexpected
 * error is reported by its class and code only: its text may quote a statement
 * or a value, so none of it is copied.
 */
export function runStep(context: StepContext): Promise<ActionResult> {
  return settled(() => (['server', 'unprotect-server', 'remove-server'].includes(context.metadata.step) ? applyServer(context) : applyTenantStep(context)));
}

/** Turns whatever `work` throws into a result, by the rules above. */
export async function settled(work: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Stop) return error.result;
    if (error instanceof TenantRefusedError) return { success: false, status: 'blocked', message: error.message };
    if (error instanceof TenantBusyError) return { success: false, status: 'pending', message: SERVER_BUSY };
    const raw = (error as { code?: unknown } | null)?.code;
    const code = typeof raw === 'string' && /^[A-Z0-9_]{3,40}$/.test(raw) ? raw : undefined;
    const kind = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
    const label = code ? `${kind} ${code}` : kind;
    // Dropped connections and timeouts are worth simply repeating; the text is tested, never shown.
    const retry = (code !== undefined && NETWORK.has(code)) || (error instanceof Error && /timeout|Connection terminated|fetch failed/i.test(error.message));
    return retry
      ? { success: false, status: 'pending', message: `The connection to the app's shared database server dropped (${label}). Run the same command again; nothing the app uses was changed.` }
      : { success: false, error: label, message: `A step on the app's shared database server failed (${label}). The app keeps using its current login.` };
  }
}
