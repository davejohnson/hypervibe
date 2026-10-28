import { applyDatabasePasswordRotation, planDatabasePasswordRotation, pendingDatabasePasswordRotation } from './database-password-rotation.service.js';
import { validateCredential, credentialManagement, type CredentialValidation } from '../registry/credential-validation.registry.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import type { CredentialTracking } from '../spec/credential.schema.js';
import { PlanService, type EnvironmentPlan, type PlanOptions } from '../plan/plan.service.js';
import { registryCredentialLifecycle } from '../ports/registry-credential.port.js';
import { ConvergeExecutor, type PlanRunDocument, type ActionResult } from '../plan/converge.executor.js';
import { credentialActionId, credentialActionMetadataSchema, CREDENTIAL_OPERATION, type CredentialTarget } from '../plan/credential-plan.contract.js';
import { hasPendingDatabaseBootstrap } from '../plan/database-bootstrap.contract.js';
import { hasPendingDatabaseInitialization } from '../plan/database-initialization.contract.js';
import { scopedSecretObservation } from '../plan/scoped-secrets.js';
import { hashEnvValue, type ObservedState } from '../ports/observe.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { resolveSecretValueRef } from '../services/secret-value-ref.js';
import { deriveHypervibeSecretValue } from '../services/hypervibe-secret-value.js';
import { adapterFactory } from '../services/adapter.factory.js';
import { syncHostingEnvVars } from '../services/hosting-env.service.js';
import { parseDelegatedSecretBindings, immutableSecretConflict } from '../services/delegated-secret.service.js';
import { recordRuntimeRolloutRequirements, parseRuntimeRolloutBindings } from '../services/runtime-rollout.service.js';
import { getGitHubAdapter } from '../services/github-ops.service.js';
import { parseGitHubDelegatedBindings, githubDelegatedSecretActionId } from './github-infrastructure.service.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { githubActionsCanonicalEnvironment } from '../spec/devops-selection.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { credentialRuntimeServices, credentialConsumerValue, type CredentialConsumerTemplate } from './credential-runtime-consumers.js';
import { reviewStripeWebhookCredential, revalidateStripeWebhookCredential, acceptStripeWebhookCredential, type StripeWebhookCredentialEndpoint } from './stripe-webhook-credential.service.js';
type CommandContext = { repos: { environments: EnvironmentRepository; runs: RunRepository; services: ServiceRepository } };
const createCommandContext = (): CommandContext => ({ repos: { environments: new EnvironmentRepository(), runs: new RunRepository(), services: new ServiceRepository() } });

type Validation = CredentialValidation;
type Frozen = { value: string; descriptor: CredentialTracking; validation: Validation; webhook?: StripeWebhookCredentialEndpoint; consumerTemplates?: Record<string, Record<string, CredentialConsumerTemplate>>; before: Record<string, Record<string, string | null>>; presenceBefore?: Record<string, Record<string, boolean>>; reviewedActions: PlanRunDocument['actions']; lockEnvironmentIds: string[] };
type Progress = { planId: string; state: 'pending' | 'accepted'; attempted: string[]; acknowledged?: string[]; registryEvidence?: Record<string, 'readback' | 'acknowledgement'>; registryBaselines?: Record<string, { state: 'present' | 'absent' | 'unknown'; deploymentId?: string; activeDeploymentIds?: string[] }>; hostingEvidence?: Record<string, 'readback' | 'acknowledgement'>; hostingHashes?: Record<string, Record<string, string>>; acceptedInputHash?: string; completed: string[]; acceptedAt?: string; validation?: Validation; descriptor?: CredentialTracking };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
function progress(env: Environment, role: string): Progress | undefined { return obj(env.platformBindings.credentialUpdates)[role] as Progress | undefined; }
export function pendingCredentialUpdate(projectId: string): string | undefined {
  const databaseRotation = pendingDatabasePasswordRotation(projectId);
  if (databaseRotation) return databaseRotation;
  for (const env of new EnvironmentRepository().findByProjectId(projectId)) {
    for (const value of Object.values(obj(env.platformBindings.credentialUpdates))) {
      const update = obj(value);
      if (update.state === 'pending' && typeof update.planId === 'string') return update.planId;
    }
  }
  return undefined;
}
/** Local deletion must not discard the only recovery intent or activation
 * evidence. Strict activation records require verified transfer/retirement;
 * local deletion itself has no provider evidence to establish that. */
export function credentialRecoveryDeletionOwners(projectId: string, selection: { environment?: string; service?: string }): string[] {
  return new EnvironmentRepository().findByProjectId(projectId).filter(environment => {
    if (selection.environment && environment.name !== selection.environment) return false;
    const bindings = environment.platformBindings;
    if (Object.values(obj(bindings.credentialUpdates)).some(value => obj(value).state === 'pending')) return true;
    if (new ComponentRepository().findByEnvironmentId(environment.id).some(component => component.bindings.credentialRotation !== undefined
      || component.bindings.credentialAliasRepair !== undefined || hasPendingDatabaseBootstrap(component.bindings)
      || hasPendingDatabaseInitialization(component.bindings))) return true;
    if (bindings.runtimeRollouts === undefined) return false;
    if (!Array.isArray(bindings.runtimeRollouts)) return true;
    return bindings.runtimeRollouts.some(value => {
      const rollout = obj(value);
      return (rollout.operationId !== undefined || rollout.configurationExpectationEncrypted !== undefined)
        && (!selection.service || !rollout.service || rollout.service === selection.service);
    });
  }).map(environment => environment.name);
}

function save(ctx: CommandContext, env: Environment, role: string, update: Progress) {
  const current = ctx.repos.environments.findById(env.id)!;
  ctx.repos.environments.updatePlatformBindings(env.id, { credentialUpdates: { ...obj(current.platformBindings.credentialUpdates), [role]: update } });
}

function slotsForRole(spec: ProjectSpec, role: string) {
  const slots = Object.entries(spec.secrets).filter(([, s]) => s.credential?.role === role).sort(([a], [b]) => a.localeCompare(b));
  if (!slots.length) throw new Error('Declare the credential role, source and destinations with hv_spec first.');
  if (slots.some(([key]) => Object.values(spec.environments).some(environment => environment.secretDestinations?.[key])))
    throw new Error('Native secret destinations cannot also declare credential lifecycle authority. Preserve the native reference; no credential source read or rotation is authorized.');
  const descriptor = JSON.parse(JSON.stringify(slots[0][1].credential)) as CredentialTracking;
  if (slots.some(([, s]) => !isDeepStrictEqual(JSON.parse(JSON.stringify(s.credential)), descriptor) || s.ownership !== slots[0][1].ownership)) throw new Error('Every alias of a role must declare the same source, purpose, identity and ownership.');
  if (slots[0][1].ownership === 'delegated' && !descriptor.source && descriptor.kind !== 'database-password') throw new Error('An externally supplied role requires one explicit source reference.');
  const first = slots[0][1];
  if (first.ownership === 'hypervibe' && (descriptor.source || slots.some(([, s]) => s.ownership !== 'hypervibe' || s.generation !== first.generation))) throw new Error('Generated aliases require one generation and no external source.');
  return { slots, descriptor };
}

async function observe(ctx: CommandContext, project: Project, spec: ProjectSpec, target: CredentialTarget): Promise<{ environment: Environment; observed: ObservedState | null; hashes: Record<string, string | null>; presence?: Record<string, boolean>; scopeId?: number; present?: boolean }> {
  const environment = ctx.repos.environments.findById(target.environmentId);
  if (!environment || environment.projectId !== project.id || environment.name !== target.environment) throw new Error('The exact reviewed environment binding is missing.');
  if (target.kind === 'database') return { environment, observed: null, hashes: {}, present: true };
  if (target.kind === 'registry') {
    const adapter = await adapterFactory.getProviderAdapter(target.provider, project);
    const port = adapter.success ? registryCredentialLifecycle(adapter.adapter) : undefined;
    if (!port || !isDeepStrictEqual(await port.inspect(environment, target.service), target.identity)) throw new Error('The exact container image or pull-credential target changed.');
    const envSpec = spec.environments[target.environment];
    if (!envSpec || envSpec.hosting.provider !== target.provider || !envSpec.services[target.service]) throw new Error('The container pull consumer is no longer declared.');
    const { observed } = await new PlanService().observeEnvironment(project, environment, envSpec, { hostingOnly: true });
    return { environment, observed, hashes: { registry: null } };
  }
  if (target.kind === 'github') {
    const result = getGitHubAdapter(target.repository);
    if ('error' in result) throw new Error('A verified connection for the exact repository is required.');
    const [owner, repo] = target.repository.split('/');
    const evidence = await result.adapter.observeSecretInventory(owner, repo, target.scope);
    if (evidence.state !== 'present' || target.scope && evidence.environmentId !== target.scopeId) throw new Error('The GitHub secret scope is absent, replaced or unknown. Inspection never recreates it.');
    return { environment, observed: null, hashes: { github: null }, scopeId: evidence.environmentId, present: evidence.secrets.some(s => s.name.toUpperCase() === target.key.toUpperCase()) };
  }
  const envSpec = spec.environments[target.environment];
  if (!envSpec || envSpec.hosting.provider !== target.provider || envSpec.deploy?.strategy !== 'branch' || envSpec.deploy.trigger !== 'ci') throw new Error('Credential updates require an existing managed-CI environment.');
  if (target.activation) {
    const adapter = await adapterFactory.getProviderAdapter(target.provider, project);
    if (!adapter.success || adapter.adapter?.capabilities.credentialUpdateActivation !== target.activation
      || (adapter.adapter?.capabilities.credentialValueEvidence ?? 'readback') !== target.valueEvidence) throw new Error('The reviewed credential update or evidence capability changed.');
  }
  const names = credentialRuntimeServices(spec, target.environment, target.key, spec.secrets[target.key]?.credential);
  const selected = { ...envSpec, services: Object.fromEntries(names.map(name => [name, envSpec.services[name]])) };
  const { observed } = await new PlanService().observeEnvironment(project, environment, selected, { hostingOnly: true });
  const verified = scopedSecretObservation(environment, selected, observed, target.valueEvidence === 'acknowledgement' ? [] : [target.key]);
  if (verified.targetFingerprint !== target.targetFingerprint || !isDeepStrictEqual(names, target.services)) throw new Error('Credential destination identities changed; re-plan.');
  const presence = Object.fromEntries(target.services.map(name => [name, observed!.services.find(s => s.name === name)!.envVarKeys.includes(target.key)]));
  return { environment, observed, presence, present: Object.values(presence).every(Boolean), hashes: Object.fromEntries(target.services.map(name => {
    const service = observed!.services.find(s => s.name === name)!;
    return [name, service.envVarEvidence === 'recorded-update' ? null : service.envVarHashes[target.key] ?? null];
  })) };
}

export async function planCredentialLifecycle(project: Project, spec: ProjectSpec, revision: number, environmentName: string, options: PlanOptions): Promise<EnvironmentPlan | { error: string }> {
  const ctx = createCommandContext();
  try {
    if (!options.credential || !options.intent || options.secretRefs || options.serviceFilter || options.envVarOverrides || options.envFile || options.includeEnvFile === true) throw new Error('scope="credentials" requires credential=<declared role> and intent="adopt" or "rotate", without other deploy inputs.');
    const { slots, descriptor } = slotsForRole(spec, options.credential);
    const anchor = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
    if (!anchor) throw new Error('Credential review requires an existing environment.');
    for (const env of ctx.repos.environments.findByProjectId(project.id)) {
      const pending = progress(env, descriptor.role);
      if (pending?.state === 'pending') throw new Error(`Credential update is incomplete. Resume hv_apply planId="${pending.planId}"; the frozen replacement must be recovered before another plan.`);
    }
    if (['database-password'].includes(descriptor.kind)) return planDatabasePasswordRotation({ project, spec, revision, environmentName, descriptor, intent: options.intent });
    if (descriptor.kind === 'stripe-webhook' && !descriptor.stripeWebhook) throw new Error('Declare the native Stripe endpoint binding before rotating its signing secret.');
    if (descriptor.kind === 'stripe' && !descriptor.identity?.accountId) throw new Error('Stripe credentials require the intended account or sandbox account ID.');
    if (descriptor.kind === 'github-api-management' && (slots.some(([, slot]) => slot.environments.length > 0) || descriptor.containerPull?.length)) throw new Error('API-management credentials cannot supply runtime or container-pull consumers. Declare a separate package-read role.');
    const first = slots[0][1];
    const value = first.ownership === 'hypervibe'
      ? deriveHypervibeSecretValue(project.name, environmentName, slots[0][0], first)
      : await resolveSecretValueRef(descriptor.source!, { projectId: project.id, environmentName }).catch(() => { throw new Error('Cannot resolve the declared source. No credential plan was saved.'); });
    if (!value) throw new Error('The declared source is empty.');
    new AuditRepository().create({ action: 'credential.source.read', resourceType: 'credential-role', resourceId: `${project.id}/${descriptor.role}`, details: { role: descriptor.role, source: descriptor.source ?? 'hypervibe-generator', aliases: slots.map(([key]) => key), ownership: first.ownership, principals: [...new Set(slots.map(([, slot]) => slot.ownership === 'delegated' ? slot.principal : 'hypervibe'))] } });
    const webhookReview = descriptor.kind === 'stripe-webhook' ? await reviewStripeWebhookCredential({ project, spec, descriptor, value }) : undefined;
    const validation = webhookReview?.validation ?? await validateCredential(descriptor, value);
    if (validation.at) validation.evidenceId = new AuditRepository().create({ action: 'credential.validated', resourceType: 'credential-role', resourceId: `${project.id}/${descriptor.role}`, details: { ...validation, subject: 'candidate-plan-input' } }).id;
    if (validation.result === 'failed' || descriptor.kind === 'stripe' && validation.result !== 'passed') throw new Error('Credential validation failed or intended account/sandbox identity could not be verified. No plan was saved.');
    const targets: CredentialTarget[] = [];
    const nativeRegistryConsumers: Array<Record<string, unknown>> = [];
    const registryGuidance: string[] = [];
    const before: Frozen['before'] = {};
    const presenceBefore: NonNullable<Frozen['presenceBefore']> = {};
    const consumerTemplates: NonNullable<Frozen['consumerTemplates']> = {};
    if (descriptor.containerPull?.length && options.intent === 'adopt') throw new Error('Adoption cannot prove a write-only container-pull credential matches; review an explicit rotation.');
    if (descriptor.containerPull?.length && descriptor.kind !== 'github-package-read' && descriptor.kind !== 'opaque') throw new Error('Container pulls require a separate package-read credential, never an API-management role.');
    for (const pull of descriptor.containerPull ?? []) {
      const environment = ctx.repos.environments.findByProjectAndName(project.id, pull.environment);
      const envSpec = spec.environments[pull.environment];
      if (!environment || !envSpec || !envSpec.services[pull.service]) throw new Error('The declared container-pull consumer has no exact existing binding.');
      const adapter = await adapterFactory.getProviderAdapter(envSpec.hosting.provider, project);
      const port = adapter.success ? registryCredentialLifecycle(adapter.adapter) : undefined;
      if (!port) {
        const model = adapter.adapter?.capabilities.registryCredentialModel;
        const guidance = adapter.adapter?.capabilities.registryCredentialGuidance;
        if (!adapter.success || !model || !guidance) throw new Error(`${envSpec.hosting.provider} has no verified container-pull credential model.`);
        const bindings = parseHostingBindings(environment);
        if (bindings.provider !== envSpec.hosting.provider || !bindings.projectId || !bindings.services?.[pull.service]?.serviceId) throw new Error('The native registry consumer has no exact existing workload binding.');
        nativeRegistryConsumers.push({ kind: 'container-pull', environment: pull.environment, service: pull.service, provider: envSpec.hosting.provider,
          providerProjectId: bindings.projectId, providerEnvironmentId: bindings.environmentId, serviceId: bindings.services[pull.service].serviceId,
          credentialModel: model, passwordCopy: 'not-applicable', nextAction: guidance });
        registryGuidance.push(`${pull.environment}/${pull.service}: ${guidance}`);
        continue;
      }
      const identity = await port.inspect(environment, pull.service);
      targets.push({ kind: 'registry', environment: pull.environment, environmentId: environment.id, provider: envSpec.hosting.provider, key: slots[0][0], service: pull.service, username: pull.username, identity });
    }
    for (const [key, slot] of slots) {
      for (const name of [...slot.environments].sort()) {
        const environment = ctx.repos.environments.findByProjectAndName(project.id, name);
        const envSpec = spec.environments[name];
        if (!environment || !envSpec) throw new Error('Every declared runtime consumer must have an existing environment binding.');
        const services = credentialRuntimeServices(spec, name, key, descriptor);
        if (!services.length) continue;
        const selected = { ...envSpec, services: Object.fromEntries(services.map(service => [service, envSpec.services[service]])) };
        const adapter = await adapterFactory.getProviderAdapter(envSpec.hosting.provider, project);
        const activation = adapter.adapter?.capabilities.credentialUpdateActivation;
        const valueEvidence = adapter.adapter?.capabilities.credentialValueEvidence ?? 'readback';
        if (!adapter.success || !activation) throw new Error(`${envSpec.hosting.provider} has no reviewed credential update capability.`);
        const { observed } = await new PlanService().observeEnvironment(project, environment, selected, { hostingOnly: true });
        const evidence = scopedSecretObservation(environment, selected, observed, valueEvidence === 'acknowledgement' ? [] : [key]);
        const target: CredentialTarget = { kind: 'hosting', provider: envSpec.hosting.provider, environment: name, environmentId: environment.id, key, services, targetFingerprint: evidence.targetFingerprint, activation, valueEvidence };
        targets.push(target);
      }
      if (slot.ownership !== 'delegated' || !slot.githubActions) continue;
      const repository = spec.github?.repository ?? parseGitHubRepoFromRemote(spec.gitRemoteUrl ?? project.gitRemoteUrl);
      const canonical = githubActionsCanonicalEnvironment(spec);
      const environment = canonical && ctx.repos.environments.findByProjectAndName(project.id, canonical);
      if (!repository || !environment) throw new Error('GitHub consumers require an exact repository and existing canonical environment.');
      const result = getGitHubAdapter(repository);
      if ('error' in result) throw new Error('A verified GitHub management connection is required; package-read credentials do not authorize management.');
      const [owner, repo] = repository.split('/');
      for (const scope of [...(slot.githubActions.repository ? [undefined] : []), ...slot.githubActions.environments]) {
        const evidence = await result.adapter.observeSecretInventory(owner, repo, scope);
        if (evidence.state !== 'present') throw new Error('A declared GitHub repository/environment is absent or unknown. No infrastructure will be created.');
        if (options.intent === 'adopt') throw new Error('Adoption cannot prove a write-only GitHub value matches the source. Preserve it and review an explicit rotation.');
        targets.push({ kind: 'github', provider: 'github', environment: environment.name, environmentId: environment.id, key, repository, ...(scope ? { scope, scopeId: evidence.environmentId } : {}) });
      }
    }
    if (!targets.length) throw new Error(registryGuidance.length ? `This role has no password-copy destinations. ${registryGuidance.join(' ')} Declare its actual build or CI consumers before reviewing synchronization.` : 'The role has no reviewed destinations.');
    const actions: PlanRunDocument['actions'] = [];
    for (const target of targets) {
      const evidence = await observe(ctx, project, spec, target);
      const id = credentialActionId(descriptor.role, target);
      before[id] = evidence.hashes;
      if (evidence.presence) presenceBefore[id] = evidence.presence;
      const matches = target.kind === 'hosting' && target.services.every(service => evidence.hashes[service] === hashEnvValue(credentialConsumerValue(value, consumerTemplates[id]?.[service])));
      if (options.intent === 'adopt' && target.kind !== 'database' && !matches) throw new Error('Adoption requires every existing destination to match the source; a differing local value is a candidate replacement. Review intent="rotate" separately.');
      const accepted = progress(evidence.environment, descriptor.role);
      const binding = parseDelegatedSecretBindings(evidence.environment).find(b => b.name === target.key);
      const slot = spec.secrets[target.key];
      if (target.kind === 'hosting' && slot.ownership === 'hypervibe' && slot.replacementPolicy === 'immutable') {
        const conflict = immutableSecretConflict({ environment: evidence.environment, observed: evidence.observed, serviceNames: target.services, conflictsWith: slot.conflictsWith ?? [] });
        if (conflict || !matches && (binding || Object.values(evidence.hashes).some(hash => hash !== null))) throw new Error('Immutable generated secrets cannot replace existing values or coexist with unresolved legacy keys.');
      }
      let recordedMatch = false;
      if (accepted?.state === 'accepted' && accepted.planId) {
        const previousPlan = obj(ctx.repos.runs.findById(accepted.planId)?.plan);
        const encrypted = obj(previousPlan.overrides).delegatedSecretVarsEncrypted;
        if (typeof encrypted === 'string') {
          const previous = getSecretStore().decryptObject<Frozen>(encrypted);
          const priorAction = previous.reviewedActions.find(a => a.id === id);
          const priorTarget = priorAction?.metadata?.target as CredentialTarget | undefined;
          if (target.kind === 'github' && priorTarget?.kind === 'github' && priorTarget.scopeId !== target.scopeId) throw new Error('The GitHub environment was replaced. Review its identity before synchronizing credentials.');
          recordedMatch = previous.value === value && isDeepStrictEqual(priorTarget, target) && accepted.completed.includes(id) && evidence.present !== false;
        }
      }
      const expectedBindingHash = hashEnvValue(target.kind === 'hosting' ? credentialConsumerValue(value, consumerTemplates[id]?.[target.services[0]]) : value);
      const noop = (matches && binding?.valueHash === expectedBindingHash || (target.kind !== 'hosting' || target.valueEvidence === 'acknowledgement') && recordedMatch) && accepted?.state === 'accepted' && isDeepStrictEqual(accepted.descriptor, descriptor);
      actions.push({ id, type: noop ? 'noop' : 'update', resource: { kind: 'secret', name: target.key, provider: target.provider }, verified: true, requiresConfirm: true,
        ...(target.kind === 'database' ? { dataBearing: options.intent === 'rotate' } : {}),
        reason: `${options.intent === 'adopt' ? 'Adopt existing' : 'Synchronize replacement for'} ${descriptor.label}: ${target.key} in ${target.kind === 'database' ? `${target.environment}: native database authentication for ${target.identity.username}; old password is replaced for new connections` : target.kind === 'hosting' ? `${target.environment} (${target.services.join(', ')}); ${target.activation === 'provider-rollout' ? 'provider configuration rollout starts during this action' : 'activation waits for managed rollout'}` : target.kind === 'registry' ? `${target.environment}/${target.service} container pull (${target.identity.image}); ${target.identity.activation === 'provider-rollout' ? 'provider configuration rollout starts during this action' : 'activation waits for managed rollout'}` : `${target.repository}/${target.scope ?? 'repository'}`}.`,
        metadata: { operation: CREDENTIAL_OPERATION, role: descriptor.role, intent: options.intent, target } });
    }
    const management = credentialManagement(descriptor);
    const warnings = [`Credential validation: ${validation.result}. ${validation.tested}`, ...(management ? [`Manage or create a replacement: ${management.creationUrl}`] : []), 'Configuration acceptance, deployment, credential authentication and application operation are separate outcomes. Old credential revocation remains pending until all consumers and old instances are verified.',
      ...(descriptor.kind === 'session-signing' ? ['Replacing this signing secret can sign users out and invalidate sessions or JWTs.'] : [])];
    if (webhookReview) warnings.push(...webhookReview.warnings, `${webhookReview.guidance.action} ${webhookReview.guidance.managementUrl}`);
    warnings.push(...registryGuidance);
    const lockEnvironmentIds = [...new Set([anchor.id, ...targets.map(t => t.environmentId), ...(webhookReview ? [webhookReview.endpoint.environmentId] : [])])].sort();
    const frozen: Frozen = { value, descriptor, validation, webhook: webhookReview?.endpoint, consumerTemplates, before, presenceBefore, reviewedActions: actions, lockEnvironmentIds };
    const credentialReview: EnvironmentPlan['credentialReview'] = { role: descriptor.role, label: descriptor.label, purpose: descriptor.purpose, intent: options.intent, source: descriptor.source, identity: descriptor.identity, validation,
      targets: targets.map(target => {
        if (target.kind !== 'hosting') return { ...target };
        const binding = parseHostingBindings(ctx.repos.environments.findById(target.environmentId));
        return { kind: target.kind, provider: target.provider, environment: target.environment, key: target.key, activation: target.activation, valueEvidence: target.valueEvidence,
          providerProjectId: binding.projectId, providerEnvironmentId: binding.environmentId,
          services: target.services.map(name => ({ name, serviceId: binding.services?.[name]?.serviceId ?? binding.services?.[name]?.jobName })) };
      }) };
    if (webhookReview) credentialReview.targets.push({ kind: 'stripe-webhook', ...webhookReview.endpoint, managementUrl: webhookReview.guidance.managementUrl });
    credentialReview.targets.push(...nativeRegistryConsumers);
    const document: PlanRunDocument = { kind: 'hv_plan', scope: 'credentials', environmentName, specRevision: revision, observedFingerprint: null, actions, warnings,
      credentialReview,
      lockEnvironmentIds,
      overrides: { delegatedSecretVarsEncrypted: getSecretStore().encryptObject(frozen) } };
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: anchor.id, type: 'plan', plan: document as unknown as Record<string, unknown> });
    ctx.repos.runs.updateStatus(run.id, 'succeeded');
    return { scope: 'credentials', credentialReview, planRunId: run.id, environmentName, specRevision: revision, verified: true, observed: null, actions, warnings, unmanaged: [], inputRequired: [], blocked: [] };
  } catch (error) { return { error: error instanceof Error ? error.message : 'Cannot review this credential update.' }; }
}

export async function applyCredentialLifecycle(ctx: CommandContext, params: { project: Project; spec: ProjectSpec; specRevision: number; planId: string; confirmActions?: string[] }) {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) throw new Error(loaded.error);
  if (loaded.run.projectId !== params.project.id) throw new Error('Credential plan belongs to another project.');
  if (loaded.document.actions.some(action => action.metadata?.operation === 'databasePasswordRotate')) return applyDatabasePasswordRotation(params);
  const frozen = getSecretStore().decryptObject<Frozen>(loaded.document.overrides!.delegatedSecretVarsEncrypted!);
  if (!isDeepStrictEqual(frozen.reviewedActions, loaded.document.actions) || !isDeepStrictEqual(frozen.lockEnvironmentIds, loaded.document.lockEnvironmentIds)) throw new Error('Credential plan authority differs from its frozen review. No writes are authorized.');
  if (frozen.descriptor.kind === 'database-password') throw new Error('Legacy native database-password plans lack the complete issuer/reference/consumer recovery authority. Their frozen input and progress are preserved; do not replay password updates.');
  const { descriptor } = slotsForRole(params.spec, frozen.descriptor.role);
  if (!isDeepStrictEqual(descriptor, frozen.descriptor)) throw new Error('Credential declaration changed; re-plan.');
  const expectedConfiguration = (environmentId: string, service: string) => ({ [service]: {
    operationId: params.planId,
    envVarHashes: Object.fromEntries(frozen.reviewedActions.flatMap(action => {
      const target = credentialActionMetadataSchema.parse(action.metadata).target;
      return target.kind === 'hosting' && target.environmentId === environmentId && target.services.includes(service)
        ? [[target.key, hashEnvValue(credentialConsumerValue(frozen.value, frozen.consumerTemplates?.[action.id]?.[service]))]] : [];
    })),
  } });
  const recovering = frozen.lockEnvironmentIds.some(id => {
    const env = ctx.repos.environments.findById(id);
    return env && progress(env, descriptor.role)?.planId === params.planId && progress(env, descriptor.role)?.state === 'pending';
  });
  let result = await executor.execute({ planRunId: params.planId, currentSpecRevision: params.specRevision, confirmActions: params.confirmActions,
    ...(recovering ? { maxPlanAgeMs: Number.POSITIVE_INFINITY } : {}),
    handler: async (action, execution): Promise<ActionResult> => {
      const { target, role, intent } = credentialActionMetadataSchema.parse(action.metadata);
      let evidence: Awaited<ReturnType<typeof observe>>;
      try { evidence = await observe(ctx, params.project, params.spec, target); }
      catch { return { success: false, status: 'blocked', message: 'The exact destination cannot be verified. No write was attempted.' }; }
      if (frozen.webhook) await revalidateStripeWebhookCredential({ project: params.project, spec: params.spec, descriptor, reviewed: frozen.webhook });
      let state = progress(evidence.environment, role);
      if (state?.state === 'pending' && state.planId !== params.planId) return { success: false, status: 'blocked', message: `Recover credential plan ${state.planId} first.` };
      state = state?.planId === params.planId ? state : { planId: params.planId, state: 'pending', attempted: [], completed: [], descriptor, validation: frozen.validation };
      // Persist at the effect boundary. A failed read or stale precondition
      // alone must not create recovery state for a write never attempted.
      const complete = () => {
        state!.completed = [...new Set([...state!.completed, action.id])];
        save(ctx, evidence.environment, role, state!);
      };
      if (target.kind === 'database') {
        return { success: false, status: 'blocked', message: 'Native database credentials require the reviewed authentication and complete consumer configuration actions.' };
      }
      if (target.kind === 'registry') {
        if (state.completed.includes(action.id)) return { success: true, message: 'Retained completed container-pull synchronization and its recorded evidence; no write repeated.' };
        const adapter = await adapterFactory.getProviderAdapter(target.provider, params.project);
        const port = adapter.success ? registryCredentialLifecycle(adapter.adapter) : undefined;
        if (!port) return { success: false, status: 'blocked', message: 'Container-pull credential capability is unavailable.' };
        const uncertain = state.attempted.includes(action.id);
        const acknowledged = state.acknowledged?.includes(action.id) === true;
        if (uncertain && !acknowledged && !port.reconcile && !params.confirmActions?.includes(`${action.id}:retry-uncertain`)) return { success: false, status: 'pending', message: `This destination is write-only and its earlier write is uncertain. Inspect the native operation, then explicitly confirm ${action.id}:retry-uncertain to replay the same frozen input.` };
        const operationId = createHash('sha256').update(params.planId).update('\0').update(action.id).digest('hex');
        const currentService = evidence.observed?.services.find(service => service.name === target.service);
        const deploymentId = currentService?.deployment?.id ?? currentService?.maintenance?.deploymentId;
        state.registryBaselines = { ...state.registryBaselines, [action.id]: state.registryBaselines?.[action.id] ?? {
          state: deploymentId ? 'present' : currentService?.status === 'empty' ? 'absent' : 'unknown', ...(deploymentId ? { deploymentId } : {}),
          ...(currentService?.deployment?.activeDeploymentIds ? { activeDeploymentIds: currentService.deployment.activeDeploymentIds } : {}),
        } };
        state.attempted = [...new Set([...state.attempted, action.id])]; save(ctx, evidence.environment, role, state);
        const credential = { username: target.username, token: frozen.value };
        const receipt = acknowledged ? { success: true, message: 'Recovered an acknowledged registry write without repeating it.', data: { credentialValueEvidence: state.registryEvidence?.[action.id] ?? 'acknowledgement', mutationAttempted: false } }
          : uncertain && port.reconcile ? await port.reconcile(evidence.environment, target.service, target.identity, credential, { operationId, retryUncertain: true })
          : await port.update(evidence.environment, target.service, target.identity, credential, { operationId, retryUncertain: uncertain });
        if (receipt.success) {
          state.acknowledged = [...new Set([...(state.acknowledged ?? []), action.id])];
          state.registryEvidence = { ...state.registryEvidence, [action.id]: receipt.data?.credentialValueEvidence === 'readback' ? 'readback' : 'acknowledgement' };
          save(ctx, evidence.environment, role, state);
        } else if (!uncertain && receipt.data?.mutationAttempted === false) {
          state.attempted = state.attempted.filter(id => id !== action.id);
          if (state.attempted.length || state.completed.length) save(ctx, evidence.environment, role, state);
          else {
            const updates = { ...obj(ctx.repos.environments.findById(evidence.environment.id)!.platformBindings.credentialUpdates) }; delete updates[role];
            ctx.repos.environments.updatePlatformBindings(evidence.environment.id, { credentialUpdates: updates });
          }
          return { success: false, status: 'blocked', message: 'The registry destination could not be verified. The provider confirmed no write was attempted.' };
        }
        const currentEnvironment = ctx.repos.environments.findById(evidence.environment.id)!;
        const retained = parseRuntimeRolloutBindings(currentEnvironment).some(binding => binding.provider === target.provider && binding.service === target.service && binding.actionIds.includes(action.id)
          && obj(ctx.repos.runs.findById(binding.applyRunId)?.plan).planRunId === params.planId);
        if (!retained) recordRuntimeRolloutRequirements({ environment: currentEnvironment, provider: target.provider, observed: evidence.observed,
          actions: [{ ...action, metadata: { ...action.metadata, services: [target.service] } }], receipts: [{ actionId: action.id, status: receipt.success ? 'succeeded' : 'pending', data: {
            runtimeRolloutRequired: true, services: [target.service], rolloutBaseline: state.registryBaselines[action.id],
          } }], includeUncertainWrites: true, applyRunId: execution.applyRunId });
        if (!receipt.success) return { success: false, status: 'pending', message: 'Container-pull credential write was not confirmed. Inspect before retrying.' };
        complete();
        return { success: true, message: 'Container-pull configuration synchronized. Managed deployment and image acquisition verification remain required.', data: { configurationUpdated: true,
          credentialValueEvidence: state.registryEvidence?.[action.id] ?? 'acknowledgement', credentialUpdateActivation: target.identity.activation ?? 'deferred', runtimeActivation: 'unknown', imagePull: 'unknown', credentialAuthentication: frozen.validation.result, revocation: 'pending' } };
      }
      if (target.kind === 'github') {
        if (state.completed.includes(action.id)) return { success: true, message: 'Prior acknowledged synchronization retained; current value remains write-only.' };
        if (state.attempted.includes(action.id) && !params.confirmActions?.includes(`${action.id}:retry-uncertain`)) return { success: false, status: 'pending', message: `An earlier GitHub write is uncertain. Current values are write-only. After reviewing the provider operation, explicitly include ${action.id}:retry-uncertain in confirmActions to repeat the frozen write; no new credential is generated.` };
        state.attempted.push(action.id); save(ctx, evidence.environment, role, state);
        const adapter = getGitHubAdapter(target.repository);
        if ('error' in adapter) return { success: false, status: 'blocked', message: 'GitHub management connection unavailable.' };
        const [owner, repo] = target.repository.split('/');
        try {
          if (target.scope) await adapter.adapter.setEnvironmentSecret(owner, repo, target.scope, target.key, frozen.value, { expectedEnvironmentId: target.scopeId! });
          else await adapter.adapter.setRepositorySecret(owner, repo, target.key, frozen.value);
        } catch { return { success: false, status: 'pending', message: 'GitHub synchronization outcome is uncertain; the value cannot be read back.' }; }
        const env = ctx.repos.environments.findById(evidence.environment.id)!;
        const slot = params.spec.secrets[target.key];
        if (slot.ownership !== 'delegated') return { success: false, status: 'blocked', message: 'GitHub secret ownership changed.' };
        const targetKey = target.scope ? `environment:${target.scope}` : 'repository';
        const bindings = parseGitHubDelegatedBindings(env).filter(b => b.name !== target.key || b.target !== targetKey);
        bindings.push({ name: target.key, target: targetKey, principal: slot.principal, valueHash: hashEnvValue(frozen.value), syncedAt: new Date().toISOString(), actionId: githubDelegatedSecretActionId(target.key, target.scope ? { scope: 'environment', environment: target.scope } : { scope: 'repository' }) });
        ctx.repos.environments.updatePlatformBindings(env.id, { github: { ...obj(env.platformBindings.github), delegatedActionsBindings: bindings } });
        complete();
        return { success: true, message: 'GitHub acknowledged the write. Presence and recorded synchronization do not prove its current value.', data: { configurationUpdated: true, runtimeActivation: 'unknown', credentialAuthentication: frozen.validation.result, applicationOperation: 'unknown', revocation: 'pending' } };
      }
      const values = Object.fromEntries(target.services.map(service => [service, credentialConsumerValue(frozen.value, frozen.consumerTemplates?.[action.id]?.[service])]));
      const expectedByService = Object.fromEntries(target.services.map(service => [service, hashEnvValue(values[service])]));
      for (const name of target.services) {
        const expected = expectedByService[name];
        const attempt = `${action.id}:${name}`;
        evidence = await observe(ctx, params.project, params.spec, target);
        const current = evidence.hashes[name];
        const acknowledged = target.valueEvidence === 'acknowledgement' && evidence.presence?.[name]
          && (state.completed.includes(action.id) || state.acknowledged?.includes(attempt));
        if (current === expected || acknowledged) {
          // Recover a provider write whose local rollout receipt was interrupted.
          // Fresh readback becomes a conservative baseline, never activation proof.
          const recorded = parseRuntimeRolloutBindings(evidence.environment).some(binding => binding.service === name
            && binding.provider === target.provider && binding.actionIds.includes(action.id)
            && obj(ctx.repos.runs.findById(binding.applyRunId)?.plan).planRunId === params.planId);
          if (state.attempted.includes(attempt) && !recorded) recordRuntimeRolloutRequirements({
            environment: evidence.environment, provider: target.provider, observed: evidence.observed,
            actions: [{ ...action, metadata: { ...action.metadata, services: [name] } }],
            receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true, services: [name], credentialKeys: [target.key], credentialValueEvidence: target.valueEvidence, configurationUpdated: true } }], applyRunId: execution.applyRunId,
            expectedConfiguration: expectedConfiguration(target.environmentId, name),
          });
          continue;
        }
        if (intent === 'adopt') return { success: false, status: 'blocked', message: 'Adoption stopped because the existing value no longer matches; no replacement was written.' };
        if (state.attempted.includes(attempt) && !params.confirmActions?.includes(`${action.id}:retry-uncertain`)) return { success: false, status: 'pending', message: `An earlier write remains uncertain. Inspect convergence before retrying. Explicitly include ${action.id}:retry-uncertain in confirmActions to retry the same frozen value after review.` };
        if (current !== frozen.before[action.id]?.[name]) return { success: false, status: 'blocked', message: 'A destination changed after review. No unreviewed value will be overwritten.' };
        if (frozen.presenceBefore?.[action.id] && evidence.presence?.[name] !== frozen.presenceBefore[action.id][name]) return { success: false, status: 'blocked', message: 'Selected-key presence changed after review. Reconcile the exact destination before writing.' };
        const service = ctx.repos.services.findByProjectId(params.project.id).find(s => s.name === name);
        if (!service) return { success: false, status: 'blocked', message: 'Reviewed service identity is missing.' };
        state.attempted.push(attempt); save(ctx, evidence.environment, role, state);
        const receipt = await syncHostingEnvVars({ project: params.project, environment: evidence.environment, service, vars: { [target.key]: values[name] },
          ...(target.activation ? { requireCredentialUpdate: true, deferDeployment: target.activation === 'deferred' } : { deferDeployment: true, requireDeferredSecretUpdate: true }) });
        if (receipt.success) {
          state.acknowledged = [...new Set([...(state.acknowledged ?? []), attempt])];
          save(ctx, evidence.environment, role, state);
        }
        // Retain the baseline even if the provider reply was lost. It is a requirement,
        // never proof that this attempted mutation succeeded or reached the runtime.
        const after = await observe(ctx, params.project, params.spec, target).catch(() => null);
        recordRuntimeRolloutRequirements({ environment: ctx.repos.environments.findById(evidence.environment.id)!, provider: target.provider, observed: after?.observed ?? null,
          actions: [{ ...action, metadata: { ...action.metadata, services: [name] } }],
          receipts: [{ actionId: action.id, status: receipt.success || after?.hashes[name] === expected ? 'succeeded' : 'pending',
            data: { ...receipt.data, runtimeRolloutRequired: true, services: [name], credentialKeys: [target.key], credentialValueEvidence: target.valueEvidence, configurationUpdated: receipt.success || after?.hashes[name] === expected } }],
          expectedConfiguration: expectedConfiguration(target.environmentId, name), includeUncertainWrites: true, applyRunId: execution.applyRunId });
        if (after?.hashes[name] !== expected && !(receipt.success && target.valueEvidence === 'acknowledgement' && after?.presence?.[name])) return { success: false, status: 'pending', message: receipt.success ? 'Configuration accepted; readback is still pending.' : 'Write outcome is uncertain; readback must confirm before retrying.' };
      }
      const env = ctx.repos.environments.findById(evidence.environment.id)!;
      const slot = params.spec.secrets[target.key];
      const now = new Date().toISOString();
      state.hostingEvidence = { ...state.hostingEvidence, [target.key]: target.valueEvidence ?? 'readback' };
      state.hostingHashes = { ...state.hostingHashes, [target.key]: expectedByService };
      state.acceptedInputHash = hashEnvValue(frozen.value);
      const binding = { name: target.key, principal: slot.ownership === 'delegated' ? slot.principal : 'hypervibe', valueHash: expectedByService[target.services[0]], syncedAt: now, applyRunId: execution.applyRunId, actionId: action.id,
        ...(slot.ownership === 'hypervibe' ? { source: 'hypervibe-generated', generator: slot.generator, generation: slot.generation, ...(slot.replacementPolicy === 'immutable' ? { replacementPolicy: 'immutable', conflictsWith: slot.conflictsWith ?? [] } : {}) } : { source: 'delegated-plan-input' }) };
      save(ctx, env, role, state);
      ctx.repos.environments.updatePlatformBindings(env.id, { delegatedEnvBindings: [...parseDelegatedSecretBindings(env).filter(b => b.name !== target.key), binding] });
      complete();
      return { success: true, message: intent === 'adopt' ? 'Existing value adopted without provider mutations.' : 'Configuration synchronized. Managed rollout and application verification remain pending.', data: { environmentId: target.environmentId, configurationUpdated: intent === 'rotate', adopted: intent === 'adopt', credentialAuthentication: frozen.validation.result, applicationOperation: 'unknown', revocation: 'pending' } };
    } });
  if (recovering && result.conflict?.kind === 'already_applied') {
    const completed = ctx.repos.runs.findById(result.conflict.runId);
    if (completed?.projectId === params.project.id && completed.status === 'succeeded'
      && obj(completed.plan).planRunId === params.planId && loaded.document.actions.every(action => action.type === 'noop'
        || completed.receipts.some(receipt => receipt.step === action.id && receipt.status === 'success'))) {
      // Provider effects and their receipts are already durable. Finish only the
      // interrupted acceptance metadata; never replay a successful plan.
      result = { success: true, applyRunId: completed.id, receipts: completed.receipts.map(receipt => ({
        actionId: receipt.step, status: 'succeeded' as const, message: 'Recovered recorded synchronization; no provider write repeated.',
      })) };
    }
  }
  if (result.success) {
    if (frozen.webhook) await acceptStripeWebhookCredential({ project: params.project, spec: params.spec, descriptor, value: frozen.value, reviewed: frozen.webhook });
    for (const id of loaded.document.lockEnvironmentIds ?? []) {
      const env = ctx.repos.environments.findById(id)!;
      const state = progress(env, descriptor.role);
      if (state?.planId === params.planId) {
        // A mixed repair can retain acknowledged aliases as noops. Carry their
        // reviewed coverage into the new accepted input, without another write.
        const retained = loaded.document.actions.filter(action => action.type === 'noop'
          && credentialActionMetadataSchema.parse(action.metadata).target.environmentId === id).map(action => action.id);
        save(ctx, env, descriptor.role, { ...state, completed: [...new Set([...state.completed, ...retained])],
          state: 'accepted', acceptedAt: new Date().toISOString(), descriptor, validation: frozen.validation });
      }
    }
  }
  return result;
}
