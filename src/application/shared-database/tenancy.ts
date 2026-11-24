import crypto from 'node:crypto';
import {
  TenantBusyError, TenantRefusedError, dropTenant, ensureTenant, listTenants, observeTenant, retireTenantLogin, setTenantLoginPassword, tenantNames,
  type TenantIdentity, type TenantNames, type TenantObservation, type TenantServer,
} from '../../adapters/providers/database/tenant-database.js';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { EngineActionSegment, EngineStateIdentity } from '../../domain/ports/infrastructure-engine.port.js';
import { gcpDatabaseOnSharedServer, type GcpDatabaseBinding } from '../gcp-database-location.js';
import { connectionUrl } from '../infrastructure-engine-database.js';
import { Stop, blocked, newPassword, pending, withAdministrator, type ServerAddress } from './administrator.js';
import type { Seen, SeenConnectionSecret, SharedDatabaseCloud, SharedDatabaseEngine } from './ports.js';
import { findSharedServer, sharedServerState, type SharedServerScope } from './server.js';

/**
 * One environment's database on the shared server: allocation, its login and
 * password, rotation and release. All SQL goes through the tenant module; this
 * file decides when each of its calls is allowed and what gets recorded.
 */
export const SHARED_DATABASE_OPERATION = 'gcpSharedDatabase';
export type SharedDatabaseStep = 'server' | 'allocate' | 'rotate' | 'retire' | 'release' | 'unprotect-server' | 'remove-server';
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
  if (recorded) return { names: tenantNames(recorded.replace(/^app_/, '')), tenantId: environment.id };
  const hint = environment.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'env';
  return { names: tenantNames(`${hint}_${crypto.createHash('sha256').update(environment.id).digest('hex').slice(0, 12)}`), tenantId: environment.id };
}

const otherLogin = (names: TenantNames, login: string): string => (login === names.logins[0] ? names.logins[1] : names.logins[0]);

export interface CredentialState {
  /** The secret holds a working version made for this database. */
  ready: boolean;
  login?: string;
  generation: number;
  latestVersion?: string;
  /** The login a finished rotation still has to switch off. */
  retirePending?: string;
}

/** Reads the state of the environment's connection secret from what Hypervibe recorded with its latest version. */
export function credentialState(seen: Seen<SeenConnectionSecret>, target: { secretId: string; environmentLabel: string; instanceName: string; names: TenantNames }): CredentialState {
  if (seen.state === 'unknown') throw blocked(seen.reason);
  if (seen.state === 'absent') return { ready: false, generation: 0 };
  const labels = seen.value.labels;
  if (labels['managed-by'] !== 'hypervibe' || labels['hv-environment'] !== target.environmentLabel) {
    throw blocked(`Secret Manager already has ${target.secretId}, but it is not owned by this Hypervibe environment.`);
  }
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

export interface StepContext {
  cloud: SharedDatabaseCloud;
  engine: SharedDatabaseEngine;
  scope: SharedServerScope;
  environment: { id: string; name: string };
  /** The environment's saved binding as it is now, not as it was when planned. */
  binding: GcpDatabaseBinding | undefined;
  metadata: StepMetadata;
  server?: ReviewedServerPlan;
}

/** `binding` is what to record: a record to save, null to forget the database, absent to leave the binding alone. */
export interface StepOutcome { result: ActionResult; binding?: SharedDatabaseRecord | null }

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

async function applyServer(context: StepContext): Promise<StepOutcome> {
  const reviewed = context.server;
  if (!reviewed || JSON.stringify(reviewed.state) !== JSON.stringify(sharedServerState(context.scope))) {
    return { result: { success: false, status: 'blocked', message: 'The reviewed plan for the shared database server targets a different app, Google Cloud project or region. Run hv_plan again.' } };
  }
  const { step, instanceName } = context.metadata;
  if (step !== 'server') {
    // Looked at again at the last moment: a server with anything of an environment's on it is never unprotected or deleted.
    const tenants = await serverInventory(context.cloud, context.scope, instanceName);
    if (tenants.length) throw blocked(`The app's shared database server holds a database again (${tenants.map((tenant) => tenant.names.database).join(', ')}). It was not changed.`);
  }
  const outcome = await context.engine.apply(reviewed.state, reviewed.planId, reviewed.segment);
  const states = Object.values(outcome.outcomes);
  if (states.length && states.every((state) => state === 'succeeded')) {
    return { result: { success: true, message: step === 'remove-server' ? `The app's shared database server (${instanceName}) was deleted.`
      : step === 'unprotect-server' ? `Deletion protection is off on the app's shared database server (${instanceName}). Plan its removal again to delete it.`
        : `The app's shared database server (${instanceName}) is ready.` } };
  }
  const settled = !states.includes('unknown');
  return { result: { success: false, ...(settled ? {} : { status: 'pending' as const }),
    message: `The change to the app's shared database server was not ${settled ? 'made' : 'confirmed'}: ${outcome.diagnostics.join(' ') || 'the engine gave no reason.'} Run hv_plan again.` } };
}

/** Proves the login opens this tenant's database and acts as its owner role, before anything is published. */
async function proveLogin(cloud: SharedDatabaseCloud, server: ServerAddress, names: TenantNames, login: string, password: string): Promise<void> {
  const seen = await cloud.withSession({ connectionName: server.connectionName, user: login, password, database: names.database },
    (session) => session.query('SELECT current_user::text AS role, session_user::text AS login, current_database()::text AS database'));
  const row = seen.rows[0];
  if (row?.role !== names.owner || row.login !== login || row.database !== names.database) {
    throw new Stop({ success: false, message: `The new login for ${names.database} did not open that database as its owner. Nothing was published; the app keeps using its current login.` });
  }
}

/** Sets a new password on `login`, proves it, then publishes the connection URL with what is recorded about it. */
async function issueCredential(context: StepContext, server: ServerAddress, tenants: TenantServer, identity: TenantIdentity,
  login: string, retire?: string): Promise<void> {
  const { metadata, cloud } = context;
  const password = newPassword();
  await setTenantLoginPassword(tenants, { ...identity, login, password });
  await proveLogin(cloud, server, identity.names, login, password);
  const labels = { ...metadata.labels, 'hv-db-instance': server.instanceName, 'hv-db-database': identity.names.database, 'hv-db-login': login,
    'hv-db-generation': String(metadata.generation ?? 1), ...(retire ? { 'hv-db-retire': retire } : {}) };
  const failure = await cloud.publishConnectionSecret(metadata.gcpProjectId, metadata.secretId!, labels, connectionUrl(login, password, identity.names.database, server.connectionName));
  if (failure) throw new Stop(failure);
}

const record = (context: StepContext, identity: TenantIdentity, activeLogin: string): SharedDatabaseRecord => ({
  instanceName: context.metadata.instanceName, gcpProjectId: context.scope.gcpProjectId, region: context.scope.region,
  databaseName: identity.names.database, placement: 'app', tenantId: identity.tenantId, activeLogin,
});

async function applyTenantStep(context: StepContext): Promise<StepOutcome> {
  const { metadata, cloud, scope } = context;
  const identity = tenantFor(context.environment, context.binding);
  if (metadata.tenantId !== identity.tenantId || metadata.databaseName !== identity.names.database) {
    return { result: { success: false, status: 'blocked', message: 'The database this plan was reviewed for is not this environment\'s. Run hv_plan again.' } };
  }
  const recorded = gcpDatabaseOnSharedServer(context.binding);
  const server = await runningServer(cloud, scope, metadata.instanceName);
  const name = context.environment.name;
  const credential = async () => credentialState(await cloud.observeConnectionSecret(metadata.gcpProjectId, metadata.secretId!),
    { secretId: metadata.secretId!, environmentLabel: metadata.labels?.['hv-environment'] ?? '', instanceName: server.instanceName, names: identity.names });

  return withAdministrator(cloud, scope, server, { repair: true }, async (tenants): Promise<StepOutcome> => {
    if (metadata.step === 'release') {
      const dropped = await dropTenant(tenants, identity);
      const leftover = dropped.remainingRoles.length ? ` Its logins ${dropped.remainingRoles.join(', ')} are switched off but could not be deleted yet; they are removed when this is run again.` : '';
      return { binding: null, result: { success: true, message: dropped.database === 'dropped'
        ? `${name}'s database (${identity.names.database}) was deleted from the app's shared database server. The server and the other environments' databases were not touched.${leftover}`
        : `${name}'s database was already gone from the app's shared database server. The server was not touched.${leftover}` } };
    }
    if (metadata.step === 'allocate') {
      const seen = await observeTenant(tenants, identity);
      // A database that was recorded and is no longer there is lost data, never a reason to make an empty one.
      if (recorded && seen.database === 'absent') {
        throw blocked(`${name}'s database (${identity.names.database}) is recorded but is no longer on the app's shared database server. Hypervibe will not put an empty database in its place.`);
      }
      // A new database is made only when the server itself says none exists and none was ever recorded for this environment.
      await ensureTenant(tenants, { ...identity, connectionLimit: metadata.connectionLimit ?? CONNECTION_LIMITS.other, allocate: !recorded && seen.database === 'absent' });
      const current = await credential();
      if (current.ready) return { binding: record(context, identity, current.login!), result: { success: true, message: `${name}'s database on the app's shared database server is ready (${identity.names.database}).` } };
      // Never the login the services may already hold: its password keeps working.
      const login = recorded && context.binding!.database!.activeLogin ? otherLogin(identity.names, context.binding!.database!.activeLogin) : identity.names.logins[0];
      await issueCredential(context, server, tenants, identity, login);
      return { binding: record(context, identity, login), result: { success: true, message: `${name} has its own database (${identity.names.database}) on the app's shared database server; the app connects through ${metadata.secretId}.` } };
    }
    const current = await credential();
    if (!current.ready || !recorded) throw blocked(`${name}'s database login changed since this plan. Run hv_plan again.`);
    if (metadata.step === 'rotate') {
      if (current.retirePending || current.generation >= (metadata.generation ?? 1)) throw blocked(`${name}'s database password was already changed since this plan. Run hv_plan again.`);
      const next = otherLogin(identity.names, current.login!);
      await issueCredential(context, server, tenants, identity, next, current.login);
      return { binding: record(context, identity, next), result: { success: true, message: `A new password for ${name}'s database is published on its second login. The app keeps running on its current login until its services move to the new secret version.` } };
    }
    // retire: every service runs the new version, so the previous login can be switched off.
    if (!current.retirePending || !current.latestVersion) throw blocked(`${name}'s database has no previous login waiting to be switched off. Run hv_plan again.`);
    const retired = await retireTenantLogin(tenants, { ...identity, login: current.retirePending });
    const seen = await cloud.observeConnectionSecret(metadata.gcpProjectId, metadata.secretId!);
    const { 'hv-db-retire': _retire, ...labels } = seen.state === 'present' ? seen.value.labels : {};
    if (seen.state !== 'present' || !cloud.relabelConnectionSecret(metadata.gcpProjectId, metadata.secretId!, current.latestVersion, labels)) {
      throw pending(`The previous login for ${name}'s database is switched off, but that could not be recorded. Run the same command again.`);
    }
    const open = retired.remainingSessions ? ` ${retired.remainingSessions} of its sessions had not ended yet; they cannot be reopened.` : '';
    return { binding: record(context, identity, current.login!), result: { success: true, message: `The previous login for ${name}'s database no longer works. Rotation is complete.${open}` } };
  });
}

/** What the server itself lists: every database Hypervibe made on it, finished or not. Never repairs anything. */
export async function serverInventory(cloud: SharedDatabaseCloud, scope: SharedServerScope, instanceName: string): Promise<TenantObservation[]> {
  const server = await runningServer(cloud, scope, instanceName);
  return withAdministrator(cloud, scope, server, { repair: false }, (tenants) => listTenants(tenants));
}

/** Runs one reviewed step. Every refusal comes back as a result; nothing here throws a password or a statement at the caller. */
export async function runStep(context: StepContext): Promise<StepOutcome> {
  try {
    return ['server', 'unprotect-server', 'remove-server'].includes(context.metadata.step) ? await applyServer(context) : await applyTenantStep(context);
  } catch (error) {
    if (error instanceof Stop) return { result: error.result };
    if (error instanceof TenantRefusedError) return { result: { success: false, status: 'blocked', message: error.message } };
    if (error instanceof TenantBusyError) return { result: { success: false, status: 'pending', message: error.message } };
    const reason = (error instanceof Error ? error.message.split('\n')[0]! : 'unknown error').replace(/postgresql:\/\/\S+/g, '<redacted>');
    const retry = /timeout|ECONN|ENOTFOUND|EAI_AGAIN|Connection terminated|fetch failed/i.test(reason);
    return { result: { success: false, ...(retry ? { status: 'pending' as const } : { error: reason }),
      message: retry ? `The connection to the shared database server dropped (${reason}). Run the same command again; nothing the app uses was changed.`
        : `The shared database server refused a step (${reason}). The app keeps using its current login.` } };
  }
}
