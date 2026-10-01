import { z } from 'zod';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { DailyBackupObservation, DailyBackupReview, IDailyBackupPolicy } from '../ports/daily-backup.port.js';
import type { Receipt } from '../ports/provider.port.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import type { AdapterFactory } from './adapter.factory.js';
import { parseServiceVolumeBindings } from './service-volume.service.js';
import { withStorageInstanceScopes } from './storage-instance-identity.js';
import { recoveryIdentityStringSchema, recoverySourceIdentitySchema } from './recovery-source.js';
import { managedRecoverySource, observeManagedBackupProgram } from './managed-backup-policy.service.js';
import { resolveBackupStrategy } from './backup-strategy.service.js';

export interface BackupResource {
  kind: 'database' | 'volume' | 'storage';
  name: string;
  provider: string;
  retained: boolean;
  bindingState: 'bound' | 'unbound' | 'unknown';
  reason?: string;
  componentId?: string;
}

export interface EffectiveBackupPolicy {
  mode: 'daily' | 'disabled';
  source: 'default' | 'explicit';
  reason?: string;
  resources: BackupResource[];
}

export type BackupTargetDescriptor = { kind: 'database'; componentId: string }
  | { kind: 'volume' | 'storage'; name: string };

export interface BackupCoverageItem {
  resource: BackupResource;
  state: 'scheduled' | 'needs-configuration' | 'unsupported' | 'unknown' | 'disabled';
  reason?: string;
  target?: BackupTargetDescriptor;
  observation?: DailyBackupObservation;
}

export interface BackupPolicyObservation {
  policy: EffectiveBackupPolicy;
  resources: BackupCoverageItem[];
  managedProgram?: ReturnType<typeof resolveBackupStrategy> & { state: 'ready' | 'blocked' };
}

export interface BackupPolicyContext {
  spec: EnvironmentSpec;
  environment?: Environment | null;
  components: Component[];
  project?: Project;
  adapterFactory: Pick<AdapterFactory, 'getDatabaseAdapter' | 'getProviderAdapter' | 'getStorageAdapter'>;
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identity = (value: unknown): string | undefined => {
  const parsed = recoveryIdentityStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const scope = (value: unknown): Record<string, string> | undefined => {
  const object = record(value);
  return object && Object.keys(object).length && Object.values(object).every(value => identity(value) !== undefined)
    ? object as Record<string, string> : undefined;
};
const externalId = (component: Component) => identity(component.externalId) ?? identity(component.bindings.instanceId) ?? identity(component.bindings.serviceId);

function policyFor(spec: EnvironmentSpec | undefined, environment?: Environment | null, components: Component[] = []): EffectiveBackupPolicy {
  const resources: BackupResource[] = [];
  const desired = spec?.database;
  const databases = components.filter(component => component.environmentId === environment?.id && (component.type === 'postgres' || component.type === desired?.engine || /^data-migration:.*:postgres$/.test(component.type)));
  const matches = databases.filter(component => component.type === desired?.engine && component.bindings.provider === desired.provider);
  if (desired && matches.length !== 1) resources.push({ kind: 'database', name: desired.engine, provider: desired.provider, retained: false,
    bindingState: matches.length > 1 ? 'unknown' : 'unbound', reason: matches.length > 1 ? 'Multiple bound databases match this declaration.' : 'The declared database is not durably bound.' });
  for (const component of databases) {
    const provider = identity(component.bindings.provider) ?? 'unknown';
    const current = matches.length === 1 && matches[0].id === component.id;
    const candidate = component.type.startsWith('data-migration:');
    resources.push({ kind: 'database', name: current ? component.type : `${component.type}:${component.id}`, provider, retained: !current,
      componentId: component.id, bindingState: !candidate && provider !== 'unknown' && externalId(component) ? 'bound' : 'unknown',
      ...(candidate ? { reason: 'An incomplete database migration candidate remains retained; backup coverage is unknown.' }
        : !(provider !== 'unknown' && externalId(component)) ? { reason: 'Retained database identity is incomplete.' } : {}) });
    for (const [key, value] of [['previous', component.bindings.previousProvider], ['migration-previous', component.bindings.dataMigrationPreviousTarget]] as const) {
      if (value !== undefined) resources.push({ kind: 'database', name: `${component.type}:${component.id}:${key}`, provider: identity(value) ?? identity(record(value)?.provider) ?? 'unknown', retained: true,
        bindingState: 'unknown', reason: 'A previous database remains retained; its backup policy requires explicit source reconciliation.' });
    }
  }
  const previousDatabase = environment?.platformBindings.previousDatabase;
  if (previousDatabase !== undefined) resources.push({ kind: 'database', name: '__previous-database__', provider: identity(record(previousDatabase)?.provider) ?? 'unknown', retained: true,
    bindingState: 'unknown', reason: 'An imported previous database remains retained; its backup policy requires explicit source reconciliation.' });

  const retainedVolumes = parseServiceVolumeBindings(environment ?? null);
  if (!retainedVolumes) resources.push({ kind: 'volume', name: '__invalid__', provider: spec?.hosting.provider ?? 'unknown', retained: true, bindingState: 'unknown', reason: 'Retained filesystem bindings are malformed or duplicated.' });
  const declaredVolumes = Object.entries(spec?.services ?? {}).filter(([, service]) => service.volume).map(([name]) => name);
  for (const name of [...new Set([...declaredVolumes, ...Object.keys(retainedVolumes ?? {})])].sort()) {
    const binding = retainedVolumes?.[name];
    const providerChanged = Boolean(binding && declaredVolumes.includes(name) && binding.provider !== spec?.hosting.provider);
    if (providerChanged) resources.push({ kind: 'volume', name, provider: spec!.hosting.provider, retained: false, bindingState: 'unbound', reason: 'The declared provider has no durably bound filesystem; the previous filesystem remains retained.' });
    const complete = binding?.state === 'bound' || (binding?.state === 'staged' && Object.keys(binding.components).length > 0 && Object.values(binding.components).every(component => component.state === 'bound'));
    resources.push({ kind: 'volume', name, provider: binding?.provider ?? spec?.hosting.provider ?? 'unknown', retained: providerChanged || !declaredVolumes.includes(name), bindingState: complete ? 'bound' : binding ? 'unknown' : 'unbound',
      ...(!complete ? { reason: 'The filesystem is not completely bound; no backup target can safely be selected.' } : {}) });
  }

  const rawStorage = environment?.platformBindings.storage;
  const rawMap = record(rawStorage);
  if (rawStorage !== undefined && !rawMap) resources.push({ kind: 'storage', name: '__invalid__', provider: 'unknown', retained: true, bindingState: 'unknown', reason: 'Retained object-storage bindings are malformed.' });
  const storage = withStorageInstanceScopes(rawMap ?? {}, record(environment?.platformBindings.storageProviders) ?? {});
  for (const name of [...new Set([...Object.keys(spec?.storage ?? {}), ...Object.keys(storage)])].sort()) {
    const binding = record(storage[name]);
    // Backup copies are retained protection, not another source recursively requiring a backup of itself.
    if (spec?.storage?.[name]?.purpose === 'backup' || binding?.purpose === 'backup') continue;
    const raw = record(rawMap?.[name]);
    const providerChanged = Boolean(binding && spec?.storage?.[name] && binding.provider !== spec.storage[name].provider);
    if (providerChanged) resources.push({ kind: 'storage', name, provider: spec!.storage![name].provider, retained: false, bindingState: 'unbound', reason: 'The declared provider has no durably bound object store; the previous store remains retained.' });
    const valid = identity(binding?.provider) && identity(binding?.externalId) && scope(binding?.instanceScope)
      && !(raw?.instanceScope !== undefined && !scope(raw.instanceScope));
    resources.push({ kind: 'storage', name, provider: identity(binding?.provider) ?? spec?.storage?.[name]?.provider ?? 'unknown', retained: providerChanged || !spec?.storage?.[name],
      bindingState: valid ? 'bound' : Object.hasOwn(storage, name) ? 'unknown' : 'unbound',
      ...(!valid ? { reason: 'The object store has no complete durable provider identity and scope.' } : {}) });
    if (binding?.previousTarget !== undefined) resources.push({ kind: 'storage', name: `${name}:previous`, provider: identity(record(binding.previousTarget)?.provider) ?? 'unknown', retained: true,
      bindingState: 'unknown', reason: 'A previous object store remains retained; its backup policy requires explicit source reconciliation.' });
  }
  const recovery = environment?.platformBindings.storageCreateRecovery;
  if (recovery !== undefined && (!record(recovery) || Object.keys(record(recovery)!).length)) resources.push({ kind: 'storage', name: '__create-recovery__', provider: 'unknown', retained: true, bindingState: 'unknown', reason: 'Unresolved object-storage creation may have left additional data-bearing resources.' });
  const migrationCandidates = environment?.platformBindings.dataMigrationCandidates;
  if (migrationCandidates !== undefined && (!record(migrationCandidates) || Object.keys(record(migrationCandidates)!).length)) resources.push({ kind: 'storage', name: '__migration-candidates__', provider: 'unknown', retained: true, bindingState: 'unknown', reason: 'Retained object-storage migration candidates have unverified backup coverage.' });
  return { mode: spec?.backups?.mode ?? 'daily', source: spec?.backups ? 'explicit' : 'default',
    ...(spec?.backups?.mode === 'disabled' ? { reason: spec.backups.reason } : {}), resources };
}

/** Resolve defaults without rewriting source specs or changing existing spec hashes. */
export function resolveBackupPolicies(spec: ProjectSpec, environments: Environment[] = [], components: Component[] = []): Record<string, EffectiveBackupPolicy> {
  return Object.fromEntries([...new Set([...Object.keys(spec.environments), ...environments.map(environment => environment.name)])].map(name =>
    [name, policyFor(spec.environments[name], environments.find(environment => environment.name === name), components)]));
}

function descriptor(resource: BackupResource): BackupTargetDescriptor | undefined {
  if (resource.bindingState !== 'bound') return undefined;
  return resource.kind === 'database' ? resource.componentId ? { kind: 'database', componentId: resource.componentId } : undefined
    : { kind: resource.kind, name: resource.name };
}

type BoundCapability = { state: 'ready'; observe: () => Promise<DailyBackupObservation>; configureDaily: (review: DailyBackupReview) => Promise<Receipt>;
  observeRecovery?: () => Promise<import('./backup-health.service.js').BackupRecoveryObservation> }
  | { state: 'unknown' | 'unsupported'; reason: string };
function bind<T>(capability: IDailyBackupPolicy<T> | undefined, target: T): BoundCapability {
  return capability && typeof capability.observe === 'function' && typeof capability.configureDaily === 'function'
    ? { state: 'ready', observe: () => capability.observe(target), configureDaily: review => capability.configureDaily(target, review),
      ...(capability.observeRecovery ? { observeRecovery: () => capability.observeRecovery!(target) } : {}) }
    : { state: 'unsupported', reason: 'This provider adapter does not implement daily backup policy management for this resource.' };
}

export async function resolveBackupTarget(context: BackupPolicyContext, resource: BackupResource): Promise<BoundCapability> {
  const unknown = { state: 'unknown' as const, reason: 'The exact bound source or provider capability could not be resolved.' };
  const environment = context.environment;
  if (!environment) return unknown;
  if (resource.bindingState !== 'bound') return { state: 'unknown', reason: resource.reason ?? unknown.reason };
  try {
    if (resource.kind === 'database') {
      const component = context.components.find(component => component.id === resource.componentId && component.environmentId === environment.id && component.bindings.provider === resource.provider);
      if (!component || !externalId(component)) return unknown;
      const result = await context.adapterFactory.getDatabaseAdapter(resource.provider, context.project);
      if (!result.success || !result.adapter || result.adapter.name !== resource.provider) return unknown;
      return bind(result.adapter.dailyBackups, { environment, component });
    }
    if (resource.kind === 'volume') {
      const binding = parseServiceVolumeBindings(environment)?.[resource.name];
      if (!binding || binding.provider !== resource.provider) return unknown;
      const result = await context.adapterFactory.getProviderAdapter(resource.provider, context.project);
      if (!result.success || !result.adapter || result.adapter.name !== resource.provider) return unknown;
      const volumes = result.adapter.serviceVolumes;
      if (!volumes?.dailyBackups) return bind(undefined, undefined);
      const mount = binding.state === 'staged' ? volumes.staged?.runtimeMount?.(binding.target, binding.components) : binding.state === 'bound' && binding.externalId ? { target: binding.target, externalId: binding.externalId } : undefined;
      return mount ? bind(volumes.dailyBackups, { target: mount.target, externalId: mount.externalId }) : unknown;
    }
    const storage = record(environment.platformBindings.storage);
    const bindings = withStorageInstanceScopes(storage ?? {}, record(environment.platformBindings.storageProviders) ?? {});
    const binding = record(bindings[resource.name]);
    const instanceScope = scope(binding?.instanceScope);
    const id = identity(binding?.externalId);
    if (!id || !instanceScope || binding?.provider !== resource.provider) return unknown;
    const result = await context.adapterFactory.getStorageAdapter(resource.provider, context.project);
    if (!result.success || !result.adapter || result.adapter.name !== resource.provider) return unknown;
    return bind(result.adapter.dailyBackups, { environment, context: instanceScope, externalId: id });
  } catch { return unknown; }
}

const knownObservationSchema = z.object({ state: z.literal('known'), source: recoverySourceIdentitySchema, daily: z.boolean(),
  policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), preservationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  mechanism: z.enum(['snapshot', 'continuous', 'retained-copy']),
  retention: z.object({ unit: z.enum(['days', 'backups']), value: z.number().positive() }).strict().optional() }).strict();

export async function observeBackupPolicy(context: BackupPolicyContext): Promise<BackupPolicyObservation> {
  const policy = policyFor(context.spec, context.environment, context.components);
  const resources: BackupCoverageItem[] = [];
  let managedProgram: BackupPolicyObservation['managedProgram'] = policy.mode === 'daily' && policy.resources.length
    ? { ...resolveBackupStrategy(context.spec), state: 'blocked' } : undefined;
  for (const resource of policy.resources) {
    const target = descriptor(resource);
    const base = { resource, ...(target ? { target } : {}) };
    if (policy.mode === 'disabled') { resources.push({ ...base, state: 'disabled', reason: policy.reason }); continue; }
    const resolved = await resolveBackupTarget(context, resource);
    if (resolved.state !== 'ready') { resources.push({ ...base, ...resolved }); continue; }
    try {
      const observed = knownObservationSchema.safeParse(await resolved.observe());
      if (observed.success && observed.data.source.provider === resource.provider) {
        resources.push({ ...base, state: observed.data.daily ? 'scheduled' : 'needs-configuration', observation: observed.data });
        continue;
      }
    } catch { /* Unknown reads never imply no schedule. */ }
    resources.push({ ...base, state: 'unknown', reason: 'The provider did not return verified daily backup policy evidence for this exact resource.' });
  }
  if (policy.mode === 'daily' && context.spec.backups?.mode === 'daily' && context.spec.backups.runnerImage) {
    const managed = await observeManagedBackupProgram(context);
    if (managedProgram) managedProgram = { ...managedProgram, state: managed.state,
      issues: managed.state === 'ready' ? [] : managed.issues };
    if (managed.state === 'ready') for (const item of resources) {
      const source = managedRecoverySource(managed.target, item.resource);
      if (!source) continue;
      const prior = item.observation?.state === 'known' ? item.observation : undefined;
      item.state = 'scheduled'; delete item.reason;
      item.observation = { state: 'known', source, daily: true, mechanism: 'retained-copy',
        policyFingerprint: prior?.policyFingerprint ?? managed.contractHash,
        preservationFingerprint: prior?.preservationFingerprint ?? managed.contractHash,
        retention: { unit: 'backups', value: 7 } };
    }
  }
  return { policy, resources, ...(managedProgram ? { managedProgram } : {}) };
}

export async function configureBackupPolicyItem(context: BackupPolicyContext & { item: BackupCoverageItem; reviewed: DailyBackupReview }): Promise<Receipt> {
  const policy = policyFor(context.spec, context.environment, context.components);
  const resource = policy.resources.find(resource => resource.kind === context.item.resource.kind && resource.name === context.item.resource.name
    && resource.provider === context.item.resource.provider && resource.componentId === context.item.resource.componentId);
  const target = resource ? descriptor(resource) : undefined;
  if (policy.mode !== 'daily' || !resource || !target || JSON.stringify(target) !== JSON.stringify(context.item.target)) {
    return { success: false, message: 'The reviewed daily backup target no longer matches current intent and durable bindings. Re-plan.', data: { applied: 0, skipped: 1, mutationAttempted: false } };
  }
  const resolved = await resolveBackupTarget(context, resource);
  if (resolved.state !== 'ready') return { success: false, message: resolved.reason, data: { applied: 0, skipped: 1, mutationAttempted: false } };
  try { return await resolved.configureDaily(context.reviewed); }
  catch { return { success: false, message: 'The daily backup policy write could not be verified. Re-plan to observe the current policy; no automatic retry was attempted.', data: { applied: null, skipped: 0, mutationAttempted: true } }; }
}
