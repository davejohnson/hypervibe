import crypto from 'node:crypto';
import type { GcpDatabaseConnection } from '../../adapters/providers/gcp/tofu/gcp-database-connection.js';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { engineSegmentOf } from '../../domain/ports/infrastructure-engine.port.js';
import type { EnvironmentSpec } from '../../domain/spec/spec.schema.js';
import { gcpDatabaseOnSharedServer, type GcpDatabaseBinding } from '../gcp-database-location.js';
import { Stop, blocked } from './administrator.js';
import type { SharedDatabaseCloud, SharedDatabaseEngine } from './ports.js';
import {
  SERVER_ENGINE_ACTIONS, administratorSecretId, findSharedServer, newSharedServerName, sharedServerConfiguration, sharedServerCost, sharedServerProtection,
  sharedServerState, type SharedServerScope,
} from './server.js';
import {
  CONNECTION_LIMITS, SHARED_DATABASE_OPERATION, credentialState, runStep, serverInventory, tenantFor,
  type ReviewedServerPlan, type SharedDatabaseRecord, type SharedDatabaseStep, type StepMetadata,
} from './tenancy.js';

/**
 * The one way in to the app's shared database server.
 *
 * An environment whose database spec says `placement: "app"` gets its own
 * PostgreSQL database on one server per app instead of a server of its own.
 * Everything about that server stays behind this file: its configuration and
 * saved state, Hypervibe's administrator login, which database and logins an
 * environment has, rotation and release. A planner asks three things and
 * learns nothing else: what to do (`actions`), what its services connect to
 * (`connection`, `credential`), and what to write in the environment's binding
 * after a step (`binding`).
 */
export { googleSharedDatabaseCloud } from './google.js';
export type { SharedDatabaseCloud, SharedDatabaseEngine } from './ports.js';

export interface SharedDatabaseRequest {
  /** The Hypervibe project: the app the server belongs to. */
  project: { id: string; name: string };
  environment: { id: string; name: string };
  gcpProjectId: string;
  region: string;
  /** The environment's saved engine binding, as it is now. */
  binding: GcpDatabaseBinding | undefined;
  engine: SharedDatabaseEngine;
  cloud: SharedDatabaseCloud;
}

export interface SharedDatabasePlanRequest extends SharedDatabaseRequest {
  /** The environment's database spec; absent when the database is being removed or the environment torn down. */
  desired: EnvironmentSpec['database'];
  teardown?: boolean;
  /** A worker of this environment counts pending work with a query in the database. */
  countsPendingWork: boolean;
  /** The environment's own connection secret (DATABASE_URL) and its ownership labels. */
  secret: { id: string; labels: Record<string, string> };
  /** The connection secret version each running service uses now. Asked only when a rotation is waiting to finish. */
  runningSecretVersions(): Promise<{ versions: string[] } | { blocked: string }>;
}

export interface SharedDatabasePlan {
  actions: PlanAction[];
  /** What workloads connect to; absent when no database remains. */
  connection?: GcpDatabaseConnection;
  /** Whether the environment's connection secret can be handed to services, and at which version. */
  credential: { ready: boolean; version?: string };
  warnings: string[];
  /** Saved with the reviewed plan and handed back, unread, to `apply`. */
  reviewed: Record<string, unknown>;
}

export interface SharedDatabaseApplyRequest extends SharedDatabaseRequest {
  action: PlanAction;
  reviewed: unknown;
}

export interface SharedDatabaseApplied {
  result: ActionResult;
  /** What to save as the binding's database: a record, null to forget it, absent to leave it. */
  binding?: SharedDatabaseRecord | null;
}

export interface SharedDatabaseEntry {
  /** Undefined when this environment's database is not, and is not asked to be, on the shared server: the caller carries on as before. */
  plan(request: SharedDatabasePlanRequest): Promise<SharedDatabasePlan | { blocked: string } | undefined>;
  /** True for the actions `plan` and `planServerRemoval` return. */
  handles(action: PlanAction): boolean;
  apply(request: SharedDatabaseApplyRequest): Promise<SharedDatabaseApplied>;
  /** Removing the server itself: offered only when the server's own list of databases is empty. Never part of an environment's plan. */
  planServerRemoval(request: Omit<SharedDatabaseRequest, 'environment' | 'binding'>): Promise<{ actions: PlanAction[]; reviewed: Record<string, unknown> } | { blocked: string }>;
}

interface Reviewed { instanceName: string; server?: ReviewedServerPlan }

const scopeOf = (request: Pick<SharedDatabaseRequest, 'project' | 'gcpProjectId' | 'region'>): SharedServerScope =>
  ({ projectId: request.project.id, gcpProjectId: request.gcpProjectId, region: request.region });

const resource = { kind: 'database' as const, name: 'postgres', provider: 'gcp' };

/** What an environment on the shared server cannot have yet. Each is refused whole, never half done. */
function unsupported(request: SharedDatabasePlanRequest): string | undefined {
  const name = request.environment.name;
  const database = request.desired!;
  const onServer = 'on the app\'s shared database server';
  if (request.countsPendingWork) return `${name} has an on-demand worker that counts pending work in the database. That is not available yet ${onServer}; give ${name} its own database (remove "placement") or run the worker all the time.`;
  if (database.size !== undefined) return `database.size cannot be set for ${name}: its database is ${onServer}, whose size is not chosen by one environment. Remove "size", or remove "placement" to give ${name} its own database.`;
  if (database.version !== undefined) return `database.version cannot be set for ${name}: its database is ${onServer} (PostgreSQL 16), and one environment cannot change the version for the others. Remove "version", or remove "placement".`;
  if (request.binding && (request.binding as { migration?: unknown }).migration) return `${name} is part of a migration. Migration is not available yet for a database ${onServer}.`;
  return undefined;
}

/** Plans the server through the engine in its own saved state and wraps the result as one plainly worded action. */
async function planServer(request: Pick<SharedDatabaseRequest, 'engine' | 'project'>, scope: SharedServerScope, instanceName: string,
  exists: { server: boolean; administratorSecret: boolean }, mode: { protect?: boolean; destroy?: boolean } = {}): Promise<{ action?: PlanAction; server?: ReviewedServerPlan }> {
  const state = sharedServerState(scope);
  let adopt: { server?: boolean; administratorSecret?: boolean } = {};
  for (let round = 0; ; round++) {
    const planId = crypto.randomUUID();
    const planned = await request.engine.plan(sharedServerConfiguration({ scope, instanceName, adopt, ...(mode.protect === false ? { protect: false } : {}) }), state, planId, mode.destroy);
    if (!planned.ok) throw blocked(planned.error);
    if (planned.blockers.length) throw blocked(planned.blockers.join(' '));
    const changes = planned.actions.filter((action) => action.type !== 'noop');
    const creating = (id: string) => changes.some((action) => action.id === id && action.type === 'create');
    // A create for something that already exists means saved state lost track of an interrupted create. It carries this app's label, so it is taken over.
    const missed = { ...(exists.server && creating(SERVER_ENGINE_ACTIONS.server) ? { server: true } : {}),
      ...(exists.administratorSecret && creating(SERVER_ENGINE_ACTIONS.administratorSecret) ? { administratorSecret: true } : {}) };
    if (Object.keys(missed).length && round === 0 && !mode.destroy) { adopt = missed; continue; }
    if (Object.keys(missed).length) throw blocked('The shared database server exists but could not be matched to Hypervibe\'s saved state. Nothing was planned.');
    if (!changes.length) return {};
    const addresses = [...new Set(changes.flatMap((action) => engineSegmentOf(action)?.addresses ?? []))];
    const billable = creating(SERVER_ENGINE_ACTIONS.server);
    const replaces = changes.some((action) => action.type === 'replace' || (action.type === 'destroy' && !mode.destroy));
    if (replaces) throw blocked('The engine would replace or delete the app\'s shared database server. Hypervibe will not plan that from an environment.');
    const step: SharedDatabaseStep = mode.destroy ? 'remove-server' : mode.protect === false ? 'unprotect-server' : 'server';
    const reason = mode.destroy
      ? `Delete ${request.project.name}'s shared database server (${instanceName}) and its backups. Its own list shows no database left on it. This cannot be undone.`
      : mode.protect === false
        ? `Turn off deletion protection on ${request.project.name}'s shared database server (${instanceName}) so it can be deleted. Its own list shows no database left on it. Plan the removal again afterwards.`
        : billable
          ? `Create the app's shared database server (${sharedServerCost()}). ${sharedServerProtection()} Each environment that uses it gets its own database on it.`
          : `Finish setting up the app's shared database server (${instanceName}); no new server is created and nothing on it is changed.`;
    return {
      server: { planId, state, segment: { ...planned.segment, addresses } },
      action: {
        id: `shared-database:${step}`, type: mode.destroy ? 'destroy' : billable ? 'create' : 'update', resource, verified: true, reason,
        ...(billable ? { billable: true } : {}), ...(mode.destroy ? { dataBearing: true } : {}), ...(billable || mode.destroy || mode.protect === false ? { requiresConfirm: true } : {}),
        metadata: { operation: SHARED_DATABASE_OPERATION, step, gcpProjectId: scope.gcpProjectId, region: scope.region, instanceName, databaseName: '', tenantId: '' } satisfies StepMetadata,
      },
    };
  }
}

async function plan(request: SharedDatabasePlanRequest): Promise<SharedDatabasePlan | { blocked: string } | undefined> {
  const { environment, binding, desired, cloud } = request;
  const bound = gcpDatabaseOnSharedServer(binding);
  const wanted = desired?.placement === 'app';
  if (!bound && !wanted) return undefined;
  const name = environment.name;
  if (!bound && binding?.database && wanted) {
    return { blocked: `${name} already has a database server of its own. Moving an existing database onto the app's shared server is not available yet; remove "placement" from its database to keep it where it is.` };
  }
  if (bound && desired && !wanted) {
    return { blocked: `${name}'s database is on the app's shared database server. Moving it to a server of its own is not available yet; keep "placement": "app" on its database.` };
  }
  try {
    const scope = scopeOf(request);
    const identity = tenantFor(environment, binding);
    const metadata = (step: SharedDatabaseStep, instanceName: string, more: Partial<StepMetadata> = {}): Record<string, unknown> => ({
      operation: SHARED_DATABASE_OPERATION, step, gcpProjectId: scope.gcpProjectId, region: scope.region, instanceName,
      databaseName: identity.names.database, tenantId: identity.tenantId, ...more } satisfies StepMetadata);

    if (!desired) {
      const instanceName = binding!.database!.instanceName;
      return {
        credential: { ready: false }, reviewed: { instanceName } satisfies Reviewed,
        warnings: [`${name}'s database (${identity.names.database}) is deleted from the app's shared database server; export it first if you need the data. The server and the other environments' databases on it stay.`],
        actions: [{ id: 'shared-database:release', type: 'destroy', resource, verified: true, dataBearing: true, requiresConfirm: true,
          reason: `Permanently delete ${name}'s database (${identity.names.database}) and its logins from the app's shared database server. The server itself and every other environment's database stay.`,
          metadata: metadata('release', instanceName) }],
      };
    }

    const refused = unsupported(request);
    if (refused) return { blocked: refused };
    const listed = await cloud.listServers(scope.gcpProjectId);
    if (listed.state === 'unknown') return { blocked: listed.reason };
    const found = findSharedServer(listed.servers, scope);
    if (found.state === 'unclear') return { blocked: found.reason };
    if (bound && (found.state !== 'present' || found.server.instanceName !== binding!.database!.instanceName)) {
      return { blocked: `${name}'s database is recorded on shared database server ${binding!.database!.instanceName}, which was not found in ${scope.gcpProjectId}. Hypervibe will not create another server or an empty database in its place.` };
    }
    const instanceName = found.state === 'present' ? found.server.instanceName : newSharedServerName(request.project.name);
    const administratorSecret = await cloud.readAdministratorSecret(scope.gcpProjectId, administratorSecretId(instanceName));
    if (administratorSecret.state === 'unknown') return { blocked: administratorSecret.reason };
    // The server is planned only while a piece of it is missing; an ordinary plan for an environment never re-plans a finished server.
    const server = found.state === 'present' && administratorSecret.state === 'present' ? {}
      : await planServer(request, scope, instanceName, { server: found.state === 'present', administratorSecret: administratorSecret.state === 'present' });

    const credential = credentialState(await cloud.observeConnectionSecret(scope.gcpProjectId, request.secret.id),
      { secretId: request.secret.id, environmentLabel: request.secret.labels['hv-environment'] ?? '', instanceName, names: identity.names });
    const generation = desired.passwordGeneration ?? 1;
    const actions: PlanAction[] = server.action ? [server.action] : [];
    const secret = { secretId: request.secret.id, labels: request.secret.labels };
    if (!bound || !credential.ready) {
      // Staging counts as "other" here: on one server its connections come out of production's.
      const limit = /prod/i.test(name) ? CONNECTION_LIMITS.production : CONNECTION_LIMITS.other;
      actions.push({ id: 'shared-database:allocate', type: bound ? 'update' : 'create', resource, verified: true,
        ...(server.action ? { dependsOn: [server.action.id] } : {}),
        reason: bound
          ? `Give ${name}'s database on the app's shared database server a working login again and store its connection URL in Secret Manager (${request.secret.id}).`
          : `Create ${name}'s own database on the app's shared database server (up to ${limit} connections), with two logins that take turns, and store its connection URL in Secret Manager (${request.secret.id}). No extra server charge. Passwords never enter OpenTofu.`,
        metadata: metadata('allocate', instanceName, { ...secret, generation, connectionLimit: limit }) });
    } else if (credential.retirePending) {
      const running = await request.runningSecretVersions();
      if ('blocked' in running) return running;
      // Only once every service runs the published version; until then the rollout is still under way.
      if (running.versions.every((version) => version === credential.latestVersion)) {
        actions.push({ id: 'shared-database:retire', type: 'update', resource, verified: true,
          reason: `Every service now uses ${name}'s new database password; Hypervibe will switch off the previous login. Other environments' logins are not touched.`,
          metadata: metadata('retire', instanceName, secret) });
      }
    } else if (credential.generation < generation) {
      actions.push({ id: 'shared-database:rotate', type: 'update', resource, verified: true,
        reason: `Rotate ${name}'s database password with no downtime: set a new password on its idle login, then move services to it before switching the old one off. Other environments' logins are not touched.`,
        metadata: metadata('rotate', instanceName, { ...secret, generation }) });
    }
    const ready = bound && credential.ready;
    return {
      actions,
      connection: { connectionName: `${scope.gcpProjectId}:${scope.region}:${instanceName}`, wireServices: ready,
        workerQuery: { projectId: scope.gcpProjectId, instanceName, databaseName: identity.names.database } },
      credential: { ready, ...(ready && credential.latestVersion ? { version: credential.latestVersion } : {}) },
      warnings: actions.some((action) => action.id === 'shared-database:allocate' && action.type === 'create')
        ? [`${name}'s database shares one server with this app's other environments that use "placement": "app". Their data is separate, but they share the machine: a heavy load or a full disk in one can slow the others, and a restore or a PostgreSQL upgrade covers the whole server. Remove "placement" to give ${name} a server of its own.`]
        : [],
      reviewed: { instanceName, ...(server.server ? { server: server.server } : {}) } satisfies Reviewed,
    };
  } catch (error) {
    if (error instanceof Stop) return { blocked: error.result.message };
    throw error;
  }
}

async function planServerRemoval(request: Omit<SharedDatabaseRequest, 'environment' | 'binding'>): Promise<{ actions: PlanAction[]; reviewed: Record<string, unknown> } | { blocked: string }> {
  try {
    const scope = scopeOf(request);
    const listed = await request.cloud.listServers(scope.gcpProjectId);
    if (listed.state === 'unknown') return { blocked: listed.reason };
    const found = findSharedServer(listed.servers, scope);
    if (found.state === 'unclear') return { blocked: found.reason };
    if (found.state === 'absent') return { blocked: `${request.project.name} has no shared database server in ${scope.gcpProjectId} (${scope.region}).` };
    const { instanceName } = found.server;
    const tenants = await serverInventory(request.cloud, scope, instanceName);
    if (tenants.length) {
      return { blocked: `The app's shared database server still holds ${tenants.length === 1 ? 'a database' : `${tenants.length} databases`} (${tenants.map((tenant) => tenant.names.database).join(', ')}). Remove ${tenants.length === 1 ? 'that environment\'s database' : 'those environments\' databases'} first; the server is never deleted with data on it.` };
    }
    const exists = { server: true, administratorSecret: true };
    const planned = await planServer(request, scope, instanceName, exists, found.server.deletionProtection ? { protect: false } : { protect: false, destroy: true });
    if (!planned.action || !planned.server) return { blocked: 'The engine found nothing to change on the shared database server. Run the removal plan again.' };
    return { actions: [planned.action], reviewed: { instanceName, server: planned.server } satisfies Reviewed };
  } catch (error) {
    if (error instanceof Stop) return { blocked: error.result.message };
    throw error;
  }
}

async function apply(request: SharedDatabaseApplyRequest): Promise<SharedDatabaseApplied> {
  const metadata = request.action.metadata as unknown as StepMetadata | undefined;
  const reviewed = request.reviewed as Reviewed | undefined;
  const scope = scopeOf(request);
  if (metadata?.operation !== SHARED_DATABASE_OPERATION || metadata.gcpProjectId !== scope.gcpProjectId || metadata.region !== scope.region
    || !reviewed || typeof reviewed !== 'object' || reviewed.instanceName !== metadata.instanceName) {
    return { result: { success: false, status: 'blocked', message: 'The shared database target changed since this plan. Run hv_plan again.' } };
  }
  return runStep({ cloud: request.cloud, engine: request.engine, scope, environment: request.environment, binding: request.binding, metadata, ...(reviewed.server ? { server: reviewed.server } : {}) });
}

export const sharedDatabase: SharedDatabaseEntry = {
  plan,
  handles: (action) => action.metadata?.operation === SHARED_DATABASE_OPERATION,
  apply,
  planServerRemoval,
};
