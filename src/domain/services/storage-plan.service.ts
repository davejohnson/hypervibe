import { runtimeAccessBindings, runtimeAccessReady } from './runtime-access.service.js';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { IProviderAdapter, Receipt } from '../ports/provider.port.js';
import {
  createStorageCreateRecovery,
  parseStorageCreateRecovery,
  storageDeletionEvidenceSchema,
  storageDeletionReceiptsSchema,
  storageRecoveryMapSchema,
  storageDeletionRecoverySchema,
  type StorageDeletionRecovery,
  type StorageDestroyOptions,
  type IStorageAdapter,
  type StorageContext,
  type StorageCreateRecovery,
  type StorageRuntimeTarget,
} from '../ports/storage.port.js';
import { withStorageInstanceScopes } from './storage-instance-identity.js';
import { S3_STORAGE_RUNTIME_ENV_KEYS } from './storage-runtime-env.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { adapterFactory } from './adapter.factory.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { receiptRolloutBaseline } from './runtime-rollout.service.js';

export const STORAGE_OPERATIONS = {
  ensure: 'storageEnsure',
  clearCreateRecovery: 'storageCreateRecoveryClear',
  finalizeCreateRecovery: 'storageCreateRecoveryFinalize',
  wire: 'storageWire',
  unwire: 'storageUnwire',
  destroy: 'storageDestroy',
  recoverDeletion: 'storageDeletionRecover',
  continueDeletion: 'storageDeletionContinue',
  retryDeletion: 'storageDeletionRetry',
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
  /** Applied runtime projection per consumer; not proof of continuous remote secret absence. */
  runtimeContracts?: Record<string, string>;
  purpose?: 'backup';
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

type StorageCreateRecoveryState = {
  present: boolean;
  malformed: boolean;
  raw: Record<string, unknown>;
  parsed: Record<string, StorageCreateRecovery>;
  deletions: Record<string, StorageDeletionRecovery>;
};

function storageCreateRecoveryState(
  environment: Pick<Environment, 'platformBindings'> | null
): StorageCreateRecoveryState {
  const value = environment?.platformBindings.storageCreateRecovery;
  if (value === undefined) {
    return { present: false, malformed: false, raw: {}, parsed: {}, deletions: {} };
  }
  const raw = asRecord(value);
  if (!raw) {
    return { present: true, malformed: true, raw: {}, parsed: {}, deletions: {} };
  }
  const parsed = storageRecoveryMapSchema.safeParse(raw);
  return parsed.success
    ? { present: true, malformed: false, raw,
      parsed: Object.fromEntries(Object.entries(parsed.data).filter((entry): entry is [string, StorageCreateRecovery] => entry[1].operation === 'create')),
      deletions: Object.fromEntries(Object.entries(parsed.data).filter((entry): entry is [string, StorageDeletionRecovery] => entry[1].operation === 'delete')) }
    : { present: true, malformed: true, raw, parsed: {}, deletions: {} };
}

function storageContext(value: unknown): StorageContext | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  if (entries.length === 0 || entries.some(([, item]) => typeof item !== 'string' || item.length === 0)) {
    return undefined;
  }
  return Object.fromEntries(entries) as StorageContext;
}

function scopesMatch(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => (
      rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value
    ));
}

function currentStorageContext(
  environment: Pick<Environment, 'platformBindings'> | null,
  provider: string,
  hostingProvider: string
): StorageContext | undefined {
  const contexts = asRecord(environment?.platformBindings.storageProviders);
  const providerContext = storageContext(contexts?.[provider]);
  if (providerContext) return providerContext;
  if (provider !== hostingProvider) return undefined;
  const projectId = environment?.platformBindings.projectId;
  const environmentId = environment?.platformBindings.environmentId;
  return typeof projectId === 'string' && projectId.length > 0
    && typeof environmentId === 'string' && environmentId.length > 0
    ? { projectId, environmentId }
    : undefined;
}

function recoveryMatchesTarget(
  recovery: StorageCreateRecovery,
  name: string,
  provider: string,
  context: StorageContext | undefined
): boolean {
  return recovery.resourceName === name
    && recovery.provider === provider
    && (!context || scopesMatch(recovery.providerScope, context));
}

function recoveriesMatch(left: StorageCreateRecovery, right: StorageCreateRecovery): boolean {
  return left.provider === right.provider
    && left.operation === right.operation
    && left.resourceName === right.resourceName
    && left.state === right.state
    && left.externalId === right.externalId
    && left.returnedName === right.returnedName
    && scopesMatch(left.providerScope, right.providerScope);
}

function storageRecoveryGuidance(): string {
  return 'Use hv_inspect to identify the exact bucket and provider scope, then use the provider\'s hv_import storage-adoption workflow to bind that exact resource. The recovery marker is not deletion authority.';
}

function storageIdentityMatches(binding: StorageBinding, item: NonNullable<ObservedState['storage']>[number]): boolean {
  return binding.externalId === item.externalId
    && binding.provider === item.provider
    && scopesMatch(binding.instanceScope, item.instanceScope);
}

function exactRecoveredStorage(
  live: NonNullable<ObservedState['storage']>,
  recovery: StorageCreateRecovery,
  name: string,
  provider: string,
  region: string
): NonNullable<ObservedState['storage']>[number] | undefined {
  if (
    recovery.state !== 'identified'
    || !recovery.externalId
    || recovery.provider !== provider
    || recovery.resourceName !== name
    || recovery.returnedName !== name
  ) return undefined;

  const identityCandidates = live.filter((item) => (
    item.provider === provider
    && (
      item.externalId === recovery.externalId
      || item.name.toLowerCase() === name.toLowerCase()
    )
  ));
  if (identityCandidates.length !== 1) return undefined;

  const candidate = identityCandidates[0];
  return candidate
    && candidate.externalId === recovery.externalId
    && candidate.name === name
    && scopesMatch(candidate.instanceScope, recovery.providerScope)
    && candidate.region === region
    && candidate.status === 'ready'
    ? candidate
    : undefined;
}

function storageObservationKnown(observed: ObservedState | null, provider: string): boolean {
  if (!observed) return true;
  const byProvider = observed.completeness?.storageByProvider;
  return byProvider
    ? byProvider[provider] === 'complete'
    : observed.completeness?.storage !== 'unknown';
}

function storageRuntimeContract(provider: string, hostingProvider: string): string | undefined {
  const version = providerRegistry.getMetadata(provider)?.storageRuntimeContract;
  return version ? `${version}:${hostingProvider}` : undefined;
}

function requireAppliedStorageEnvUpdate(receipt: Receipt): Receipt {
  return receipt.data?.skipped === true
    ? { ...receipt, success: false, message: `Storage environment update was skipped: ${receipt.message}` }
    : receipt;
}

/** Preserve pending rollout evidence for the exact storage consumer without
 * forwarding arbitrary provider receipt data or claiming runtime activation. */
function storageRuntimeRolloutData(receipt: Receipt, serviceName: string): Record<string, unknown> {
  if (receipt.data?.runtimeRolloutRequired !== true) return {};
  const baseline = receiptRolloutBaseline(receipt, serviceName) ?? { state: 'unknown' as const };
  return {
    services: [serviceName], runtimeRolloutRequired: true,
    rolloutBaseline: { state: baseline.state,
      ...(baseline.id ? { deploymentId: baseline.id } : {}),
      ...(baseline.activeDeploymentIds ? { activeDeploymentIds: baseline.activeDeploymentIds } : {}) },
    ...(receipt.data.deploymentDeferred === true ? { deploymentDeferred: true } : {}),
  };
}

function boundServiceId(environment: Environment | null, serviceName: string): string | undefined {
  const services = asRecord(environment?.platformBindings.services);
  const binding = asRecord(services?.[serviceName]);
  return typeof binding?.serviceId === 'string' && binding.serviceId.length > 0
    ? binding.serviceId
    : undefined;
}

export function parseStorageBindings(environment: Pick<Environment, 'platformBindings'> | null): Record<string, StorageBinding> {
  const storage = asRecord(environment?.platformBindings.storage) ?? {};
  const contexts = asRecord(environment?.platformBindings.storageProviders) ?? {};
  return withStorageInstanceScopes(storage, contexts) as Record<string, StorageBinding>;
}

export function parseStorageProviderContexts(environment: Pick<Environment, 'platformBindings'> | null): Record<string, StorageContext> {
  return (asRecord(environment?.platformBindings.storageProviders) ?? {}) as Record<string, StorageContext>;
}

/** Share validation across ordinary deletion and migration candidate/rollback
 * cleanup. Callers persist this metadata with their matching reference removal. */
export function storageDeletionReceiptUpdate(input: {
  history: unknown; name: string; provider: string; externalId: string; context: StorageContext; receipt: Receipt;
}) {
  const history = storageDeletionReceiptsSchema.parse(input.history ?? {});
  if (!input.receipt.success) throw new Error('Incomplete deletion cannot clear its retained reference.');
  const raw = input.receipt.data?.storageDeletion;
  if (raw === undefined) return { history, evidence: undefined };
  const evidence = storageDeletionEvidenceSchema.parse(raw);
  if (evidence.provider !== input.provider || evidence.externalId !== input.externalId
    || !scopesMatch(evidence.instanceScope, input.context)) throw new Error('Storage deletion evidence does not match the exact target.');
  const existing = history[input.name] ?? [];
  return { history: { ...history, [input.name]: existing.some(item => isDeepStrictEqual(item, evidence))
    ? existing : [...existing, evidence] }, evidence };
}

function storageDeletionReference(environment: Environment, name: string, target: StorageDeletionRecovery['target']) {
  const bindings = parseStorageBindings(environment), contexts = parseStorageProviderContexts(environment);
  const binding = bindings[name];
  const candidate = asRecord(asRecord(asRecord(environment.platformBindings.dataMigrationCandidates)?.storage)?.[name]);
  const selected = target === 'active' ? binding : target === 'previous' ? binding?.previousTarget : candidate;
  if (!selected || typeof selected.provider !== 'string' || typeof selected.externalId !== 'string') return undefined;
  const root = environment.platformBindings;
  const fallback = typeof root.projectId === 'string' && typeof root.environmentId === 'string'
    ? { projectId: root.projectId, environmentId: root.environmentId } : undefined;
  const context = storageContext(target === 'candidate' ? candidate?.context : selected.instanceScope)
    ?? contexts[selected.provider] ?? fallback;
  return { provider: selected.provider, externalId: selected.externalId, context,
    migrationId: target === 'candidate' ? candidate?.migrationId : target === 'previous' ? binding?.dataMigration?.id : undefined,
    record: target === 'previous' ? binding : selected };
}

/** Existing storage lifecycle frontier, shared by ordinary and migration cleanup.
 * The marker precedes every native DELETE. It never authorizes uncertain replay. */
export async function destroyTrackedStorage(input: {
  environmentId: string; name: string; target: StorageDeletionRecovery['target']; migrationId?: string;
  adapter: IStorageAdapter; externalId: string; context: StorageContext; allowMutation?: boolean; retryAttempt?: boolean;
}): Promise<{ success: boolean; status?: 'blocked' | 'pending'; message: string; error?: string; data?: Record<string, unknown> }> {
  const blocked = (message: string, data?: Record<string, unknown>) => ({ success: false, status: 'blocked' as const, message, ...(data ? { data } : {}) });
  const before = envRepo.findById(input.environmentId);
  if (!before) return blocked('The storage environment is no longer available.');
  const reference = storageDeletionReference(before, input.name, input.target);
  if (!reference || reference.provider !== input.adapter.name || reference.externalId !== input.externalId
    || !scopesMatch(reference.context, input.context) || reference.migrationId !== input.migrationId) return blocked('The exact storage reference or effective provider context changed.');
  const recoveryState = storageCreateRecoveryState(before);
  if (recoveryState.malformed || recoveryState.parsed[input.name]
    || !storageDeletionReceiptsSchema.safeParse(before.platformBindings.storageDeletionReceipts ?? {}).success) return blocked('Storage recovery evidence must be resolved before cleanup.');
  let marker = recoveryState.deletions[input.name];
  const markerMatches = (value: StorageDeletionRecovery) => value.target === input.target && value.migrationId === input.migrationId
    && value.snapshot.provider === input.adapter.name && value.snapshot.externalId === input.externalId
    && scopesMatch(value.snapshot.instanceScope, input.context);
  if (marker && (!markerMatches(marker) || !input.adapter.capabilities?.supportsDeletionRecovery)) return blocked('The retained deletion requires its original supported provider recovery path.');
  const permissionsClear = (environment: Environment) => {
    if (input.target !== 'active') return true;
    const access = runtimeAccessBindings(environment);
    return Boolean(access && !Object.keys(access.storageRuntimeAccess[input.name] ?? {}).length);
  };
  const allowMutation = marker ? input.allowMutation === true : true;
  let retryAvailable = input.retryAttempt === true;
  if (allowMutation && !permissionsClear(before)) return blocked('Reconcile retained bucket permissions before deleting this storage.');
  const options: StorageDestroyOptions = {
    recovery: marker?.snapshot,
    allowMutation,
    retryAttempt: input.retryAttempt,
    persistRecovery: async snapshot => {
      const nextMarker = storageDeletionRecoverySchema.parse({ operation: 'delete', resourceName: input.name,
        target: input.target, ...(input.migrationId ? { migrationId: input.migrationId } : {}), snapshot });
      if (!markerMatches(nextMarker)) throw new Error('Deletion progress does not match the reviewed storage target.');
      if (marker) {
        const previous = marker.snapshot;
        const immutable = (value: typeof snapshot) => ({ provider: value.provider, externalId: value.externalId,
          instanceScope: value.instanceScope, nativeIdentity: value.nativeIdentity, requestedAt: value.requestedAt,
          steps: value.steps, policySeconds: value.retention.policySeconds });
        const dispatch = !options.retryAttempt && previous.phase === 'ready' && snapshot.phase === 'uncertain' && previous.nextStep === snapshot.nextStep;
        const observed = previous.phase !== 'ready' && snapshot.phase === 'ready' && previous.nextStep + 1 === snapshot.nextStep;
        const sameAttempt = previous.nextStep === snapshot.nextStep && previous.attemptedAt === snapshot.attemptedAt;
        const rejected = previous.phase === 'uncertain' && snapshot.phase === 'rejected' && sameAttempt && options.allowMutation;
        const presence = previous.phase !== 'ready' && previous.phase === snapshot.phase && sameAttempt
          && previous.rejectionStatus === snapshot.rejectionStatus && Boolean(snapshot.retryObservedAt);
        const retry = retryAvailable && options.allowMutation && deletionRetryReady(previous)
          && snapshot.phase === 'uncertain' && previous.nextStep === snapshot.nextStep && !snapshot.retryObservedAt
          && (previous.phase === 'rejected' || input.adapter.capabilities.supportsConditionalObjectDeletionRetry === true);
        const expectedPrior = retry ? [...previous.priorAttempts ?? [], { step: previous.nextStep, attemptedAt: previous.attemptedAt!,
          outcome: previous.phase, ...(previous.rejectionStatus ? { rejectionStatus: previous.rejectionStatus } : {}) }] : previous.priorAttempts;
        if (!isDeepStrictEqual(immutable(previous), immutable(snapshot)) || !(dispatch || observed || rejected || presence || retry)
          || dispatch && !options.allowMutation || !isDeepStrictEqual(snapshot.priorAttempts, expectedPrior)
          || previous.retention.resources.some(item => !snapshot.retention.resources.some(next => isDeepStrictEqual(next, item)))) {
          throw new Error('Deletion progress cannot replace its original identities or replay an uncertain step.');
        }
        if (retry) retryAvailable = false;
      } else if (snapshot.phase !== 'ready' || snapshot.nextStep !== 0) throw new Error('Deletion must save its selected identities before the first attempt.');
      const latest = envRepo.findById(input.environmentId);
      const current = storageCreateRecoveryState(latest);
      if (!latest || !isDeepStrictEqual(storageDeletionReference(latest, input.name, input.target), reference)
        || current.malformed || current.parsed[input.name] || !isDeepStrictEqual(current.deletions[input.name], marker)) throw new Error('Storage identity or recovery changed before deletion dispatch.');
      if (snapshot.phase === 'uncertain' && !snapshot.retryObservedAt && options.allowMutation && !permissionsClear(latest)) throw new Error('Reconcile retained bucket permissions before continuing deletion.');
      const next = { ...latest.platformBindings, storageCreateRecovery: { ...current.raw, [input.name]: nextMarker } };
      if (!envRepo.compareAndSwapPlatformBindings(latest.id, latest.platformBindings, next)) throw new Error('Deletion progress could not be saved; no further deletion was dispatched.');
      marker = nextMarker;
    },
  };
  let receipt: Receipt;
  try {
    receipt = input.adapter.capabilities?.supportsDeletionRecovery
      ? await input.adapter.destroyBucket(before, input.context, input.externalId, options)
      : await input.adapter.destroyBucket(before, input.context, input.externalId);
  } catch { return blocked('Storage deletion outcome is unknown. Its reference and recovery evidence were retained.'); }
  if (!receipt.success) return { ...receipt,
    ...(receipt.data?.storageDeletionContinuation === true ? { status: 'pending' as const } : {}) };
  let validated: ReturnType<typeof storageDeletionReceiptUpdate>;
  try {
    validated = storageDeletionReceiptUpdate({ history: before.platformBindings.storageDeletionReceipts,
      name: input.name, provider: input.adapter.name, externalId: input.externalId, context: input.context, receipt });
    if (marker && (!validated.evidence || !isDeepStrictEqual(validated.evidence.nativeIdentity, marker.snapshot.nativeIdentity)
      || !isDeepStrictEqual(validated.evidence.priorAttempts, marker.snapshot.priorAttempts)
      || !isDeepStrictEqual(validated.evidence.deletedObjects, marker.snapshot.steps.filter(step => step.kind === 'object')
        .map(({ name, generation, metageneration }) => ({ name, generation, metageneration })))
      || marker.snapshot.phase === 'ready' || marker.snapshot.steps[marker.snapshot.nextStep].kind !== 'bucket')) throw new Error('Deletion completion does not match its selected identities and previous attempts.');
  } catch { return blocked('Storage deletion returned incomplete or mismatched evidence; its reference was retained.'); }
  const data = validated.evidence ? { storageDeletion: validated.evidence } : receipt.data;
  try {
    const latest = envRepo.findById(input.environmentId);
    if (!latest) return blocked('Storage deletion finished, but its local evidence could not be retained.', data);
    const state = storageCreateRecoveryState(latest);
    if (state.malformed || !isDeepStrictEqual(state.deletions[input.name], marker)
      || !isDeepStrictEqual(storageDeletionReference(latest, input.name, input.target), reference)) return blocked('The storage reference changed during cleanup; its current reference and recovery evidence were preserved.', data);
    const update = storageDeletionReceiptUpdate({ history: latest.platformBindings.storageDeletionReceipts,
      name: input.name, provider: input.adapter.name, externalId: input.externalId, context: input.context, receipt });
    const next: Record<string, unknown> = { ...latest.platformBindings,
      ...(update.evidence ? { storageDeletionReceipts: update.history } : {}) };
    if (input.target === 'candidate') {
      const root = asRecord(latest.platformBindings.dataMigrationCandidates) ?? {};
      const candidates = { ...(asRecord(root.storage) ?? {}) }; delete candidates[input.name];
      next.dataMigrationCandidates = { ...root, storage: candidates };
    } else {
      const storage = { ...(asRecord(latest.platformBindings.storage) ?? {}) };
      if (input.target === 'active') delete storage[input.name];
      else { const binding = { ...asRecord(storage[input.name]) }; delete binding.previousTarget; storage[input.name] = binding; }
      next.storage = storage;
    }
    if (marker) { const recoveries = { ...state.raw }; delete recoveries[input.name]; next.storageCreateRecovery = Object.keys(recoveries).length ? recoveries : undefined; }
    if (!envRepo.compareAndSwapPlatformBindings(latest.id, latest.platformBindings, next)) return blocked('Saving the storage deletion receipt failed; its reference and recovery evidence were retained.', data);
    return { success: true, message: receipt.message, data };
  } catch { return blocked('Saving the storage deletion receipt failed; inspect retained recovery evidence before continuing.', data); }
}

export function storageEnvKeys(name: string): string[] {
  void name;
  return [...S3_STORAGE_RUNTIME_ENV_KEYS];
}

function deletionRetryReady(snapshot: StorageDeletionRecovery['snapshot']): boolean {
  return Boolean(snapshot.retryObservedAt && (snapshot.phase === 'rejected'
    || snapshot.phase === 'uncertain' && snapshot.steps[snapshot.nextStep].kind === 'object'));
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
    ...(params.operation === STORAGE_OPERATIONS.destroy || params.operation === STORAGE_OPERATIONS.continueDeletion || params.operation === STORAGE_OPERATIONS.retryDeletion ? { dataBearing: true } : {}),
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
  const recoveries = storageCreateRecoveryState(params.environment);

  if (!recoveries.malformed && Object.keys(recoveries.deletions).length) {
    for (const [name, marker] of Object.entries(recoveries.deletions)) {
      const retry = deletionRetryReady(marker.snapshot);
      actions.push(action({
      id: `storage:${name}:${retry ? 'deletion-retry' : 'deletion-recovery'}`, type: retry || marker.snapshot.phase === 'ready' ? 'destroy' : 'update', name, provider: marker.snapshot.provider,
      operation: retry ? STORAGE_OPERATIONS.retryDeletion : marker.snapshot.phase === 'ready' ? STORAGE_OPERATIONS.continueDeletion : STORAGE_OPERATIONS.recoverDeletion,
      requiresConfirm: retry || marker.snapshot.phase === 'ready', verified: false,
      reason: retry ? `Explicitly retry the prior ${marker.snapshot.phase} deletion of the same exact ${marker.snapshot.steps[marker.snapshot.nextStep].kind} for storage "${name}" using its original native preconditions`
        : marker.snapshot.phase === 'ready'
        ? `Delete the remaining ${marker.snapshot.steps.length - marker.snapshot.nextStep} exact selected targets for storage "${name}"`
        : `Check the previous deletion of storage "${name}" without sending another delete`,
      metadata: { recoverySha256: canonicalJsonSha256(marker) },
    }));
    }
    warnings.push('Uncertain deletion recovery only reads its exact prior target. Continuing remaining unattempted deletions requires this fresh plan.');
    return { actions, warnings, unmanaged };
  }

  if (recoveries.malformed) {
    const actionNames = new Set<string>([
      ...Object.keys(desired),
      ...Object.keys(recoveries.raw).filter((name) => name.trim().length > 0),
    ]);
    if (actionNames.size === 0) actionNames.add('storage-create-recovery');
    for (const name of actionNames) {
      const desiredSpec = desired[name];
      const rawMarker = asRecord(recoveries.raw[name]);
      const provider = desiredSpec?.provider
        ?? (typeof rawMarker?.provider === 'string' && rawMarker.provider.trim().length > 0
          ? rawMarker.provider
          : params.environmentSpec.hosting.provider);
      actions.push(action({
        id: desiredSpec ? `storage:${name}` : `storage:${name}:create-recovery`,
        type: 'update',
        name,
        provider,
        operation: STORAGE_OPERATIONS.ensure,
        verified: false,
        reason: `Storage create-recovery state for "${name}" is malformed; all mutations are blocked`,
        metadata: { blockedReason: 'malformed_storage_create_recovery' },
      }));
    }
    warnings.push('Malformed retained storage-create recovery state blocks storage reconciliation until it is explicitly repaired.');
    return { actions, warnings, unmanaged };
  }

  for (const [name, spec] of Object.entries(desired)) {
    const recovery = recoveries.parsed[name];
    let recoveryClearActionId: string | undefined;
    let recoveryFinalizeActionId: string | undefined;
    if (recovery) {
      const context = currentStorageContext(
        params.environment,
        spec.provider,
        params.environmentSpec.hosting.provider
      );
      const exactTarget = recoveryMatchesTarget(recovery, name, spec.provider, context);
      const observationKnown = storageObservationKnown(params.observed, spec.provider);
      const sameNameCandidates = live.filter((item) => (
        item.provider === spec.provider
        && item.name.toLowerCase() === name.toLowerCase()
      ));
      const recoveredObservation = exactRecoveredStorage(
        live,
        recovery,
        name,
        spec.provider,
        spec.region
      );
      const exactRecovered = exactTarget
        && !bindings[name]
        && params.observed
        && observationKnown
        && recoveredObservation
        ? recoveredObservation
        : undefined;
      const providerConfirmedAbsent = Boolean(
        exactTarget
        && recovery.state === 'unresolved'
        && !bindings[name]
        && params.observed
        && observationKnown
        && sameNameCandidates.length === 0
      );
      if (exactRecovered) {
        recoveryFinalizeActionId = `storage:${name}`;
        actions.push(action({
          id: recoveryFinalizeActionId,
          type: 'update',
          name,
          provider: spec.provider,
          operation: STORAGE_OPERATIONS.finalizeCreateRecovery,
          verified: true,
          reason: `Finalize the exact delayed create for storage "${name}" after complete provider observation proved it converged`,
          metadata: {
            externalId: exactRecovered.externalId,
            region: exactRecovered.region,
            instanceScope: recovery.providerScope,
            storageCreateRecovery: recovery,
          },
        }));
        // Continue planning against the binding that the finalization action
        // will persist. This keeps dependent wiring in the same reviewed plan
        // without issuing another provider create.
        bindings[name] = {
          provider: spec.provider,
          externalId: exactRecovered.externalId,
          instanceScope: recovery.providerScope,
          region: spec.region,
          services: [],
          envKeys: storageEnvKeys(name),
        };
      } else if (providerConfirmedAbsent) {
        recoveryClearActionId = `storage:${name}:create-recovery:clear`;
        actions.push(action({
          id: recoveryClearActionId,
          type: 'update',
          name,
          provider: spec.provider,
          operation: STORAGE_OPERATIONS.clearCreateRecovery,
          verified: true,
          requiresConfirm: true,
          reason: `Clear retained create-recovery state after complete provider observation confirmed storage "${name}" is absent`,
          metadata: {
            instanceScope: recovery.providerScope,
            storageCreateRecovery: recovery,
          },
        }));
      } else {
        actions.push(action({
          id: `storage:${name}`,
          type: 'update',
          name,
          provider: spec.provider,
          operation: STORAGE_OPERATIONS.ensure,
          verified: false,
          reason: exactTarget
            ? `Storage "${name}" has a retained create outcome that requires explicit resolution`
            : `Storage "${name}" has create-recovery state that does not match its current provider or scope`,
          metadata: {
            blockedReason: exactTarget
              ? 'storage_create_recovery_required'
              : 'storage_create_recovery_target_mismatch',
            storageCreateRecovery: recovery,
          },
        }));
        continue;
      }
    }
    const binding = bindings[name];
    const observationKnown = storageObservationKnown(params.observed, spec.provider);
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
    const boundObserved = binding
      ? live.filter((item) => storageIdentityMatches(binding, item))
      : [];
    const nameCandidates = binding
      ? []
      : live.filter((item) => item.provider === spec.provider && item.name.toLowerCase() === name.toLowerCase());
    const observed = binding
      ? boundObserved.length === 1 ? boundObserved[0] : undefined
      : nameCandidates.length === 1 ? nameCandidates[0] : undefined;
    const ensureId = `storage:${name}`;
    const conflict = !binding && nameCandidates.length > 0;
    const ambiguousConflict = nameCandidates.length > 1;
    const providerDrift = Boolean(binding && binding.provider !== spec.provider);
    const regionDrift = Boolean(binding && observed?.region && observed.region !== spec.region);
    const bindingIdentityMismatch = Boolean(
      binding
      && !providerDrift
      && params.observed
      && observationKnown
      && boundObserved.length !== 1
    );
    const locallyBoundWithoutObservation = Boolean(binding && !params.observed);
    if (!recoveryFinalizeActionId) actions.push(action({
      id: ensureId,
      type: conflict || providerDrift || regionDrift || bindingIdentityMismatch
        ? 'update'
        : observed && binding || locallyBoundWithoutObservation
          ? 'noop'
          : 'create',
      name,
      provider: spec.provider,
      operation: STORAGE_OPERATIONS.ensure,
      verified: Boolean(params.observed && observationKnown),
      billable: !binding && nameCandidates.length === 0,
      ...(recoveryClearActionId ? { dependsOn: [recoveryClearActionId] } : {}),
      reason: providerDrift
        ? `Storage provider changed from ${binding?.provider} to ${spec.provider}; declare a one-use dataMigration before replacing durable data`
        : conflict
        ? ambiguousConflict
          ? `Multiple live buckets named "${name}" exist; explicit identity cleanup or adoption is required`
          : `A live bucket named "${name}" exists but is not managed by Hypervibe; explicit hv_import adoption is required`
        : bindingIdentityMismatch
          ? `The locally bound bucket "${name}" is absent or has a different provider scope; refusing to create a replacement`
        : regionDrift
          ? `Bucket region is immutable and drifted from ${observed?.region} to ${spec.region}; migrate data explicitly before replacement`
          : observed && binding || locallyBoundWithoutObservation
            ? `Object storage bucket "${name}" is in sync`
            : `Object storage bucket "${name}" is not deployed`,
      metadata: {
        region: spec.region,
        services: spec.injectInto,
        ...(providerDrift ? { blockedReason: 'provider_migration_required', externalId: binding?.externalId } : {}),
        ...(conflict ? ambiguousConflict
          ? {
              blockedReason: 'ambiguous_storage_identity',
              externalIds: nameCandidates.map((candidate) => candidate.externalId).sort(),
            }
          : { blockedReason: 'unmanaged_conflict', externalId: observed?.externalId } : {}),
        ...(bindingIdentityMismatch ? {
          blockedReason: 'storage_binding_identity_mismatch',
          externalId: binding?.externalId,
          instanceScope: binding?.instanceScope ?? null,
        } : {}),
        ...(regionDrift ? { blockedReason: 'immutable_region', externalId: observed?.externalId } : {}),
      },
    }));
    if (conflict) {
      for (const candidate of nameCandidates) {
        unmanaged.push({ kind: 'storage', name: candidate.name, detail: `${candidate.provider} bucket requires explicit hv_import adoption` });
      }
    }
    if (bindingIdentityMismatch) {
      for (const candidate of live.filter((item) => (
        item.externalId === binding?.externalId
        || item.name.toLowerCase() === name.toLowerCase()
      ))) {
        unmanaged.push({
          kind: 'storage',
          name: candidate.name,
          detail: `${candidate.provider} bucket ${candidate.externalId} does not match the durable local binding scope`,
        });
      }
    }

    for (const serviceName of spec.injectInto) {
      const serviceId = boundServiceId(params.environment, serviceName);
      const observedServiceCandidates = serviceId
        ? params.observed?.services.filter((service) => service.externalId === serviceId) ?? []
        : [];
      const observedService = observedServiceCandidates.length === 1
        ? observedServiceCandidates[0]
        : undefined;
      const sameNameCandidates = params.observed?.services.filter((service) => service.name === serviceName) ?? [];
      const serviceIdentityMismatch = Boolean(params.observed && (
        serviceId
          ? observedServiceCandidates.length !== 1
          : sameNameCandidates.length > 0
      ));
      const keys = binding?.envKeys ?? storageEnvKeys(name);
      const runtimeContract = storageRuntimeContract(spec.provider, params.environmentSpec.hosting.provider);
      const nativeAccess = providerRegistry.getMetadata(spec.provider)?.storageRuntimeAccess?.hostingProviders.includes(params.environmentSpec.hosting.provider);
      const accessReady = !nativeAccess || runtimeAccessReady(params.observed?.runtimeAccess, name, serviceName);
      const wired = accessReady && !serviceIdentityMismatch
        && binding?.services.includes(serviceName)
        && (!runtimeContract || binding.runtimeContracts?.[serviceName] === runtimeContract)
        && keys.every((key) => observedService?.envVarKeys.includes(key));
      actions.push(action({
        id: `storage:${name}:wiring:${serviceName}`,
        type: wired ? 'noop' : 'update',
        name,
        provider: spec.provider,
        operation: STORAGE_OPERATIONS.wire,
        verified: params.observed !== null,
        reason: serviceIdentityMismatch
          ? `Cannot safely resolve the durable provider identity for service "${serviceName}"`
          : wired
            ? `Storage "${name}" is wired to service "${serviceName}"`
            : `Wire storage "${name}" to service "${serviceName}"`,
        dependsOn: [ensureId, `service:${serviceName}`],
        metadata: {
          serviceName,
          envKeys: keys,
          ...(runtimeContract ? { runtimeContract } : {}),
          ...(serviceId ? { serviceId } : { serviceIdPending: true }),
          ...(!accessReady ? { blockedReason: 'runtime_access_unverified' } : {}),
          ...(serviceIdentityMismatch ? {
            blockedReason: 'service_binding_identity_mismatch',
          } : {}),
        },
      }));
    }
    for (const serviceName of binding?.services ?? []) {
      if (spec.injectInto.includes(serviceName)) continue;
      const serviceId = boundServiceId(params.environment, serviceName);
      actions.push(action({
        id: `storage:${name}:unwiring:${serviceName}`,
        type: 'update', name, provider: spec.provider, operation: STORAGE_OPERATIONS.unwire,
        verified: params.observed !== null,
        reason: `Remove storage "${name}" access from service "${serviceName}"`,
        metadata: {
          serviceName,
          envKeys: binding.envKeys,
          ...(serviceId
            ? { serviceId }
            : { blockedReason: 'service_binding_identity_mismatch' }),
        },
      }));
    }
  }

  for (const [name, recovery] of Object.entries(recoveries.parsed)) {
    if (desired[name]) continue;
    actions.push(action({
      id: `storage:${name}:create-recovery`,
      type: 'update',
      name,
      provider: recovery.provider,
      operation: STORAGE_OPERATIONS.ensure,
      verified: false,
      reason: `Storage "${name}" was removed from the spec, but a possibly committed create still requires explicit resolution`,
      metadata: {
        blockedReason: 'orphaned_storage_create_recovery',
        storageCreateRecovery: recovery,
      },
    }));
  }

  for (const [name, binding] of Object.entries(bindings)) {
    if (desired[name]) continue;
    if (recoveries.parsed[name]) continue;
    if (binding.purpose === 'backup') {
      warnings.push(`Retaining backup storage "${name}" after its policy was removed. Backup exclusion never authorizes deleting recovery history.`);
      continue;
    }
    const observationKnown = storageObservationKnown(params.observed, binding.provider);
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
      const serviceId = boundServiceId(params.environment, serviceName);
      actions.push(action({
        id: `storage:${name}:unwiring:${serviceName}`,
        type: 'update', name, provider: binding.provider, operation: STORAGE_OPERATIONS.unwire,
        verified: params.observed !== null, reason: `Remove storage "${name}" access from service "${serviceName}"`,
        metadata: {
          serviceName,
          envKeys: binding.envKeys,
          ...(serviceId
            ? { serviceId }
            : { blockedReason: 'service_binding_identity_mismatch' }),
        },
      }));
    }
    const observed = live.find((item) => storageIdentityMatches(binding, item));
    actions.push(action({
      id: `storage:${name}:destroy`, type: 'destroy', name, provider: binding.provider,
      operation: STORAGE_OPERATIONS.destroy, verified: Boolean(observed), requiresConfirm: true,
      reason: `Storage "${name}" was removed from the spec; deleting it loses all stored objects`,
      dependsOn: binding.services.map((serviceName) => `storage:${name}:unwiring:${serviceName}`),
      metadata: {
        externalId: binding.externalId,
        instanceScope: binding.instanceScope ?? null,
        region: binding.region,
        ...(observed?.objectCount !== undefined ? { objectCount: observed.objectCount } : {}),
        ...(observed?.sizeBytes !== undefined ? { sizeBytes: observed.sizeBytes } : {}),
      },
    }));
  }

  for (const item of live.filter((candidate) => storageObservationKnown(params.observed, candidate.provider))) {
    if (Object.values(bindings).some((binding) => storageIdentityMatches(binding, item)) || desired[item.name]) continue;
    unmanaged.push({ kind: 'storage', name: item.name, detail: `${item.provider} object bucket exists but is not managed by Hypervibe` });
  }
  return { actions, warnings, unmanaged };
}

export function isStorageAction(planAction: PlanAction): boolean {
  return typeof planAction.metadata?.operation === 'string' && STORAGE_OPERATION_SET.has(planAction.metadata.operation);
}

async function storageRuntimeTarget(params: {
  project: Project; environmentSpec: EnvironmentSpec; environment: Environment;
  serviceName: string; storageName: string; connectionProvider?: string; usesWorkloadIdentity?: boolean;
  hosting?: IProviderAdapter;
}): Promise<StorageRuntimeTarget> {
  const target: StorageRuntimeTarget = { hostingProvider: params.environmentSpec.hosting.provider,
    connectionProvider: params.connectionProvider, serviceName: params.serviceName,
    runtimeAccessBinding: runtimeAccessBindings(params.environment)?.storageRuntimeAccess[params.storageName]?.[params.serviceName]?.binding };
  if (!params.usesWorkloadIdentity) return target;
  const result = params.hosting ? { success: true, adapter: params.hosting }
    : await adapterFactory.getProviderAdapter(target.hostingProvider, params.project, undefined, params.environment.name);
  if (!result.success || !result.adapter || result.adapter.name !== target.hostingProvider) {
    throw new Error('Storage runtime identity requires the selected hosting connection.');
  }
  const hosting = result.adapter;
  await hosting.configureTarget?.({ region: params.environmentSpec.hosting.region });
  const desired = params.environmentSpec.services[params.serviceName];
  if (!desired) throw new Error('Storage runtime destination service is missing from the reviewed project.');
  const service = { name: params.serviceName,
    buildConfig: { workloadKind: desired.workloadKind, cronSchedule: desired.cronSchedule } };
  if (hosting.runtimeIdentities) {
    const state = runtimeAccessBindings(params.environment);
    if (!state) throw new Error('Storage runtime identity bindings are invalid.');
    const observed = await hosting.runtimeIdentities.inspect({ environment: params.environment,
      environmentSpec: params.environmentSpec, service, binding: state.runtimeIdentities[params.serviceName], mode: 'ensure' });
    if (observed.state !== 'ready' || !observed.identity) throw new Error('Storage workload identity preparation is incomplete.');
    target.identity = observed.identity;
  } else if (hosting.resolveRuntimeIdentity) {
    target.identity = await hosting.resolveRuntimeIdentity(params.environment, service);
  }
  return target;
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
    const adapterResult = await adapterFactory.getStorageAdapter(spec.provider, project, environment.name);
    if (!adapterResult.success || !adapterResult.adapter) throw new Error('A declared storage connection is unavailable; runtime configuration cannot be resolved safely.');
    const root = environment.platformBindings as { projectId?: string; environmentId?: string };
    const context = binding.instanceScope ?? contexts[spec.provider] ?? (environmentSpec.hosting.provider === spec.provider && root.projectId && root.environmentId
      ? { projectId: root.projectId, environmentId: root.environmentId }
      : undefined);
    if (!context) throw new Error('The declared storage scope is missing; runtime configuration cannot be resolved safely.');
    for (const serviceName of spec.injectInto) {
      const target = await storageRuntimeTarget({ project, environmentSpec, environment, serviceName, storageName: name,
        connectionProvider: adapterResult.connectionProvider,
        usesWorkloadIdentity: adapterResult.adapter.capabilities.usesWorkloadIdentity });
      const vars = await adapterResult.adapter.getRuntimeEnv(environment, context, binding.externalId, name, target);
      output[serviceName] = { ...(output[serviceName] ?? {}), ...vars };
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function persist(
  environment: Environment,
  storage: Record<string, StorageBinding>,
  storageProviders: Record<string, StorageContext>,
  storageCreateRecovery?: Record<string, StorageCreateRecovery> | null
): void {
  const deletionRecovery = storageCreateRecoveryState(envRepo.findById(environment.id)).deletions;
  if (storageCreateRecovery && Object.keys(storageCreateRecovery).some(name => deletionRecovery[name])) {
    throw new Error('A pending storage deletion cannot be overwritten by create recovery.');
  }
  const recovery = { ...storageCreateRecovery, ...deletionRecovery };
  envRepo.updatePlatformBindings(environment.id, {
    storage,
    storageProviders,
    ...(storageCreateRecovery !== undefined ? {
      storageCreateRecovery: Object.keys(recovery).length > 0
        ? recovery
        : undefined,
    } : {}),
  });
}

function persistStorageCreateRecovery(
  environmentId: string,
  storageName: string,
  recovery: StorageCreateRecovery
): string | undefined {
  try {
    const latest = envRepo.findById(environmentId);
    if (!latest) return `Environment ${environmentId} is missing; storage create-recovery state could not be retained.`;
    const current = storageCreateRecoveryState(latest);
    if (current.malformed || current.deletions[storageName]) {
      return 'Existing storage create-recovery state is malformed; Hypervibe refused to overwrite evidence of a possibly committed create.';
    }
    const updated = envRepo.updatePlatformBindings(environmentId, {
      storageCreateRecovery: { ...current.raw, [storageName]: recovery },
    });
    return updated
      ? undefined
      : `Environment ${environmentId} disappeared before storage create-recovery state could be retained.`;
  } catch (error) {
    return `Storage create-recovery persistence reported an error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function validateReturnedStorageRecovery(input: {
  value: unknown;
  provider: string;
  resourceName: string;
  providerScope: StorageContext;
  externalId?: string;
}): StorageCreateRecovery | null {
  const recovery = parseStorageCreateRecovery(input.value);
  if (!recovery
    || recovery.provider !== input.provider
    || recovery.resourceName !== input.resourceName
    || !scopesMatch(recovery.providerScope, input.providerScope)
    || (input.externalId !== undefined && recovery.externalId !== input.externalId)) {
    return null;
  }
  return recovery;
}

function storageCreateMayHaveCommitted(input: {
  success: boolean;
  externalId?: string;
  data?: Record<string, unknown>;
}): boolean {
  if (input.success && !input.externalId) return true;
  if (input.success) return false;
  const phase = input.data?.phase;
  return input.data?.storageCreateRecovery !== undefined
    || input.data?.created === true
    || (
      (phase === 'bucketCreate' || phase === 'storageCreate')
      && input.data?.mutationAttempted !== false
    )
    // ensureBucket is the create mutation boundary. Unless the adapter gives
    // an explicit definitive-rejection signal, a failed receipt may have been
    // returned after the provider committed.
    || input.data?.mutationAttempted !== false;
}

function conservativeStorageRecovery(input: {
  provider: string;
  resourceName: string;
  providerScope: StorageContext;
  externalId?: string;
}): StorageCreateRecovery {
  return createStorageCreateRecovery({
    provider: input.provider,
    resourceName: input.resourceName,
    providerScope: input.providerScope,
    state: input.externalId ? 'mismatched' : 'unresolved',
    ...(input.externalId ? { externalId: input.externalId } : {}),
  });
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
  const recoveryState = storageCreateRecoveryState(environment);
  if (operation === STORAGE_OPERATIONS.recoverDeletion || operation === STORAGE_OPERATIONS.continueDeletion || operation === STORAGE_OPERATIONS.retryDeletion) {
    const marker = recoveryState.deletions[name];
    const continuation = operation === STORAGE_OPERATIONS.continueDeletion;
    const retry = operation === STORAGE_OPERATIONS.retryDeletion;
    if (recoveryState.malformed || !marker || params.action.type !== (continuation || retry ? 'destroy' : 'update')
      || (retry ? !deletionRetryReady(marker.snapshot) : continuation ? marker.snapshot.phase !== 'ready' : marker.snapshot.phase === 'ready')
      || (continuation || retry) && !params.action.requiresConfirm
      || params.action.resource.provider !== marker.snapshot.provider || params.action.resource.name !== name
      || params.action.metadata?.recoverySha256 !== canonicalJsonSha256(marker)) return { success: false, status: 'blocked', message: 'Storage deletion recovery identity changed. Re-run hv_plan.' };
    const resolved = await adapterFactory.getStorageAdapter(marker.snapshot.provider, params.project, params.envName);
    if (!resolved.success || !resolved.adapter) return { success: false, status: 'blocked', message: 'The original storage adapter is unavailable for read-only recovery.' };
    if (retry && marker.snapshot.phase === 'uncertain' && !resolved.adapter.capabilities.supportsConditionalObjectDeletionRetry) return { success: false, status: 'blocked', message: 'This provider has no supported exact conditional deletion retry.' };
    return destroyTrackedStorage({ environmentId: environment.id, name, target: marker.target, migrationId: marker.migrationId,
      adapter: resolved.adapter, externalId: marker.snapshot.externalId, context: marker.snapshot.instanceScope, allowMutation: continuation || retry, retryAttempt: retry });
  }
  if (Object.keys(recoveryState.deletions).length) return { success: false, status: 'blocked', message: 'Read-only storage deletion recovery must finish before another storage action. Re-run hv_plan.' };
  if (operation === STORAGE_OPERATIONS.clearCreateRecovery) {
    const retainedRecovery = recoveryState.parsed[name];
    const plannedRecovery = parseStorageCreateRecovery(params.action.metadata?.storageCreateRecovery);
    const plannedContext = storageContext(params.action.metadata?.instanceScope);
    const desired = params.environmentSpec.storage?.[name];
    const currentContext = desired
      ? currentStorageContext(environment, desired.provider, params.environmentSpec.hosting.provider)
      : undefined;
    if (
      recoveryState.malformed
      || !retainedRecovery
      || !plannedRecovery
      || !plannedContext
      || !desired
      || params.action.type !== 'update'
      || params.action.requiresConfirm !== true
      || params.action.resource.name !== name
      || params.action.resource.provider !== desired.provider
      || retainedRecovery.state !== 'unresolved'
      || !recoveriesMatch(retainedRecovery, plannedRecovery)
      || !scopesMatch(retainedRecovery.providerScope, plannedContext)
      || !scopesMatch(currentContext, plannedContext)
    ) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage create-recovery clear for "${name}" has stale mutation authority`,
        error: 'The retained marker, desired storage target, or exact provider scope changed after planning. Re-run hv_plan.',
      };
    }
    const storageResult = await adapterFactory.getStorageAdapter(desired.provider, params.project, params.envName);
    if (!storageResult.success || !storageResult.adapter) {
      return { success: false, message: 'Storage adapter unavailable', error: storageResult.error };
    }
    const adapter = storageResult.adapter;
    if (adapter.name !== desired.provider) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage recovery action "${params.action.id}" resolved the wrong provider adapter`,
        error: `Plan targets ${desired.provider}, but the resolved adapter is ${adapter.name}.`,
      };
    }
    let observed: Awaited<ReturnType<typeof adapter.observe>>;
    try {
      observed = await adapter.observe(environment, plannedContext);
    } catch (error) {
      return {
        success: false,
        status: 'blocked',
        message: `Could not re-observe storage "${name}" before clearing recovery state`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const candidates = observed.filter((item) => (
      item.name.toLowerCase() === name.toLowerCase()
      || (retainedRecovery.externalId !== undefined && item.externalId === retainedRecovery.externalId)
    ));
    if (candidates.length > 0) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage "${name}" appeared during create-recovery verification`,
        error: 'The provider now reports a matching bucket. Inspect its exact identity and explicitly adopt it; Hypervibe preserved the recovery marker.',
      };
    }
    const latest = envRepo.findById(environment.id);
    const latestState = storageCreateRecoveryState(latest);
    const latestRecovery = latestState.parsed[name];
    if (!latest || latestState.malformed || !latestRecovery || !recoveriesMatch(latestRecovery, retainedRecovery)) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage create-recovery state changed while verifying "${name}"`,
        error: 'Hypervibe preserved the latest recovery state. Re-run hv_plan.',
      };
    }
    const remainingRecoveries = { ...latestState.parsed };
    delete remainingRecoveries[name];
    const updated = envRepo.updatePlatformBindings(latest.id, {
      storageCreateRecovery: Object.keys({ ...remainingRecoveries, ...latestState.deletions }).length > 0
        ? { ...remainingRecoveries, ...latestState.deletions }
        : undefined,
    });
    if (!updated) {
      return {
        success: false,
        message: `Could not persist create-recovery resolution for storage "${name}"`,
        error: `Environment "${params.envName}" disappeared after provider absence was verified.`,
      };
    }
    return {
      success: true,
      message: `Cleared provider-confirmed absent create-recovery state for storage "${name}"`,
      data: { cleared: true, instanceScope: plannedContext },
    };
  }
  if (operation === STORAGE_OPERATIONS.finalizeCreateRecovery) {
    const retainedRecovery = recoveryState.parsed[name];
    const plannedRecovery = parseStorageCreateRecovery(params.action.metadata?.storageCreateRecovery);
    const plannedContext = storageContext(params.action.metadata?.instanceScope);
    const plannedExternalId = typeof params.action.metadata?.externalId === 'string'
      ? params.action.metadata.externalId
      : undefined;
    const plannedRegion = typeof params.action.metadata?.region === 'string'
      ? params.action.metadata.region
      : undefined;
    const desired = params.environmentSpec.storage?.[name];
    const currentContext = desired
      ? currentStorageContext(environment, desired.provider, params.environmentSpec.hosting.provider)
      : undefined;
    if (
      recoveryState.malformed
      || !retainedRecovery
      || !plannedRecovery
      || !plannedContext
      || !plannedExternalId
      || !plannedRegion
      || !desired
      || params.action.type !== 'update'
      || params.action.verified !== true
      || params.action.resource.name !== name
      || params.action.resource.provider !== desired.provider
      || retainedRecovery.state !== 'identified'
      || retainedRecovery.externalId !== plannedExternalId
      || retainedRecovery.returnedName !== name
      || plannedRegion !== desired.region
      || !recoveriesMatch(retainedRecovery, plannedRecovery)
      || !scopesMatch(retainedRecovery.providerScope, plannedContext)
      || !scopesMatch(currentContext, plannedContext)
      || Boolean(parseStorageBindings(environment)[name])
    ) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage create-recovery finalization for "${name}" has stale mutation authority`,
        error: 'The retained marker, desired storage target, exact provider identity, or scope changed after planning. Re-run hv_plan.',
      };
    }
    const storageResult = await adapterFactory.getStorageAdapter(desired.provider, params.project, params.envName);
    if (!storageResult.success || !storageResult.adapter) {
      return { success: false, message: 'Storage adapter unavailable', error: storageResult.error };
    }
    const adapter = storageResult.adapter;
    if (adapter.name !== desired.provider) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage recovery action "${params.action.id}" resolved the wrong provider adapter`,
        error: `Plan targets ${desired.provider}, but the resolved adapter is ${adapter.name}.`,
      };
    }
    let observed: Awaited<ReturnType<typeof adapter.observe>>;
    try {
      observed = await adapter.observe(environment, plannedContext);
    } catch (error) {
      return {
        success: false,
        status: 'blocked',
        message: `Could not re-observe storage "${name}" before finalizing recovery`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const exactMatch = exactRecoveredStorage(
      observed,
      retainedRecovery,
      name,
      desired.provider,
      desired.region
    );
    if (!exactMatch) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage "${name}" did not match delayed-create recovery evidence`,
        error: 'Hypervibe preserved the recovery marker because fresh provider observation did not prove exactly one ready bucket with the reviewed id, name, region, and scope.',
      };
    }
    const latest = envRepo.findById(environment.id);
    const latestState = storageCreateRecoveryState(latest);
    const latestRecovery = latestState.parsed[name];
    const latestBindings = parseStorageBindings(latest);
    if (
      !latest
      || latestState.malformed
      || !latestRecovery
      || !recoveriesMatch(latestRecovery, retainedRecovery)
      || Boolean(latestBindings[name])
    ) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage create-recovery state changed while finalizing "${name}"`,
        error: 'Hypervibe preserved the latest state. Re-run hv_plan.',
      };
    }
    const remainingRecoveries = { ...latestState.parsed };
    delete remainingRecoveries[name];
    const latestContexts = parseStorageProviderContexts(latest);
    persist(
      latest,
      {
        ...latestBindings,
        [name]: {
          provider: adapter.name,
          externalId: plannedExternalId,
          instanceScope: plannedContext,
          region: desired.region,
          ...(desired.purpose ? { purpose: desired.purpose } : {}),
          services: [],
          envKeys: adapter.runtimeEnvKeys(name),
          updatedAt: new Date().toISOString(),
        },
      },
      { ...latestContexts, [adapter.name]: plannedContext },
      remainingRecoveries
    );
    const persisted = envRepo.findById(latest.id);
    const persistedBinding = parseStorageBindings(persisted)[name];
    const persistedRecovery = storageCreateRecoveryState(persisted);
    if (
      !persistedBinding
      || persistedBinding.provider !== adapter.name
      || persistedBinding.externalId !== plannedExternalId
      || persistedBinding.region !== desired.region
      || !scopesMatch(persistedBinding.instanceScope, plannedContext)
      || persistedRecovery.malformed
      || Boolean(persistedRecovery.parsed[name])
    ) {
      return {
        success: false,
        message: `Could not persist delayed-create recovery for storage "${name}"`,
        error: 'The exact provider resource remains intact, but Hypervibe could not verify its durable local binding.',
      };
    }
    return {
      success: true,
      message: `Finalized delayed create for storage "${name}" without another provider mutation`,
      data: { externalId: plannedExternalId, region: desired.region, recovered: true },
    };
  }
  const retainedRecovery = recoveryState.parsed[name];
  if (recoveryState.malformed || retainedRecovery) {
    return {
      success: false,
      status: 'blocked',
      message: recoveryState.malformed
        ? `Storage create-recovery state is malformed for environment "${params.envName}"`
        : `Storage "${name}" has retained create-recovery state`,
      error: `${storageRecoveryGuidance()} No storage provider mutation was attempted.`,
      ...(retainedRecovery ? { data: { storageCreateRecovery: retainedRecovery } } : {}),
    };
  }
  const bindings = parseStorageBindings(environment);
  const contexts = parseStorageProviderContexts(environment);
  const desired = params.environmentSpec.storage?.[name];
  const plannedService = typeof params.action.metadata?.serviceName === 'string'
    ? params.action.metadata.serviceName
    : undefined;
  const binding = bindings[name];
  const currentServiceId = plannedService ? boundServiceId(environment, plannedService) : undefined;
  const plannedServiceId = typeof params.action.metadata?.serviceId === 'string'
    ? params.action.metadata.serviceId
    : undefined;
  const pendingServiceId = params.action.metadata?.serviceIdPending === true;
  const serviceTargetMatches = !plannedService
    || (plannedServiceId ? plannedServiceId === currentServiceId : false)
    || (
      operation === STORAGE_OPERATIONS.wire
      && pendingServiceId
      && Boolean(currentServiceId)
      && params.action.dependsOn?.includes(`service:${plannedService}`) === true
    );
  const hasPlannedInstanceScope = Object.prototype.hasOwnProperty.call(params.action.metadata ?? {}, 'instanceScope');
  const rawPlannedInstanceScope = params.action.metadata?.instanceScope;
  const plannedInstanceScope = storageContext(rawPlannedInstanceScope);
  const plannedInstanceScopeMatches = hasPlannedInstanceScope
    && (rawPlannedInstanceScope === null || plannedInstanceScope !== undefined)
    && scopesMatch(binding?.instanceScope, plannedInstanceScope);
  const identityMatches = Boolean(name)
    && name === params.action.resource.name
    && (
      operation === STORAGE_OPERATIONS.ensure
        ? desired?.provider === params.action.resource.provider
        : operation === STORAGE_OPERATIONS.wire
        ? desired?.provider === params.action.resource.provider
            && Boolean(plannedService && desired.injectInto.includes(plannedService))
            && serviceTargetMatches
            && params.action.metadata?.runtimeContract === storageRuntimeContract(params.action.resource.provider, params.environmentSpec.hosting.provider)
          : operation === STORAGE_OPERATIONS.unwire
            ? binding?.provider === params.action.resource.provider
              && Boolean(plannedService)
              && serviceTargetMatches
            : operation === STORAGE_OPERATIONS.destroy
              ? !desired
                && binding?.provider === params.action.resource.provider
                && params.action.metadata?.externalId === binding.externalId
                && plannedInstanceScopeMatches
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

  if (params.action.metadata?.blockedReason) {
    const blockedReason = params.action.metadata.blockedReason;
    const error = blockedReason === 'unmanaged_conflict'
      ? 'Use hv_inspect and hv_import to explicitly adopt the live bucket, or rename the desired bucket.'
      : blockedReason === 'provider_migration_required'
        ? 'Declare dataMigration on the target environment so Hypervibe copies and verifies the bucket before changing its provider binding.'
        : blockedReason === 'storage_binding_identity_mismatch'
          ? 'The provider id or provider-native scope differs from the persisted binding. Inspect the live resources and explicitly import the intended bucket.'
          : blockedReason === 'service_binding_identity_mismatch'
            ? 'The destination service could not be resolved by its durable provider id. Re-run hv_plan after restoring or explicitly adopting its binding.'
            : blockedReason === 'storage_create_recovery_required'
              || blockedReason === 'storage_create_recovery_target_mismatch'
              || blockedReason === 'orphaned_storage_create_recovery'
              || blockedReason === 'malformed_storage_create_recovery'
              ? storageRecoveryGuidance()
            : 'Object-storage locations are immutable. Migrate objects explicitly, then remove/destroy and recreate the bucket.';
    return { success: false, status: 'blocked', message: params.action.reason, error };
  }

  const storageResult = await adapterFactory.getStorageAdapter(params.action.resource.provider, params.project, params.envName);
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

  if (operation === STORAGE_OPERATIONS.ensure) {
    const spec = desired;
    if (!spec) return { success: false, message: `Storage "${name}" is absent from the current spec` };
    let context = contexts[adapter.name];
    if (!context && params.environmentSpec.hosting.provider === adapter.name) {
      const root = environment.platformBindings as { projectId?: string; environmentId?: string };
      if (root.projectId && root.environmentId) context = { projectId: root.projectId, environmentId: root.environmentId };
    }
    const contextResult = await adapter.ensureContext(params.project.name, environment, context, spec.region);
    const exactContext = storageContext(contextResult.context);
    if (!contextResult.receipt.success || !exactContext) {
      return {
        success: false,
        message: contextResult.receipt.message,
        error: contextResult.receipt.error
          ?? 'Storage provider returned a successful context receipt without a complete non-secret provider scope.',
      };
    }
    context = exactContext;
    let result: Awaited<ReturnType<typeof adapter.ensureBucket>>;
    try {
      result = await adapter.ensureBucket(environment, context, name, spec.region);
    } catch (error) {
      const recovery = conservativeStorageRecovery({
        provider: adapter.name,
        resourceName: name,
        providerScope: context,
      });
      const persistenceError = persistStorageCreateRecovery(environment.id, name, recovery);
      return {
        success: false,
        message: `Storage provider call for "${name}" ended with an unresolved create outcome`,
        error: [
          error instanceof Error ? error.message : String(error),
          persistenceError,
        ].filter((value): value is string => Boolean(value)).join('; '),
        data: { storageCreateRecovery: recovery, instanceScope: context },
      };
    }

    const externalId = typeof result.externalId === 'string' && result.externalId.trim().length > 0
      ? result.externalId.trim()
      : undefined;
    const returnedContext = result.context === undefined ? context : storageContext(result.context);
    const contextMatches = Boolean(returnedContext && scopesMatch(returnedContext, context));
    const returnedRecovery = validateReturnedStorageRecovery({
      value: result.receipt.data?.storageCreateRecovery,
      provider: adapter.name,
      resourceName: name,
      providerScope: context,
      externalId,
    });
    const hasRecoveryValue = result.receipt.data?.storageCreateRecovery !== undefined;
    const mayHaveCommitted = storageCreateMayHaveCommitted({
      success: result.receipt.success,
      externalId,
      data: result.receipt.data,
    }) || !contextMatches;

    if (!result.receipt.success || !externalId || !contextMatches || hasRecoveryValue) {
      const recovery = returnedRecovery ?? (mayHaveCommitted
        ? conservativeStorageRecovery({
            provider: adapter.name,
            resourceName: name,
            providerScope: context,
            ...(externalId ? { externalId } : {}),
          })
        : undefined);
      const persistenceError = recovery
        ? persistStorageCreateRecovery(environment.id, name, recovery)
        : undefined;
      return {
        success: false,
        ...(!result.receipt.success && result.receipt.data?.pending === true
          && returnedRecovery?.state === 'identified' && contextMatches && !persistenceError
          ? { status: 'pending' as const } : {}),
        message: result.receipt.success
          ? `Storage provider returned an incomplete or inconsistent success for "${name}"`
          : result.receipt.message,
        error: [
          result.receipt.error,
          hasRecoveryValue && !returnedRecovery
            ? 'Provider returned malformed or inconsistent storage create-recovery state; Hypervibe retained a conservative blocker.'
            : undefined,
          !contextMatches
            ? 'Provider returned a storage scope that does not match the exact reviewed context.'
            : undefined,
          result.receipt.success && !externalId
            ? 'Provider reported success without a valid bucket id; Hypervibe refused to create a normal storage binding.'
            : undefined,
          persistenceError,
        ].filter((value): value is string => Boolean(value)).join('; ') || undefined,
        data: {
          ...(result.receipt.data ?? {}),
          ...(externalId ? { externalId } : {}),
          instanceScope: context,
          ...(recovery ? { storageCreateRecovery: recovery } : {}),
        },
      };
    }

    const latestEnvironment = envRepo.findById(environment.id) ?? environment;
    const latestRecoveries = storageCreateRecoveryState(latestEnvironment);
    if (latestRecoveries.malformed || latestRecoveries.parsed[name]) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage create-recovery state changed while ensuring "${name}"`,
        error: `${storageRecoveryGuidance()} Hypervibe preserved the new recovery state and did not replace it with a normal binding.`,
      };
    }
    const latestBindings = parseStorageBindings(latestEnvironment);
    const latestContexts = parseStorageProviderContexts(latestEnvironment);
    const next = {
      ...latestBindings,
      [name]: {
        provider: adapter.name,
        externalId,
        instanceScope: context,
        region: spec.region,
        ...(spec.purpose ? { purpose: spec.purpose } : {}),
        services: latestBindings[name]?.services ?? [],
        envKeys: adapter.runtimeEnvKeys(name),
        updatedAt: new Date().toISOString(),
      },
    };
    persist(
      latestEnvironment,
      next,
      { ...latestContexts, [adapter.name]: context },
      latestRecoveries.parsed
    );
    return { success: true, message: result.receipt.message, data: { externalId, region: spec.region } };
  }

  const context = binding?.instanceScope ?? contexts[binding?.provider] ?? (params.environmentSpec.hosting.provider === binding?.provider
    ? (() => { const root = environment.platformBindings as { projectId?: string; environmentId?: string }; return root.projectId && root.environmentId ? { projectId: root.projectId, environmentId: root.environmentId } : undefined; })()
    : undefined);
  if (!binding || !context) return { success: false, message: `Storage binding/context missing for "${name}"` };

  if (operation === STORAGE_OPERATIONS.destroy) {
    return destroyTrackedStorage({ environmentId: environment.id, name, target: 'active', adapter,
      externalId: binding.externalId, context });
  }

  const serviceName = String(params.action.metadata?.serviceName ?? '');
  const service = serviceRepo.findByProjectAndName(params.project.id, serviceName);
  if (!service) return { success: false, message: `Service "${serviceName}" not found locally` };
  const hostingResult = await adapterFactory.getProviderAdapter(params.environmentSpec.hosting.provider, params.project, undefined, params.envName);
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
    const access = runtimeAccessBindings(environment);
    if (!access || access.storageRuntimeAccess[name]?.[serviceName]) return { success: false, status: 'blocked', message: 'Reconcile the exact bucket permission removal before clearing runtime configuration.' };
    const cleared = Object.fromEntries((binding.envKeys ?? storageEnvKeys(name)).map((key) => [key, '']));
    const receipt = requireAppliedStorageEnvUpdate(await hosting.setEnvVars(environment, service, cleared));
    if (receipt.success) {
      persist(environment, { ...bindings, [name]: { ...binding, services: binding.services.filter((item) => item !== serviceName) } }, contexts);
    }
    return { success: receipt.success, message: receipt.success ? `Cleared storage "${name}" runtime configuration from "${serviceName}"` : receipt.message, error: receipt.error,
      data: receipt.success ? { serviceName, envKeys: Object.keys(cleared).sort(), ...storageRuntimeRolloutData(receipt, serviceName) } : receipt.data };
  }

  const runtimeTarget = await storageRuntimeTarget({ project: params.project, environmentSpec: params.environmentSpec,
    environment, serviceName, storageName: name, hosting, connectionProvider: storageResult.connectionProvider,
    usesWorkloadIdentity: adapter.capabilities.usesWorkloadIdentity });
  const runtimeEnv = await adapter.getRuntimeEnv(environment, context, binding.externalId, name, runtimeTarget);
  const runtimeEnvKeys = Object.keys(runtimeEnv).sort();
  const receipt = requireAppliedStorageEnvUpdate(await hosting.setEnvVars(environment, service, runtimeEnv));
  if (receipt.success) {
    const runtimeContract = storageRuntimeContract(adapter.name, params.environmentSpec.hosting.provider);
    persist(environment, { ...bindings, [name]: { ...binding, services: Array.from(new Set([...binding.services, serviceName])),
      ...(runtimeContract ? { runtimeContracts: { ...binding.runtimeContracts, [serviceName]: runtimeContract } } : {}),
      envKeys: runtimeEnvKeys, updatedAt: new Date().toISOString() } }, contexts);
  }
  return {
    success: receipt.success,
    message: receipt.success ? `Wired storage "${name}" to service "${serviceName}"` : receipt.message,
    error: receipt.error,
    data: receipt.success ? { serviceName, envKeys: runtimeEnvKeys, ...storageRuntimeRolloutData(receipt, serviceName) } : receipt.data,
  };
}
