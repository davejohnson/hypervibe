import { isDeepStrictEqual } from 'node:util';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Project } from '../entities/project.entity.js';
import type { Component } from '../entities/component.entity.js';
import type { ProjectSpec, EnvironmentSpec } from '../spec/spec.schema.js';
import type { EnvironmentPlan, PlanOptions } from '../plan/plan.service.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { databaseFreshInitializationDiagnosticSchema, databaseFreshInitializationInspectionSchema, databaseFreshInitializationProgressSchema,
  databaseFreshInitializationResultStateSchema,
  type DatabaseFreshInitializationInspection } from '../ports/database-fresh-initialization.port.js';
import { databaseInitializationActionId, databaseInitializationAttemptSchema, databaseInitializationMetadataSchema,
  DATABASE_FRESH_INITIALIZATION_OPERATION, isDatabaseInitializationAction,
  type DatabaseInitializationAttempt } from '../plan/database-initialization.contract.js';
import { adapterFactory } from './adapter.factory.js';
import { bindingIdentityFingerprint, providerIdentityScopeMatches } from './binding-identity.js';
import { databaseCheckpointBindings } from './database-checkpoint.js';
import { recoveryIdentityStringSchema } from './recovery-source.js';
import { providerRegistry } from '../registry/provider.registry.js';

const components = new ComponentRepository();
const environments = new EnvironmentRepository();
class InitializationBlocked extends Error {}
const warning = 'This initializes empty database storage and restarts only the database. Existing ephemeral database contents are discarded. Application rollout, schema migrations, SQL access, backups and restore remain separate.';
function attempt(component: Component): DatabaseInitializationAttempt | undefined {
  return component.bindings.freshInitialization === undefined ? undefined
    : databaseInitializationAttemptSchema.parse(component.bindings.freshInitialization);
}
function bindingFingerprint(component: Component, prior?: DatabaseInitializationAttempt): string {
  const bindings = { ...component.bindings };
  delete bindings.freshInitialization;
  for (const [key, value] of Object.entries(prior?.storageBindings ?? {})) {
    if (!isDeepStrictEqual(bindings[key], value)) throw new InitializationBlocked('Recorded initialization storage bindings changed; preserve the original recovery record.');
    delete bindings[key];
  }
  return bindingIdentityFingerprint(bindings);
}
function load(project: Project, environmentName: string, spec: EnvironmentSpec) {
  const intent = spec.database?.freshInitialization;
  const environment = environments.findByProjectAndName(project.id, environmentName);
  const candidates = environment ? components.findByEnvironmentId(environment.id).filter(c => c.type === spec.database?.engine) : [];
  const component = candidates.length === 1 ? candidates[0] : undefined;
  if (!intent || !environment || !component?.externalId || component.externalId !== intent.target.externalId
    || component.bindings.provider !== spec.database!.provider || component.bindings.retainedCleanup
    || component.bindings.provisioningIncomplete || component.bindings.unresolvedMutation) {
    throw new InitializationBlocked('Fresh initialization requires its explicit discard intent and one exact existing database binding.');
  }
  const target = { provider: spec.database!.provider, ...intent.target };
  const keys = providerRegistry.get(target.provider)?.inspection?.selectors.database?.scopeKeys ?? [];
  if (!keys.length || keys.some(key => !target.providerScope[key]) || !providerIdentityScopeMatches({
    componentBindings: component.bindings, environmentBindings: environment.platformBindings,
    provider: target.provider, liveScope: target.providerScope,
  })) throw new InitializationBlocked('The declared initialization target does not match the durable database and environment scope.');
  // A consumed intent cannot preempt later maintenance, backups or migrations.
  // Callers still validate its exact intent and preserved storage receipt.
  if (attempt(component)?.progress.phase === 'complete') return { intent, environment, component, target };
  if (components.findByEnvironmentId(environment.id).some(c => c.bindings.credentialAliasRepair !== undefined
    || c.bindings.credentialRotation && (c.bindings.credentialRotation as { phase?: string }).phase !== 'installed')) {
    throw new InitializationBlocked('Recover pending database credential work before initializing storage.');
  }
  const checkpoints = databaseCheckpointBindings(component.bindings, environment.platformBindings);
  if (Object.values(checkpoints).some(value => value.state !== 'complete')
    || spec.database?.resilience?.checkpoint && checkpoints[spec.database.resilience.checkpoint.id]?.state !== 'complete') {
    throw new InitializationBlocked('Complete or explicitly resolve the outstanding database checkpoint before initializing storage.');
  }
  // Maintenance is removed only after verified exit; malformed retained state also vetoes writes.
  const migrationCandidates = environment.platformBindings.dataMigrationCandidates;
  if (spec.dataMigration || spec.maintenance?.enabled || environment.platformBindings.maintenance !== undefined
    || environment.platformBindings.previousDatabase !== undefined
    || components.findByEnvironmentId(environment.id).some(c => c.type.startsWith('data-migration:')
      || c.bindings.dataMigrationPreviousTarget !== undefined || c.bindings.previousProvider !== undefined)
    || migrationCandidates !== undefined && (typeof migrationCandidates !== 'object' || migrationCandidates === null
      || Array.isArray(migrationCandidates) || Object.keys(migrationCandidates).length > 0)) {
    throw new InitializationBlocked('Resolve environment data migration or maintenance before initializing database storage.');
  }
  for (const otherProject of new ProjectRepository().findAll()) for (const otherEnvironment of environments.findByProjectId(otherProject.id)) {
    for (const other of components.findByEnvironmentId(otherEnvironment.id)) {
      if (other.id === component.id || other.externalId !== component.externalId || other.bindings.provider !== target.provider) continue;
      const scope = other.bindings.providerScope;
      if (!scope || typeof scope !== 'object' || Array.isArray(scope)
        || keys.some(key => {
          const value = (scope as Record<string, unknown>)[key];
          const parsed = recoveryIdentityStringSchema.safeParse(value);
          return !parsed.success || parsed.data !== value;
        })
        || keys.every(key => (scope as Record<string, unknown>)[key] === target.providerScope[key])) {
        throw new InitializationBlocked('The exact database identity is shared or ambiguously bound to another environment.');
      }
    }
  }
  return { intent, environment, component, target };
}
function decrypted(value: string, target: ReturnType<typeof load>['target']): DatabaseFreshInitializationInspection {
  const result = databaseFreshInitializationInspectionSchema.parse(getSecretStore().decryptObject(value));
  if (!isDeepStrictEqual(result.target, target)) throw new InitializationBlocked('Private initialization evidence belongs to another database.');
  return result;
}

/** Isolated first-stage planning, before reference/backup prerequisites that require a volume. */
export async function planDatabaseFreshInitialization(params: { project: Project; spec: ProjectSpec; revision: number;
  environmentName: string; options?: PlanOptions }): Promise<EnvironmentPlan | { error: string } | null> {
  const spec = params.spec.environments[params.environmentName];
  const environment = environments.findByProjectAndName(params.project.id, params.environmentName);
  if (!spec) return null;
  if (!environment) return spec.database?.freshInitialization
    ? { error: 'Fresh initialization requires an existing bound environment; it cannot create one.' } : null;
  const existing = environment ? components.findByEnvironmentId(environment.id) : [];
  if (!spec?.database?.freshInitialization && !existing.some(c => c.bindings.freshInitialization !== undefined
    && !databaseInitializationAttemptSchema.safeParse(c.bindings.freshInitialization).success)) {
    const unfinished = existing.some(c => c.bindings.freshInitialization !== undefined
      && attempt(c)?.progress.phase !== 'complete');
    if (!unfinished) return null;
  }
  const actions: PlanAction[] = [];
  const blocked: EnvironmentPlan['blocked'] = [];
  let encrypted: string | undefined;
  try {
    if (params.options?.serviceFilter) throw new InitializationBlocked('A service-filtered plan cannot skip database initialization. Run hv_plan without services.');
    const current = load(params.project, params.environmentName, spec);
    const prior = attempt(current.component);
    if (prior && (prior.metadata.intentId !== current.intent.id || prior.metadata.componentId !== current.component.id
      || !isDeepStrictEqual(prior.metadata.target, current.target))) {
      throw new InitializationBlocked('A different initialization intent already owns this database. Preserve its original recovery record.');
    }
    if (prior?.progress.phase === 'complete') {
      bindingFingerprint(current.component, prior);
      return null;
    }
    const resolved = await adapterFactory.getDatabaseAdapter(current.target.provider, params.project);
    if (!resolved.success || resolved.adapter?.name !== current.target.provider || !resolved.adapter.freshInitialization) {
      throw new InitializationBlocked('This database provider does not implement explicit fresh initialization.');
    }
    let reviewed: DatabaseFreshInitializationInspection;
    if (prior) {
      encrypted = prior.inspectionEncrypted;
      reviewed = decrypted(encrypted, current.target);
      if (bindingFingerprint(current.component) !== prior.metadata.bindingsFingerprint
        || bindingIdentityFingerprint(current.environment.platformBindings) !== prior.metadata.environmentFingerprint) {
        throw new InitializationBlocked('The recorded initialization target configuration changed; preserve recovery evidence.');
      }
    } else {
      const observed = await resolved.adapter.freshInitialization.inspect(current);
      if (observed.state !== 'eligible') throw new InitializationBlocked(observed.reason);
      reviewed = databaseFreshInitializationInspectionSchema.parse(observed.inspection);
      if (!isDeepStrictEqual(reviewed.target, current.target)) throw new InitializationBlocked('Observed initialization scope does not match the exact declared target.');
      encrypted = getSecretStore().encryptObject(reviewed);
    }
    const metadata = prior?.metadata ?? { operation: DATABASE_FRESH_INITIALIZATION_OPERATION,
      componentId: current.component.id, intentId: current.intent.id, target: current.target,
      configurationFingerprint: reviewed.configurationFingerprint,
      bindingsFingerprint: bindingFingerprint(current.component),
      environmentFingerprint: bindingIdentityFingerprint(current.environment.platformBindings) };
    actions.push({ id: databaseInitializationActionId(current.component.id, current.intent.id), type: 'update',
      resource: { kind: 'database', name: 'postgres', provider: current.target.provider },
      verified: true, requiresConfirm: true, billable: true, dataBearing: true,
      reason: prior ? 'Resume verification of the exact database initialization attempt without repeating uncertain writes.'
        : 'Initialize new empty persistent storage on this existing database; discard its ephemeral contents and restart only this database.',
      metadata });
  } catch (error) {
    encrypted = undefined;
    blocked.push({ category: 'prerequisite', provider: spec?.database?.provider ?? 'hypervibe',
      reason: error instanceof InitializationBlocked ? error.message : 'The exact database initialization evidence is unavailable or invalid; no mutation is authorized.' });
  }
  const document = { kind: 'hv_plan', scope: 'database-initialization' as const, environmentName: params.environmentName,
    specRevision: params.revision, observedFingerprint: null, actions, warnings: [warning],
    ...(encrypted ? { overrides: { databaseInitializationEncrypted: encrypted } } : {}) };
  const runs = new RunRepository();
  const run = runs.create({ projectId: params.project.id, environmentId: environment.id, type: 'plan', plan: document });
  runs.updateStatus(run.id, 'succeeded');
  return { planRunId: run.id, scope: 'database-initialization', specRevision: params.revision,
    environmentName: params.environmentName, verified: blocked.length === 0, observed: null,
    actions, warnings: [warning], blocked, unmanaged: [], inputRequired: [] };
}

export async function applyDatabaseFreshInitialization(params: { project: Project; spec: EnvironmentSpec;
  environmentName: string; action: PlanAction; confirmed: ReadonlySet<string>; encrypted?: string }): Promise<ActionResult> {
  const stop = (message: string): ActionResult => ({ success: false, status: 'blocked', message });
  if (!isDatabaseInitializationAction(params.action) || !params.confirmed.has(params.action.id) || !params.encrypted) {
    return stop('Fresh initialization requires its exact reviewed action, encrypted evidence and confirmation.');
  }
  try {
    const metadata = databaseInitializationMetadataSchema.parse(params.action.metadata);
    let current = load(params.project, params.environmentName, params.spec);
    let prior = attempt(current.component);
    const reviewed = decrypted(params.encrypted, current.target);
    if (metadata.componentId !== current.component.id || metadata.intentId !== current.intent.id
      || !isDeepStrictEqual(metadata.target, current.target) || metadata.configurationFingerprint !== reviewed.configurationFingerprint
      || metadata.bindingsFingerprint !== bindingFingerprint(current.component, prior)
      || metadata.environmentFingerprint !== bindingIdentityFingerprint(current.environment.platformBindings)
      || prior && (!isDeepStrictEqual(prior.metadata, metadata)
        || !isDeepStrictEqual(decrypted(prior.inspectionEncrypted, current.target), reviewed))) {
      return stop('The reviewed database initialization identity or configuration changed. Re-plan without replacing recovery evidence.');
    }
    if (prior?.progress.phase === 'complete') return { success: true,
      message: 'The exact initialization is already recorded. Application and backup readiness remain separate.',
      data: { applied: 0, skipped: 1, providerMutations: 0 } };
    const resolved = await adapterFactory.getDatabaseAdapter(current.target.provider, params.project);
    if (!resolved.success || resolved.adapter?.name !== current.target.provider || !resolved.adapter.freshInitialization) {
      return stop('Explicit database initialization is unavailable for this provider.');
    }
    const initial: DatabaseInitializationAttempt = prior ?? { metadata, inspectionEncrypted: params.encrypted,
      startedAt: new Date().toISOString(), progress: { phase: 'prepared' } };
    if (!prior) {
      components.updateBindings(current.component.id, { freshInitialization: initial });
      prior = attempt(components.findById(current.component.id)!);
      if (!isDeepStrictEqual(prior, initial)) return stop('Initialization intent could not be persisted. No provider mutation is authorized.');
    }
    const order = ['prepared', 'configuration-attempted', 'configuration-verified', 'storage-attempted', 'storage-identified',
      'storage-verified', 'activation-attempted', 'activation-identified', 'complete'];
    const result = await resolved.adapter.freshInitialization.apply({ environment: current.environment, component: current.component,
      reviewed, progress: prior!.progress, saveProgress: async next => {
        const progress = databaseFreshInitializationProgressSchema.parse(next);
        const fresh = load(params.project, params.environmentName, params.spec);
        if (!isDeepStrictEqual(attempt(fresh.component), prior)
          || metadata.bindingsFingerprint !== bindingFingerprint(fresh.component)
          || metadata.environmentFingerprint !== bindingIdentityFingerprint(fresh.environment.platformBindings)
          || order.indexOf(progress.phase) < order.indexOf(prior!.progress.phase)
          || prior!.progress.storageId && progress.storageId !== prior!.progress.storageId
          || prior!.progress.storageInstanceId && progress.storageInstanceId !== prior!.progress.storageInstanceId
          || prior!.progress.deploymentId && progress.deploymentId !== prior!.progress.deploymentId) {
          throw new InitializationBlocked('Initialization identity or progress changed before mutation; preserve recovery evidence.');
        }
        // Completion is committed atomically with storage bindings after provider verification.
        if (progress.phase === 'complete') return;
        const nextAttempt = { ...prior!, progress };
        components.updateBindings(fresh.component.id, { freshInitialization: nextAttempt });
        const saved = attempt(components.findById(fresh.component.id)!);
        if (!isDeepStrictEqual(saved, nextAttempt)) throw new InitializationBlocked('Initialization progress could not be durably verified.');
        prior = saved;
      } });
    if (result.state !== 'complete') {
      // A provider acknowledgement can outlive a failed local progress write. Preserve
      // its exact non-secret IDs in the executor's durable receipt without changing a
      // drifted binding or authorizing another request. Recovery still fails closed.
      const acknowledged = databaseFreshInitializationProgressSchema.safeParse(result.progress);
      const progress = acknowledged.success ? acknowledged.data : undefined;
      const correlated = progress && progress.phase !== 'complete'
        && order.indexOf(progress.phase) >= order.indexOf(prior!.progress.phase)
        && (!prior!.progress.storageId || prior!.progress.storageId === progress.storageId)
        && (!prior!.progress.storageInstanceId || prior!.progress.storageInstanceId === progress.storageInstanceId)
        && (!prior!.progress.deploymentId || prior!.progress.deploymentId === progress.deploymentId);
      // Only bounded provider classifications cross the result boundary. Never
      // project the arbitrary reason or a diagnostic with unknown fields.
      const outcome = databaseFreshInitializationResultStateSchema.safeParse(result.state);
      const providerState = outcome.success && outcome.data !== 'complete' ? outcome.data : undefined;
      const diagnostic = databaseFreshInitializationDiagnosticSchema.safeParse(result.diagnostic);
      const data = { ...(providerState ? { providerState,
        ...(diagnostic.success ? { diagnostic: diagnostic.data } : {}) } : {}),
      ...(correlated && progress.storageId ? { intentId: metadata.intentId, target: metadata.target,
        acknowledgedProgress: progress, recoveryRequired: true } : {}) };
      return { ...stop('Database initialization is not verified. Preserve the attempt and its apply receipt; uncertain writes will not be repeated.'),
        ...(Object.keys(data).length ? { data } : {}) };
    }
    const progress = databaseFreshInitializationProgressSchema.parse(result.progress);
    current = load(params.project, params.environmentName, params.spec);
    if (progress.phase !== 'complete' || !result.storageBindings || !Object.keys(result.storageBindings).length
      || !isDeepStrictEqual(attempt(current.component), prior)
      || metadata.bindingsFingerprint !== bindingFingerprint(current.component)
      || metadata.environmentFingerprint !== bindingIdentityFingerprint(current.environment.platformBindings)
      || prior!.progress.storageId !== progress.storageId || prior!.progress.deploymentId !== progress.deploymentId
      || prior!.progress.storageInstanceId !== progress.storageInstanceId || prior!.progress.phase !== 'activation-identified'
      || Object.entries(result.storageBindings).some(([key, value]) => key === 'freshInitialization'
        || Object.hasOwn(current.component.bindings, key) && !isDeepStrictEqual(current.component.bindings[key], value))) {
      return stop('Database initialization completion or its exact storage bindings could not be verified. Preserve recovery state.');
    }
    const completed = { intentId: metadata.intentId, target: metadata.target, storageId: progress.storageId,
      storageInstanceId: progress.storageInstanceId, deploymentId: progress.deploymentId,
      ...(progress.activationReconciliation ? { activationReconciliation: progress.activationReconciliation } : {}),
      configurationFingerprint: metadata.configurationFingerprint, verifiedAt: new Date().toISOString() };
    const complete = databaseInitializationAttemptSchema.parse({ ...prior, progress, storageBindings: result.storageBindings, completed });
    components.updateBindings(current.component.id, { ...result.storageBindings, freshInitialization: complete });
    if (!isDeepStrictEqual(attempt(components.findById(current.component.id)!), complete)) return stop('Database initialization completion could not be persisted.');
    return { success: true, message: 'Initialized empty persistent database storage on the existing service. Application migrations, rollout, SQL access and backups remain unchecked.',
      data: { applied: 1, skipped: 0, databaseConfigurationVerified: true, applicationRollout: 'unchecked', sqlAccess: 'unchecked', backup: 'unchecked' } };
  } catch (error) {
    return stop(error instanceof InitializationBlocked ? error.message
      : 'Database initialization could not be verified. The exact attempt is retained; no automatic replacement or cleanup is authorized.');
  }
}
