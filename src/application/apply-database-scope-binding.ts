import { isDeepStrictEqual } from 'node:util';
import type { Project } from '../domain/entities/project.entity.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { BackupPolicyContext } from '../domain/services/backup-policy.service.js';
import { bindingIdentityFingerprint, providerIdentityScopeMatches } from '../domain/services/binding-identity.js';
import { currentDatabaseScopeComponent, databaseScopeBindingMetadataSchema,
  databaseScopeBindingsFingerprint, isDatabaseScopeBindingAction, observeDatabaseBindingSource,
  observeDatabaseRuntimeReference, primaryDatabaseRecordState, DATABASE_PROVISION_RECOVERY_OPERATION, DATABASE_PROVISION_CANDIDATE_OPERATION,
  databaseProvisionRecoveryMetadataSchema, isDatabaseProvisionRecoveryAction,
  currentDatabaseProvisionRecoveryComponent, observeDatabaseProvisionRecovery,
  provisionRecoveryComponentFingerprint } from '../domain/services/database-scope-binding.service.js';
import { recoverySourceIdentityMatches } from '../domain/services/recovery-source.js';
import type { CommandContext } from './context.js';
import { SpecStore } from '../domain/spec/spec.store.js';

const blocked = (message: string, applied = 0): ActionResult => ({ success: false, status: 'blocked', message,
  data: { applied, skipped: 0, providerMutations: 0 } });

export async function applyDatabaseScopeBinding(params: {
  ctx: CommandContext; project: Project; environmentName: string; environmentSpec: EnvironmentSpec;
  action: PlanAction; confirmedActionIds: ReadonlySet<string>; specRevision?: number;
}): Promise<ActionResult> {
  const { ctx, project, environmentName, environmentSpec, action } = params;
  if (action.metadata?.operation === DATABASE_PROVISION_RECOVERY_OPERATION
    || action.metadata?.operation === DATABASE_PROVISION_CANDIDATE_OPERATION) return applyDatabaseProvisionRecovery(params);
  const parsed = databaseScopeBindingMetadataSchema.safeParse(action.metadata);
  if (!parsed.success || !isDatabaseScopeBindingAction(action) || !params.confirmedActionIds.has(action.id)) {
    return blocked('Database scope repair requires its exact reviewed action and confirmation. Re-run hv_plan.');
  }
  const reviewed = parsed.data;
  const load = () => {
    const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
    const context: BackupPolicyContext = { project, spec: environmentSpec, environment,
      components: environment ? ctx.repos.components.findByEnvironmentId(environment.id) : [], adapterFactory: ctx.adapterFactory };
    const component = currentDatabaseScopeComponent(context);
    if (!component || component.id !== reviewed.componentId || component.type !== action.resource.name
      || component.bindings.provider !== reviewed.source.provider || component.externalId !== reviewed.source.primaryExternalId) return undefined;
    const scopePresent = Object.hasOwn(component.bindings, 'providerScope');
    const alreadyBound = scopePresent && isDeepStrictEqual(component.bindings.providerScope, reviewed.source.providerScope);
    if (reviewed.priorProviderScope) {
      if (!alreadyBound && !isDeepStrictEqual(component.bindings.providerScope, reviewed.priorProviderScope)) return undefined;
      if (!Object.entries(reviewed.priorProviderScope).every(([key, value]) => reviewed.source.providerScope[key] === value)) return undefined;
    } else if (scopePresent && !alreadyBound) return undefined;
    const referenceRecorded = Object.hasOwn(component.bindings, 'directUrlVariable');
    if (reviewed.runtimeReference && referenceRecorded
      && component.bindings.directUrlVariable !== reviewed.runtimeReference.directUrlVariable) return undefined;
    if (databaseScopeBindingsFingerprint(component.bindings, Boolean(reviewed.runtimeReference)) !== reviewed.bindingsFingerprint) return undefined;
    return { context, component, alreadyBound, referenceRecorded };
  };
  let current = load();
  if (!current) return blocked('The reviewed database identity or its binding metadata changed. Re-run hv_plan.');
  const environmentFingerprint = bindingIdentityFingerprint(current.context.environment!.platformBindings);
  const source = await observeDatabaseBindingSource(current.context, current.component);
  if (!source || !recoverySourceIdentityMatches(source, reviewed.source)) {
    return blocked('The exact reviewed database recovery source could not be re-observed. No binding changed; re-run hv_plan.');
  }
  if (reviewed.runtimeReference) {
    const reference = await observeDatabaseRuntimeReference(current.context, current.component);
    if (reference.state !== 'known' || !isDeepStrictEqual(reference.reference, reviewed.runtimeReference)) {
      return blocked('The reviewed database runtime URL variable could not be re-observed. No binding changed; re-run hv_plan.');
    }
  }
  // Re-load after the network boundary, preserving credentials and recovery
  // evidence written while the read was in flight. Only absent reviewed fields are merged.
  current = load();
  if (!current || bindingIdentityFingerprint(current.context.environment!.platformBindings) !== environmentFingerprint
    || !providerIdentityScopeMatches({ componentBindings: current.component.bindings,
      environmentBindings: current.context.environment!.platformBindings, provider: source.provider,
      liveScope: source.providerScope })) return blocked('Database or environment bindings changed during source observation. Re-run hv_plan.');
  const environmentId = current.component.environmentId;
  const primaryState = primaryDatabaseRecordState(current.context.environment!.platformBindings, current.component);
  if (primaryState === 'conflict') {
    return blocked('The committed primary database identity names a different database. It was left unchanged; review databaseTopology.primary in .hypervibe/bindings.json.');
  }
  let applied = 0;
  let recordedPrimary = false;
  try {
    // Record the environment identity first: the component write below also
    // exports the repository bindings, so a failed export is retried as export-only.
    if (primaryState === 'missing') {
      // Record only the exact re-observed identity; never replace another record.
      const topology = current.context.environment!.platformBindings.databaseTopology as Record<string, unknown> | undefined;
      const replicas = topology?.replicas && typeof topology.replicas === 'object' ? topology.replicas : {};
      ctx.repos.environments.updatePlatformBindings(environmentId, { databaseTopology: {
        primary: { provider: reviewed.source.provider, externalId: reviewed.source.primaryExternalId }, replicas } });
      recordedPrimary = true;
      applied = 1;
    }
    if (!current.alreadyBound || (reviewed.runtimeReference && !current.referenceRecorded)) {
      const patch = { ...(!current.alreadyBound ? { providerScope: reviewed.source.providerScope } : {}),
        ...(reviewed.runtimeReference && !current.referenceRecorded ? { directUrlVariable: reviewed.runtimeReference.directUrlVariable } : {}) };
      const saved = ctx.repos.components.updateBindings(current.component.id, patch);
      if (!saved || !isDeepStrictEqual(saved.bindings.providerScope, reviewed.source.providerScope)
        || (reviewed.runtimeReference && saved.bindings.directUrlVariable !== reviewed.runtimeReference.directUrlVariable)) {
        return blocked('The database scope write could not be verified. Re-run hv_plan to inspect the current binding.', applied);
      }
      applied = 1;
    }
    // A prior SQLite write may have succeeded before repository export failed.
    ctx.repos.environments.syncRepoBindingsForId(environmentId);
  } catch {
    const saved = ctx.repos.components.findById(current.component.id);
    const scopeSaved = !current.alreadyBound && isDeepStrictEqual(saved?.bindings.providerScope, reviewed.source.providerScope);
    const referenceSaved = Boolean(reviewed.runtimeReference && !current.referenceRecorded
      && saved?.bindings.directUrlVariable === reviewed.runtimeReference.directUrlVariable);
    return blocked('Database binding persistence or repository export could not be completed. The exact local identity is retained; retry this reviewed action to verify and export it.',
      scopeSaved || referenceSaved || recordedPrimary ? 1 : 0);
  }
  if (!applied) return { success: true, message: 'The reviewed database recovery scope and identity are already recorded.',
    data: { applied: 0, skipped: 1, providerMutations: 0 } };
  return { success: true, message: reviewed.runtimeReference
    ? 'Recorded the existing database runtime URL variable without changing provider resources.'
    : primaryState === 'missing'
    ? 'Recorded the existing database identity in .hypervibe/bindings.json. Backup completion and restore remain unchecked.'
    : 'Recorded the existing database recovery scope. Backup completion and restore remain unchecked.',
    data: { applied: 1, skipped: 0, providerMutations: 0 } };
}

async function applyDatabaseProvisionRecovery(params: Parameters<typeof applyDatabaseScopeBinding>[0]): Promise<ActionResult> {
  const { ctx, project, environmentName, environmentSpec, action } = params;
  const parsed = databaseProvisionRecoveryMetadataSchema.safeParse(action.metadata);
  if (!parsed.success || !isDatabaseProvisionRecoveryAction(action) || !params.confirmedActionIds.has(action.id)) {
    return blocked('Database provision recovery requires its exact reviewed action and confirmation.');
  }
  const reviewed = parsed.data;
  const candidateSelection = reviewed.operation === DATABASE_PROVISION_CANDIDATE_OPERATION;
  const withoutReceipt = (bindings: Record<string, unknown>) => {
    const { provisionRecovery: _receipt, ...rest } = bindings;
    return rest;
  };
  const load = () => {
    // Recovery is authorized by one reviewed desired-state revision. Inspect
    // without adopting repository edits or writing a newer revision.
    let currentSpec;
    try { currentSpec = new SpecStore().getForInspection(project); } catch { return undefined; }
    if (!currentSpec || currentSpec.revision !== params.specRevision
      || !isDeepStrictEqual(currentSpec.spec.environments[environmentName], environmentSpec)) return undefined;
    const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
    const context: BackupPolicyContext = { project, spec: environmentSpec, environment,
      components: environment ? ctx.repos.components.findByEnvironmentId(environment.id) : [], adapterFactory: ctx.adapterFactory };
    const component = context.components.find(candidate => candidate.id === reviewed.componentId);
    if (!environment || !component || component.type !== action.resource.name
      || component.bindings.provider !== reviewed.source.provider || environmentSpec.database?.provider !== reviewed.source.provider) return undefined;
    const receipt = component.bindings.provisionRecovery as Record<string, unknown> | undefined;
    if (receipt !== undefined) {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.version !== 1
        || !isDeepStrictEqual(receipt.reviewed, reviewed)
        || receipt.selectionBasis !== (candidateSelection ? 'operator-confirmed-current-resource' : 'retained-native-identity')
        || component.externalId !== reviewed.source.primaryExternalId
        || component.bindings.provisioningIncomplete !== undefined || component.bindings.unresolvedMutation !== undefined
        || provisionRecoveryComponentFingerprint({ ...component, bindings: withoutReceipt(component.bindings) }) !== receipt.componentFingerprint
        || bindingIdentityFingerprint(environment.platformBindings) !== receipt.environmentFingerprint) return undefined;
      const prior = receipt.prior as { externalId: string | null; unresolvedMutation?: unknown };
      if (!prior || !(prior.externalId === null || typeof prior.externalId === 'string')) return undefined;
      const retained = { ...component, externalId: prior.externalId,
        bindings: { ...withoutReceipt(component.bindings), provisioningIncomplete: true,
          ...(prior.unresolvedMutation ? { unresolvedMutation: prior.unresolvedMutation } : {}) } };
      return { context, component, retained, completed: true };
    }
    if (currentDatabaseProvisionRecoveryComponent(context)?.id !== component.id
      || provisionRecoveryComponentFingerprint(component) !== reviewed.bindingsFingerprint
      || bindingIdentityFingerprint(environment.platformBindings) !== reviewed.environmentFingerprint) return undefined;
    return { context, component, retained: component, completed: false };
  };
  const before = load();
  if (!before) return blocked('The retained database attempt or environment changed. Re-run hv_plan; no provider mutation was attempted.');
  if ((before.retained.externalId === null) !== candidateSelection) {
    return blocked('An ID-less attempt requires the explicit current-candidate selection action; it cannot prove original workflow lineage.');
  }
  const observation = await observeDatabaseProvisionRecovery(before.context, before.retained);
  if (!observation || (observation.state !== 'ready' && observation.state !== 'candidate')
    || (observation.state === 'candidate') !== candidateSelection
    || !recoverySourceIdentityMatches(observation.source, reviewed.source)
    || observation.evidenceFingerprint !== reviewed.evidenceFingerprint) {
    return blocked('The exact reviewed database attempt could not be verified again. Recovery remains blocked without provider writes.');
  }
  // Network reads cannot authorize overwriting state changed while they ran.
  const current = load();
  if (!current || !isDeepStrictEqual(current.component, before.component)
    || !isDeepStrictEqual(current.context.environment, before.context.environment)) {
    return blocked('Database or environment metadata changed during verification; nothing was recorded.');
  }
  if (current.completed) {
    try { ctx.repos.environments.syncRepoBindingsForId(current.component.environmentId); }
    catch { return blocked('The database is already recorded, but repository export remains incomplete. Retry this reviewed action.', 1); }
    return { success: true, message: 'The verified database is already recorded; repository export is complete.',
      data: { applied: 0, skipped: 1, providerMutations: 0 } };
  }
  const candidate = { ...current.component, externalId: reviewed.source.primaryExternalId };
  if (primaryDatabaseRecordState(current.context.environment!.platformBindings, candidate) === 'conflict') {
    return blocked('The recorded primary database names another resource. Recovery did not replace it.');
  }
  const bindings = { ...current.component.bindings, ...observation.bindings };
  delete bindings.provisioningIncomplete;
  delete bindings.unresolvedMutation;
  // The acknowledged attempt remains available for audit; verification cannot
  // replace it with a later template or a new creation request.
  if (!isDeepStrictEqual(bindings.databaseTemplate, current.component.bindings.databaseTemplate)) {
    return blocked('The verified provider metadata does not preserve the retained template attempt.');
  }
  const topology = current.context.environment!.platformBindings.databaseTopology as Record<string, unknown> | undefined;
  const environmentBindings = { ...current.context.environment!.platformBindings, databaseTopology: {
    ...(topology ?? {}), primary: { provider: reviewed.source.provider, externalId: reviewed.source.primaryExternalId },
    replicas: topology?.replicas ?? {},
  } };
  const receipt = { version: 1, reviewed,
    selectionBasis: candidateSelection ? 'operator-confirmed-current-resource' : 'retained-native-identity',
    prior: { externalId: current.component.externalId,
      ...(current.component.bindings.unresolvedMutation ? { unresolvedMutation: current.component.bindings.unresolvedMutation } : {}) },
    componentFingerprint: provisionRecoveryComponentFingerprint({ ...candidate, bindings }),
    environmentFingerprint: bindingIdentityFingerprint(environmentBindings) };
  let saved;
  try {
    saved = ctx.repos.components.finalizeProvisionIfUnchanged({ component: current.component,
      environment: current.context.environment!, externalId: candidate.externalId,
      bindings: { ...bindings, provisionRecovery: receipt }, environmentBindings, specRevision: params.specRevision! });
  } catch { return blocked('Database metadata could not be committed. The retained attempt was preserved.'); }
  if (!saved) return blocked('Database or environment metadata changed before recording; nothing was overwritten.');
  try { ctx.repos.environments.syncRepoBindingsForId(saved.environmentId); }
  catch { return blocked('The exact database was recorded, but repository export is incomplete. Retry this reviewed action; no provider mutation is needed.', 1); }
  return { success: true, message: candidateSelection
    ? 'Recorded the explicitly selected current database. Original workflow lineage remains unproven. Project settings were preserved; application deployment remains separate.'
    : 'Recorded the verified retained database identity. Project settings were preserved; application deployment remains separate.',
    data: { applied: 1, skipped: 0, providerMutations: 0, authentication: 'unchecked' } };
}
