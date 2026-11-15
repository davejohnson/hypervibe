import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { getDb } from '../../adapters/db/sqlite.adapter.js';
import type { Project } from '../entities/project.entity.js';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { EnvironmentPlan, PlanOptions } from '../plan/plan.service.js';
import type { ActionResult } from '../plan/converge.executor.js';
import type { PlanAction } from '../plan/plan.types.js';
import { databaseBootstrapActionId, databaseBootstrapActionSchema, databaseBootstrapBaseSchema,
  databaseBootstrapMetadataSchema, databaseBootstrapRecoverySchema,
  DATABASE_BOOTSTRAP_AUTHENTICATE_OPERATION, DATABASE_BOOTSTRAP_MIGRATE_OPERATION,
  type DatabaseBootstrapBase, type DatabaseBootstrapMetadata, type DatabaseBootstrapRecovery } from '../plan/database-bootstrap.contract.js';
import { completedDatabaseInitializationDeploymentId, getCompletedDatabaseInitializationReceipt } from '../plan/database-initialization.contract.js';
import { databaseTaskCheckpointSchema, type DatabaseTaskCheckpoint, type IHostingAdapter } from '../ports/hosting.port.js';
import { databaseInitializationBootstrapInspectionSchema, type DatabaseInitializationBootstrapInspection } from '../ports/database-initialization-bootstrap.port.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import { withMigrationReleaseCommand } from '../spec/spec-bootstrap.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { adapterFactory } from './adapter.factory.js';
import { bindingIdentityFingerprint } from './binding-identity.js';
import { recoveryIdentityStringSchema } from './recovery-source.js';
import { buildDatabaseInitializationCommand, DATABASE_INITIALIZATION_AUTH_COMMAND_HASH,
  type DatabaseInitializationRequest } from './database-initialization-program.js';

const components = new ComponentRepository(), environments = new EnvironmentRepository(), services = new ServiceRepository();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const warnings = ['Private task authentication proves that task connection only. Migration completion proves the reviewed command exited successfully; schema contents, application rollout, old-instance drainage and application operation remain unchecked.'];
class BootstrapBlocked extends Error {}
const stop = (message: string, data?: Record<string, unknown>): ActionResult => ({ success: false, status: 'blocked', message, ...(data ? { data } : {}) });
const declarationSchema = z.object({ intent: z.unknown(), hostingProvider: z.string(), databaseProvider: z.string(), service: z.string(), image: z.string(), command: z.string(),
  aliases: z.record(z.string(), z.enum(['DATABASE_URL', 'DIRECT_URL'])),
  approvedVariables: z.object({ NODE_ENV: z.enum(['production', 'development', 'test']).optional() }).strict() }).strict();
const reviewSchema = z.object({ version: z.literal(1), base: databaseBootstrapBaseSchema,
  declaration: declarationSchema, inspection: databaseInitializationBootstrapInspectionSchema,
  authenticationExecutionId: z.uuid(), migrationExecutionId: z.uuid() }).strict();
type Review = z.infer<typeof reviewSchema>;
const retained = (component: Component) => component.bindings.databaseBootstrap === undefined ? undefined
  : databaseBootstrapRecoverySchema.parse(component.bindings.databaseBootstrap);
const decrypt = (encrypted: string) => reviewSchema.parse(getSecretStore().decryptObject(encrypted));
const observationOrCleanupPending = (state?: DatabaseTaskCheckpoint) => state?.phase === 'deployed' || state?.phase === 'terminal' || state?.phase === 'cleanup-attempted';
const modeFor = (state: DatabaseBootstrapRecovery): 'authenticate' | 'migrate' => state.authenticationVerifiedAt ? 'migrate' : 'authenticate';
const checkpointFor = (state: DatabaseBootstrapRecovery, mode: 'authenticate' | 'migrate') => mode === 'authenticate' ? state.authentication : state.migration;

function declaration(spec: EnvironmentSpec) {
  const intent = spec.database?.freshInitialization;
  const bootstrap = intent?.bootstrap;
  if (!intent || !bootstrap) throw new BootstrapBlocked('The original fresh initialization bootstrap declaration is required.');
  const service = withMigrationReleaseCommand(spec).services[bootstrap.service];
  const command = service?.releaseCommand;
  if (!command?.trim()) throw new BootstrapBlocked('Bootstrap requires the selected service’s declared migration release command.');
  const nodeEnv = spec.envVars.NODE_ENV;
  if (nodeEnv !== undefined && !['production', 'development', 'test'].includes(nodeEnv)) throw new BootstrapBlocked('The declared application mode is unsupported for private bootstrap.');
  return declarationSchema.parse({ intent, hostingProvider: spec.hosting.provider, databaseProvider: spec.database!.provider,
    service: bootstrap.service, image: bootstrap.image, command,
    aliases: service.databaseEnvAliases ?? {}, approvedVariables: nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv } });
}
function local(project: Project, environmentName: string) {
  const environment = environments.findByProjectAndName(project.id, environmentName);
  const candidates = environment ? components.findByEnvironmentId(environment.id).filter(item => item.type === 'postgres') : [];
  if (!environment || candidates.length !== 1) throw new BootstrapBlocked('Bootstrap requires one exact initialized PostgreSQL component.');
  return { environment, component: candidates[0] };
}
function generation(current: { environment: Environment; component: Component }) {
  const completed = getCompletedDatabaseInitializationReceipt(current);
  if (!completed) throw new BootstrapBlocked('Complete and retain the exact fresh initialization receipt before private bootstrap.');
  return { completed, generationHash: bindingIdentityFingerprint(completed) };
}
function assertExclusiveDatabase(current: ReturnType<typeof local>, target: ReturnType<typeof generation>['completed']['target']) {
  const keys = providerRegistry.get(target.provider)?.inspection?.selectors.database?.scopeKeys ?? [];
  if (!keys.length) throw new BootstrapBlocked('The exact database ownership scope is unsupported.');
  for (const project of new ProjectRepository().findAll()) for (const environment of environments.findByProjectId(project.id)) {
    for (const other of components.findByEnvironmentId(environment.id)) {
      if (other.type !== 'postgres' || other.id === current.component.id || other.externalId !== target.externalId || other.bindings.provider !== target.provider) continue;
      const scope = other.bindings.providerScope;
      if (!scope || typeof scope !== 'object' || Array.isArray(scope)
        || keys.some(key => {
          const value = (scope as Record<string, unknown>)[key], parsed = recoveryIdentityStringSchema.safeParse(value);
          return !parsed.success || parsed.data !== value;
        }) || keys.every(key => (scope as Record<string, unknown>)[key] === target.providerScope[key])) {
        throw new BootstrapBlocked('The exact database identity is shared or ambiguously bound to another environment.');
      }
    }
  }
}
function environmentFingerprint(environment: Environment, service: string) {
  return bindingIdentityFingerprint({ provider: environment.platformBindings.provider,
    projectId: environment.platformBindings.projectId, environmentId: environment.platformBindings.environmentId,
    serviceId: record(record(environment.platformBindings.services)[service]).serviceId });
}
async function provider(project: Project, name: string, databaseProvider: string): Promise<IHostingAdapter> {
  const capability = providerRegistry.getMetadata(name)?.lifecycle?.hosting?.databaseInitializationTasks;
  if (!capability?.databaseProviders.includes(databaseProvider)) throw new BootstrapBlocked('Private bootstrap is unsupported for this hosting and database provider pair.');
  const resolved = await adapterFactory.getHostingAdapterByName(name, project);
  if (!resolved.success || resolved.adapter?.name !== name || !resolved.adapter.databaseInitialization || !resolved.adapter.runJob) {
    throw new BootstrapBlocked('The exact hosting provider has no supported private initialization capability.');
  }
  return resolved.adapter;
}
async function inspect(adapter: IHostingAdapter, current: ReturnType<typeof local>, desired: ReturnType<typeof declaration>) {
  const g = generation(current);
  assertExclusiveDatabase(current, g.completed.target);
  const observed = databaseInitializationBootstrapInspectionSchema.parse(await adapter.databaseInitialization!.inspect({
    environment: current.environment, completedInitialization: {
      target: g.completed.target, storageId: g.completed.storageId,
      storageInstanceId: g.completed.storageInstanceId, deploymentId: g.completed.deploymentId,
      ...(g.completed.activationReconciliation ? { activationReconciliation: g.completed.activationReconciliation } : {}),
    },
    sourceServiceName: desired.service, expectedImage: desired.image, databaseEnvAliases: desired.aliases, approvedVariables: desired.approvedVariables,
  }));
  if (observed.source.provider !== g.completed.target.provider || observed.source.primaryExternalId !== g.completed.target.externalId
    || !isDeepStrictEqual(observed.source.providerScope, g.completed.target.providerScope)
    || observed.databaseDeploymentId !== completedDatabaseInitializationDeploymentId(g.completed)
    || observed.image !== desired.image || observed.sourceServiceId !== record(record(current.environment.platformBindings.services)[desired.service]).serviceId
    || !isDeepStrictEqual(observed.approvedVariables, desired.approvedVariables)) throw new BootstrapBlocked('Private bootstrap observation changed the reviewed target.');
  return observed;
}
function baseFor(current: ReturnType<typeof local>, desired: ReturnType<typeof declaration>, observed: DatabaseInitializationBootstrapInspection): DatabaseBootstrapBase {
  const g = generation(current);
  return databaseBootstrapBaseSchema.parse({ componentId: current.component.id, generationHash: g.generationHash, intentId: g.completed.intentId,
    hostingProvider: desired.hostingProvider,
    service: desired.service, image: desired.image, migrationCommandHash: hash(desired.command), source: observed.source,
    databaseDeploymentId: observed.databaseDeploymentId, sourceServiceId: observed.sourceServiceId, sourceInstanceId: observed.sourceInstanceId,
    environmentFingerprint: environmentFingerprint(current.environment, desired.service), variableReferences: observed.variableReferences,
    approvedVariables: observed.approvedVariables });
}
function sameDeclaration(current: ReturnType<typeof local>, spec: EnvironmentSpec, review: Review) {
  return isDeepStrictEqual(declaration(spec), review.declaration) && generation(current).generationHash === review.base.generationHash
    && current.component.id === review.base.componentId
    && environmentFingerprint(current.environment, review.base.service) === review.base.environmentFingerprint;
}
function metadata(review: Review, mode: 'authenticate' | 'migrate'): DatabaseBootstrapMetadata {
  return databaseBootstrapMetadataSchema.parse({ ...review.base, mode,
    operation: mode === 'authenticate' ? DATABASE_BOOTSTRAP_AUTHENTICATE_OPERATION : DATABASE_BOOTSTRAP_MIGRATE_OPERATION,
    executionId: mode === 'authenticate' ? review.authenticationExecutionId : review.migrationExecutionId,
    commandHash: mode === 'authenticate' ? DATABASE_INITIALIZATION_AUTH_COMMAND_HASH : review.base.migrationCommandHash });
}
function persist(componentId: string, state: DatabaseBootstrapRecovery, expected?: DatabaseBootstrapRecovery): DatabaseBootstrapRecovery {
  const valid = databaseBootstrapRecoverySchema.parse(state);
  getDb().transaction(() => {
    if (!isDeepStrictEqual(retained(components.findById(componentId)!), expected)) throw new BootstrapBlocked('Bootstrap recovery changed before persistence.');
    components.updateBindings(componentId, { databaseBootstrap: valid });
  }).immediate();
  const result = retained(components.findById(componentId)!);
  if (!isDeepStrictEqual(result, valid)) throw new BootstrapBlocked('Bootstrap recovery state could not be durably verified.');
  return result!;
}
function advancingCheckpoint(before: DatabaseTaskCheckpoint | undefined, next: DatabaseTaskCheckpoint) {
  const phases = ['create-attempted', 'created', 'configure-attempted', 'configured', 'deploy-attempted', 'deployed', 'terminal', 'cleanup-attempted', 'complete'];
  if (!before) return next.phase === 'create-attempted';
  if (next.authorityHash !== before.authorityHash
    || (['taskServiceId', 'taskInstanceId', 'deploymentId', 'terminal'] as const).some(key => before[key] !== undefined && !isDeepStrictEqual(before[key], next[key]))) return false;
  const distance = phases.indexOf(next.phase) - phases.indexOf(before.phase);
  return distance === 1 || distance === 0 && (isDeepStrictEqual(before, next)
    || before.phase === 'created' && !before.taskInstanceId && Boolean(next.taskInstanceId)
      && isDeepStrictEqual({ ...before, taskInstanceId: next.taskInstanceId }, next));
}

export async function planDatabaseBootstrap(params: { project: Project; spec: ProjectSpec; revision: number;
  environmentName: string; options?: PlanOptions }): Promise<EnvironmentPlan | { error: string } | null> {
  const spec = params.spec.environments[params.environmentName];
  const environment = environments.findByProjectAndName(params.project.id, params.environmentName);
  const existing = environment ? components.findByEnvironmentId(environment.id).filter(item => item.type === 'postgres') : [];
  if (!spec?.database?.freshInitialization?.bootstrap && !existing.some(item => item.bindings.databaseBootstrap !== undefined)) return null;
  if (!environment) return { error: 'Private bootstrap requires an existing initialized database environment.' };
  let encrypted: string | undefined;
  const actions: PlanAction[] = [], blocked: EnvironmentPlan['blocked'] = [];
  try {
    if (params.options?.serviceFilter !== undefined || params.options?.envVarOverrides !== undefined || params.options?.envFile !== undefined
      || params.options?.secretRefs !== undefined || params.options?.includeEnvFile === true) throw new BootstrapBlocked('Private bootstrap accepts no deployment, dotenv, service or secret overrides.');
    const current = local(params.project, params.environmentName), state = retained(current.component);
    let review: Review, mode: 'authenticate' | 'migrate';
    if (state) {
      review = decrypt(state.inspectionEncrypted); encrypted = state.inspectionEncrypted; mode = modeFor(state);
      if (!isDeepStrictEqual(state.base, review.base) || state.authenticationExecutionId !== review.authenticationExecutionId
        || state.migrationExecutionId !== review.migrationExecutionId) throw new BootstrapBlocked('The original bootstrap review is inconsistent; it was preserved.');
      if (state.consumedAt) {
        if (generation(current).generationHash !== review.base.generationHash) throw new BootstrapBlocked('The consumed bootstrap belongs to another initialization generation.');
        return null;
      }
      const checkpoint = checkpointFor(state, mode);
      if (!observationOrCleanupPending(checkpoint)) {
        if (!sameDeclaration(current, spec, review)) throw new BootstrapBlocked('The bootstrap generation, command or declaration changed; the original execution cannot be reused.');
        if (checkpoint?.phase === 'complete' && checkpoint.terminal?.status === 'failed') throw new BootstrapBlocked('This bootstrap execution failed and cannot be automatically repeated.');
        const adapter = await provider(params.project, review.base.hostingProvider, review.base.source.provider);
        if (!isDeepStrictEqual(await inspect(adapter, current, review.declaration), review.inspection)) throw new BootstrapBlocked('The exact private configuration changed; the original execution was preserved.');
      }
    } else {
      const desired = declaration(spec);
      const adapter = await provider(params.project, spec.hosting.provider, spec.database!.provider);
      const observed = await inspect(adapter, current, desired);
      review = { version: 1, base: baseFor(current, desired, observed), declaration: desired, inspection: observed,
        authenticationExecutionId: randomUUID(), migrationExecutionId: randomUUID() };
      encrypted = getSecretStore().encryptObject(review); mode = 'authenticate';
    }
    const m = metadata(review, mode);
    actions.push({ id: databaseBootstrapActionId(m), type: 'update', resource: { kind: 'database', name: 'postgres', provider: m.source.provider },
      verified: true, requiresConfirm: true, billable: true, dataBearing: mode === 'migrate',
      reason: mode === 'authenticate' ? 'Run and clean up one private fresh-authentication task for the reviewed initialized database.'
        : 'Run and clean up the exact reviewed migration command against the authenticated initialization generation.', metadata: m });
  } catch (error) {
    encrypted = undefined; actions.length = 0;
    blocked.push({ category: 'prerequisite', provider: spec?.hosting.provider ?? 'unknown',
      reason: error instanceof BootstrapBlocked ? error.message : 'Private bootstrap evidence or recovery state could not be verified.' });
  }
  const document = { kind: 'hv_plan', scope: 'database-bootstrap', environmentName: params.environmentName, specRevision: params.revision,
    observedFingerprint: null, databaseBootstrapReady: blocked.length === 0, actions, warnings,
    ...(encrypted ? { overrides: { databaseBootstrapEncrypted: encrypted } } : {}) };
  const runs = new RunRepository(); const run = runs.create({ projectId: params.project.id, environmentId: environment.id, type: 'plan', plan: document });
  runs.updateStatus(run.id, 'succeeded');
  return { planRunId: run.id, scope: 'database-bootstrap', environmentName: params.environmentName, specRevision: params.revision,
    verified: blocked.length === 0, observed: null, actions, warnings, blocked, unmanaged: [], inputRequired: [] };
}

export async function applyDatabaseBootstrap(params: { project: Project; spec: EnvironmentSpec; environmentName: string;
  action: PlanAction; confirmed: ReadonlySet<string>; encrypted?: string }): Promise<ActionResult> {
  const parsed = databaseBootstrapActionSchema.safeParse(params.action);
  if (!parsed.success || !params.confirmed.has(params.action.id) || !params.encrypted) return stop('Bootstrap requires its exact confirmed action and encrypted review.');
  try {
    const m = parsed.data.metadata, review = decrypt(params.encrypted);
    if (!isDeepStrictEqual(m, metadata(review, m.mode))) return stop('Bootstrap action differs from its encrypted review.');
    const current = local(params.project, params.environmentName);
    if (current.component.id !== m.componentId) return stop('The reviewed bootstrap component no longer matches.');
    let state = retained(current.component);
    if (state && (!isDeepStrictEqual(state.base, review.base) || !isDeepStrictEqual(decrypt(state.inspectionEncrypted), review)
      || state.authenticationExecutionId !== review.authenticationExecutionId || state.migrationExecutionId !== review.migrationExecutionId)) return stop('The original bootstrap recovery record changed; it was preserved.');
    if (state?.consumedAt) return generation(current).generationHash === m.generationHash
      ? { success: true, message: 'This exact bootstrap generation is already consumed; no task was repeated.', data: { providerMutations: 0 } }
      : stop('The original bootstrap authorization belongs to another initialization generation.');
    const checkpoint = state && checkpointFor(state, m.mode), recovering = observationOrCleanupPending(checkpoint);
    if (!recovering && !sameDeclaration(current, params.spec, review)) return stop('The bootstrap declaration or initialized generation changed; execution is blocked.');
    if (m.mode === 'migrate' && !state?.authenticationVerifiedAt) return stop('Complete separate fresh authentication before confirming migration.');
    if (checkpoint?.phase === 'complete' && checkpoint.terminal?.status === 'failed') return stop('The retained bootstrap execution failed; automatic replay is blocked.');
    const adapter = await provider(params.project, m.hostingProvider, m.source.provider);
    if (!recovering && !isDeepStrictEqual(await inspect(adapter, current, review.declaration), review.inspection)) return stop('Private bootstrap configuration changed; no task is authorized.');
    const service = services.findByProjectAndName(params.project.id, m.service);
    if (!service) return stop('The exact bootstrap service is no longer tracked.');
    if (!state) state = persist(current.component.id, { version: 1, base: review.base, inspectionEncrypted: params.encrypted,
      authenticationExecutionId: review.authenticationExecutionId, migrationExecutionId: review.migrationExecutionId });
    const configuration = review.inspection.privateConfiguration;
    const request: DatabaseInitializationRequest = { version: 1, executionId: m.executionId, mode: m.mode, commandHash: m.commandHash,
      keys: configuration.keys, expectedHashes: configuration.expectedHashes, authentication: configuration.authentication,
      ...(m.mode === 'migrate' ? { migration: { command: review.declaration.command, timeoutMs: 120_000 } } : {}) };
    // Observation and cleanup retain their original native scope if today's application
    // binding moved. This snapshot is never persisted as current desired state.
    const taskEnvironment = recovering ? { ...current.environment, platformBindings: { provider: m.hostingProvider,
      ...m.source.providerScope, services: { [m.service]: { serviceId: m.sourceServiceId } } } } : current.environment;
    const result = await adapter.runJob!(taskEnvironment, service, buildDatabaseInitializationCommand(), { gitRemoteUrl: params.project.gitRemoteUrl,
      declaredTask: { variableMode: 'references', sweep: false, expectedImage: m.image, executionId: m.executionId,
        databaseTask: { mode: m.mode, source: m.source, variableReferences: m.variableReferences, commandHash: m.commandHash,
          approvedVariables: m.approvedVariables, privateConfiguration: JSON.stringify(request), state: checkpoint,
          persist: async next => {
            const latest = retained(components.findById(current.component.id)!);
            if (!latest || !isDeepStrictEqual(latest, state)) throw new BootstrapBlocked('Bootstrap recovery changed during execution.');
            const valid = databaseTaskCheckpointSchema.parse(next);
            if (!advancingCheckpoint(checkpointFor(latest, m.mode), valid)) throw new BootstrapBlocked('The private task checkpoint attempted to change or rewind its acknowledged identity.');
            state = persist(current.component.id, { ...latest, [m.mode === 'authenticate' ? 'authentication' : 'migration']: valid }, latest);
            return checkpointFor(state, m.mode)!;
          } } } });
    const acknowledgement = databaseTaskCheckpointSchema.safeParse(result.receipt.data?.databaseTaskAcknowledgement);
    const durableCheckpoint = state && checkpointFor(state, m.mode);
    if (result.receipt.data?.recoveryRequired === true && (!result.receipt.success || result.status !== 'completed')
      && acknowledgement.success && acknowledgement.data.taskServiceId && state
      && advancingCheckpoint(durableCheckpoint, acknowledgement.data)
      && databaseBootstrapRecoverySchema.safeParse({ ...state,
        [m.mode === 'authenticate' ? 'authentication' : 'migration']: acknowledgement.data }).success) {
      // Acknowledged provider IDs can survive a failed local write. Retain them
      // in the apply receipt only: they do not authorize adoption or another task.
      return stop('The provider acknowledged this task but its journal could not be verified. Preserve this apply receipt; recovery is required before any replay.', {
        executionId: m.executionId, mode: m.mode, source: m.source,
        databaseTaskAcknowledgement: acknowledgement.data, recoveryRequired: true,
        authentication: 'unknown', migration: 'unchecked', cleanupVerified: false,
        deployedConfiguration: 'unchecked', applicationOperation: 'unchecked',
      });
    }
    const durable = retained(components.findById(current.component.id)!)!;
    const terminal = checkpointFor(durable, m.mode);
    const data = { authentication: terminal?.terminal?.result?.authentication ?? 'unknown',
      migration: terminal?.terminal?.result?.migration ?? 'unchecked', cleanupVerified: terminal?.phase === 'complete',
      deployedConfiguration: 'unchecked', applicationOperation: 'unchecked' };
    if (terminal?.phase !== 'complete') return { success: false, status: 'pending', message: 'The exact private task execution or owned cleanup remains pending.', data };
    if (!result.receipt.success || result.status !== 'completed' || result.exitCode !== 0 || result.receipt.data?.cleanupVerified !== true
      || terminal.terminal?.status !== 'succeeded') return stop('The retained private task did not succeed; it will not be automatically repeated.', data);
    let currentProof = false;
    try {
      const after = local(params.project, params.environmentName);
      currentProof = sameDeclaration(after, params.spec, review)
        && isDeepStrictEqual(await inspect(adapter, after, review.declaration), review.inspection);
    } catch { /* Unknown current evidence never erases the finite task/cleanup result. */ }
    if (!currentProof) return stop('The task receipt and cleanup are retained, but current database configuration changed or is unknown; bootstrap completion is blocked.', data);
    persist(current.component.id, { ...durable, ...(m.mode === 'authenticate'
      ? { authenticationVerifiedAt: new Date().toISOString() } : { consumedAt: new Date().toISOString() }) }, durable);
    return { success: true, message: m.mode === 'authenticate' ? 'Fresh private task authentication and cleanup are verified. Migration requires its separate confirmed plan.'
      : 'The exact reviewed migration command exited successfully and its task was removed. Schema contents and application operation remain unchecked.', data };
  } catch (error) {
    return stop(error instanceof BootstrapBlocked ? error.message : 'Private bootstrap verification failed; retained execution state was preserved.');
  }
}
