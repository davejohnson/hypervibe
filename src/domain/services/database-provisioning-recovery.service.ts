import { isDeepStrictEqual as equal } from 'node:util';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { getDb } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Component } from '../entities/component.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { ProjectSpec, EnvironmentSpec } from '../spec/spec.schema.js';
import type { EnvironmentPlan, PlanOptions } from '../plan/plan.service.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { databaseProvisioningReviewSchema, databaseProvisioningProgressSchema } from '../ports/database-provisioning-recovery.port.js';
import { databaseProvisioningRecoveryActionId, databaseProvisioningRecoveryMetadataSchema,
  databaseProvisioningRecoveryAttemptSchema, DATABASE_PROVISIONING_RECOVERY_OPERATION, isDatabaseProvisioningRecoveryAction } from '../plan/database-provisioning-recovery.contract.js';
import { adapterFactory } from './adapter.factory.js';
import { bindingIdentityFingerprint } from './binding-identity.js';

const components = new ComponentRepository(), environments = new EnvironmentRepository();
const journalKey = 'provisioningCompletion';
class RecoveryBlocked extends Error {}
const warning = 'Only the exact retained database may be completed. Instance creation/deletion, application deployment, schema migrations and backups are separate. Native password replacement cannot exclude a simultaneous password change by another administrator.';
function fingerprint(component: Component) { const bindings = { ...component.bindings }; delete bindings[journalKey]; return bindingIdentityFingerprint(bindings); }
function attempt(component: Component) {
  if (component.bindings[journalKey] === undefined) return undefined;
  return databaseProvisioningRecoveryAttemptSchema.parse(component.bindings[journalKey]);
}
function scopesMayOverlap(left: unknown, right: unknown) {
  const parse = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const a = parse(left), b = parse(right);
  // Only a proven, contradictory native scope excludes another binding.
  return !Object.keys(a).some(key => typeof a[key] === 'string' && a[key] && typeof b[key] === 'string' && b[key] && a[key] !== b[key]);
}
function load(project: Project, environmentName: string, spec: EnvironmentSpec) {
  const environment = environments.findByProjectAndName(project.id, environmentName);
  const found = environment ? components.findByEnvironmentId(environment.id).filter(c => c.type === 'postgres') : [];
  const component = found.length === 1 ? found[0] : undefined;
  if (!environment || !component?.externalId || !spec.database || component.bindings.provider !== spec.database.provider
    || component.bindings.provisioningIncomplete !== true || component.bindings.retainedCleanup
    || component.bindings.unresolvedMutation || component.bindings.freshInitialization || component.bindings.credentialRotation) {
    throw new RecoveryBlocked('Completion requires one exact retained incomplete database without conflicting recovery.');
  }
  for (const otherProject of new ProjectRepository().findAll()) for (const otherEnvironment of environments.findByProjectId(otherProject.id)) {
    for (const other of components.findByEnvironmentId(otherEnvironment.id)) if (other.id !== component.id
      && other.externalId === component.externalId && other.bindings.provider === component.bindings.provider
      && scopesMayOverlap(other.bindings.providerScope, component.bindings.providerScope)) {
      throw new RecoveryBlocked('The retained database is shared or ambiguously scoped; automatic completion is blocked.');
    }
  }
  return { environment, component };
}
const decrypt = (encrypted: string) => databaseProvisioningReviewSchema.parse(getSecretStore().decryptObject(encrypted));

export async function planDatabaseProvisioningRecovery(input: { project: Project; spec: ProjectSpec; revision: number; environmentName: string; options?: PlanOptions }): Promise<EnvironmentPlan | null> {
  const spec = input.spec.environments[input.environmentName], environment = environments.findByProjectAndName(input.project.id, input.environmentName);
  if (!spec?.database || !environment || !components.findByEnvironmentId(environment.id).some(c => c.type === 'postgres' && c.bindings.provisioningIncomplete === true)) return null;
  const resolved = await adapterFactory.getDatabaseAdapter(spec.database.provider, input.project, environment.name);
  if (!resolved.success || !resolved.adapter?.provisioningRecovery) return null;
  const actions: PlanAction[] = [], blocked: EnvironmentPlan['blocked'] = []; let encrypted: string | undefined;
  try {
    if (input.options?.serviceFilter) throw new RecoveryBlocked('Database completion requires an unfiltered plan.');
    const current = load(input.project, input.environmentName, spec), prior = attempt(current.component);
    const observed = await resolved.adapter.provisioningRecovery.inspect(current);
    if (observed.state !== 'ready') throw new RecoveryBlocked(observed.state === 'pending'
      ? 'The retained native database creation is still running. Continue read-only observation; no reset or another create is authorized.'
      : 'The exact retained database identity or native readiness could not be verified.');
    const fresh = databaseProvisioningReviewSchema.parse(observed.review), reviewed = prior ? decrypt(prior.reviewEncrypted) : fresh;
    if (!equal(fresh.target, reviewed.target) || reviewed.target.provider !== spec.database.provider || reviewed.target.externalId !== current.component.externalId
      || !equal(reviewed.target.providerScope, current.component.bindings.providerScope)) throw new RecoveryBlocked('The retained database scope or lifetime changed.');
    encrypted = prior?.reviewEncrypted ?? getSecretStore().encryptObject(reviewed);
    const metadata = prior?.metadata ?? { operation: DATABASE_PROVISIONING_RECOVERY_OPERATION, componentId: current.component.id,
      target: reviewed.target, replaceCredential: reviewed.replaceCredential, createDatabase: reviewed.createDatabase,
      bindingsFingerprint: fingerprint(current.component), environmentFingerprint: bindingIdentityFingerprint(current.environment.platformBindings) };
    if (metadata.bindingsFingerprint !== fingerprint(current.component)
      || metadata.environmentFingerprint !== bindingIdentityFingerprint(current.environment.platformBindings)) throw new RecoveryBlocked('The reviewed database bindings or environment changed; preserve its recovery record.');
    actions.push({ id: databaseProvisioningRecoveryActionId(current.component.id), type: 'update', resource: { kind: 'database', name: 'postgres', provider: reviewed.target.provider },
      verified: true, requiresConfirm: true, dataBearing: true, billable: false,
      reason: prior ? 'Resume the exact retained database completion without repeating an uncertain write.'
        : `${reviewed.replaceCredential ? 'Set one new password for the reviewed database role' : 'Preserve and verify the retained database credential'}; ${reviewed.createDatabase ? 'create its missing logical database' : 'preserve its existing logical database'} and verify SQL access. Preserve the instance and existing data.`, metadata });
  } catch (error) { encrypted = undefined; blocked.push({ category: 'prerequisite', provider: spec.database.provider,
    reason: error instanceof RecoveryBlocked ? error.message : 'Database completion evidence is invalid or unavailable; preserve its existing identity and recovery state.' }); }
  const runs = new RunRepository(), run = runs.create({ projectId: input.project.id, environmentId: environment.id, type: 'plan', plan: {
    kind: 'hv_plan', scope: 'database-provisioning-recovery', environmentName: input.environmentName, specRevision: input.revision,
    observedFingerprint: null, actions, warnings: [warning], ...(encrypted ? { overrides: { databaseProvisioningEncrypted: encrypted } } : {}),
  } }); runs.updateStatus(run.id, 'succeeded');
  return { planRunId: run.id, scope: 'database-provisioning-recovery', specRevision: input.revision, environmentName: input.environmentName,
    verified: blocked.length === 0, observed: null, actions, blocked, warnings: [warning], unmanaged: [], inputRequired: [] };
}

export async function applyDatabaseProvisioningRecovery(input: { project: Project; spec: EnvironmentSpec; environmentName: string;
  action: PlanAction; confirmed: ReadonlySet<string>; encrypted?: string }): Promise<ActionResult> {
  const stop = (message: string): ActionResult => ({ success: false, status: 'blocked', message });
  if (!isDatabaseProvisioningRecoveryAction(input.action) || !input.confirmed.has(input.action.id) || !input.encrypted) return stop('Database completion requires its exact reviewed action, encrypted evidence and confirmation.');
  try {
    const metadata = databaseProvisioningRecoveryMetadataSchema.parse(input.action.metadata), reviewed = decrypt(input.encrypted);
    let current = load(input.project, input.environmentName, input.spec), prior = attempt(current.component);
    const unchanged = () => metadata.componentId === current.component.id && metadata.bindingsFingerprint === fingerprint(current.component)
      && metadata.environmentFingerprint === bindingIdentityFingerprint(current.environment.platformBindings)
      && (reviewed.replaceCredential ? current.component.bindings.password === undefined : current.component.bindings.password === reviewed.password);
    if (!unchanged() || !equal(metadata.target, reviewed.target) || metadata.replaceCredential !== reviewed.replaceCredential
      || metadata.createDatabase !== reviewed.createDatabase || reviewed.target.externalId !== current.component.externalId
      || !equal(reviewed.target.providerScope, current.component.bindings.providerScope)
      || prior && (!equal(prior.metadata, metadata) || !equal(decrypt(prior.reviewEncrypted), reviewed))) return stop('Reviewed database completion authority changed; preserve the original attempt.');
    const resolved = await adapterFactory.getDatabaseAdapter(metadata.target.provider, input.project, current.environment.name);
    if (!resolved.success || resolved.adapter?.name !== metadata.target.provider || !resolved.adapter.provisioningRecovery) return stop('The reviewed provider completion capability is unavailable.');
    if (!prior) {
      const initial = databaseProvisioningRecoveryAttemptSchema.parse({ metadata, reviewEncrypted: input.encrypted, startedAt: new Date().toISOString(), progress: { phase: 'prepared' } });
      components.updateBindings(current.component.id, { [journalKey]: initial });
      prior = attempt(components.findById(current.component.id)!);
      if (!equal(prior, initial)) return stop('Database completion intent could not be durably verified.');
    }
    const phases = databaseProvisioningProgressSchema.shape.phase.options;
    const result = await resolved.adapter.provisioningRecovery.apply({ ...current, reviewed, progress: prior!.progress,
      saveProgress: async next => {
        const progress = databaseProvisioningProgressSchema.parse(next); current = load(input.project, input.environmentName, input.spec);
        if (!unchanged() || !equal(attempt(current.component), prior) || phases.indexOf(progress.phase) < phases.indexOf(prior!.progress.phase)
          || prior!.progress.credentialOperationId && progress.credentialOperationId !== prior!.progress.credentialOperationId
          || prior!.progress.databaseOperationId && progress.databaseOperationId !== prior!.progress.databaseOperationId) throw new RecoveryBlocked('Database recovery progress or identity changed before mutation.');
        if (progress.phase === 'complete') return;
        const nextAttempt = { ...prior!, progress }; components.updateBindings(current.component.id, { [journalKey]: nextAttempt });
        const saved = attempt(components.findById(current.component.id)!); if (!equal(saved, nextAttempt)) throw new RecoveryBlocked('Database recovery progress could not be persisted.'); prior = saved;
      } });
    if (result.state !== 'complete') return { ...stop('Database completion is not verified; retain the original attempt and inspect its native operations without repeating writes.'),
      ...(result.state === 'pending' ? { status: 'pending' as const } : {}) };
    current = load(input.project, input.environmentName, input.spec);
    if (!unchanged() || !equal(attempt(current.component), prior) || prior!.progress.phase !== 'database-verified'
      || !result.bindings || result.bindings.provider !== metadata.target.provider || result.bindings.instanceId !== metadata.target.externalId
      || !equal(result.bindings.providerScope, metadata.target.providerScope) || result.bindings.username !== metadata.target.username
      || result.bindings.database !== metadata.target.database || result.bindings.password !== reviewed.password) return stop('Native database completion returned inconsistent bindings; retain the exact recovery state.');
    const topology = current.environment.platformBindings.databaseTopology as { primary?: unknown; replicas?: unknown } | undefined;
    const primary = { provider: metadata.target.provider, externalId: metadata.target.externalId };
    if (topology?.primary && !equal(topology.primary, primary) || topology?.replicas && Object.keys(topology.replicas).length) return stop('A different database topology is already retained; completion cannot overwrite it.');
    const bindings: Record<string, unknown> = { ...current.component.bindings, ...result.bindings, [journalKey]: { ...prior!, progress: { ...prior!.progress, phase: 'complete' as const } } };
    delete bindings.provisioningIncomplete; delete bindings.cleanupRequired;
    getDb().transaction(() => { components.update(current.component.id, { bindings });
      environments.updatePlatformBindings(current.environment.id, { databaseTopology: { primary, replicas: {} } }); })();
    return { success: true, message: 'Completed the same retained database and verified SQL authentication. Application rollout, migrations, backups and restore remain separate.',
      data: { externalId: metadata.target.externalId, sqlAuthentication: 'verified', applicationDeployment: 'unchecked', backups: 'unchecked' } };
  } catch { return stop('Database completion could not be verified. Its identity and private recovery state are preserved; no repeated write or replacement is authorized.'); }
}
