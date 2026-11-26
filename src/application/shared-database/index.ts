import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { GcpDatabaseConnection } from '../../adapters/providers/gcp/tofu/gcp-database-connection.js';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { engineSegmentOf } from '../../domain/ports/infrastructure-engine.port.js';
import type { EnvironmentSpec } from '../../domain/spec/spec.schema.js';
import { gcpDatabaseOnSharedServer, type GcpDatabaseBinding } from '../gcp-database-location.js';
import { Stop, blocked } from './administrator.js';
import { applySwitch, applySwitchToShared, cleanupTarget, confirmMoved, planArrived, planCleanup, planMove, planMoveToShared, type DatabaseMove, type MoveStepContext, type OwnDatabasePause } from './move.js';
import { pauseDatabase, resumeDatabase } from './pause.js';
import type { SharedDatabaseCloud, SharedDatabaseEngine } from './ports.js';
import {
  SERVER_ENGINE_ACTION, findSharedServer, serverPlanReview, newSharedServerName, sharedServerConfiguration, sharedServerCost, sharedServerProtection, sharedServerState, type SharedServerScope,
} from './server.js';
import {
  CONNECTION_LIMITS, SHARED_DATABASE_OPERATION, credentialState, recordedAllocation, runStep, settled, tenantFor,
  type ReviewedServerPlan, type RunningSecretVersions, type SharedDatabaseRecord, type SharedDatabaseStep, type StepMetadata,
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
 * (`connection`, `credential`), and what to keep in the environment's binding
 * (`record`, called by a step whenever that changes).
 */
export { googleSharedDatabaseCloud } from './google.js';
export type { DatabaseMove, OwnDatabasePause } from './move.js';
export type { SharedDatabaseCloud, SharedDatabaseEngine } from './ports.js';

export interface SharedDatabaseRequest {
  /** The Hypervibe project: the app the server belongs to. */
  project: { id: string; name: string };
  environment: { id: string; name: string };
  gcpProjectId: string;
  region: string;
  /** The environment's saved engine binding, as it is now. */
  binding: GcpDatabaseBinding | undefined;
  /** The environment's own connection secret (DATABASE_URL) and its ownership labels, worked out by the caller each time, never taken from a saved plan. */
  secret: { id: string; labels: Record<string, string> };
  /** The connection secret version each of the environment's services and jobs runs now. Asked only when a rotation is finishing. */
  runningSecretVersions: RunningSecretVersions;
  /** Pausing the database on the environment's own server, and undoing that. Only a move onto the shared server asks. */
  ownDatabasePause?: OwnDatabasePause;
  engine: SharedDatabaseEngine;
  cloud: SharedDatabaseCloud;
}

export interface SharedDatabasePlanRequest extends SharedDatabaseRequest {
  /** The environment's database spec; absent when the database is being removed or the environment torn down. */
  desired: EnvironmentSpec['database'];
  teardown?: boolean;
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
  /**
   * Set when the database is leaving the shared server for one of the environment's own. Everything above is then empty:
   * the caller plans that server as it would for any environment, keeps the workloads where `move` says, and places the move's steps.
   */
  move?: DatabaseMove;
}

/** What Hypervibe has saved for one of the app's environments. */
export interface RecordedEnvironment { environment: string; binding: GcpDatabaseBinding | undefined }

/** The exact call that removes the app's shared database server once no environment uses it. */
export const sharedServerRemovalCall = (projectName: string): string => `hv_plan project=${JSON.stringify(projectName)} scope="shared-database" intent="remove"`;

export interface SharedDatabaseApplyRequest extends SharedDatabaseRequest {
  action: PlanAction;
  reviewed: unknown;
  /** The app's other environments, so a release can say when it was the last database on the server. */
  others?: RecordedEnvironment[];
  /** Saves the database part of the environment's binding at once: a record, or null to forget it. */
  record(database: SharedDatabaseRecord | null): void;
}

export interface SharedDatabasePauseRequest extends Pick<SharedDatabaseRequest, 'project' | 'environment' | 'gcpProjectId' | 'region' | 'binding' | 'cloud'> {
  /**
   * The environment's own connection secret, and the exact version its services are pinned to. The copy login's URL goes
   * to the one secret named after it (`databaseCopySecretId`), which must exist, belong to the same environment, and never
   * be mounted into a service.
   */
  secret: { id: string; labels: Record<string, string>; version: string };
}

export type SharedServerRequest = Pick<SharedDatabaseRequest, 'project' | 'gcpProjectId' | 'region' | 'engine' | 'cloud'> & {
  /** Every environment of the app as saved now. The server is never removed while one of them still records a database on it. */
  recorded: RecordedEnvironment[];
};
export interface SharedServerRemovalPlan { instanceName: string; action: PlanAction; reviewed: Record<string, unknown> }

export interface SharedDatabaseEntry {
  /** Undefined when this environment's database is not, and is not asked to be, on the shared server: the caller carries on as before. */
  plan(request: SharedDatabasePlanRequest): Promise<SharedDatabasePlan | { blocked: string } | undefined>;
  /** True for the actions `plan` and `planServerRemoval` return. */
  handles(action: PlanAction): boolean;
  apply(request: SharedDatabaseApplyRequest): Promise<ActionResult>;
  /**
   * Removing the server itself; never part of an environment's plan. `none` when the app has no shared server.
   * Planning reads no database: the step itself refuses, at the last moment, while any database is on the server.
   */
  planServerRemoval(request: SharedServerRequest): Promise<SharedServerRemovalPlan | { none: true } | { blocked: string }>;
  /**
   * Stops every way the app has into this environment's database and proves nobody is connected; then opens one other
   * way in, for copying it, whose URL goes to a secret of its own. `resume` undoes it: the connection the services hold works again.
   * Both can be repeated, in any order. Not part of any plan yet.
   */
  pause(request: SharedDatabasePauseRequest): Promise<ActionResult>;
  resume(request: SharedDatabasePauseRequest): Promise<ActionResult>;
  applyServerRemoval(request: SharedServerRequest & { action: PlanAction; reviewed: unknown }): Promise<ActionResult>;
}

interface Reviewed { instanceName: string; server?: ReviewedServerPlan }

const scopeOf = (request: Pick<SharedDatabaseRequest, 'project' | 'gcpProjectId' | 'region'>): SharedServerScope =>
  ({ projectId: request.project.id, gcpProjectId: request.gcpProjectId, region: request.region });

const resource = { kind: 'database' as const, name: 'postgres', provider: 'gcp' };

/** The environments whose saved record puts a database on this app's shared server in this Google project and region. */
function recordedOn(scope: SharedServerScope, environments: RecordedEnvironment[]): string[] {
  // An environment that moved to its own server still has its old database here until that is deleted.
  const here = (binding: GcpDatabaseBinding | undefined) => (gcpDatabaseOnSharedServer(binding) ? binding!.database : binding?.database?.movedFrom ?? binding?.database?.moveTo) as { gcpProjectId?: string; region?: string } | undefined;
  return environments.filter(({ binding }) => { const record = here(binding); return record !== undefined && (record.gcpProjectId ?? scope.gcpProjectId) === scope.gcpProjectId && (record.region ?? scope.region) === scope.region; })
    .map(({ environment }) => environment);
}
const stillRecorded = (names: string[]): string => `${names.join(', ')} still ${names.length === 1 ? 'has its' : 'have their'} database on the app's shared database server. Tear ${names.length === 1 ? 'that environment' : 'those environments'} down, or remove the database from ${names.length === 1 ? 'its' : 'their'} spec and apply, before removing the server. Nothing was changed.`;
const serverMetadata = (scope: SharedServerScope, step: SharedDatabaseStep, instanceName: string): Record<string, unknown> =>
  ({ operation: SHARED_DATABASE_OPERATION, step, gcpProjectId: scope.gcpProjectId, region: scope.region, instanceName, databaseName: '', tenantId: '' } satisfies StepMetadata);

type ServerChange = 'create' | 'take-over' | 'unprotect' | 'delete';

/** A plan with nothing to do is not a wrong plan; the caller decides what an empty plan means. */
const hasNoChange = (shown: unknown): boolean => {
  const rows = (shown as { resource_changes?: Array<{ change?: { actions?: unknown[]; importing?: unknown } }> } | null)?.resource_changes;
  return Array.isArray(rows) && rows.every((row) => !row.change?.importing && row.change?.actions?.length === 1 && ['no-op', 'read'].includes(String(row.change.actions[0])));
};

/**
 * Plans one change to the server through the engine, in the server's own saved state, and accepts the result only
 * when it is exactly that change. Anything else the engine wants to do to the server is refused, never folded in.
 */
async function planServerChange(request: Pick<SharedDatabaseRequest, 'engine'>, scope: SharedServerScope, instanceName: string, change: ServerChange): Promise<ReviewedServerPlan | undefined> {
  const state = sharedServerState(scope);
  const planId = crypto.randomUUID();
  // The engine's plan must be exactly this operation on exactly this server: its saved state may name another one.
  let reviewed = false;
  const review = serverPlanReview(change === 'create' ? 'create' : change === 'delete' ? 'delete' : 'update', instanceName);
  const planned = await request.engine.plan(sharedServerConfiguration({ scope, instanceName, ...(change === 'take-over' ? { adopt: true } : {}), ...(change === 'create' ? {} : { protect: false }) }),
    state, planId, (shown) => { reviewed = true; return hasNoChange(shown) || review(shown); }, change === 'delete');
  if (!planned.ok) throw blocked(reviewed ? `${planned.error} The engine's plan was not exactly "${change}" on shared database server ${instanceName}, the one Google lists for this app; its saved state may describe a different server. Nothing was planned.` : planned.error);
  if (planned.blockers.length) throw blocked(planned.blockers.join(' '));
  const changes = planned.actions.filter((action) => action.type !== 'noop');
  if (!changes.length) return undefined;
  const expected = change === 'create' ? 'create' : change === 'delete' ? 'destroy' : 'update';
  if (changes.length !== 1 || changes[0]!.id !== SERVER_ENGINE_ACTION || changes[0]!.type !== expected) {
    throw blocked(`The engine would ${changes.map((action) => action.type).join(' and ')} the app's shared database server (${instanceName}) where only "${expected}" was expected. Hypervibe will not change it.`);
  }
  return { planId, state, segment: { ...planned.segment, addresses: [...new Set(changes.flatMap((action) => engineSegmentOf(action)?.addresses ?? []))] } };
}

/** What an environment on the shared server cannot have yet, that only its saved binding shows. What the spec alone shows is refused where specs are checked. */
function unsupported(request: SharedDatabasePlanRequest): string | undefined {
  if (request.binding && (request.binding as { migration?: unknown }).migration) {
    return `${request.environment.name} is part of a migration. Migration is not available yet for a database on the app's shared database server.`;
  }
  return undefined;
}

async function plan(request: SharedDatabasePlanRequest): Promise<SharedDatabasePlan | { blocked: string } | undefined> {
  const { environment, binding, desired, cloud } = request;
  const bound = gcpDatabaseOnSharedServer(binding);
  const wanted = desired?.placement === 'app';
  const moving = { environment, binding, scope: scopeOf(request), secret: request.secret, runningSecretVersions: request.runningSecretVersions, cloud };
  const move = async (work: () => Promise<DatabaseMove>): Promise<SharedDatabasePlan | { blocked: string }> => {
    try {
      return { actions: [], credential: { ready: false }, warnings: [], reviewed: {}, move: await work() };
    } catch (error) {
      if (error instanceof Stop) return { blocked: error.result.message };
      throw error;
    }
  };
  const record = binding?.database;
  // The other way: an environment with a server of its own that asks for the shared server, and one that has just arrived on it.
  if (!bound && record && record.movedFrom === undefined && (wanted || record.moveTo !== undefined)) {
    if (!wanted) return { blocked: `${environment.name}'s database is being moved onto the app's shared database server. Finish the move first: keep "placement": "app" on its database and run hv_plan and hv_apply until nothing is left.` };
    const prepared = await plan({ ...request, binding: record.moveTo !== undefined ? { database: record.moveTo as NonNullable<GcpDatabaseBinding['database']> } : undefined });
    if (!prepared || 'blocked' in prepared) return prepared ?? { blocked: 'Nothing could be planned on the app\'s shared database server.' };
    return move(() => planMoveToShared({ ...moving, desired: desired!, prepared }));
  }
  if (bound && record!.movedFrom !== undefined) {
    if (!desired || !wanted) return { blocked: `${environment.name}'s database was moved onto the app's shared database server, and its own server is still there. Finish the move first: keep "placement": "app" on its database and run hv_plan and hv_apply until that server is deleted.` };
    const { movedFrom: _left, ...arrived } = record!;
    const prepared = await plan({ ...request, binding: { ...binding, database: arrived } });
    if (!prepared || 'blocked' in prepared) return prepared ?? { blocked: 'Nothing could be planned on the app\'s shared database server.' };
    return move(() => planArrived({ ...moving, desired, prepared }));
  }
  if (!bound && binding?.database?.movedFrom !== undefined) return move(() => planCleanup({ ...moving, desired: desired ?? undefined, wantsShared: wanted } as Parameters<typeof planCleanup>[0]));
  if (bound && binding!.database!.move !== undefined && (!desired || wanted)) {
    return { blocked: `${environment.name}'s database is being moved to a server of its own. Finish the move first: remove "placement" from its database and run hv_plan and hv_apply until nothing is left.` };
  }
  if (bound && desired && !wanted) return move(() => planMove({ ...moving, desired }));
  if (!bound && !wanted) return undefined;
  const name = environment.name;
  try {
    const scope = scopeOf(request);
    const identity = tenantFor(environment, binding);
    const recorded = recordedAllocation(binding, identity);
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
    // The server is planned from an environment only when Google's own list shows none. One that exists is never changed from here.
    const instanceName = found.state === 'present' ? found.server.instanceName : newSharedServerName(request.project.name);
    const actions: PlanAction[] = [];
    let server: ReviewedServerPlan | undefined;
    if (found.state === 'absent') {
      server = await planServerChange(request, scope, instanceName, 'create');
      if (!server) return { blocked: `Hypervibe's saved state says the app's shared database server exists, but Google lists none in ${scope.gcpProjectId} (${scope.region}). Nothing was planned.` };
      actions.push({ id: 'shared-database:server', type: 'create', resource, verified: true, billable: true, requiresConfirm: true,
        reason: `Create the app's shared database server (${sharedServerCost()}). ${sharedServerProtection()} Each environment that uses it gets its own database on it.`,
        metadata: serverMetadata(scope, 'server', instanceName) });
    }

    const credential = credentialState(await cloud.observeConnectionSecret(scope.gcpProjectId, request.secret.id),
      { secretId: request.secret.id, environmentLabel: request.secret.labels['hv-environment'] ?? '', instanceName, names: identity.names });
    const generation = desired.passwordGeneration ?? 1;
    const secret = { secretId: request.secret.id, labels: request.secret.labels };
    const finished = recorded === 'finished';
    if (!finished || !credential.ready) {
      // Staging counts as "other" here: on one server its connections come out of production's.
      const limit = /prod/i.test(name) ? CONNECTION_LIMITS.production : CONNECTION_LIMITS.other;
      actions.push({ id: 'shared-database:allocate', type: finished ? 'update' : 'create', resource, verified: true,
        ...(server ? { dependsOn: ['shared-database:server'] } : {}),
        reason: finished
          ? `Give ${name}'s database on the app's shared database server a working login again and store its connection URL in Secret Manager (${request.secret.id}). Its data is not touched.`
          : `Create ${name}'s own database on the app's shared database server (up to ${limit} connections), with two logins that take turns, and store its connection URL in Secret Manager (${request.secret.id}). No extra server charge. Passwords never enter OpenTofu.`,
        metadata: metadata('allocate', instanceName, { ...secret, generation, connectionLimit: limit }) });
    } else if (credential.retirePending) {
      const running = await request.runningSecretVersions();
      if ('blocked' in running) return running;
      // Only once every service and job runs the published version; until then the rollout is still under way.
      if (credential.latestVersion && running.versions.every((version) => version === credential.latestVersion)) {
        actions.push({ id: 'shared-database:retire', type: 'update', resource, verified: true,
          reason: `Every service now uses ${name}'s new database password; Hypervibe will switch off the previous login. Other environments' logins are not touched.`,
          metadata: metadata('retire', instanceName, { ...secret, secretVersion: credential.latestVersion }) });
      }
    } else if (credential.generation < generation) {
      actions.push({ id: 'shared-database:rotate', type: 'update', resource, verified: true,
        reason: `Rotate ${name}'s database password with no downtime: set a new password on its idle login, then move services to it before switching the old one off. Other environments' logins are not touched.`,
        metadata: metadata('rotate', instanceName, { ...secret, generation }) });
    }
    const ready = finished && credential.ready;
    return {
      actions,
      connection: { connectionName: `${scope.gcpProjectId}:${scope.region}:${instanceName}`, wireServices: ready,
        workerQuery: { projectId: scope.gcpProjectId, instanceName, databaseName: identity.names.database } },
      credential: { ready, ...(ready && credential.latestVersion ? { version: credential.latestVersion } : {}) },
      warnings: actions.some((action) => action.id === 'shared-database:allocate' && action.type === 'create')
        ? [`${name}'s database shares one server with this app's other environments that use "placement": "app". Their data is separate, but they share the machine: a heavy load or a full disk in one can slow the others, and a restore or a PostgreSQL upgrade covers the whole server. Remove "placement" to give ${name} a server of its own.`]
        : [],
      reviewed: { instanceName, ...(server ? { server } : {}) } satisfies Reviewed,
    };
  } catch (error) {
    if (error instanceof Stop) return { blocked: error.result.message };
    throw error;
  }
}

async function planServerRemoval(request: SharedServerRequest): Promise<SharedServerRemovalPlan | { none: true } | { blocked: string }> {
  try {
    const scope = scopeOf(request);
    const users = recordedOn(scope, request.recorded);
    if (users.length) return { blocked: stillRecorded(users) };
    const listed = await request.cloud.listServers(scope.gcpProjectId);
    if (listed.state === 'unknown') return { blocked: listed.reason };
    const found = findSharedServer(listed.servers, scope);
    if (found.state === 'unclear') return { blocked: found.reason };
    if (found.state === 'absent') return { none: true };
    const { instanceName } = found.server;
    const only = 'It is changed only if its own list shows no database on it at that moment; otherwise nothing happens.';
    const step = (name: SharedDatabaseStep, server: ReviewedServerPlan, type: 'update' | 'destroy', reason: string): SharedServerRemovalPlan => ({
      instanceName, reviewed: { instanceName, server } satisfies Reviewed,
      action: { id: `shared-database:${name}`, type, resource, verified: true, requiresConfirm: true, ...(type === 'destroy' ? { dataBearing: true } : {}), reason, metadata: serverMetadata(scope, name, instanceName) },
    });
    // Google refuses to delete a protected server, so removal is two reviewed steps: protection off, then delete.
    if (!found.server.deletionProtection) {
      const removal = await planServerChange(request, scope, instanceName, 'delete');
      if (removal) return step('remove-server', removal, 'destroy', `Delete ${request.project.name}'s shared database server (${instanceName}) and its backups. ${only} This cannot be undone.`);
    }
    // Either still protected, or saved state lost track of the server (an interrupted create): the first step puts both right.
    const prepare = await planServerChange(request, scope, instanceName, 'unprotect').catch(async (error: unknown) => {
      if (!(error instanceof Stop)) throw error;
      return planServerChange(request, scope, instanceName, 'take-over');
    });
    if (!prepare) return { blocked: 'The engine found nothing to change on the shared database server, yet could not plan its deletion. Run the removal again.' };
    return step('unprotect-server', prepare, 'update', `Turn off deletion protection on ${request.project.name}'s shared database server (${instanceName}) so it can be deleted in a second step. ${only}`);
  } catch (error) {
    if (error instanceof Stop) return { blocked: error.result.message };
    throw error;
  }
}

type Applying = Pick<SharedDatabaseApplyRequest, 'action' | 'reviewed' | 'project' | 'gcpProjectId' | 'region' | 'engine' | 'cloud'>
  & Partial<Pick<SharedDatabaseApplyRequest, 'environment' | 'binding' | 'record' | 'runningSecretVersions' | 'secret' | 'ownDatabasePause'>>;

async function run(request: Applying, serverSteps: boolean): Promise<ActionResult> {
  const metadata = request.action.metadata as unknown as StepMetadata | undefined;
  const reviewed = request.reviewed as Reviewed | undefined;
  const scope = scopeOf(request);
  const removal = metadata?.step === 'unprotect-server' || metadata?.step === 'remove-server';
  if (metadata?.operation !== SHARED_DATABASE_OPERATION || metadata.gcpProjectId !== scope.gcpProjectId || metadata.region !== scope.region
    || !reviewed || typeof reviewed !== 'object' || reviewed.instanceName !== metadata.instanceName || removal !== serverSteps) {
    return { success: false, status: 'blocked', message: 'The shared database target changed since this plan. Run hv_plan again.' };
  }
  // Where a login is published is decided now, from the environment itself. A saved action that names another secret or owner is refused.
  if (metadata.secretId !== undefined || metadata.labels !== undefined) {
    if (!request.secret || metadata.secretId !== request.secret.id || !isDeepStrictEqual(metadata.labels, request.secret.labels)) {
      return { success: false, status: 'blocked', message: 'The secret this plan would publish to is not this environment\'s own. Nothing was changed. Run hv_plan again.' };
    }
    metadata.secretId = request.secret.id;
    metadata.labels = request.secret.labels;
  }
  const record = request.binding?.database;
  const moveContext = (): MoveStepContext => ({ cloud: request.cloud, scope, environment: request.environment ?? { id: '', name: '' }, binding: request.binding, secret: request.secret ?? { id: '', labels: {} },
    runningSecretVersions: request.runningSecretVersions ?? (async () => ({ blocked: 'No workloads to check.' })), metadata, record: request.record ?? (() => {}) });
  const onShared = gcpDatabaseOnSharedServer(request.binding);
  if (metadata.step === 'switch') return settled(() => (onShared ? applySwitch(moveContext()) : applySwitchToShared({ ...moveContext(), ownPause: request.ownDatabasePause })));
  if (record && !onShared && record.movedFrom === undefined) {
    // An environment with a server of its own: the only steps for it here make its database on the shared server, noted beside its own record.
    if (!['server', 'allocate'].includes(metadata.step) || metadata.own?.instanceName !== record.instanceName) {
      return { success: false, status: 'blocked', message: 'This environment\'s database is on a server of its own. Nothing was changed. Run hv_plan again.' };
    }
    const save = request.record;
    request = { ...request, binding: record.moveTo !== undefined ? { database: record.moveTo as NonNullable<GcpDatabaseBinding['database']> } : undefined,
      record: (made) => save?.({ instanceName: record.instanceName, ...(made ? { moveTo: made } : {}) }) };
  }
  if (onShared && record?.movedFrom !== undefined) {
    // Just arrived from a server of its own: until that server is gone, the only step is the look before it is touched.
    if (metadata.step !== 'confirm-moved') return { success: false, status: 'blocked', message: 'This environment\'s database was just moved onto the shared server. Nothing was changed. Run hv_plan again.' };
    return settled(async () => {
      const { movedFrom: _left, ...arrived } = record;
      const identity = tenantFor(request.environment ?? { id: '', name: '' }, { database: arrived });
      const credential = credentialState(await request.cloud.observeConnectionSecret(scope.gcpProjectId, request.secret?.id ?? ''),
        { secretId: request.secret?.id ?? '', environmentLabel: request.secret?.labels['hv-environment'] ?? '', instanceName: arrived.instanceName, names: identity.names });
      return confirmMoved(moveContext(), credential.ready ? credential.latestVersion : undefined);
    });
  }
  if (metadata.step === 'confirm-moved') return { success: false, status: 'blocked', message: 'The shared database target changed since this plan. Run hv_plan again.' };
  // While a database is being moved, the move's own step is the only one that may touch it.
  if (record?.move !== undefined) return { success: false, status: 'blocked', message: 'This environment\'s database is being moved to a server of its own. Nothing was changed. Run hv_plan again.' };
  if (record?.movedFrom !== undefined && !gcpDatabaseOnSharedServer(request.binding)) {
    // The only step left for a database that was moved away is deleting what it left behind.
    if (metadata.step !== 'release') return { success: false, status: 'blocked', message: 'The shared database target changed since this plan. Run hv_plan again.' };
    const target = await settled(async () => ({ success: true, message: '', data: await cleanupTarget(moveContext()) }));
    if (!target.success) return target;
    const { binding, record: forget } = target.data as Awaited<ReturnType<typeof cleanupTarget>>;
    request = { ...request, binding, record: forget };
  }
  return runStep({ cloud: request.cloud, engine: request.engine, scope, environment: request.environment ?? { id: '', name: '' }, binding: request.binding,
    record: request.record ?? (() => {}), runningSecretVersions: request.runningSecretVersions ?? (async () => ({ blocked: 'No workloads to check.' })),
    metadata, ...(reviewed.server ? { server: reviewed.server } : {}) });
}

const pauseContext = (request: SharedDatabasePauseRequest) => ({ cloud: request.cloud, scope: scopeOf(request), environment: request.environment, binding: request.binding, secret: request.secret });

export const sharedDatabase: SharedDatabaseEntry = {
  plan,
  handles: (action) => action.metadata?.operation === SHARED_DATABASE_OPERATION,
  // An environment's plan can never carry a step that removes the server, and the removal can never carry an environment's.
  async apply(request) {
    const result = await run(request, false);
    const metadata = request.action.metadata as unknown as StepMetadata;
    // The last database is gone and the server is not: say so, with the one call that removes it.
    if (result.success && metadata.step === 'release' && request.others && !recordedOn(scopeOf(request), request.others).length) {
      return { ...result, message: `${result.message} No other environment of ${request.project.name} is recorded on that server; it is still running and still billed. To remove it: ${sharedServerRemovalCall(request.project.name)}.` };
    }
    return result;
  },
  planServerRemoval,
  pause: (request) => pauseDatabase(pauseContext(request)),
  resume: (request) => resumeDatabase(pauseContext(request)),
  async applyServerRemoval(request) {
    const users = recordedOn(scopeOf(request), request.recorded);
    return users.length ? { success: false, status: 'blocked', message: stillRecorded(users) } : run(request, true);
  },
};
