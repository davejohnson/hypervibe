import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adapterFactory } from './adapter.factory.js';
import { providerRegistry } from '../registry/provider.registry.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { IProviderAdapter, ProviderRuntimeIdentity } from '../ports/provider.port.js';
import type { IStorageAdapter } from '../ports/storage.port.js';
import type { RuntimeIdentityBinding, RuntimeIdentityObservation } from '../ports/runtime-identity.port.js';
import type { StorageRuntimeAccessTarget, StorageRuntimeAccessObservation } from '../ports/storage-runtime-access.port.js';
import { runtimeCoordinateSchema, runtimeCoordinatesSchema } from '../../lib/value-free-coordinates.js';

const coordinate = runtimeCoordinateSchema;
const coordinates = runtimeCoordinatesSchema;
const identitySchema = z.object({ provider: coordinate, principal: coordinate, scope: coordinates, source: z.enum(['observed', 'configured']), activation: coordinates.optional() }).strict();
const stepSchema = z.object({ operation: z.enum(['create', 'attach', 'destroy', 'recover']), target: coordinates, description: coordinate, requiresConfirm: z.boolean(), restartsWorkload: z.boolean().optional() }).strict();
const identityBindingSchema = z.object({ provider: coordinate, evidence: coordinates, pending: z.object({ attemptId: coordinate, step: stepSchema }).strict().optional() }).strict();
const grantSchema = z.object({ id: coordinate, attemptId: coordinate, evidence: coordinates }).strict();
const targetSchema = z.object({ provider: coordinate, externalId: coordinate, context: coordinates, identity: identitySchema }).strict();
const baseRecordSchema = targetSchema.extend({ binding: grantSchema.optional(), pending: z.object({ attemptId: coordinate, operation: z.enum(['grant', 'revoke']) }).strict().optional() }).strict();
const recordSchema = baseRecordSchema.extend({ retiring: baseRecordSchema.optional() }).strict();
const identitiesSchema = z.record(z.string(), identityBindingSchema);
const grantsSchema = z.record(z.string(), z.record(z.string(), recordSchema));
type AccessRecord = z.infer<typeof recordSchema>;
export const RUNTIME_ACCESS_OPERATIONS = { identity: 'runtimeIdentity', grant: 'storageRuntimeGrant', revoke: 'storageRuntimeRevoke', recover: 'storageRuntimeRecover' } as const;
const operations = new Set<string>(Object.values(RUNTIME_ACCESS_OPERATIONS));
export function isRuntimeAccessAction(action: PlanAction): boolean { return operations.has(String(action.metadata?.operation)); }

export function runtimeAccessBindings(environment: Pick<Environment, 'platformBindings'> | null) {
  const identities = identitiesSchema.safeParse(environment?.platformBindings.runtimeIdentities ?? {});
  const grants = grantsSchema.safeParse(environment?.platformBindings.storageRuntimeAccess ?? {});
  if (environment?.platformBindings.runtimeIdentities === null || environment?.platformBindings.storageRuntimeAccess === null || !identities.success || !grants.success) return null;
  return { runtimeIdentities: identities.data, storageRuntimeAccess: grants.data };
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function fingerprint(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
interface Input { environment: Environment | null; environmentSpec: EnvironmentSpec; hosting?: IProviderAdapter; storageAdapters: Record<string, IStorageAdapter | undefined> }
interface IdentityItem { provider: string; serviceName: string; mode: 'ensure' | 'destroy'; binding?: RuntimeIdentityBinding; observation: RuntimeIdentityObservation }
interface AccessItem { provider: string; serviceName: string; storageName: string; desired: boolean; target?: Omit<StorageRuntimeAccessTarget, 'environment'>; retained?: AccessRecord; previous?: AccessRecord; retiring?: boolean; observation: StorageRuntimeAccessObservation; waiting?: boolean }
export interface RuntimeAccessObservation { identities: IdentityItem[]; grants: AccessItem[]; invalid?: boolean }
const unavailable = 'Exact workload identity and bucket access could not be verified; no permission change is authorized.';
function accessTarget(value: Pick<AccessRecord, 'provider' | 'externalId' | 'context' | 'identity'>) {
  const { source: _source, activation: _activation, ...identity } = value.identity;
  return { provider: value.provider, externalId: value.externalId, context: value.context, identity };
}
function identityObservation(value: RuntimeIdentityObservation): RuntimeIdentityObservation {
  if (value.state === 'ready') return { state: 'ready', ...(value.identity ? { identity: identitySchema.parse(value.identity) } : {}), ...(value.warnings?.length ? { warnings: z.array(coordinate).max(100).parse(value.warnings) } : {}) };
  if (value.state === 'action') return { state: 'action', step: stepSchema.parse(value.step), ...(value.preparedIdentity ? { preparedIdentity: identitySchema.parse(value.preparedIdentity) } : {}), ...(value.requiresStorageAccess === true ? { requiresStorageAccess: true } : {}) };
  return { state: value.state === 'waiting' ? 'waiting' : 'unknown', reason: unavailable };
}
function grantObservation(value: StorageRuntimeAccessObservation): StorageRuntimeAccessObservation {
  return value.state === 'present' ? { state: 'present', binding: grantSchema.parse(value.binding) } : value.state === 'absent' ? { state: 'absent' } : { state: 'unknown', reason: unavailable };
}

/** Read-only, bounded to declared consumers and retained exact grants. */
export async function observeRuntimeAccess(input: Input): Promise<RuntimeAccessObservation> {
  const { environment, environmentSpec, hosting, storageAdapters } = input;
  const result: RuntimeAccessObservation = { identities: [], grants: [] };
  if (!environment) return result;
  const state = runtimeAccessBindings(environment);
  if (!state) return { ...result, invalid: true };
  // Creating the empty local row is not a provider change. Keep initial plan
  // and apply observations equal until the reviewed hosting scope is bound.
  if (!environment.platformBindings.projectId && !Object.keys(state.runtimeIdentities).length && !Object.keys(state.storageRuntimeAccess).length
    && !Object.keys(environment.platformBindings.services ?? {}).length && !Object.keys(environment.platformBindings.storage ?? {}).length) return result;
  const storage = environment.platformBindings.storage as Record<string, { externalId: string; instanceScope?: Record<string, string> }> | undefined;
  const names = new Set(Object.keys(state.storageRuntimeAccess));
  const consumers = new Set([...Object.keys(state.runtimeIdentities), ...(hosting?.runtimeIdentities ? Object.keys(environmentSpec.services) : [])]);
  for (const [name, spec] of Object.entries(environmentSpec.storage ?? {})) {
    if (!(storageAdapters[spec.provider]?.runtimeAccess?.hostingProviders ?? providerRegistry.getMetadata(spec.provider)?.storageRuntimeAccess?.hostingProviders ?? []).includes(environmentSpec.hosting.provider)) continue;
    names.add(name);
    for (const serviceName of spec.injectInto) consumers.add(serviceName);
  }
  const identities = new Map<string, ProviderRuntimeIdentity>();
  const waiting = new Set<string>();
  for (const serviceName of [...consumers].sort()) {
    const desired = environmentSpec.services[serviceName];
    const binding = state.runtimeIdentities[serviceName];
    const mode = desired ? 'ensure' : 'destroy';
    const service = { name: serviceName, buildConfig: desired ? { workloadKind: desired.workloadKind, cronSchedule: desired.cronSchedule } : {} };
    try {
      if (hosting?.runtimeIdentities) {
        const grantRetained = Object.values(state.storageRuntimeAccess).some(records => Object.hasOwn(records, serviceName));
        const bound = (environment.platformBindings.services as Record<string, { serviceId?: string }> | undefined)?.[serviceName]?.serviceId;
        const needsWorkload = !binding && !bound && providerRegistry.getMetadata(environmentSpec.hosting.provider)?.lifecycle?.hosting?.runtimeIdentityTiming === 'after-workload';
        let observation: RuntimeIdentityObservation = mode === 'destroy' && grantRetained
          ? { state: 'waiting', reason: 'Revoke the retained bucket grants before removing this workload identity.' }
          : needsWorkload ? { state: 'waiting', reason: 'Bind the exact workload before preparing its runtime identity.' }
            : identityObservation(await hosting.runtimeIdentities.inspect({ environment, environmentSpec, service, binding, mode }));
        if (binding?.pending && observation.state === 'action' && observation.step.operation !== 'recover') observation = { state: 'waiting', reason: 'The original runtime identity attempt must be independently recovered before another write.' };
        result.identities.push({ provider: environmentSpec.hosting.provider, serviceName, mode, binding, observation });
        if (observation.state === 'ready' && observation.identity) identities.set(serviceName, observation.identity);
        else if (observation.state === 'action' && observation.preparedIdentity && observation.requiresStorageAccess) identities.set(serviceName, observation.preparedIdentity);
        else waiting.add(serviceName);
      } else if (desired && hosting?.resolveRuntimeIdentity && (environment.platformBindings.services as Record<string, { serviceId?: string }> | undefined)?.[serviceName]?.serviceId) identities.set(serviceName, identitySchema.parse(await hosting.resolveRuntimeIdentity(environment, service)));
      else waiting.add(serviceName);
    } catch {
      result.identities.push({ provider: environmentSpec.hosting.provider, serviceName, mode, binding, observation: { state: 'unknown', reason: unavailable } });
      waiting.add(serviceName);
    }
  }
  for (const storageName of [...names].sort()) {
    const spec = environmentSpec.storage?.[storageName];
    const retainedRecords = state.storageRuntimeAccess[storageName] ?? {};
    const serviceNames = new Set([...Object.keys(retainedRecords), ...(spec?.injectInto ?? [])]);
    for (const serviceName of [...serviceNames].sort()) {
      const previous = retainedRecords[serviceName];
      const provider = previous?.provider ?? spec!.provider;
      const adapter = storageAdapters[provider];
      if (!previous && !(adapter?.runtimeAccess?.hostingProviders ?? providerRegistry.getMetadata(provider)?.storageRuntimeAccess?.hostingProviders ?? []).includes(environmentSpec.hosting.provider)) continue;
      const identity = identities.get(serviceName);
      const bucket = storage?.[storageName];
      const candidate = identity && bucket?.externalId && bucket.instanceScope && spec
        ? targetSchema.safeParse({ provider: spec.provider, externalId: bucket.externalId, context: bucket.instanceScope, identity }) : undefined;
      const current = candidate?.success ? candidate.data : undefined;
      const wanted = Boolean(environmentSpec.services[serviceName] && spec?.injectInto.includes(serviceName));
      const changed = Boolean(previous && current && fingerprint(accessTarget(previous)) !== fingerprint(accessTarget(current)));
      const prepared = result.identities.some(item => item.serviceName === serviceName && item.observation.state === 'action' && item.observation.requiresStorageAccess);
      const transition = wanted && changed && prepared && !previous?.pending && !previous?.retiring;
      const retained = transition ? undefined : previous;
      const desired = wanted && (!changed || transition);
      const selected = transition ? current : previous ?? current;
      const target = selected ? { serviceName, storageName, externalId: selected.externalId, context: selected.context, identity: selected.identity } : undefined;
      const item: AccessItem = { provider: selected?.provider ?? provider, storageName, serviceName, desired, target, retained, ...(transition ? { previous } : {}), observation: { state: 'unknown', reason: unavailable } };
      result.grants.push(item);
      if (wanted && changed && prepared && previous?.retiring) continue;
      if (!previous && (!bucket || waiting.has(serviceName))) { item.waiting = true; continue; }
      const selectedAdapter = storageAdapters[item.provider];
      if (!target || !selectedAdapter?.runtimeAccess) continue;
      try { targetSchema.parse({ provider: item.provider, externalId: target.externalId, context: target.context, identity: target.identity }); item.observation = grantObservation(await selectedAdapter.runtimeAccess.observe({ ...target, environment }, retained?.binding)); }
      catch { /* Never forward provider errors or turn an unknown read into absence. */ }
      if (previous?.retiring) {
        const old = previous.retiring;
        const oldTarget = { serviceName, storageName, externalId: old.externalId, context: old.context, identity: old.identity };
        const activated = identities.get(serviceName)?.source === 'observed' && current && fingerprint(accessTarget(previous)) === fingerprint(accessTarget(current));
        const retiring: AccessItem = { provider: old.provider, storageName, serviceName, desired: false, target: oldTarget, retained: old, retiring: true,
          waiting: wanted && !activated, observation: { state: 'unknown', reason: unavailable } };
        result.grants.push(retiring);
        if (!retiring.waiting) try { retiring.observation = grantObservation(await storageAdapters[old.provider]?.runtimeAccess?.observe({ ...oldTarget, environment }, old.binding) ?? retiring.observation); } catch { /* Keep exact retirement unknown. */ }
      }
    }
  }
  return result;
}

export function planRuntimeAccess(observed: RuntimeAccessObservation): PlanAction[] {
  if (observed.invalid) return [{ id: 'runtime-access:invalid', type: 'update', resource: { kind: 'service', name: 'runtime-access', provider: 'hypervibe' }, verified: false, reason: 'Malformed retained runtime identity or grant state requires repair.', metadata: { operation: RUNTIME_ACCESS_OPERATIONS.identity, blockedReason: 'invalid_runtime_access_state' } }];
  const actions: PlanAction[] = [];
  for (const item of observed.identities) {
    const live = item.observation;
    if (live.state === 'ready' || live.state === 'waiting') continue;
    const step = live.state === 'action' ? live.step : undefined;
    if (live.state === 'action' && live.requiresStorageAccess && observed.grants.some(grant => grant.serviceName === item.serviceName && !grant.retiring
      && (!grant.desired || grant.waiting || grant.retained?.pending || !grant.retained?.binding || grant.observation.state !== 'present' || fingerprint(grant.observation.binding) !== fingerprint(grant.retained.binding)))) continue;
    actions.push({ id: `runtime-identity:${item.serviceName}`, type: 'update', resource: { kind: 'service', name: item.serviceName, provider: item.provider }, verified: Boolean(step), reason: step?.description ?? unavailable,
      ...(step?.requiresConfirm ? { requiresConfirm: true } : {}),
      metadata: { operation: RUNTIME_ACCESS_OPERATIONS.identity, serviceName: item.serviceName, ...(step ? { step } : { blockedReason: 'runtime_identity_unknown' }), evidenceHash: fingerprint(item) } });
  }
  // Only one frontier: dependent grants cannot race an identity transition.
  if (actions.length) return actions;
  for (const item of observed.grants) {
    if (item.waiting) continue;
    if (!item.retiring && !item.desired && item.retained?.retiring) continue;
    const { retained, observation } = item;
    const matches = observation.state === 'present' && retained?.binding && fingerprint(observation.binding) === fingerprint(retained.binding);
    if (item.desired && matches && !retained?.pending) continue;
    if (!item.desired && !retained) continue;
    const recover = Boolean(retained?.pending);
    const operation = recover ? RUNTIME_ACCESS_OPERATIONS.recover : item.desired ? RUNTIME_ACCESS_OPERATIONS.grant : RUNTIME_ACCESS_OPERATIONS.revoke;
    const unknown = !item.target || (!recover && observation.state === 'unknown')
      || (observation.state === 'present' && !matches && !(retained?.pending && observation.binding.attemptId === retained.pending.attemptId));
    const requiresConfirm = !item.desired || retained?.pending?.operation === 'revoke';
    actions.push({ id: `storage:${item.storageName}:access:${item.serviceName}${item.retiring ? ':retiring' : ''}`, type: 'update', resource: { kind: 'storage', name: item.storageName, provider: item.provider }, verified: !unknown,
      reason: unknown ? unavailable : recover ? 'Reconcile the exact recorded permission change.' : item.desired ? `Give ${item.serviceName} access to its ${item.storageName} bucket using workload identity.` : `Revoke the recorded ${item.storageName} bucket grant from ${item.serviceName}.`,
      ...(requiresConfirm ? { requiresConfirm: true } : {}),
      metadata: { operation, serviceName: item.serviceName, storageName: item.storageName, ...(item.retiring ? { retiring: true } : {}), evidenceHash: fingerprint(item), ...(unknown ? { blockedReason: 'runtime_access_unknown' } : {}) } });
  }
  return actions;
}

export async function applyRuntimeAccessAction(input: Input & { action: PlanAction; confirmedActionIds: ReadonlySet<string>; save: (bindings: { runtimeIdentities?: Record<string, RuntimeIdentityBinding>; storageRuntimeAccess?: Record<string, Record<string, AccessRecord>> }) => void | Promise<void> }): Promise<{ success: boolean; status?: 'blocked'; message: string }> {
  const block = (message = unavailable) => ({ success: false, status: 'blocked' as const, message });
  if (input.action.type === 'noop') return { success: true, message: 'No permission change requested.' };
  const { environment, environmentSpec, action } = input;
  if (!environment) return block();
  const state = runtimeAccessBindings(environment);
  if (!state) return block();
  const observed = await observeRuntimeAccess(input);
  const fresh = planRuntimeAccess(observed).find(candidate => candidate.id === action.id);
  if (!fresh || !fresh.verified || fingerprint(fresh) !== fingerprint(action) || (fresh.requiresConfirm && (action.requiresConfirm !== true || !input.confirmedActionIds.has(action.id)))) return block('Runtime access changed or its exact confirmation is missing; re-plan.');
  const serviceName = String(action.metadata!.serviceName);
  try {
    if (action.metadata!.operation === RUNTIME_ACCESS_OPERATIONS.identity) {
      const item = observed.identities.find(candidate => candidate.serviceName === serviceName)!;
      if (!input.hosting?.runtimeIdentities || item.observation.state !== 'action') return block();
      const step = item.observation.step;
      const attemptId = item.binding?.pending?.attemptId ?? randomUUID();
      const binding = { provider: environmentSpec.hosting.provider, evidence: item.binding?.evidence ?? {}, ...item.binding, pending: { attemptId, step } };
      await input.save({ runtimeIdentities: { ...state.runtimeIdentities, [serviceName]: binding } });
      const result = await input.hosting.runtimeIdentities.apply({ environment, environmentSpec, service: { name: serviceName, buildConfig: environmentSpec.services[serviceName] ?? {} }, binding, mode: item.mode, step, attemptId });
      if (result.binding) {
        const parsed = identityBindingSchema.safeParse(result.binding);
        if (!parsed.success || parsed.data.provider !== item.provider || result.receipt.success && parsed.data.pending) return block();
        await input.save({ runtimeIdentities: { ...state.runtimeIdentities, [serviceName]: result.receipt.success ? parsed.data : { ...parsed.data, pending: binding.pending } } });
      } else if (result.receipt.success && item.mode === 'destroy' && (step.operation === 'destroy' || step.operation === 'recover' && step.target.recoverOperation === 'destroy')) {
        // The provider contract requires exact workload and principal absence before this receipt.
        const retained = { ...state.runtimeIdentities }; delete retained[serviceName];
        await input.save({ runtimeIdentities: retained });
        return { success: true, message: 'Verified removal of the exact unused workload identity.' };
      } else if ((result.receipt.data?.mutationAttempted === false || result.receipt.data?.mutationRejected === true) && !item.binding?.pending) await input.save({ runtimeIdentities: state.runtimeIdentities });
      return result.receipt.success && result.binding ? { success: true, message: 'Runtime identity stage verified. Re-plan for its next dependency.' } : block('Identity change is incomplete; retained intent must be reconciled.');
    }
    const storageName = String(action.metadata!.storageName);
    const item = observed.grants.find(candidate => candidate.storageName === storageName && candidate.serviceName === serviceName && Boolean(candidate.retiring) === Boolean(action.metadata!.retiring))!;
    const driver = input.storageAdapters[item.provider]?.runtimeAccess;
    if (!driver || !item.target) return block();
    const operation = item.retained?.pending?.operation ?? (item.desired ? 'grant' : 'revoke');
    const attemptId = item.retained?.pending?.attemptId ?? randomUUID();
    const record: AccessRecord = { provider: item.provider, externalId: item.target.externalId, context: item.target.context, identity: item.target.identity, ...(item.retained?.binding ? { binding: item.retained.binding } : {}), pending: { operation, attemptId },
      ...(!item.retiring && (item.previous || item.retained?.retiring) ? { retiring: item.previous ?? item.retained!.retiring } : {}) };
    const saveRecord = async (value?: AccessRecord) => {
      const records = { ...state.storageRuntimeAccess[storageName] };
      if (item.retiring) {
        const current = { ...records[serviceName]! };
        if (value) current.retiring = value; else delete current.retiring;
        records[serviceName] = current;
      } else if (value) records[serviceName] = value;
      else if (records[serviceName]?.retiring) return Promise.reject(new Error('Retiring access must be removed before its container binding.'));
      else delete records[serviceName];
      await input.save({ storageRuntimeAccess: { ...state.storageRuntimeAccess, [storageName]: records } });
    };
    await saveRecord(record);
    if (operation === 'revoke') {
      if (item.observation.state !== 'absent') {
        if (!record.binding) return block();
        const receipt = await driver.revoke({ ...item.target, environment }, record.binding);
        if (!receipt.success) return block('Grant removal is incomplete; its exact recovery intent is retained.');
      }
      if ((await driver.observe({ ...item.target, environment }, record.binding)).state !== 'absent') return block();
      await saveRecord();
    } else {
      const result = await driver.grant({ ...item.target, environment }, attemptId, record.binding);
      if (result.binding && grantSchema.safeParse(result.binding).success && result.binding.attemptId === attemptId) {
        record.binding = result.binding;
        await saveRecord(record);
      }
      if (!result.receipt.success || !record.binding) return block('Grant completion is unverified; its exact recovery intent is retained.');
      const verification = await driver.observe({ ...item.target, environment }, record.binding);
      if (verification.state !== 'present' || fingerprint(verification.binding) !== fingerprint(record.binding)) return block();
      delete record.pending;
      await saveRecord(record);
    }
    return { success: true, message: 'Exact bucket permission configuration verified. Application data access remains a deployment check.' };
  } catch { return block('Runtime access could not complete. Any persisted attempt is retained for exact recovery.'); }
}

export async function projectRuntimeAccessInput(project: Project, environment: Environment | null, environmentSpec: EnvironmentSpec, hosting?: IProviderAdapter): Promise<Input> {
  const retained = runtimeAccessBindings(environment);
  const identityCapability = providerRegistry.getMetadata(environmentSpec.hosting.provider)?.lifecycle?.hosting?.runtimeIdentityTiming;
  const providers = new Set([...Object.values(environmentSpec.storage ?? {}).filter(spec => providerRegistry.getMetadata(spec.provider)?.storageRuntimeAccess?.hostingProviders.includes(environmentSpec.hosting.provider)).map(spec => spec.provider),
    ...Object.values(retained?.storageRuntimeAccess ?? {}).flatMap(records => Object.values(records).flatMap(record => [record.provider, ...(record.retiring ? [record.retiring.provider] : [])]))]);
  const storageAdapters: Input['storageAdapters'] = {};
  for (const provider of providers) {
    const result = await adapterFactory.getStorageAdapter(provider, project);
    if (result.success && result.adapter?.name === provider) storageAdapters[provider] = result.adapter;
  }
  const needsHosting = providers.size > 0 || Boolean(identityCapability && Object.keys(environmentSpec.services).length) || Object.keys(retained?.runtimeIdentities ?? {}).length > 0;
  if (!hosting && needsHosting) {
    const result = await adapterFactory.getProviderAdapter(environmentSpec.hosting.provider, project, undefined, environment?.name);
    if (result.success && result.adapter?.name === environmentSpec.hosting.provider) hosting = result.adapter;
  }
  if (needsHosting) await hosting?.configureTarget?.({ region: environmentSpec.hosting.region });
  return { environment, environmentSpec, hosting, storageAdapters };
}

export function runtimeAccessReady(observed: RuntimeAccessObservation | undefined, storageName: string, serviceName: string): boolean {
  const item = observed?.grants.find(grant => grant.storageName === storageName && grant.serviceName === serviceName);
  return Boolean(item?.desired && !item.waiting && !item.retained?.pending && item.retained?.binding
    && item.observation.state === 'present' && fingerprint(item.retained.binding) === fingerprint(item.observation.binding));
}

/** Local pending intent outranks stale repository exports; conflicting native identities never merge. */
export function mergeRuntimeAccessBindings(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const left = runtimeAccessBindings({ platformBindings: existing });
  const right = runtimeAccessBindings({ platformBindings: incoming });
  if (!left || !right) throw new Error('Malformed runtime access recovery bindings.');
  const result: Record<string, unknown> = {};
  if (existing.runtimeIdentities !== undefined || incoming.runtimeIdentities !== undefined) {
    const identities = { ...right.runtimeIdentities, ...left.runtimeIdentities };
    for (const [name, next] of Object.entries(right.runtimeIdentities)) {
      const previous = left.runtimeIdentities[name];
      if (!previous) continue;
      if (previous.provider !== next.provider || Object.keys(previous.evidence).some(key => next.evidence[key] !== undefined && next.evidence[key] !== previous.evidence[key])
        || previous.pending && next.pending && fingerprint(previous.pending) !== fingerprint(next.pending)) throw new Error('Runtime identity conflicts with retained local evidence.');
    }
    result.runtimeIdentities = identities;
  }
  if (existing.storageRuntimeAccess !== undefined || incoming.storageRuntimeAccess !== undefined) {
    const grants = { ...right.storageRuntimeAccess, ...left.storageRuntimeAccess };
    for (const [name, next] of Object.entries(right.storageRuntimeAccess)) {
      const previous = left.storageRuntimeAccess[name] ?? {};
      grants[name] = { ...next, ...previous };
      for (const [serviceName, candidate] of Object.entries(next)) {
        const retained = previous[serviceName];
        if (!retained) continue;
        if (fingerprint(accessTarget(retained)) !== fingerprint(accessTarget(candidate))
          || retained.binding && candidate.binding && fingerprint(retained.binding) !== fingerprint(candidate.binding)
          || retained.pending && candidate.pending && fingerprint(retained.pending) !== fingerprint(candidate.pending)
          || retained.retiring && candidate.retiring && fingerprint(retained.retiring) !== fingerprint(candidate.retiring)) throw new Error('Runtime bucket access conflicts with retained local evidence.');
      }
    }
    result.storageRuntimeAccess = grants;
  }
  return result;
}
