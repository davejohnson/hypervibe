import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ActionReceipt } from '../plan/converge.executor.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ObservedService, ObservedState } from '../ports/observe.port.js';

export interface RuntimeRolloutBinding {
  service: string;
  provider: string;
  serviceExternalId?: string;
  baselineDeployment: {
    state: 'present' | 'absent' | 'unknown';
    id?: string;
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
  if (!Array.isArray(raw)) return [];

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
    ) {
      return [];
    }
    const id = stringField(baseline, 'id');
    if (state === 'present' && !id) return [];
    return [{
      service,
      provider,
      ...(stringField(record, 'serviceExternalId')
        ? { serviceExternalId: stringField(record, 'serviceExternalId') }
        : {}),
      baselineDeployment: {
        state: state as RuntimeRolloutBinding['baselineDeployment']['state'],
        ...(id ? { id } : {}),
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
  return [...services].sort();
}

function baselineDeployment(
  observed: ObservedState | null,
  service: ObservedService | undefined
): RuntimeRolloutBinding['baselineDeployment'] {
  if (
    !observed
    || observed.partial
    || observed.completeness?.services === 'unknown'
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
    return id ? { state, id } : { state: 'unknown' };
  }
  if (state === 'absent' || state === 'unknown') return { state };
  return undefined;
}

/**
 * Persist only provider-acknowledged runtime rollout requirements. A deferred
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
}): Environment {
  const actions = new Map(params.actions.map((action) => [action.id, action]));
  const observedServices = new Map(
    (params.observed?.services ?? []).map((service) => [service.name, service])
  );
  const existing = parseRuntimeRolloutBindings(params.environment);
  const byService = new Map(existing.map((binding) => [binding.service, binding]));
  const requiredAt = params.now ?? new Date().toISOString();

  for (const receipt of params.receipts) {
    if (receipt.status !== 'succeeded' || asRecord(receipt.data)?.runtimeRolloutRequired !== true) {
      continue;
    }
    const action = actions.get(receipt.actionId);
    if (!action) continue;
    for (const serviceName of rolloutServices(action, receipt)) {
      const observedService = observedServices.get(serviceName);
      const current = byService.get(serviceName);
      const actionIds = current?.applyRunId === params.applyRunId
        ? [...new Set([...current.actionIds, action.id])].sort()
        : [action.id];
      const exactReceiptBaseline = receiptRolloutBaseline(receipt, serviceName);
      byService.set(serviceName, {
        service: serviceName,
        provider: params.provider,
        ...(observedService?.externalId
          ? { serviceExternalId: observedService.externalId }
          : current?.serviceExternalId
            ? { serviceExternalId: current.serviceExternalId }
            : {}),
        baselineDeployment: exactReceiptBaseline
          ?? (current?.applyRunId === params.applyRunId
            ? current.baselineDeployment
            : baselineDeployment(params.observed, observedService)),
        requiredAt,
        applyRunId: params.applyRunId,
        actionIds,
      });
    }
  }

  const runtimeRollouts = [...byService.values()].sort((left, right) => (
    left.service.localeCompare(right.service)
  ));
  if (JSON.stringify(runtimeRollouts) === JSON.stringify(existing)) {
    return params.environment;
  }
  return new EnvironmentRepository().updatePlatformBindings(params.environment.id, {
    runtimeRollouts,
  }) ?? params.environment;
}

function rolloutCompleted(
  binding: RuntimeRolloutBinding,
  service: ObservedService | undefined
): boolean {
  if (!service || service.status !== 'running') return false;
  if (
    binding.serviceExternalId
    && service.externalId !== binding.serviceExternalId
  ) {
    return true;
  }
  const currentDeploymentId = service.deployment?.id ?? service.maintenance?.deploymentId;
  if (!currentDeploymentId) return false;
  if (binding.baselineDeployment.state === 'absent') return true;
  if (binding.baselineDeployment.state === 'present') {
    return currentDeploymentId !== binding.baselineDeployment.id;
  }
  return false;
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
    || params.observed.partial
    || params.observed.completeness?.services === 'unknown';

  return parseRuntimeRolloutBindings(params.environment)
    .filter((binding) => binding.provider === params.provider)
    .filter((binding) => (
      observationIncomplete || !rolloutCompleted(binding, observedServices.get(binding.service))
    ))
    .map((binding) => {
      const service = observedServices.get(binding.service);
      const reason = observationIncomplete
        ? 'A post-configuration deployment could not be verified because service observation is incomplete.'
        : !service
          ? 'The affected service is not currently observable.'
          : service.status !== 'running'
            ? `The affected service is ${service.status}; a successful post-configuration deployment is still required.`
            : binding.baselineDeployment.state === 'unknown'
              ? 'Hypervibe could not prove that the running deployment was created after the configuration change.'
              : 'The service is still running the deployment that was active before the configuration change.';
      return {
        service: binding.service,
        provider: binding.provider,
        requiredSince: binding.requiredAt,
        reason,
        actionIds: binding.actionIds,
      };
    });
}
