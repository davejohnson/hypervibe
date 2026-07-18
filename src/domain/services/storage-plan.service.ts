import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { StorageContext, StorageCredentials } from '../ports/storage.port.js';
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
  region: string;
  services: string[];
  envKeys: string[];
  updatedAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseStorageBindings(environment: Pick<Environment, 'platformBindings'> | null): Record<string, StorageBinding> {
  return (asRecord(environment?.platformBindings.storage) ?? {}) as Record<string, StorageBinding>;
}

export function parseStorageProviderContexts(environment: Pick<Environment, 'platformBindings'> | null): Record<string, StorageContext> {
  return (asRecord(environment?.platformBindings.storageProviders) ?? {}) as Record<string, StorageContext>;
}

export function storageEnvKeys(name: string): string[] {
  void name;
  return ['AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET_NAME', 'AWS_DEFAULT_REGION', 'AWS_S3_URL_STYLE'];
}

function storageEnvVars(name: string, credentials?: StorageCredentials): Record<string, string> {
  const [endpoint, accessKeyId, secretAccessKey, bucket, region, urlStyle] = storageEnvKeys(name);
  if (!credentials) {
    const ref = (key: string) => `\${{${name}.${key}}}`;
    return {
      [endpoint]: ref('ENDPOINT'), [accessKeyId]: ref('ACCESS_KEY_ID'), [secretAccessKey]: ref('SECRET_ACCESS_KEY'),
      [bucket]: ref('BUCKET'), [region]: ref('REGION'), [urlStyle]: 'virtual',
    };
  }
  return {
    [bucket]: credentials.bucket, [endpoint]: credentials.endpoint, [accessKeyId]: credentials.accessKeyId,
    [secretAccessKey]: credentials.secretAccessKey, [region]: credentials.region, [urlStyle]: credentials.urlStyle,
  };
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
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  const unmanaged: Array<{ kind: 'storage'; name: string; detail?: string }> = [];

  for (const [name, spec] of Object.entries(desired)) {
    const binding = bindings[name];
    const observed = binding
      ? live.find((item) => item.externalId === binding.externalId)
      : live.find((item) => item.name.toLowerCase() === name.toLowerCase());
    const ensureId = `storage:${name}`;
    const conflict = !binding && Boolean(observed);
    const regionDrift = Boolean(binding && observed?.region && observed.region !== spec.region);
    actions.push(action({
      id: ensureId,
      type: conflict || regionDrift ? 'update' : observed && binding ? 'noop' : 'create',
      name,
      provider: spec.provider,
      operation: STORAGE_OPERATIONS.ensure,
      verified: params.observed !== null,
      billable: !observed,
      reason: conflict
        ? `A live bucket named "${name}" exists but is not managed by Hypervibe; explicit hv_import adoption is required`
        : regionDrift
          ? `Bucket region is immutable and drifted from ${observed?.region} to ${spec.region}; migrate data explicitly before replacement`
          : observed && binding ? `Object storage bucket "${name}" is in sync` : `Object storage bucket "${name}" is not deployed`,
      metadata: {
        region: spec.region,
        services: spec.injectInto,
        ...(conflict ? { blockedReason: 'unmanaged_conflict', externalId: observed?.externalId } : {}),
        ...(regionDrift ? { blockedReason: 'immutable_region', externalId: observed?.externalId } : {}),
      },
    }));
    if (conflict && observed) unmanaged.push({ kind: 'storage', name: observed.name, detail: `${observed.provider} bucket requires explicit hv_import adoption` });

    for (const serviceName of spec.injectInto) {
      const observedService = params.observed?.services.find((service) => service.name === serviceName);
      const keys = storageEnvKeys(name);
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

  for (const item of live) {
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
    const credentials = environmentSpec.hosting.provider === spec.provider
      ? undefined
      : await adapterResult.adapter.getCredentials(environment, context, binding.externalId);
    const vars = storageEnvVars(name, credentials);
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
  const name = String(params.action.metadata?.storageName ?? params.action.resource.name);
  const operation = String(params.action.metadata?.operation ?? '');
  const bindings = parseStorageBindings(environment);
  const contexts = parseStorageProviderContexts(environment);
  const storageResult = await adapterFactory.getStorageAdapter(params.action.resource.provider, params.project);
  if (!storageResult.success || !storageResult.adapter) return { success: false, message: 'Storage adapter unavailable', error: storageResult.error };
  const adapter = storageResult.adapter;

  if (params.action.metadata?.blockedReason) {
    return { success: false, status: 'blocked', message: params.action.reason, error: params.action.metadata.blockedReason === 'unmanaged_conflict'
      ? 'Use hv_inspect and hv_import to explicitly adopt the live bucket, or rename the desired bucket.'
      : 'Railway bucket regions are immutable. Migrate objects explicitly, then remove/destroy and recreate the bucket.' };
  }

  if (operation === STORAGE_OPERATIONS.ensure) {
    let context = contexts[adapter.name];
    if (!context && params.environmentSpec.hosting.provider === adapter.name) {
      const root = environment.platformBindings as { projectId?: string; environmentId?: string };
      if (root.projectId && root.environmentId) context = { projectId: root.projectId, environmentId: root.environmentId };
    }
    const contextResult = await adapter.ensureContext(params.project.name, environment, context);
    if (!contextResult.receipt.success || !contextResult.context) return { success: false, message: contextResult.receipt.message, error: contextResult.receipt.error };
    context = contextResult.context;
    const spec = params.environmentSpec.storage?.[name];
    if (!spec) return { success: false, message: `Storage "${name}" is absent from the current spec` };
    const result = await adapter.ensureBucket(environment, context, name, spec.region);
    if (!result.receipt.success || !result.externalId) return { success: false, message: result.receipt.message, error: result.receipt.error };
    const next = { ...bindings, [name]: { provider: adapter.name, externalId: result.externalId, region: spec.region, services: bindings[name]?.services ?? [], envKeys: storageEnvKeys(name), updatedAt: new Date().toISOString() } };
    persist(environment, next, { ...contexts, [adapter.name]: context });
    return { success: true, message: result.receipt.message, data: { externalId: result.externalId, region: spec.region } };
  }

  const binding = bindings[name];
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

  if (operation === STORAGE_OPERATIONS.unwire) {
    const cleared = Object.fromEntries((binding.envKeys ?? storageEnvKeys(name)).map((key) => [key, '']));
    const receipt = await hosting.setEnvVars(environment, service, cleared);
    if (receipt.success) {
      persist(environment, { ...bindings, [name]: { ...binding, services: binding.services.filter((item) => item !== serviceName) } }, contexts);
    }
    return { success: receipt.success, message: receipt.success ? `Removed storage "${name}" access from "${serviceName}"` : receipt.message, error: receipt.error };
  }

  const credentials = params.environmentSpec.hosting.provider === adapter.name
    ? undefined
    : await adapter.getCredentials(environment, context, binding.externalId);
  const receipt = await hosting.setEnvVars(environment, service, storageEnvVars(name, credentials));
  if (receipt.success) {
    persist(environment, { ...bindings, [name]: { ...binding, services: Array.from(new Set([...binding.services, serviceName])), envKeys: storageEnvKeys(name), updatedAt: new Date().toISOString() } }, contexts);
  }
  return {
    success: receipt.success,
    message: receipt.success ? `Wired storage "${name}" to service "${serviceName}"` : receipt.message,
    error: receipt.error,
    data: receipt.success ? { serviceName, envKeys: storageEnvKeys(name) } : receipt.data,
  };
}
