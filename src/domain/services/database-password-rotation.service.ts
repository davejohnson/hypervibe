import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import { ConvergeExecutor, type PlanRunDocument, type ActionResult } from '../plan/converge.executor.js';
import { PlanService, type EnvironmentPlan } from '../plan/plan.service.js';
import { scopedSecretObservation } from '../plan/scoped-secrets.js';
import { databasePasswordActionId, databasePasswordMetadataSchema, DATABASE_PASSWORD_OPERATIONS, isDatabasePasswordPlan } from '../plan/database-password-plan.contract.js';
import { DatabaseCredentialReviewError, databaseCredentialLifecycle, databaseCredentialConfigurationSchema, databaseCredentialTargetSchema,
  type DatabaseCredentialTarget, type DatabaseCredentialConfiguration } from '../ports/database-credential.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import { hashEnvValue, type ObservedState } from '../ports/observe.port.js';
import type { CredentialTracking } from '../spec/credential.schema.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { adapterFactory } from './adapter.factory.js';
import { replaceDatabaseCredentialBindings } from './database-credential-value.js';
import { resolveSecretValueRef } from './secret-value-ref.js';
import { recordRuntimeRolloutRequirements, runtimeRolloutRequirements } from './runtime-rollout.service.js';
import { composeDatabaseCredentialConfiguration, composedDatabaseConfiguration, databaseConfigurationRolloutData, sameDatabaseConfigurationAuthority, retargetDatabaseConfiguration } from './database-credential-configuration.js';
import { deriveHypervibeSecretValue } from './hypervibe-secret-value.js';

const components = new ComponentRepository();
const environments = new EnvironmentRepository();
const runs = new RunRepository();
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const progressSchema = z.object({
  planId: z.string().min(1), phase: z.enum(['database-attempted', 'database-authenticated', 'configuration-attempted', 'installed']),
  baselineEncrypted: z.string().min(1),
}).strict();
type Progress = z.infer<typeof progressSchema>;
type Frozen = { kind: 'database-password'; value: string; descriptor: CredentialTracking; target: DatabaseCredentialTarget;
  configuration: DatabaseCredentialConfiguration; actions: PlanRunDocument['actions']; lockEnvironmentIds: string[]; hostingProvider: string; beforeBindings: Record<string, unknown>; intendedBindings: Record<string, unknown>;
  applicationValidation?: { at: string; tested: string };
  intent?: 'adopt' | 'rotate'; previousPassword?: string; replacementRecovered?: boolean;
  validation?: { result: 'passed'; at: string; tested: string; applicationOperation: 'unknown'; evidenceId: string } };
class RotationError extends Error {}
function progress(component: Component): Progress | undefined {
  if (component.bindings.credentialRotation === undefined) return undefined;
  const result = progressSchema.safeParse(component.bindings.credentialRotation);
  if (!result.success) throw new RotationError('Database rotation recovery state is invalid; it was preserved.');
  return result.data;
}
export function pendingDatabasePasswordRotation(projectId: string): string | undefined {
  for (const environment of environments.findByProjectId(projectId)) for (const component of components.findByEnvironmentId(environment.id)) {
    if (component.bindings.credentialRotation === undefined) continue;
    const parsed = progressSchema.safeParse(component.bindings.credentialRotation);
    if (!parsed.success) {
      const value = record(component.bindings.credentialRotation);
      return typeof value.planId === 'string' ? value.planId : 'invalid-database-rotation-state';
    }
    if (parsed.data.phase !== 'installed') return parsed.data.planId;
  }
  return undefined;
}
function save(component: Component, value: Progress) {
  components.updateBindings(component.id, { credentialRotation: value });
  // A repository acknowledgement may be null or misleading. The exact durable
  // recovery intent is required before either external mutation boundary.
  const persisted = components.findById(component.id);
  if (!persisted || persisted.environmentId !== component.environmentId || persisted.externalId !== component.externalId
    || persisted.type !== component.type || ['provider', 'providerScope', 'username', 'database'].some(key => !isDeepStrictEqual(persisted.bindings[key], component.bindings[key]))
    || !isDeepStrictEqual(persisted.bindings.credentialRotation, value)) {
    throw new RotationError('The exact native database recovery intent was not durably persisted. No dependent mutation is authorized.');
  }
}
function restoreRefusedAttempt(component: Component) {
  components.updateBindings(component.id, { credentialRotation: component.bindings.credentialRotation });
  if (!isDeepStrictEqual(components.findById(component.id)?.bindings.credentialRotation, component.bindings.credentialRotation)) throw new RotationError('The refused update could not restore its prior recovery marker.');
}
function current(project: Project, spec: ProjectSpec, descriptor: CredentialTracking) {
  const selection = descriptor.database;
  if (!selection) throw new RotationError('A native database-password rotation requires exact database environment, component, username and database selection.');
  const environment = environments.findByProjectAndName(project.id, selection.environment);
  const envSpec = spec.environments[selection.environment];
  const component = components.findById(selection.component);
  if (!environment || !envSpec?.database || !component?.externalId || component.environmentId !== environment.id
    || component.type !== 'postgres' || component.bindings.provider !== envSpec.database.provider
    || component.bindings.credentialAliasRepair || component.bindings.unresolvedMutation || component.bindings.retainedCleanup
    || component.bindings.provisioningIncomplete) throw new RotationError('Native database rotation requires one complete, existing bound PostgreSQL identity without other pending recovery.');
  const scope = z.record(z.string(), z.string().min(1)).safeParse(component.bindings.providerScope);
  if (!scope.success || !Object.keys(scope.data).length) throw new RotationError('Native database rotation requires complete provider scope.');
  for (const otherProject of new ProjectRepository().findAll()) for (const otherEnvironment of environments.findByProjectId(otherProject.id)) {
    for (const other of components.findByEnvironmentId(otherEnvironment.id)) {
      if (other.id !== component.id && other.externalId === component.externalId && other.bindings.provider === component.bindings.provider
        && (isDeepStrictEqual(other.bindings.providerScope, scope.data) || !other.bindings.providerScope
          || !isDeepStrictEqual(Object.keys(record(other.bindings.providerScope)).sort(), Object.keys(scope.data).sort()))) {
        throw new RotationError('The database identity is shared or ambiguously bound; native rotation cannot establish complete consumers.');
      }
    }
  }
  return { environment, component, envSpec };
}
async function capability(project: Project, provider: string, persist?: () => void, desired?: ProjectSpec['environments'][string], retryUncertain = false, applicationDriver?: 'node-postgres') {
  const result = await adapterFactory.getDatabaseAdapter(provider, project);
  const native = result.success ? databaseCredentialLifecycle(result.adapter) : undefined;
  if (!native || !native.configuration && (!native.finalize || !native.inspectIssuer)) {
    throw new RotationError(`Native database-password rotation is unsupported for ${provider}: a complete SQL, issuer, reference and consumer recovery capability is required.`);
  }
  if (applicationDriver && (!native.runtimeConfiguration || typeof native.runtimeConfiguration.verifyAuthentication !== 'function')) {
    throw new RotationError(`Deployed application authentication is unsupported for ${provider}; omit applicationDriver to retain the existing native rotation boundary.`);
  }
  return { ...native, configuration: (applicationDriver ? native.runtimeConfiguration : native.configuration) ?? composeDatabaseCredentialConfiguration(project, native, persist, desired, retryUncertain) };
}
function requiredKeys(spec: ProjectSpec['environments'][string]): Record<string, string[]> {
  return Object.fromEntries(Object.entries(spec.services).map(([name, service]) => [name, [...new Set(['DATABASE_URL', ...Object.keys(service.databaseEnvAliases ?? {})])].sort()]));
}
function validateReview(value: unknown, environment: Environment, spec: ProjectSpec['environments'][string], observed: ObservedState | null): DatabaseCredentialConfiguration {
  const parsed = databaseCredentialConfigurationSchema.parse(value);
  if (!observed || observed.partial || observed.completeness?.services === 'unknown') throw new RotationError('Exact credential consumers could not be completely observed.');
  try { scopedSecretObservation(environment, spec, observed, []); }
  catch { throw new RotationError('Exact hosting scope or consumer identity could not be verified.'); }
  const bindings = parseHostingBindings(environment);
  const keys = requiredKeys(spec);
  if (!isDeepStrictEqual(parsed.consumers.map(c => c.service).sort(), Object.keys(keys).sort())
    || new Set(parsed.issuerNames).size !== parsed.issuerNames.length) throw new RotationError('Native rotation requires complete, unique issuer and consumer coverage.');
  for (const consumer of parsed.consumers) {
    const found = observed.services.filter(s => s.name === consumer.service);
    const bound = bindings.services?.[consumer.service];
    if (found.length !== 1 || found[0].externalId !== consumer.externalId
      || (bound?.serviceId ?? bound?.jobName) !== consumer.externalId
      || keys[consumer.service].some(key => !consumer.envVarHashes[key])) throw new RotationError('The exact bound consumer or declared database alias is missing from the review.');
  }
  return parsed;
}
const credentialBindingKeys = ['password', 'connectionString', 'connectionUrl', 'directUrl', 'pooledUrl', 'DATABASE_URL', 'DIRECT_URL'];
function privateBindingProjection(component: Component, replacement: string, target: DatabaseCredentialTarget) {
  const before = Object.fromEntries(credentialBindingKeys.filter(key => component.bindings[key] !== undefined).map(key => [key, component.bindings[key]]));
  for (const [key, value] of Object.entries(before)) {
    if (key === 'password' || typeof value !== 'string' || !/^postgres(?:ql)?:\/\//.test(value)) continue;
    const parsed = new URL(value);
    // Pooler-qualified identities need an independently reviewed provider
    // mapping. Do not infer role equivalence from a shared username prefix.
    if (decodeURIComponent(parsed.username) !== target.username || decodeURIComponent(parsed.pathname.slice(1)) !== target.database) {
      throw new RotationError('A stored connection has a different database or pooler identity; native credential projection is unsupported.');
    }
  }
  const projected = replaceDatabaseCredentialBindings(component, replacement, target);
  return { before, intended: Object.fromEntries(credentialBindingKeys.filter(key => projected[key] !== undefined).map(key => [key, projected[key]])) };
}
const evidence = { databaseAuthentication: 'verified', deployment: 'pending', applicationAuthentication: 'unchecked', applicationOperation: 'unchecked', oldSessions: 'unchecked' };

/** Dedicated native lifecycle reached through scope=credentials. It never treats
 * an environment edit as a database reset and never deploys implicitly. */
export async function planDatabasePasswordRotation(params: { project: Project; spec: ProjectSpec; revision: number; environmentName: string;
  descriptor: CredentialTracking; intent: 'adopt' | 'rotate' }): Promise<EnvironmentPlan | { error: string }> {
  try {
    const { descriptor, project, spec } = params;
    if (descriptor.database?.applicationDriver && params.intent !== 'rotate') throw new RotationError('Deployed application authentication is an optional rotation stage; native adoption retains its existing two-action review.');
    const slots = Object.values(spec.secrets).filter(slot => slot.credential?.role === descriptor.role);
    if (slots.some(slot => slot.environments.length || slot.ownership === 'delegated' && slot.githubActions) || descriptor.containerPull?.length || descriptor.runtimeConsumers?.length) {
      throw new RotationError('The native database rotation declares its database destination only; do not declare password inputs as application or GitHub variables.');
    }
    const pendingRole = environments.findByProjectId(project.id).flatMap(env => Object.values(record(env.platformBindings.credentialUpdates)))
      .map(record).find(value => value.state === 'pending');
    if (pendingRole) throw new RotationError(`Recover credential plan ${String(pendingRole.planId)} before native database rotation.`);
    const pending = pendingDatabasePasswordRotation(project.id);
    if (pending) throw new RotationError(`Recover native database rotation with hv_apply planId="${pending}" before another plan.`);
    const { environment, component, envSpec } = current(project, spec, descriptor);
    if (environment.name !== params.environmentName) throw new RotationError('The selected native database must belong to the plan environment.');
    const port = await capability(project, envSpec.database!.provider, undefined, envSpec, false, descriptor.database?.applicationDriver);
    const previous = progress(component);
    if (previous?.phase === 'installed') {
      const prior = runs.findById(previous.planId);
      const encrypted = record(record(prior?.plan).overrides).delegatedSecretVarsEncrypted;
      if (typeof encrypted !== 'string') throw new RotationError('The preceding database rotation review is unavailable; preserve recovery.');
      const retained = getSecretStore().decryptObject<Frozen>(encrypted);
      if (retained.descriptor.database?.applicationDriver && !retained.applicationValidation) throw new RotationError(`Finish managed deployment and reapply native database rotation ${previous.planId} before another rotation.`);
      if (descriptor.rotationGeneration && retained.descriptor.rotationGeneration && descriptor.rotationGeneration <= retained.descriptor.rotationGeneration) throw new RotationError('Increase rotationGeneration above the last accepted generation before a new rotation.');
    }
    const target = databaseCredentialTargetSchema.parse(await port.inspect(environment, component, descriptor.database!));
    if (target.componentId !== component.id || target.environmentId !== environment.id || target.externalId !== component.externalId
      || target.provider !== envSpec.database!.provider || Object.entries(record(component.bindings.providerScope)).some(([key, value]) => target.providerScope[key] !== value)
      || target.database !== descriptor.database!.database || target.username !== descriptor.database!.username) throw new RotationError('The inspected native database target differs from the selected identity.');
    const previousPassword = target.inputMode === 'provider-generated' ? await port.readCurrent(environment, component, target) : undefined;
    if (target.inputMode === 'provider-generated' && !previousPassword) throw new RotationError('The exact current generated database credential cannot be recovered before rotation.');
    const first = Object.entries(spec.secrets).find(([, slot]) => slot.credential?.role === descriptor.role)!;
    if (descriptor.rotationGeneration && (descriptor.source || params.intent !== 'rotate' || target.inputMode !== 'supplied' || first[1].ownership !== 'delegated')) throw new RotationError('rotationGeneration requires a supplied-mode delegated database rotation without a private source.');
    let generated: string | undefined;
    if (descriptor.rotationGeneration) {
      const material = getSecretStore().deriveSecret('hypervibe.database-password.v1', { project: project.id, environment: environment.id, component: component.id, role: descriptor.role, generation: String(descriptor.rotationGeneration) });
      try { generated = material.toString('base64url'); } finally { material.fill(0); }
    }
    const value = previousPassword ?? generated ?? (first[1].ownership === 'hypervibe' ? deriveHypervibeSecretValue(project.name, environment.name, first[0], first[1])
      : descriptor.source ? await resolveSecretValueRef(descriptor.source, { projectId: project.id, environmentName: environment.name }) : undefined);
    if (!value || value.includes('\0')) throw new RotationError('The private replacement is empty or invalid.');
    new AuditRepository().create({ action: 'credential.source.read', resourceType: 'credential-role', resourceId: `${project.id}/${descriptor.role}`, details: {
      role: descriptor.role, source: target.inputMode === 'provider-generated' ? `provider-generated:${target.provider}` : descriptor.source ?? 'hypervibe-generator',
      provider: target.provider, componentId: component.id, username: target.username, inputMode: target.inputMode,
    } });
    const projected = privateBindingProjection(component, value, target);
    const { observed } = await new PlanService().observeEnvironment(project, environment, envSpec, { hostingOnly: true });
    if (progress(component)?.phase === 'installed' && runtimeRolloutRequirements({ environment, provider: envSpec.hosting.provider, observed }).length) {
      throw new RotationError('The preceding database credential still has pending consumer activation; finish its rollout before another rotation.');
    }
    const configuration = validateReview(await port.configuration.inspect(environment, component, target, value, requiredKeys(envSpec)), environment, envSpec, observed);
    if (params.intent === 'adopt') {
      const currentConfiguration = await port.configuration.observe(environment, component, target, value, configuration);
      if (currentConfiguration.issuer !== 'match' || currentConfiguration.references !== 'match') throw new RotationError('Adoption preserves existing database and consumer values; a differing value requires a separate rotation.');
    }
    const consumers = configuration.consumers.map(c => ({ service: c.service, externalId: c.externalId, keys: Object.keys(c.envVarHashes).sort() }));
    const operations = descriptor.database?.applicationDriver ? DATABASE_PASSWORD_OPERATIONS : DATABASE_PASSWORD_OPERATIONS.slice(0, 2);
    const actions = operations.map(operation => ({ id: databasePasswordActionId(component.id, operation), type: 'update' as const,
      resource: { kind: 'database' as const, name: 'postgres', provider: target.provider }, verified: true, requiresConfirm: operation !== 'databasePasswordVerify', dataBearing: operation !== 'databasePasswordVerify',
      reason: operation === 'databasePasswordVerify' ? 'Verify exact consumer activation, old deployment drainage and fresh authentication using the declared application driver. No deployment is performed.' : operation === 'databasePasswordRotate' ? params.intent === 'adopt' ? 'Validate and adopt the existing database credential without changing authentication.' : 'Change the actual database password; old passwords can immediately stop authenticating new sessions.' : params.intent === 'adopt' ? 'Record existing issuer and consumer configuration without replacing values.' : 'Synchronize the exact authoritative issuer and references after fresh database authentication; affected workload rollout remains required.',
      ...(operation !== 'databasePasswordRotate' ? { dependsOn: [databasePasswordActionId(component.id, operation === 'databasePasswordSynchronize' ? 'databasePasswordRotate' : 'databasePasswordSynchronize')] } : {}),
      metadata: { operation, role: descriptor.role, target, issuerNames: configuration.issuerNames, consumers },
    }));
    const lockEnvironmentIds = [environment.id];
    const frozen: Frozen = { kind: 'database-password', value, descriptor, target, configuration, actions, lockEnvironmentIds, hostingProvider: envSpec.hosting.provider, beforeBindings: projected.before, intendedBindings: projected.intended,
      intent: params.intent, ...(previousPassword ? { previousPassword } : {}) };
    const warnings = [params.intent === 'adopt' ? 'Adoption verifies and records existing authentication and configuration without changing credentials or deploying workloads.'
      : 'This is a disruptive native password change. SQL authentication, issuer/reference configuration, workload activation, drained deployments and application operation require separate evidence. No deployment or session termination is included.',
      'Fresh authentication may acquire the provider\'s existing temporary database access lease; cleanup is required before dependent work.'];
    const document: PlanRunDocument = { kind: 'hv_plan', scope: 'credentials', environmentName: environment.name, specRevision: params.revision,
      observedFingerprint: null, actions, warnings, lockEnvironmentIds, overrides: { delegatedSecretVarsEncrypted: getSecretStore().encryptObject(frozen) } };
    const run = runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: document as unknown as Record<string, unknown> });
    runs.updateStatus(run.id, 'succeeded');
    return { scope: 'credentials', planRunId: run.id, environmentName: environment.name, specRevision: params.revision,
      verified: true, observed: null, actions, warnings, unmanaged: [], inputRequired: [], blocked: [] };
  } catch (error) { return { error: error instanceof RotationError || error instanceof DatabaseCredentialReviewError ? error.message : 'Native database rotation review failed; no replacement or provider diagnostics were exposed.' }; }
}

export async function applyDatabasePasswordRotation(params: { project: Project; spec: ProjectSpec; specRevision: number; planId: string; confirmActions?: string[] }) {
  const executor = new ConvergeExecutor(); const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) throw new Error(loaded.error);
  if (loaded.run.projectId !== params.project.id || !isDatabasePasswordPlan(loaded.document.actions)) throw new RotationError('The exact native database plan authority is invalid.');
  let frozen: Frozen;
  try { frozen = getSecretStore().decryptObject<Frozen>(loaded.document.overrides!.delegatedSecretVarsEncrypted!); }
  catch {
    // JSON decoding errors can quote decrypted input before the action handler
    // starts. Keep that private material behind the same authored error boundary.
    throw new RotationError('Native database rotation could not read its retained encrypted authority. Recovery is preserved; no private input or diagnostic was returned.');
  }
  const persistFrozen = () => {
    const currentRun = runs.findById(params.planId)!;
    runs.updatePlan(params.planId, { ...currentRun.plan, overrides: { ...record(record(currentRun.plan).overrides), delegatedSecretVarsEncrypted: getSecretStore().encryptObject(frozen) } });
    const saved = runs.findById(params.planId);
    const encrypted = record(record(saved?.plan).overrides).delegatedSecretVarsEncrypted;
    if (typeof encrypted !== 'string' || !isDeepStrictEqual(getSecretStore().decryptObject(encrypted), frozen)) throw new RotationError('Encrypted credential recovery progress was not durably persisted.');
  };
  if (frozen.kind !== 'database-password' || !isDeepStrictEqual(frozen.actions, loaded.document.actions)
    || !isDeepStrictEqual(frozen.lockEnvironmentIds, loaded.document.lockEnvironmentIds)) throw new RotationError('The native database authority differs from its encrypted review.');
  const descriptors = Object.values(params.spec.secrets).filter(slot => slot.credential?.role === frozen.descriptor.role);
  if (!descriptors.length || descriptors.some(slot => !isDeepStrictEqual(slot.credential, frozen.descriptor))) throw new RotationError('The native database declaration changed. Restore the reviewed declaration before recovery.');
  const initial = current(params.project, params.spec, frozen.descriptor);
  const recovering = progress(initial.component)?.planId === params.planId;
  return executor.execute({ planRunId: params.planId, currentSpecRevision: params.specRevision, confirmActions: params.confirmActions,
    ...(recovering ? { maxPlanAgeMs: Number.POSITIVE_INFINITY } : {}), handler: async (action): Promise<ActionResult> => {
      try {
        const m = databasePasswordMetadataSchema.parse(action.metadata);
        const { environment, component, envSpec } = current(params.project, params.spec, frozen.descriptor);
        const port = await capability(params.project, frozen.target.provider, persistFrozen, envSpec, params.confirmActions?.includes(`${action.id}:retry-uncertain`) === true, frozen.descriptor.database?.applicationDriver);
        if (!isDeepStrictEqual(await port.inspect(environment, component, frozen.descriptor.database!), frozen.target)) throw new RotationError('Native database identity changed; no write is authorized.');
        for (const key of new Set([...Object.keys(frozen.beforeBindings), ...Object.keys(frozen.intendedBindings)])) {
          if (component.bindings[key] !== frozen.beforeBindings[key] && component.bindings[key] !== frozen.intendedBindings[key]) throw new RotationError('Private bound credential configuration changed after review. Preserve recovery before replacing it.');
        }
        let state = progress(component);
        if (state && state.planId !== params.planId && state.phase !== 'installed') throw new RotationError(`Recover native database rotation ${state.planId} first.`);
        const { observed } = await new PlanService().observeEnvironment(params.project, environment, envSpec, { hostingOnly: true });
        const review = validateReview(await port.configuration.inspect(environment, component, frozen.target, frozen.value, requiredKeys(envSpec), frozen.configuration), environment, envSpec, observed);
        if (frozen.descriptor.database?.applicationDriver ? !isDeepStrictEqual(review, frozen.configuration) : !sameDatabaseConfigurationAuthority(review, frozen.configuration)) throw new RotationError('The exact issuer/reference/consumer review changed; no write is authorized.');
        if (!state || state.planId !== params.planId) state = { planId: params.planId, phase: 'database-attempted', baselineEncrypted: getSecretStore().encryptObject(observed) };
        if (m.operation === 'databasePasswordVerify') {
          if (state.phase !== 'installed') return { success: false, status: 'pending', message: 'Install the intended database credential and issuer configuration before consumer verification.' };
          const latest = environments.findById(environment.id);
          if (!latest) throw new RotationError('The exact consumer environment is no longer retained.');
          const pending = runtimeRolloutRequirements({ environment: latest, provider: frozen.hostingProvider, observed });
          if (pending.length) return { success: false, status: 'pending', message: `Complete the managed deployment for ${pending.map(item => item.service).join(', ')}, then reapply this same rotation plan. Exact activation and old deployment drainage remain pending.`, data: evidence };
          const references = await port.configuration.observe(environment, component, frozen.target, frozen.value, frozen.configuration);
          if (references.issuer !== 'match' || references.references !== 'match') return { success: false, status: 'pending', message: 'Issuer and reference readback changed; verification remains pending.' };
          const driver = frozen.descriptor.database?.applicationDriver;
          if (!driver || !port.runtimeConfiguration) throw new RotationError('The retained plan has no supported application authentication authority.');
          const auth = await port.runtimeConfiguration.verifyAuthentication(environment, component, frozen.target, frozen.configuration, driver);
          if (auth.state !== 'authenticated') return { success: false, status: 'pending', message: 'The deployed connection configuration has not passed fresh application authentication. Deployment success alone cannot complete this rotation.', data: { ...evidence, deployment: 'verified', applicationAuthentication: auth.state } };
          frozen.applicationValidation = { at: new Date().toISOString(), tested: auth.tested }; persistFrozen();
          return { success: true, message: 'Exact consumer activation, old deployment drainage and fresh configured-driver authentication are verified. Application operations and other pre-existing SQL sessions remain unchecked.', data: { ...evidence, deployment: 'verified', applicationAuthentication: 'verified' } };
        }
        let proof = await port.probe(environment, component, frozen.target, frozen.value);
        if (m.operation === 'databasePasswordRotate') {
          const generated = frozen.target.inputMode === 'provider-generated' && frozen.intent !== 'adopt';
          if (generated && !frozen.replacementRecovered) {
            const prior = progress(component);
            if (!prior || prior.planId !== params.planId) {
              if (proof.state !== 'authenticated') return { success: false, status: 'pending', message: 'The previous credential cannot authenticate the exact database; no generated reset was attempted.' };
              save(component, state);
              const changed = await port.rotate(environment, component, frozen.target);
              if (changed.state === 'blocked') { restoreRefusedAttempt(component); return { success: false, status: 'blocked', message: 'The native credential policy or identity refused the update before mutation. Correct its prerequisites and review a new plan.' }; }
              if (changed.replacement && changed.replacement !== frozen.previousPassword) frozen.value = changed.replacement;
            }
            if (frozen.value === frozen.previousPassword) {
              const recovered = await port.readCurrent(environment, component, frozen.target);
              if (!recovered || recovered === frozen.previousPassword) return { success: false, status: 'pending', message: 'Generated database replacement is pending. The same exact user will be read on retry; another reset is not authorized.' };
              frozen.value = recovered;
            }
            frozen.replacementRecovered = true;
            const refreshed = await port.configuration.inspect(environment, component, frozen.target, frozen.value, requiredKeys(envSpec));
            const authority = (config: DatabaseCredentialConfiguration) => ({ issuerNames: config.issuerNames, consumers: config.consumers.map(c => ({ service: c.service, externalId: c.externalId, keys: Object.keys(c.envVarHashes).sort() })) });
            if (!isDeepStrictEqual(authority(refreshed), authority(frozen.configuration))) throw new RotationError('Generated replacement consumer authority changed. Recovery is preserved.');
            frozen.configuration = composedDatabaseConfiguration(frozen.configuration) ? retargetDatabaseConfiguration(frozen.configuration, frozen.value) : refreshed;
            frozen.intendedBindings = privateBindingProjection(component, frozen.value, frozen.target).intended;
            persistFrozen();
            proof = await port.probe(environment, component, frozen.target, frozen.value);
          }
          if (proof.state === 'unknown') return { success: false, status: 'pending', message: 'Fresh authentication is unknown. No native password update was attempted.' };
          if (proof.state !== 'authenticated') {
            if (frozen.intent === 'adopt') return { success: false, status: 'blocked', message: 'Existing database authentication could not be verified; adoption never resets it.' };
            const prior = progress(component);
            if (prior?.planId === params.planId) return { success: false, status: 'pending', message: 'The recorded password attempt has not authenticated. Its exact replacement is retained; automatic replay is blocked.' };
            save(component, state);
            const changed = await port.rotate(environment, component, frozen.target, frozen.value);
            if (changed.state === 'blocked') { restoreRefusedAttempt(component); return { success: false, status: 'blocked', message: 'The native credential policy or identity refused the update before mutation. Correct its prerequisites and review a new plan.' }; }
            proof = await port.probe(environment, component, frozen.target, frozen.value);
            if (proof.state !== 'authenticated') return { success: false, status: 'pending', message: 'The password update outcome is uncertain; resume this plan to authenticate the same encrypted replacement. Issuer writes were not attempted.' };
          }
          if (!['configuration-attempted', 'installed'].includes(state.phase)) state.phase = 'database-authenticated';
          if (!frozen.validation) {
            const validation = { result: 'passed' as const, at: new Date().toISOString(), tested: proof.tested, applicationOperation: 'unknown' as const };
            const evidenceId = new AuditRepository().create({ action: 'credential.validated', resourceType: 'credential-role', resourceId: `${params.project.id}/${frozen.descriptor.role}`, details: { ...validation, subject: 'native-database-authentication', provider: frozen.target.provider } }).id;
            frozen.validation = { ...validation, evidenceId }; persistFrozen();
          }
          save(component, state);
          return { success: true, message: 'The intended database identity accepted the replacement in a fresh connection. Issuer configuration and workloads are separate.', data: evidence };
        }
        if (proof.state !== 'authenticated') return { success: false, status: 'pending', message: 'Fresh database authentication is not verified; issuer/reference synchronization is blocked.' };
        const configurationProof = await port.configuration.observe(environment, component, frozen.target, frozen.value, frozen.configuration);
        if (configurationProof.issuer === 'unknown' || configurationProof.references === 'unknown') return { success: false, status: 'pending', message: 'Issuer/reference state is unknown; no write was attempted.' };
        if (configurationProof.issuer !== 'match' || configurationProof.references !== 'match') {
          if (frozen.intent === 'adopt') return { success: false, status: 'blocked', message: 'Existing configuration changed; adoption will not overwrite it.' };
          if ((state.phase === 'configuration-attempted' || state.phase === 'installed') && !composedDatabaseConfiguration(frozen.configuration)) return { success: false, status: 'pending', message: 'The previous issuer/reference update has not converged; reconcile its retained intent without replaying it.' };
          state.phase = 'configuration-attempted'; save(component, state);
          await port.configuration.synchronize(environment, component, frozen.target, frozen.value, frozen.configuration);
          const after = await port.configuration.observe(environment, component, frozen.target, frozen.value, frozen.configuration);
          if (after.issuer !== 'match' || after.references !== 'match') return { success: false, status: 'pending', message: `Issuer/reference readback is incomplete. The same encrypted replacement and original deployment baseline are retained.${composedDatabaseConfiguration(frozen.configuration) ? ` For an unresolved write-only acknowledgment, explicitly confirm "${action.id}:retry-uncertain" with this action to retry only its retained destinations.` : ''}` };
        }
        // A configuration acknowledgement never discharges downstream activation.
        const baseline = getSecretStore().decryptObject<ObservedState | null>(state.baselineEncrypted);
        if (frozen.intent !== 'adopt') recordRuntimeRolloutRequirements({ environment, provider: frozen.hostingProvider, observed: baseline, actions: [action],
          receipts: frozen.configuration.consumers.map(consumer => ({ actionId: action.id, status: 'succeeded',
            data: databaseConfigurationRolloutData(frozen.configuration, consumer.service) })),
          applyRunId: params.planId,
          expectedConfiguration: Object.fromEntries(frozen.configuration.consumers.map(c => [c.service, { operationId: params.planId, envVarHashes: c.envVarHashes }])),
        });
        components.updateBindings(component.id, frozen.intendedBindings);
        const installed = components.findById(component.id);
        if (!installed || Object.entries(frozen.intendedBindings).some(([key, value]) => installed.bindings[key] !== value)) throw new RotationError('The frozen private component credentials were not durably installed; recovery is preserved.');
        const latestEnvironment = environments.findById(environment.id)!;
        const hostingHashes: Record<string, Record<string, string>> = {};
        for (const consumer of frozen.configuration.consumers) for (const [key, hash] of Object.entries(consumer.envVarHashes)) (hostingHashes[key] ??= {})[consumer.service] = hash;
        const accepted = { planId: params.planId, state: 'accepted', acceptedAt: new Date().toISOString(), acceptedInputHash: hashEnvValue(frozen.value),
          descriptor: frozen.descriptor, validation: frozen.validation, completed: frozen.actions.filter(action => action.metadata?.operation !== 'databasePasswordVerify').map(action => action.id), attempted: frozen.actions.filter(action => action.metadata?.operation !== 'databasePasswordVerify').map(action => action.id), hostingHashes,
          sourceDescriptor: frozen.target.inputMode === 'provider-generated' ? { kind: 'provider-generated', provider: frozen.target.provider, componentId: component.id, externalId: frozen.target.externalId, username: frozen.target.username, providerScope: frozen.target.providerScope } : undefined,
          nativeDatabase: { target: frozen.target, issuerNames: frozen.configuration.issuerNames, consumers: frozen.configuration.consumers.map(consumer => ({ service: consumer.service, externalId: consumer.externalId, keys: Object.keys(consumer.envVarHashes),
            valueEvidence: Array.isArray(record(frozen.configuration.privateState?.writeOnlyKeys)[consumer.service]) && (record(frozen.configuration.privateState?.writeOnlyKeys)[consumer.service] as unknown[]).length ? 'acknowledgement' : 'readback' })) } };
        environments.updatePlatformBindings(environment.id, { credentialUpdates: { ...record(latestEnvironment.platformBindings.credentialUpdates), [frozen.descriptor.role]: accepted } });
        if (record(record(environments.findById(environment.id)?.platformBindings.credentialUpdates)[frozen.descriptor.role]).acceptedInputHash !== accepted.acceptedInputHash) throw new RotationError('Native credential acceptance was not durably recorded. Recovery is preserved.');
        state.phase = 'installed'; save(component, state);
        return { success: true, message: 'The database credential and issuer references are installed. Exact consumer activation, old deployment drainage and application authentication remain pending or unchecked.', data: evidence };
      } catch (error) { return { success: false, status: 'blocked', message: error instanceof RotationError ? error.message : 'Native database rotation could not verify its boundary. Recovery is preserved; no secret or provider diagnostic was returned.' }; }
    } });
}
