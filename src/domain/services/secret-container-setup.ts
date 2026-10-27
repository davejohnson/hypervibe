import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from '../../application/context.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { normalizeGitRemoteIdentity } from '../../lib/git-remote.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { adapterFactory } from './adapter.factory.js';
import { secretDestinationIdentity } from '../ports/secret-destination.port.js';
import { SECRET_DESTINATION_PREPARE, secretContainerActionMetadataSchema, secretContainerBindings, secretContainerScopeDigest,
  type SecretContainerBinding, type SecretContainerIntent, type SecretContainerObservation } from '../ports/secret-destination-lifecycle.port.js';
import { writeRepoBindingsForEnvironment } from '../spec/repo-bindings-file.js';
import { SpecStore } from '../spec/spec.store.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';

function ownerFor(project: Project, spec: ProjectSpec, environment: string, key: string) {
  const repository = normalizeGitRemoteIdentity(spec.gitRemoteUrl ?? project.gitRemoteUrl ?? undefined)?.toLowerCase();
  if (!repository) throw new Error('Secret container setup requires a canonical repository identity.');
  return { repository, environment, key };
}
function matches(observed: SecretContainerObservation, binding: SecretContainerBinding): boolean {
  return observed.state === 'present' && observed.resource === secretDestinationIdentity(binding.destination).resource
    && observed.attemptId === binding.attemptId && observed.scopeDigest === secretContainerScopeDigest(binding)
    && (binding.state !== 'ready' || observed.createTime === binding.createTime && observed.resource === binding.resource);
}
function environmentScope(value: Environment) {
  const { secretDestinationContainers: _containers, ...scope } = value.platformBindings;
  return scope;
}
async function driverFor(project: Project, provider: string, destinations: Array<SecretContainerIntent['destination']>, environmentName: string) {
  const supported = providerRegistry.getMetadata(provider)?.secretDestinationSetupProviders ?? [];
  if (destinations.some(destination => !supported.includes(destination.provider))) throw new Error(`${provider} does not support empty container setup for these secret destinations. Existing resources are preserved.`);
  const result = await adapterFactory.getProviderAdapter(provider, project, undefined, environmentName);
  const driver = result.success ? result.adapter?.secretDestinationSetup : undefined;
  if (!driver || destinations.some(destination => !driver.providers.includes(destination.provider))) throw new Error('The connected provider cannot prepare these secret containers.');
  return driver;
}
/** Fresh ownership/lifetime evidence for a separate reviewed writer grant. */
export async function assertReadySecretContainers(input: { project: Project; spec: ProjectSpec; environment: Environment; keys: string[] }): Promise<Record<string, SecretContainerBinding>> {
  const { project, spec, environment, keys } = input;
  const desired = spec.environments[environment.name];
  if (!desired || environment.projectId !== project.id || !keys.length || keys.length > 100 || new Set(keys).size !== keys.length)
    throw new Error('Exact declared secret container scope is required.');
  const retained = secretContainerBindings(environment.platformBindings.secretDestinationContainers);
  const selected: Record<string, SecretContainerBinding> = {};
  for (const key of keys) {
    const declaration = desired.secretDestinations?.[key], binding = retained[key];
    if (!declaration || !spec.secrets[key]?.environments.includes(environment.name) || binding?.state !== 'ready'
      || !isDeepStrictEqual(binding.destination, declaration.destination) || !isDeepStrictEqual(binding.owner, ownerFor(project, spec, environment.name, key)))
      throw new Error('Prepare and verify the exact owned secret containers before authorizing their writer.');
    selected[key] = binding;
  }
  const assertCurrent = () => {
    const currentEnvironment = new EnvironmentRepository().findById(environment.id);
    const currentProject = new ProjectRepository().findById(project.id);
    const currentSpec = currentProject ? new SpecStore().get(currentProject)?.spec : undefined;
    const currentDesired = currentSpec?.environments[environment.name];
    if (!currentEnvironment || currentEnvironment.projectId !== project.id || currentEnvironment.name !== environment.name
      || !currentProject || !currentSpec || !currentDesired
      || !isDeepStrictEqual(environmentScope(currentEnvironment), environmentScope(environment))
      || !isDeepStrictEqual(currentDesired.hosting, desired.hosting)) throw new Error('Current container scope changed. No writer grant is authorized.');
    const currentBindings = secretContainerBindings(currentEnvironment.platformBindings.secretDestinationContainers);
    for (const key of keys) {
      if (!isDeepStrictEqual(currentBindings[key], selected[key])
        || !isDeepStrictEqual(currentSpec.secrets[key], spec.secrets[key])
        || !isDeepStrictEqual(currentDesired.secretDestinations?.[key], desired.secretDestinations?.[key])
        || !isDeepStrictEqual(ownerFor(currentProject, currentSpec, environment.name, key), selected[key].owner))
        throw new Error('Current container ownership changed. No writer grant is authorized.');
    }
  };
  assertCurrent();
  const driver = await driverFor(project, desired.hosting.provider, Object.values(selected).map(binding => binding.destination), environment.name);
  for (const binding of Object.values(selected)) {
    if (!matches(await driver.observe(environment, binding.destination), binding))
      throw new Error('Secret container ownership or lifetime could not be verified. No writer grant is authorized.');
  }
  assertCurrent();
  return selected;
}
export async function planSecretContainers(input: { project: Project; spec: ProjectSpec; environment: Environment; onlyKeys?: string[] }): Promise<PlanAction[]> {
  const { project, spec, environment } = input;
  const desired = spec.environments[environment.name];
  if (input.onlyKeys && input.onlyKeys.some(key => !desired.secretDestinations?.[key] || !spec.secrets[key]?.environments.includes(environment.name)))
    throw new Error('Declare the exact operator output destinations and environment secret keys before registration.');
  const entries = Object.entries(desired.secretDestinations ?? {}).filter(([key, value]) => value.version === undefined && (!input.onlyKeys || input.onlyKeys.includes(key)));
  if (!entries.length) return [];
  if (entries.length > 100) throw new Error('Prepare at most 100 secret destinations per environment.');
  const bindings = secretContainerBindings(environment.platformBindings.secretDestinationContainers);
  const driver = await driverFor(project, desired.hosting.provider, entries.map(([, value]) => value.destination), environment.name);
  const actions: PlanAction[] = [];
  for (const [key, value] of entries) {
    const owner = ownerFor(project, spec, environment.name, key);
    const binding = bindings[key];
    if (binding && (!isDeepStrictEqual(binding.destination, value.destination) || !isDeepStrictEqual(binding.owner, owner))) throw new Error(`Retained container identity for ${key} differs from current desired scope; no replacement is authorized.`);
    const observed = await driver.observe(environment, value.destination);
    if (observed.state === 'unknown') throw new Error(`Cannot verify the container for ${key}. No create or adoption is authorized.`);
    if (binding?.state === 'ready') {
      if (!matches(observed, binding)) throw new Error(`The retained container lifetime or ownership for ${key} changed. No replacement is authorized.`);
      continue;
    }
    if (observed.state === 'present' && (!binding || !matches(observed, binding) || observed.hasVersions)) throw new Error(`The existing container for ${key} is populated, unmanaged, or does not match the retained attempt. It is preserved; automatic adoption is unsupported.`);
    actions.push({ id: `secret-destination:${key}`, type: binding ? 'update' : 'create', verified: true,
      resource: { kind: 'secret', name: key, provider: desired.hosting.provider },
      ...(binding ? {} : { requiresConfirm: true, billable: true }),
      reason: binding ? `Reconcile the retained empty-container creation attempt for ${key} without another write`
        : `Create an empty secret container for ${key}; no credential value, IAM change, or workload deployment`,
      metadata: { operation: SECRET_DESTINATION_PREPARE, destination: value.destination, owner,
        mode: binding ? 'reconcile' : 'create', ...(binding ? { attemptId: binding.attemptId } : {}) },
    });
  }
  return actions;
}

export async function applySecretContainer(input: { ctx: CommandContext; project: Project; spec: ProjectSpec; environmentName: string; action: PlanAction }): Promise<ActionResult> {
  const { ctx, project, spec, environmentName, action } = input;
  const fail = (message: string, pending = false): ActionResult => ({ success: false, status: pending ? 'pending' : 'blocked', message });
  try {
    const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
    const desired = spec.environments[environmentName];
    const metadata = secretContainerActionMetadataSchema.parse(action.metadata);
    const slot = spec.secrets[action.resource.name];
    const declaration = desired?.secretDestinations?.[action.resource.name];
    if (!environment || !desired || !slot?.environments.includes(environmentName) || !declaration || declaration.version !== undefined
      || action.resource.kind !== 'secret' || action.id !== `secret-destination:${action.resource.name}` || action.verified !== true
      || action.resource.provider !== desired.hosting.provider || !isDeepStrictEqual(metadata.destination, declaration.destination)
      || !isDeepStrictEqual(metadata.owner, ownerFor(project, spec, environmentName, action.resource.name))) return fail('The reviewed container does not match the current repository, environment, key, or destination.');
    const bindings = secretContainerBindings(environment.platformBindings.secretDestinationContainers);
    let binding = bindings[action.resource.name];
    if (binding && (!isDeepStrictEqual(binding.destination, declaration.destination) || !isDeepStrictEqual(binding.owner, metadata.owner))) return fail('Retained container identity changed; no replacement is authorized.');
    if (metadata.mode === 'create' && (action.type !== 'create' || binding || action.requiresConfirm !== true || action.billable !== true)
      || metadata.mode === 'reconcile' && (action.type !== 'update' || !binding || binding.attemptId !== metadata.attemptId)) return fail('The container creation authority is stale. Prepare a fresh plan.');
    const assertCurrent = () => {
      const latest = ctx.repos.environments.findById(environment.id);
      const currentProject = ctx.repos.projects.findById(project.id);
      const currentSpec = currentProject ? new SpecStore().get(currentProject)?.spec : undefined;
      const currentDesired = currentSpec?.environments[environmentName];
      if (!latest || latest.projectId !== project.id || latest.name !== environmentName || !currentProject || !currentSpec || !currentDesired
        || !isDeepStrictEqual(environmentScope(latest), environmentScope(environment))
        || !isDeepStrictEqual(currentDesired.hosting, desired.hosting)
        || !isDeepStrictEqual(currentDesired.secretDestinations?.[action.resource.name], declaration)
        || !isDeepStrictEqual(currentSpec.secrets[action.resource.name], slot)
        || !isDeepStrictEqual(ownerFor(currentProject, currentSpec, environmentName, action.resource.name), metadata.owner))
        throw new Error('Current container source or scope changed.');
      return latest;
    };
    assertCurrent();
    const driver = await driverFor(project, desired.hosting.provider, [declaration.destination], environment.name);
    let observed: SecretContainerObservation;
    if (metadata.mode === 'create') {
      const intent = { destination: declaration.destination, owner: metadata.owner, attemptId: randomUUID() };
      observed = await driver.create(environment, intent, { beforeCreate: async () => {
        const latest = assertCurrent();
        const retained = secretContainerBindings(latest.platformBindings.secretDestinationContainers);
        if (retained[action.resource.name]) throw new Error('A concurrent attempt already owns this container.');
        binding = { ...intent, state: 'attempted' };
        const updated = ctx.repos.environments.updatePlatformBindings(environment.id, { secretDestinationContainers: { ...retained, [action.resource.name]: binding } })!;
        writeRepoBindingsForEnvironment(project, updated, undefined, () => ctx.repos.components.findByEnvironmentId(environment.id));
      } });
    } else observed = await driver.observe(environment, declaration.destination);
    if (!binding || !matches(observed, binding) || observed.state !== 'present' || observed.hasVersions && binding.state !== 'ready')
      return fail('Container creation is unconfirmed. Re-plan for metadata-only reconciliation; no automatic create retry or replacement is authorized.', Boolean(binding));
    const latest = assertCurrent();
    const retained = secretContainerBindings(latest.platformBindings.secretDestinationContainers);
    if (!isDeepStrictEqual(retained[action.resource.name], binding)) return fail('The retained container attempt changed during verification.');
    const ready: SecretContainerBinding = { ...binding, state: 'ready', resource: observed.resource, createTime: observed.createTime };
    const updated = ctx.repos.environments.updatePlatformBindings(environment.id, { secretDestinationContainers: { ...retained, [action.resource.name]: ready } })!;
    writeRepoBindingsForEnvironment(project, updated, undefined, () => ctx.repos.components.findByEnvironmentId(environment.id));
    return { success: true, message: `Verified empty secret container for ${action.resource.name}`, data: {
      key: action.resource.name, destination: ready.destination, resource: ready.resource, createTime: ready.createTime,
      valuesWritten: 0, containerVerified: true, writerAccessVerified: false,
    } };
  } catch { return fail('Secret container setup could not be safely verified. Existing resources and retained attempts are preserved.'); }
}
