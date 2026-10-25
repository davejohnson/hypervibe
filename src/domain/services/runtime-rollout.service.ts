import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ActionReceipt } from '../plan/converge.executor.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ObservedService, ObservedState } from '../ports/observe.port.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { isDeepStrictEqual } from 'node:util';
import { providerRegistry } from '../registry/provider.registry.js';

export interface RuntimeRolloutBinding {
  service: string;
  provider: string;
  serviceExternalId?: string;
  /** Opaque operation identity; the selected credential hashes stay encrypted. */
  operationId?: string;
  configurationExpectationEncrypted?: string;
  providerProjectId?: string;
  providerEnvironmentId?: string;
  /** Exact provider revision that acknowledged all selected configuration writes. */
  expectedDeploymentId?: string;
  expectedDeploymentIds?: string[];
  configurationAccepted?: 'readback' | 'acknowledgement';
  /** Provider version barrier required when its secret vault is eventually consistent. */
  configurationVersion?: number;
  configurationAcceptedKeys?: string[];
  baselineDeployment: {
    state: 'present' | 'absent' | 'unknown';
    id?: string;
    activeDeploymentIds?: string[];
  };
  requiredAt: string;
  applyRunId: string;
  actionIds: string[];
}

export interface RuntimeRolloutRequirement {
  service: string;
  provider: string;
  requiredSince: string;
  reason: string;
  actionIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

export function parseRuntimeRolloutBindings(
  environment: Pick<Environment, 'platformBindings'> | null | undefined
): RuntimeRolloutBinding[] {
  const raw = environment?.platformBindings.runtimeRollouts;
  if (raw === undefined) return [];
  const malformed = () => new Error('Malformed retained runtime rollout state; activation cannot be established.');
  if (!Array.isArray(raw)) throw malformed();
  const identities = new Set<string>();

  return raw.flatMap((value) => {
    const record = asRecord(value);
    const baseline = asRecord(record?.baselineDeployment);
    const service = stringField(record, 'service');
    const provider = stringField(record, 'provider');
    const requiredAt = stringField(record, 'requiredAt');
    const applyRunId = stringField(record, 'applyRunId');
    const state = stringField(baseline, 'state');
    const actionIds = stringArray(record?.actionIds);
    if (
      !service
      || !provider
      || !requiredAt
      || !applyRunId
      || !['present', 'absent', 'unknown'].includes(state ?? '')
      || actionIds.length === 0
      || !Array.isArray(record?.actionIds)
      || actionIds.length !== record.actionIds.length
    ) {
      throw malformed();
    }
    const id = stringField(baseline, 'id');
    const identity = JSON.stringify([provider, service]);
    const strictKeys = ['operationId', 'configurationExpectationEncrypted'] as const;
    const strict = strictKeys.some(key => record?.[key] !== undefined);
    if (state === 'present' && !id || identities.has(identity)
      || strict && strictKeys.some(key => !stringField(record, key))
      || baseline?.activeDeploymentIds !== undefined && (!Array.isArray(baseline.activeDeploymentIds)
        || stringArray(baseline.activeDeploymentIds).length !== baseline.activeDeploymentIds.length)
      || ['serviceExternalId', 'providerProjectId', 'providerEnvironmentId', 'expectedDeploymentId'].some(key => record?.[key] !== undefined && !stringField(record, key))) throw malformed();
    if (record?.configurationVersion !== undefined && (!Number.isSafeInteger(record.configurationVersion) || (record.configurationVersion as number) < 0)
      || record?.configurationAccepted !== undefined && !['readback', 'acknowledgement'].includes(String(record.configurationAccepted))
      || record?.expectedDeploymentIds !== undefined && (!Array.isArray(record.expectedDeploymentIds) || !record.expectedDeploymentIds.length || stringArray(record.expectedDeploymentIds).length !== record.expectedDeploymentIds.length || new Set(record.expectedDeploymentIds).size !== record.expectedDeploymentIds.length)
      || record?.configurationAcceptedKeys !== undefined && (!Array.isArray(record.configurationAcceptedKeys) || stringArray(record.configurationAcceptedKeys).length !== record.configurationAcceptedKeys.length)
      || record?.expectedDeploymentId !== undefined && (!strict || !record.configurationAccepted || !Array.isArray(record.configurationAcceptedKeys))) throw malformed();
    identities.add(identity);
    return [{
      service,
      provider,
      ...(stringField(record, 'serviceExternalId')
        ? { serviceExternalId: stringField(record, 'serviceExternalId') }
        : {}),
      ...Object.fromEntries(['operationId', 'configurationExpectationEncrypted', 'providerProjectId', 'providerEnvironmentId', 'expectedDeploymentId', 'configurationAccepted']
        .flatMap(key => stringField(record, key) ? [[key, stringField(record, key)]] : [])),
      ...(typeof record?.configurationVersion === 'number' ? { configurationVersion: record.configurationVersion } : {}),
      ...(Array.isArray(record?.expectedDeploymentIds) ? { expectedDeploymentIds: stringArray(record.expectedDeploymentIds) } : {}),
      ...(Array.isArray(record?.configurationAcceptedKeys) ? { configurationAcceptedKeys: stringArray(record.configurationAcceptedKeys) } : {}),
      baselineDeployment: {
        state: state as RuntimeRolloutBinding['baselineDeployment']['state'],
        ...(id ? { id } : {}),
        ...(Array.isArray(baseline?.activeDeploymentIds) ? { activeDeploymentIds: stringArray(baseline.activeDeploymentIds) } : {}),
      },
      requiredAt,
      applyRunId,
      actionIds: [...new Set(actionIds)].sort(),
    }];
  });
}

function rolloutServices(action: PlanAction, receipt: ActionReceipt): string[] {
  const data = asRecord(receipt.data);
  const metadata = asRecord(action.metadata);
  const services = new Set<string>([
    ...stringArray(data?.services),
    ...stringArray(metadata?.services),
  ]);
  const dataService = stringField(data, 'service');
  const metadataService = stringField(metadata, 'service');
  if (dataService) services.add(dataService);
  if (metadataService) services.add(metadataService);
  if (action.resource.kind === 'service') services.add(action.resource.name);
  const explicit = data?.runtimeRolloutServices;
  const authorized = new Set(stringArray(metadata?.services));
  if (metadataService) authorized.add(metadataService);
  if (action.resource.kind === 'service') authorized.add(action.resource.name);
  // A shared action can skip already-matching services. Narrow only to a
  // nonempty, well-formed subset of its reviewed destinations; malformed or
  // foreign receipt metadata retains the conservative existing behavior.
  if (Array.isArray(explicit) && explicit.length > 0
    && explicit.every(name => typeof name === 'string' && authorized.has(name))
    && new Set(explicit).size === explicit.length) return [...explicit].sort();
  return [...services].sort();
}

function baselineDeployment(
  observed: ObservedState | null,
  service: ObservedService | undefined
): RuntimeRolloutBinding['baselineDeployment'] {
  if (
    !observed
    || observed.completeness?.serviceIdentities !== 'complete' && (observed.partial || observed.completeness?.services === 'unknown')
  ) {
    return { state: 'unknown' };
  }
  if (!service || service.status === 'empty') {
    return { state: 'absent' };
  }
  const deploymentId = service.deployment?.id ?? service.maintenance?.deploymentId;
  return deploymentId
    ? { state: 'present', id: deploymentId }
    : { state: 'unknown' };
}

function receiptRolloutBaseline(
  receipt: ActionReceipt,
  serviceName: string
): RuntimeRolloutBinding['baselineDeployment'] | undefined {
  const data = asRecord(receipt.data);
  const aggregate = asRecord(data?.rolloutBaselines);
  const raw = asRecord(aggregate?.[serviceName]) ?? asRecord(data?.rolloutBaseline);
  const state = stringField(raw, 'state');
  if (state === 'present') {
    const id = stringField(raw, 'deploymentId');
    if (raw?.activeDeploymentIds !== undefined && (!Array.isArray(raw.activeDeploymentIds) || stringArray(raw.activeDeploymentIds).length !== raw.activeDeploymentIds.length)) return { state: 'unknown' };
    return id ? { state, id, ...(Array.isArray(raw?.activeDeploymentIds) ? { activeDeploymentIds: stringArray(raw.activeDeploymentIds) } : {}) } : { state: 'unknown' };
  }
  if (state === 'absent' || state === 'unknown') return { state };
  return undefined;
}

/**
 * Persist provider-acknowledged runtime rollout requirements. Credential
 * recovery may also retain a requirement for an explicitly uncertain write;
 * this records required verification, never successful configuration. A deferred
 * code deployment alone is not sufficient: several providers activate config
 * immediately using the current image. The binding stores deployment
 * identities and action ids, never environment-variable values.
 */
export function recordRuntimeRolloutRequirements(params: {
  environment: Environment;
  provider: string;
  observed: ObservedState | null;
  actions: PlanAction[];
  receipts: ActionReceipt[];
  applyRunId: string;
  now?: string;
  includeUncertainWrites?: boolean;
  /** Internal evidence, never receipt data. Only resolved configured values belong here. */
  expectedConfiguration?: Record<string, { operationId: string; envVarHashes: Record<string, string> }>;
}): Environment {
  const actions = new Map(params.actions.map((action) => [action.id, action]));
  const observedServices = new Map(
    (params.observed?.services ?? []).map((service) => [service.name, service])
  );
  const existing = parseRuntimeRolloutBindings(params.environment);
  const byService = new Map(existing.map((binding) => [binding.service, binding]));
  const requiredAt = params.now ?? new Date().toISOString();

  for (const receipt of params.receipts) {
    if ((receipt.status !== 'succeeded' && !(params.includeUncertainWrites && receipt.status === 'pending')) || asRecord(receipt.data)?.runtimeRolloutRequired !== true) {
      continue;
    }
    const action = actions.get(receipt.actionId);
    if (!action) continue;
    for (const serviceName of rolloutServices(action, receipt)) {
      const observedService = observedServices.get(serviceName);
      const declaredService = asRecord(asRecord(params.environment.platformBindings.services)?.[serviceName]);
      const declaredServiceId = params.environment.platformBindings.provider === params.provider
        ? stringField(declaredService, 'jobName') ?? stringField(declaredService, 'serviceId') : undefined;
      const current = byService.get(serviceName);
      const expected = params.expectedConfiguration?.[serviceName];
      if (expected && (!expected.operationId || !Object.keys(expected.envVarHashes).length
        || Object.entries(expected.envVarHashes).some(([key, hash]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !/^[a-f0-9]{64}$/.test(hash)))) {
        throw new Error('Runtime configuration expectation must contain an operation identity and resolved selected-key fingerprints.');
      }
      const sameOperation = !!current?.operationId && (!expected || expected.operationId === current.operationId);
      if (sameOperation && expected) {
        let matches = false;
        try { matches = isDeepStrictEqual(getSecretStore().decryptObject(current!.configurationExpectationEncrypted!), expected.envVarHashes); } catch { /* fail closed */ }
        if (!matches) throw new Error('The retained runtime configuration expectation cannot change during recovery.');
      }
      const actionIds = current?.applyRunId === params.applyRunId || sameOperation
        ? [...new Set([...current.actionIds, action.id])].sort()
        : [action.id];
      const data = asRecord(receipt.data);
      const acceptedConfiguration = receipt.status === 'succeeded' && data?.configurationUpdated === true
        && ['readback', 'acknowledgement'].includes(String(data.credentialValueEvidence))
        && Array.isArray(data.credentialKeys) && data.credentialKeys.length > 0
        && data.credentialKeys.every(key => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
      const accepted = acceptedConfiguration && data?.credentialUpdateActivation === 'provider-rollout' && stringField(data, 'deploymentId');
      const acceptedDeploymentId = accepted && (expected || current?.operationId) ? stringField(data, 'deploymentId') : undefined;
      const receiptDeploymentIds = Array.isArray(data?.deploymentIds) && data.deploymentIds.length && stringArray(data.deploymentIds).length === data.deploymentIds.length
        ? [...new Set(stringArray(data.deploymentIds))].sort() : acceptedDeploymentId ? [acceptedDeploymentId] : undefined;
      if (acceptedDeploymentId && !receiptDeploymentIds?.includes(acceptedDeploymentId)) throw new Error('Native deployment receipt did not include its selected deployment identity.');
      const nativeEvidence = acceptedDeploymentId ? {
        expectedDeploymentId: acceptedDeploymentId, expectedDeploymentIds: receiptDeploymentIds,
        configurationAccepted: data!.credentialValueEvidence as 'readback' | 'acknowledgement',
        configurationAcceptedKeys: [...new Set([...(sameOperation ? current?.configurationAcceptedKeys ?? [] : []), ...stringArray(data?.credentialKeys)])].sort(),
      } : acceptedConfiguration && (expected || sameOperation) ? {
        ...(sameOperation && current?.expectedDeploymentId ? { expectedDeploymentId: current.expectedDeploymentId, expectedDeploymentIds: current.expectedDeploymentIds } : {}),
        configurationAccepted: data!.credentialValueEvidence as 'readback' | 'acknowledgement',
        configurationAcceptedKeys: [...new Set([...(sameOperation ? current?.configurationAcceptedKeys ?? [] : []), ...stringArray(data?.credentialKeys)])].sort(),
      } : sameOperation && current?.expectedDeploymentId ? {
        expectedDeploymentId: current.expectedDeploymentId, expectedDeploymentIds: current.expectedDeploymentIds,
        configurationAccepted: current.configurationAccepted,
        configurationAcceptedKeys: current.configurationAcceptedKeys,
      } : {};
      const exactReceiptBaseline = receiptRolloutBaseline(receipt, serviceName);
      const baseline = sameOperation ? current!.baselineDeployment : exactReceiptBaseline
        ?? (current?.applyRunId === params.applyRunId
          ? current.baselineDeployment
          : baselineDeployment(params.observed, observedService));
      const activeDeploymentIds = [...new Set([
        ...(baseline.activeDeploymentIds ?? []),
        ...(!sameOperation ? (observedService?.deployment?.activeDeploymentIds ?? []).filter(id => !receiptDeploymentIds?.includes(id)) : []),
        ...(expected && current?.operationId ? current.baselineDeployment.activeDeploymentIds ?? [] : []),
        ...(expected && current?.operationId && current.baselineDeployment.id ? [current.baselineDeployment.id] : []),
      ])];
      const strict = expected ? {
        operationId: expected.operationId,
        configurationExpectationEncrypted: sameOperation ? current!.configurationExpectationEncrypted!
          : getSecretStore().encryptObject(expected.envVarHashes),
        providerProjectId: sameOperation ? current!.providerProjectId : stringField(params.environment.platformBindings, 'projectId'),
        providerEnvironmentId: sameOperation ? current!.providerEnvironmentId : stringField(params.environment.platformBindings, 'environmentId'),
      } : current?.operationId ? {
        operationId: current.operationId,
        configurationExpectationEncrypted: current.configurationExpectationEncrypted,
        providerProjectId: current.providerProjectId,
        providerEnvironmentId: current.providerEnvironmentId,
      } : {};
      byService.set(serviceName, {
        service: serviceName,
        provider: params.provider,
        ...(sameOperation && current?.serviceExternalId ? { serviceExternalId: current.serviceExternalId } : observedService?.externalId
          ? { serviceExternalId: observedService.externalId }
          : current?.serviceExternalId
            ? { serviceExternalId: current.serviceExternalId }
            : declaredServiceId ? { serviceExternalId: declaredServiceId } : {}),
        ...strict,
        ...nativeEvidence,
        ...(acceptedConfiguration && Number.isSafeInteger(data?.configurationVersion) && Number(data?.configurationVersion) >= 0
          ? { configurationVersion: Math.max(Number(data!.configurationVersion), sameOperation ? current?.configurationVersion ?? 0 : 0) }
          : sameOperation && current?.configurationVersion !== undefined ? { configurationVersion: current.configurationVersion } : {}),
        baselineDeployment: { ...baseline, ...(activeDeploymentIds.length ? { activeDeploymentIds } : {}) },
        requiredAt: sameOperation ? current!.requiredAt : requiredAt,
        applyRunId: sameOperation ? current!.applyRunId : params.applyRunId,
        actionIds,
      });
    }
  }

  const runtimeRollouts = [...byService.values()].sort((left, right) => (
    left.service.localeCompare(right.service)
  ));
  const repository = new EnvironmentRepository();
  const updated = JSON.stringify(runtimeRollouts) === JSON.stringify(existing)
    ? params.environment
    : repository.updatePlatformBindings(params.environment.id, { runtimeRollouts });
  if (runtimeRollouts.some(binding => binding.operationId)) {
    // Configuration may already have changed at the provider. Do not allow a
    // missing row or an in-memory acknowledgement to discard its safety gate.
    // Also check the unchanged path: callers can retain a stale environment.
    const durable = repository.findById(params.environment.id);
    if (!durable || durable.projectId !== params.environment.projectId || durable.name !== params.environment.name
      || !isDeepStrictEqual(durable.platformBindings.runtimeRollouts, JSON.parse(JSON.stringify(runtimeRollouts)))) {
      throw new Error('Credential rollout requirements could not be durably persisted; recovery remains pending.');
    }
    return durable;
  }
  return updated ?? params.environment;
}

function oldDeploymentStillActive(binding: RuntimeRolloutBinding, service: ObservedService | undefined): boolean {
  const oldIds = [...(binding.baselineDeployment.activeDeploymentIds ?? []), ...(binding.baselineDeployment.id ? [binding.baselineDeployment.id] : [])];
  return oldIds.some(id => service?.deployment?.activeDeploymentIds?.includes(id));
}

function rolloutCompleted(
  binding: RuntimeRolloutBinding,
  service: ObservedService | undefined,
  observed: ObservedState | null
): boolean {
  if (!service || service.status !== 'running') return false;
  if (
    binding.serviceExternalId
    && service.externalId !== binding.serviceExternalId
  ) {
    return false;
  }
  const currentDeploymentId = service.deployment?.id ?? service.maintenance?.deploymentId;
  if (!currentDeploymentId) return false;
  if (binding.operationId && strictConfigurationReason(binding, service, observed)) return false;
  if (oldDeploymentStillActive(binding, service)) return false;
  if (binding.baselineDeployment.activeDeploymentIds?.length && !service.deployment?.activeDeploymentIds) return false;
  if (binding.baselineDeployment.state === 'absent') return true;
  if (binding.baselineDeployment.state === 'present') {
    return currentDeploymentId !== binding.baselineDeployment.id;
  }
  if (binding.operationId && service.deployment?.activeDeploymentCoverage) {
    if (binding.expectedDeploymentId && binding.configurationAccepted) return true;
    const createdAt = Date.parse(service.deployment.createdAt ?? '');
    return service.workloadKind === 'cron' && service.deployment.status === 'completed'
      && service.deployment.activeDeploymentCoverage === 'instances'
      && Number.isFinite(createdAt) && createdAt >= Date.parse(binding.requiredAt);
  }
  return false;
}

function strictConfigurationReason(binding: RuntimeRolloutBinding, service: ObservedService | undefined, observed: ObservedState | null): string | undefined {
  if (!binding.operationId) return undefined;
  const separateEnvironment = providerRegistry.getMetadata(binding.provider)?.orchestration?.environment?.separateResource;
  if (!binding.serviceExternalId || !binding.providerProjectId
    || observed?.provider !== binding.provider || observed.projectId !== binding.providerProjectId
    || separateEnvironment && !binding.providerEnvironmentId
    || binding.providerEnvironmentId && observed.environmentId !== binding.providerEnvironmentId) return 'The exact provider scope of the credential consumer could not be verified.';
  const deployment = service?.deployment;
  const expectedActiveIds = binding.expectedDeploymentIds ?? (deployment?.id ? [deployment.id] : []);
  const completedExecution = service?.workloadKind === 'cron' && deployment?.status === 'completed'
    && deployment.activeDeploymentCoverage === 'instances' && deployment.activeDeploymentIds?.length === 0;
  if (!completedExecution && (!deployment?.activeDeploymentIds || !isDeepStrictEqual([...deployment.activeDeploymentIds].sort(), [...expectedActiveIds].sort()))) {
    return 'Complete active deployment evidence is required to prove retirement of old credential consumers.';
  }
  if (!deployment) return 'The exact replacement deployment has not been observed.';
  if (binding.expectedDeploymentId && (!deployment.id || !expectedActiveIds.includes(deployment.id))) return 'The selected deployment is not an exact acknowledged credential replacement.';
  if (binding.expectedDeploymentId && binding.configurationAccepted && deployment.activeDeploymentCoverage) {
    try {
      const expected = getSecretStore().decryptObject<Record<string, string>>(binding.configurationExpectationEncrypted!);
      if (Object.keys(expected).length && Object.keys(expected).every(key => binding.configurationAcceptedKeys?.includes(key))) return undefined;
    } catch { return 'The intended configuration cannot be read safely; activation remains unknown.'; }
  }
  if (deployment.configurationState !== 'resolved' || !deployment.envVarHashes) {
    return 'The intended configuration has not been verified against resolved deployed configuration.';
  }
  try {
    const expected = getSecretStore().decryptObject<Record<string, string>>(binding.configurationExpectationEncrypted!);
    if (!expected || typeof expected !== 'object' || !Object.keys(expected).length
      || Object.entries(expected).some(([key, value]) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || deployment.envVarHashes![key] !== value)) {
      return 'The deployed consumer has not activated the intended configuration.';
    }
  } catch { return 'The intended configuration cannot be read safely; activation remains unknown.'; }
  return undefined;
}

export function runtimeRolloutRequirements(params: {
  environment: Pick<Environment, 'platformBindings'> | null | undefined;
  provider: string;
  observed: ObservedState | null;
}): RuntimeRolloutRequirement[] {
  const observedServices = new Map(
    (params.observed?.services ?? []).map((service) => [service.name, service])
  );
  const observationIncomplete = !params.observed
    || params.observed.completeness?.serviceIdentities !== 'complete' && (params.observed.partial || params.observed.completeness?.services === 'unknown');

  return parseRuntimeRolloutBindings(params.environment)
    .filter((binding) => binding.provider === params.provider)
    .filter((binding) => (
      observationIncomplete || !rolloutCompleted(binding, observedServices.get(binding.service), params.observed)
    ))
    .map((binding) => {
      const service = observedServices.get(binding.service);
      const reason = observationIncomplete
        ? 'A post-configuration deployment could not be verified because service observation is incomplete.'
        : !service
          ? 'The affected service is not currently observable.'
          : binding.serviceExternalId && service.externalId !== binding.serviceExternalId
            ? 'The observed service identity differs from the reviewed credential consumer; activation remains unknown.'
          : service.status !== 'running'
            ? `The affected service is ${service.status}; a successful post-configuration deployment is still required.`
            : strictConfigurationReason(binding, service, params.observed)
              ?? (binding.baselineDeployment.state === 'unknown'
              ? 'Hypervibe could not prove that the running deployment was created after the configuration change.'
              : oldDeploymentStillActive(binding, service)
                ? 'An old deployment remains active after the configuration change; wait for it to drain before completing rotation.'
                : binding.baselineDeployment.activeDeploymentIds?.length && !service.deployment?.activeDeploymentIds
                  ? 'Retirement of previously active deployments could not be verified.'
                : 'The service is still running the deployment that was active before the configuration change.');
      return {
        service: binding.service,
        provider: binding.provider,
        requiredSince: binding.requiredAt,
        reason,
        actionIds: binding.actionIds,
      };
    });
}

export type PendingCredentialOperations = Record<string, { operationId: string; serviceId: string; configurationVersion?: number }>;
export interface ManagedCredentialActivation { version: 1; operations: Array<{ service: string; serviceId: string; operationId: string; deploymentIds: string[]; configurationVersion?: number }> }

/** Non-secret dispatch input frozen before the managed workflow is started. */
export function pendingCredentialOperations(environment: Pick<Environment, 'platformBindings'>): PendingCredentialOperations {
  return Object.fromEntries(parseRuntimeRolloutBindings(environment).filter(binding => binding.operationId && binding.serviceExternalId)
    .map(binding => [binding.service, { operationId: binding.operationId!, serviceId: binding.serviceExternalId!, ...(binding.configurationVersion !== undefined ? { configurationVersion: binding.configurationVersion } : {}) }]));
}

/** Call only after verifying the existing managed release's exact repository,
 * producer program, target scope, commit and CI run. This binds those proven
 * deployments to the accepted operation; it never asserts application behavior. */
export function acceptManagedCredentialActivation(params: { environment: Environment; provider: string; evidence: unknown; expectedOperations: PendingCredentialOperations }): ManagedCredentialActivation['operations'] {
  const evidence = asRecord(params.evidence);
  if (!evidence || evidence.version !== 1 || Object.keys(evidence).some(key => !['version', 'operations'].includes(key)) || !Array.isArray(evidence.operations)) throw new Error('Managed credential activation evidence is malformed.');
  const repository = new EnvironmentRepository();
  const environment = repository.findById(params.environment.id);
  if (!environment || environment.projectId !== params.environment.projectId || environment.name !== params.environment.name) throw new Error('Managed credential environment identity changed.');
  const bindings = parseRuntimeRolloutBindings(environment);
  const seen = new Set<string>();
  const accepted: ManagedCredentialActivation['operations'] = [];
  for (const value of evidence.operations) {
    const entry = asRecord(value);
    const service = stringField(entry, 'service');
    const serviceId = stringField(entry, 'serviceId');
    const operationId = stringField(entry, 'operationId');
    const deploymentIds = stringArray(entry?.deploymentIds).sort();
    if (!service || !serviceId || !operationId || seen.has(service) || !entry
      || Object.keys(entry).sort().join(',') !== (entry.configurationVersion !== undefined ? 'configurationVersion,deploymentIds,operationId,service,serviceId' : 'deploymentIds,operationId,service,serviceId')
      || entry.configurationVersion !== undefined && (!Number.isSafeInteger(entry.configurationVersion) || Number(entry.configurationVersion) < 0)
      || !Array.isArray(entry.deploymentIds) || !deploymentIds.length || deploymentIds.length !== entry.deploymentIds.length || new Set(deploymentIds).size !== deploymentIds.length
      || deploymentIds.some(id => id.length > 1024 || /[\s\x00-\x1f]/.test(id))) throw new Error('Managed credential deployment identities are incomplete.');
    seen.add(service);
    const expected = params.expectedOperations[service];
    const binding = bindings.find(item => item.provider === params.provider && item.service === service);
    if (!expected || expected.operationId !== operationId || expected.serviceId !== serviceId || !binding
      || binding.operationId !== operationId || binding.serviceExternalId !== serviceId) throw new Error('Managed release belongs to a different accepted credential operation.');
    if (entry.configurationVersion !== binding.configurationVersion || entry.configurationVersion !== expected.configurationVersion) throw new Error('Managed release does not prove the accepted configuration version.');
    const keys = Object.keys(getSecretStore().decryptObject<Record<string, string>>(binding.configurationExpectationEncrypted!));
    if (!binding.configurationAccepted || !keys.length || !keys.every(key => binding.configurationAcceptedKeys?.includes(key))) throw new Error('Managed release cannot certify an incomplete credential synchronization.');
    const oldIds = [...(binding.baselineDeployment.activeDeploymentIds ?? []), ...(binding.baselineDeployment.id ? [binding.baselineDeployment.id] : [])];
    if (deploymentIds.some(id => oldIds.includes(id))) throw new Error('Managed release reused a pre-rotation deployment identity.');
    binding.expectedDeploymentIds = deploymentIds;
    binding.expectedDeploymentId = deploymentIds[0];
    accepted.push({ service, serviceId, operationId, deploymentIds, ...(typeof entry.configurationVersion === 'number' ? { configurationVersion: entry.configurationVersion } : {}) });
  }
  if (accepted.length) {
    repository.updatePlatformBindings(environment.id, { runtimeRollouts: bindings });
    if (!isDeepStrictEqual(repository.findById(environment.id)?.platformBindings.runtimeRollouts, JSON.parse(JSON.stringify(bindings)))) throw new Error('Managed credential activation evidence was not durably recorded.');
  }
  return accepted;
}
