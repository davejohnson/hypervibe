import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { StorageContext } from '../ports/storage.port.js';
import { withStorageInstanceScopes } from './storage-instance-identity.js';
import { S3_STORAGE_RUNTIME_ENV_KEYS } from './storage-runtime-env.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { adapterFactory } from './adapter.factory.js';

export const STORAGE_OPERATIONS = {
  ensure: 'storageEnsure',
  wire: 'storageWire',
  unwire: 'storageUnwire',
  destroy: 'storageDestroy',
} as const;

const STORAGE_OPERATION_SET = new Set<string>(Object.values(STORAGE_OPERATIONS));
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

export interface StorageBinding {
  provider: string;
  externalId: string;
  instanceScope?: StorageContext;
  region: string;
  services: string[];
  envKeys: string[];
  updatedAt?: string;
  dataMigration?: Record<string, unknown>;
  previousTarget?: {
    provider: string;
    externalId: string;
    instanceScope?: StorageContext;
    region: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseStorageBindings(environment: Pick<Environment, 'platformBindings'> | null): Record<string, StorageBinding> {
  const storage = asRecord(environment?.platformBindings.storage) ?? {};
  const contexts = asRecord(environment?.platformBindings.storageProviders) ?? {};
  return withStorageInstanceScopes(storage, contexts) as Record<string, StorageBinding>;
}

export function parseStorageProviderContexts(environment: Pick<Environment, 'platformBindings'> | null): Record<string, StorageContext> {
  return (asRecord(environment?.platformBindings.storageProviders) ?? {}) as Record<string, StorageContext>;
}

export function storageEnvKeys(name: string): string[] {
  void name;
  return [...S3_STORAGE_RUNTIME_ENV_KEYS];
}

function action(params: {
  id: string; type: PlanAction['type']; name: string; provider: string; operation: string; reason: string;
  verified: boolean; metadata?: Record<string, unknown>; dependsOn?: string[]; requiresConfirm?: boolean; billable?: boolean;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'storage', name: params.name, provider: params.provider },
    verified: params.verified,
    reason: params.reason,
    ...(params.operation === STORAGE_OPERATIONS.destroy ? { dataBearing: true } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    ...(params.billable ? { billable: true } : {}),
    ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
    metadata: { operation: params.operation, storageName: params.name, ...(params.metadata ?? {}) },
  };
}

export function planStorage(params: {
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  observed: ObservedState | null;
}): { actions: PlanAction[]; warnings: string[]; unmanaged: Array<{ kind: 'storage'; name: string; detail?: string }> } {
  const desired = params.environmentSpec.storage ?? {};
  const bindings = parseStorageBindings(params.environment);
  const live = params.observed?.storage ?? [];
  const observationKnown = params.observed === null
    || params.observed.completeness?.storage !== 'unknown';
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  const unmanaged: Array<{ kind: 'storage'; name: string; detail?: string }> = [];

  for (const [name, spec] of Object.entries(desired)) {
    const binding = bindings[name];
    if (params.observed && !observationKnown) {
      const ensureId = `storage:${name}`;
      actions.push(action({
        id: ensureId,
        type: binding ? 'noop' : 'update',
        name,
        provider: spec.provider,
        operation: STORAGE_OPERATIONS.ensure,
        verified: false,
        reason: binding
          ? `Preserving locally bound storage "${name}" because live observation is unknown`
          : `Cannot verify whether storage "${name}" exists`,
        ...(!binding ? { metadata: { blockedReason: 'storage_observation_unknown' } } : {}),
      }));
      for (const serviceName of spec.injectInto) {
        const wired = binding?.services.includes(serviceName) === true;
        actions.push(action({
          id: `storage:${name}:wiring:${serviceName}`,
          type: wired ? 'noop' : 'update',
          name,
          provider: spec.provider,
          operation: STORAGE_OPERATIONS.wire,
          verified: false,
          reason: wired
            ? `Preserving local storage wiring for "${serviceName}" because live observation is unknown`
            : `Cannot verify storage wiring for "${serviceName}"`,
          dependsOn: [ensureId, `service:${serviceName}`],
          ...(!wired ? { metadata: { serviceName, blockedReason: 'storage_observation_unknown' } } : {}),
        }));
      }
      continue;
    }
    const observed = binding
      ? live.find((item) => item.externalId === binding.externalId)
      : live.find((item) => item.name.toLowerCase() === name.toLowerCase());
    const ensureId = `storage:${name}`;
    const conflict = !binding && Boolean(observed);
    const providerDrift = Boolean(binding && binding.provider !== spec.provider);
    const regionDrift = Boolean(binding && observed?.region && observed.region !== spec.region);
    actions.push(action({
      id: ensureId,
      type: conflict || providerDrift || regionDrift ? 'update' : observed && binding ? 'noop' : 'create',
      name,
      provider: spec.provider,
      operation: STORAGE_OPERATIONS.ensure,
      verified: params.observed !== null,
      billable: !observed,
      reason: providerDrift
        ? `Storage provider changed from ${binding?.provider} to ${spec.provider}; declare a one-use dataMigration before replacing durable data`
        : conflict
        ? `A live bucket named "${name}" exists but is not managed by Hypervibe; explicit hv_import adoption is required`
        : regionDrift
          ? `Bucket region is immutable and drifted from ${observed?.region} to ${spec.region}; migrate data explicitly before replacement`
          : observed && binding ? `Object storage bucket "${name}" is in sync` : `Object storage bucket "${name}" is not deployed`,
      metadata: {
        region: spec.region,
        services: spec.injectInto,
        ...(providerDrift ? { blockedReason: 'provider_migration_required', externalId: binding?.externalId } : {}),
        ...(conflict ? { blockedReason: 'unmanaged_conflict', externalId: observed?.externalId } : {}),
        ...(regionDrift ? { blockedReason: 'immutable_region', externalId: observed?.externalId } : {}),
      },
    }));
    if (conflict && observed) unmanaged.push({ kind: 'storage', name: observed.name, detail: `${observed.provider} bucket requires explicit hv_import adoption` });

    for (const serviceName of spec.injectInto) {
      const observedService = params.observed?.services.find((service) => service.name === serviceName);
      const keys = binding?.envKeys ?? storageEnvKeys(name);
      const wired = binding?.services.includes(serviceName) && keys.every((key) => observedService?.envVarKeys.includes(key));
      actions.push(action({
        id: `storage:${name}:wiring:${serviceName}`,
        type: wired ? 'noop' : 'update',
        name,
        provider: spec.provider,
        operation: STORAGE_OPERATIONS.wire,
        verified: params.observed !== null,
        reason: wired ? `Storage "${name}" is wired to service "${serviceName}"` : `Wire storage "${name}" to service "${serviceName}"`,
        dependsOn: [ensureId, `service:${serviceName}`],
        metadata: { serviceName, envKeys: keys },
      }));
    }
    for (const serviceName of binding?.services ?? []) {
      if (spec.injectInto.includes(serviceName)) continue;
      actions.push(action({
        id: `storage:${name}:unwiring:${serviceName}`,
        type: 'update', name, provider: spec.provider, operation: STORAGE_OPERATIONS.unwire,
        verified: params.observed !== null,
        reason: `Remove storage "${name}" access from service "${serviceName}"`,
        metadata: { serviceName, envKeys: binding.envKeys },
      }));
    }
  }

  for (const [name, binding] of Object.entries(bindings)) {
    if (desired[name]) continue;
    if (params.observed && !observationKnown) {
      actions.push(action({
        id: `storage:${name}:observation-blocked`,
        type: 'update',
        name,
        provider: binding.provider,
        operation: STORAGE_OPERATIONS.destroy,
        verified: false,
        reason: `Storage "${name}" was removed from the spec, but observation is unknown; refusing to unwire or destroy it`,
        metadata: { blockedReason: 'storage_observation_unknown', externalId: binding.externalId },
      }));
      continue;
    }
    for (const serviceName of binding.services) {
      actions.push(action({
        id: `storage:${name}:unwiring:${serviceName}`,
        type: 'update', name, provider: binding.provider, operation: STORAGE_OPERATIONS.unwire,
        verified: params.observed !== null, reason: `Remove storage "${name}" access from service "${serviceName}"`,
        metadata: { serviceName, envKeys: binding.envKeys },
      }));
    }
    const observed = live.find((item) => item.externalId === binding.externalId);
    actions.push(action({
      id: `storage:${name}:destroy`, type: 'destroy', name, provider: binding.provider,
      operation: STORAGE_OPERATIONS.destroy, verified: Boolean(observed), requiresConfirm: true,
      reason: `Storage "${name}" was removed from the spec; deleting it loses all stored objects`,
      dependsOn: binding.services.map((serviceName) => `storage:${name}:unwiring:${serviceName}`),
      metadata: {
        externalId: binding.externalId,
        region: binding.region,
        ...(observed?.objectCount !== undefined ? { objectCount: observed.objectCount } : {}),
        ...(observed?.sizeBytes !== undefined ? { sizeBytes: observed.sizeBytes } : {}),
      },
    }));
  }

  for (const item of observationKnown ? live : []) {
    if (Object.values(bindings).some((binding) => binding.externalId === item.externalId) || desired[item.name]) continue;
    unmanaged.push({ kind: 'storage', name: item.name, detail: `${item.provider} object bucket exists but is not managed by Hypervibe` });
  }
  return { actions, warnings, unmanaged };
}

export function isStorageAction(planAction: PlanAction): boolean {
  return typeof planAction.metadata?.operation === 'string' && STORAGE_OPERATION_SET.has(planAction.metadata.operation);
}

export async function resolveStorageServiceEnvVars(
  project: Project,
  environmentSpec: EnvironmentSpec,
  environment: Environment | null
): Promise<Record<string, Record<string, string>> | undefined> {
  if (!environment || !environmentSpec.storage) return undefined;
  const bindings = parseStorageBindings(environment);
  const contexts = parseStorageProviderContexts(environment);
  const output: Record<string, Record<string, string>> = {};
  for (const [name, spec] of Object.entries(environmentSpec.storage)) {
    const binding = bindings[name];
    if (!binding) continue;
    const adapterResult = await adapterFactory.getStorageAdapter(spec.provider, project);
    if (!adapterResult.success || !adapterResult.adapter) continue;
    const root = environment.platformBindings as { projectId?: string; environmentId?: string };
    const context = contexts[spec.provider] ?? (environmentSpec.hosting.provider === spec.provider && root.projectId && root.environmentId
      ? { projectId: root.projectId, environmentId: root.environmentId }
      : undefined);
    if (!context) continue;
    const vars = await adapterResult.adapter.getRuntimeEnv(environment, context, binding.externalId, name);
    for (const serviceName of spec.injectInto) output[serviceName] = { ...(output[serviceName] ?? {}), ...vars };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function persist(environment: Environment, storage: Record<string, StorageBinding>, storageProviders: Record<string, StorageContext>): void {
  envRepo.updatePlatformBindings(environment.id, { storage, storageProviders });
}

export async function applyStorageAction(params: {
  project: Project; envName: string; environmentSpec: EnvironmentSpec; action: PlanAction;
}): Promise<{ success: boolean; status?: 'pending' | 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const environment = envRepo.findByProjectAndName(params.project.id, params.envName);
  if (!environment) return { success: false, message: 'Environment not found locally', error: `No local environment "${params.envName}"` };
  const name = typeof params.action.metadata?.storageName === 'string'
    ? params.action.metadata.storageName
    : '';
  const operation = String(params.action.metadata?.operation ?? '');
  const bindings = parseStorageBindings(environment);
  const contexts = parseStorageProviderContexts(environment);
  const desired = params.environmentSpec.storage?.[name];
  const plannedService = typeof params.action.metadata?.serviceName === 'string'
    ? params.action.metadata.serviceName
    : undefined;
  const binding = bindings[name];
  const identityMatches = Boolean(name)
    && name === params.action.resource.name
    && (
      operation === STORAGE_OPERATIONS.ensure
        ? desired?.provider === params.action.resource.provider
        : operation === STORAGE_OPERATIONS.wire
          ? desired?.provider === params.action.resource.provider
            && Boolean(plannedService && desired.injectInto.includes(plannedService))
          : operation === STORAGE_OPERATIONS.unwire
            ? binding?.provider === params.action.resource.provider
              && Boolean(plannedService)
            : operation === STORAGE_OPERATIONS.destroy
              ? !desired
                && binding?.provider === params.action.resource.provider
                && params.action.metadata?.externalId === binding.externalId
              : false
    );
  if (!identityMatches) {
    return {
      success: false,
      status: 'blocked',
      message: `Storage action "${params.action.id}" has stale mutation authority`,
      error: `The reviewed bucket, provider, service destination, or durable provider id no longer matches environment "${params.envName}". Re-run hv_plan.`,
    };
  }
  const storageResult = await adapterFactory.getStorageAdapter(params.action.resource.provider, params.project);
  if (!storageResult.success || !storageResult.adapter) return { success: false, message: 'Storage adapter unavailable', error: storageResult.error };
  const adapter = storageResult.adapter;
  if (adapter.name !== params.action.resource.provider) {
    return {
      success: false,
      status: 'blocked',
      message: `Storage action "${params.action.id}" resolved the wrong provider adapter`,
      error: `Plan targets ${params.action.resource.provider}, but the resolved adapter is ${adapter.name}.`,
    };
  }

  if (params.action.metadata?.blockedReason) {
    const blockedReason = params.action.metadata.blockedReason;
    const error = blockedReason === 'unmanaged_conflict'
      ? 'Use hv_inspect and hv_import to explicitly adopt the live bucket, or rename the desired bucket.'
      : blockedReason === 'provider_migration_required'
        ? 'Declare dataMigration on the target environment so Hypervibe copies and verifies the bucket before changing its provider binding.'
        : 'Object-storage locations are immutable. Migrate objects explicitly, then remove/destroy and recreate the bucket.';
    return { success: false, status: 'blocked', message: params.action.reason, error };
  }

  if (operation === STORAGE_OPERATIONS.ensure) {
    const spec = desired;
    if (!spec) return { success: false, message: `Storage "${name}" is absent from the current spec` };
    let context = contexts[adapter.name];
    if (!context && params.environmentSpec.hosting.provider === adapter.name) {
      const root = environment.platformBindings as { projectId?: string; environmentId?: string };
      if (root.projectId && root.environmentId) context = { projectId: root.projectId, environmentId: root.environmentId };
    }
    const contextResult = await adapter.ensureContext(params.project.name, environment, context, spec.region);
    if (!contextResult.receipt.success || !contextResult.context) return { success: false, message: contextResult.receipt.message, error: contextResult.receipt.error };
    context = contextResult.context;
    const result = await adapter.ensureBucket(environment, context, name, spec.region);
    if (!result.receipt.success || !result.externalId) return { success: false, message: result.receipt.message, error: result.receipt.error };
    const next = { ...bindings, [name]: { provider: adapter.name, externalId: result.externalId, instanceScope: context, region: spec.region, services: bindings[name]?.services ?? [], envKeys: adapter.runtimeEnvKeys(name), updatedAt: new Date().toISOString() } };
    persist(environment, next, { ...contexts, [adapter.name]: context });
    return { success: true, message: result.receipt.message, data: { externalId: result.externalId, region: spec.region } };
  }

  const context = contexts[binding?.provider] ?? (params.environmentSpec.hosting.provider === binding?.provider
    ? (() => { const root = environment.platformBindings as { projectId?: string; environmentId?: string }; return root.projectId && root.environmentId ? { projectId: root.projectId, environmentId: root.environmentId } : undefined; })()
    : undefined);
  if (!binding || !context) return { success: false, message: `Storage binding/context missing for "${name}"` };

  if (operation === STORAGE_OPERATIONS.destroy) {
    const receipt = await adapter.destroyBucket(environment, context, binding.externalId);
    if (receipt.success) { const next = { ...bindings }; delete next[name]; persist(environment, next, contexts); }
    return { success: receipt.success, message: receipt.message, error: receipt.error, data: receipt.data };
  }

  const serviceName = String(params.action.metadata?.serviceName ?? '');
  const service = serviceRepo.findByProjectAndName(params.project.id, serviceName);
  if (!service) return { success: false, message: `Service "${serviceName}" not found locally` };
  const hostingResult = await adapterFactory.getProviderAdapter(params.environmentSpec.hosting.provider, params.project);
  const hosting = hostingResult.adapter as IProviderAdapter | undefined;
  if (!hostingResult.success || !hosting?.setEnvVars) return { success: false, message: 'Hosting adapter cannot sync storage variables', error: hostingResult.error };
  if (hosting.name !== params.environmentSpec.hosting.provider) {
    return {
      success: false,
      status: 'blocked',
      message: `Storage action "${params.action.id}" resolved the wrong hosting adapter`,
      error: `Environment uses ${params.environmentSpec.hosting.provider}, but the resolved adapter is ${hosting.name}.`,
    };
  }

  if (operation === STORAGE_OPERATIONS.unwire) {
    const cleared = Object.fromEntries((binding.envKeys ?? storageEnvKeys(name)).map((key) => [key, '']));
    const receipt = await hosting.setEnvVars(environment, service, cleared);
    if (receipt.success) {
      persist(environment, { ...bindings, [name]: { ...binding, services: binding.services.filter((item) => item !== serviceName) } }, contexts);
    }
    return { success: receipt.success, message: receipt.success ? `Removed storage "${name}" access from "${serviceName}"` : receipt.message, error: receipt.error };
  }

  const runtimeEnv = await adapter.getRuntimeEnv(environment, context, binding.externalId, name);
  const runtimeEnvKeys = Object.keys(runtimeEnv).sort();
  const receipt = await hosting.setEnvVars(environment, service, runtimeEnv);
  if (receipt.success) {
    persist(environment, { ...bindings, [name]: { ...binding, services: Array.from(new Set([...binding.services, serviceName])), envKeys: runtimeEnvKeys, updatedAt: new Date().toISOString() } }, contexts);
  }
  return {
    success: receipt.success,
    message: receipt.success ? `Wired storage "${name}" to service "${serviceName}"` : receipt.message,
    error: receipt.error,
    data: receipt.success ? { serviceName, envKeys: runtimeEnvKeys } : receipt.data,
  };
}
