import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ActionReceipt } from '../plan/converge.executor.js';
import type { PlanAction } from '../plan/plan.types.js';
import { hashEnvValue, type ObservedState } from '../ports/observe.port.js';
import type { DelegatedSecretSpec, ProjectSpec } from '../spec/spec.schema.js';

export const DELEGATED_SECRET_OPERATION = 'delegatedSecretSync';

export interface DelegatedSecretBinding {
  name: string;
  principal: string;
  valueHash: string;
  source: 'delegated-plan-input';
  syncedAt: string;
  applyRunId: string;
  actionId: string;
}

export interface DelegatedSecretInputRequirement {
  key: string;
  principal: string;
  reason: string;
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

export function delegatedSecretActionId(key: string): string {
  return `secret:${key}`;
}

export function delegatedSecretsForEnvironment(
  spec: ProjectSpec,
  environmentName: string
): Array<[string, DelegatedSecretSpec]> {
  return Object.entries(spec.secrets)
    .filter(([, secret]) => secret.environments.includes(environmentName))
    .sort(([left], [right]) => left.localeCompare(right));
}

export function parseDelegatedSecretBindings(
  environment: Pick<Environment, 'platformBindings'> | null | undefined
): DelegatedSecretBinding[] {
  // Avoid "secret" in the binding key: repo-bindings-file intentionally strips
  // any key that looks secret-bearing, while this array contains metadata only.
  const raw = environment?.platformBindings.delegatedEnvBindings;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((value) => {
    const record = asRecord(value);
    const name = stringField(record, 'name');
    const principal = stringField(record, 'principal');
    const valueHash = stringField(record, 'valueHash');
    const syncedAt = stringField(record, 'syncedAt');
    const applyRunId = stringField(record, 'applyRunId');
    const actionId = stringField(record, 'actionId');
    if (!name || !principal || !valueHash || !syncedAt || !applyRunId || !actionId) {
      return [];
    }
    return [{
      name,
      principal,
      valueHash,
      source: 'delegated-plan-input' as const,
      syncedAt,
      applyRunId,
      actionId,
    }];
  });
}

function liveHashesForSecret(
  observed: ObservedState | null,
  serviceNames: string[],
  key: string
): { state: 'unknown' | 'missing' | 'consistent' | 'inconsistent'; hash?: string } {
  if (!observed) return { state: 'unknown' };
  const byName = new Map(observed.services.map((service) => [service.name, service]));
  const hashes = serviceNames.map((serviceName) => byName.get(serviceName)?.envVarHashes[key]);
  if (hashes.every((hash) => hash === undefined)) return { state: 'missing' };
  if (hashes.some((hash) => hash === undefined)) return { state: 'inconsistent' };
  const distinct = new Set(hashes as string[]);
  return distinct.size === 1
    ? { state: 'consistent', hash: hashes[0] }
    : { state: 'inconsistent' };
}

export function planDelegatedSecrets(params: {
  spec: ProjectSpec;
  environmentName: string;
  hostingProvider: string;
  environment: Pick<Environment, 'platformBindings'> | null;
  observed: ObservedState | null;
  suppliedValues?: Record<string, string>;
}): {
  actions: PlanAction[];
  desiredEnvVars: Record<string, string>;
  inputRequired: DelegatedSecretInputRequirement[];
  warnings: string[];
} {
  const slots = delegatedSecretsForEnvironment(params.spec, params.environmentName);
  const serviceNames = Object.keys(params.spec.environments[params.environmentName]?.services ?? {});
  const bindings = new Map(parseDelegatedSecretBindings(params.environment).map((binding) => [binding.name, binding]));
  const suppliedValues = params.suppliedValues ?? {};
  const actions: PlanAction[] = [];
  const desiredEnvVars: Record<string, string> = {};
  const inputRequired: DelegatedSecretInputRequirement[] = [];
  const warnings: string[] = [];

  for (const [key, slot] of slots) {
    const binding = bindings.get(key);
    const suppliedValue = suppliedValues[key];
    const live = liveHashesForSecret(params.observed, serviceNames, key);
    const actionId = delegatedSecretActionId(key);

    if (suppliedValue !== undefined) {
      const suppliedHash = hashEnvValue(suppliedValue);
      desiredEnvVars[key] = suppliedValue;
      const liveMatches = live.state === 'consistent' && live.hash === suppliedHash;
      const bindingMatches = binding?.valueHash === suppliedHash && binding.principal === slot.principal;
      const inSync = liveMatches && bindingMatches;
      actions.push({
        id: actionId,
        type: inSync ? 'noop' : 'update',
        resource: { kind: 'secret', name: key, provider: params.hostingProvider },
        verified: params.observed !== null,
        reason: inSync
          ? `Delegated secret ${key} is accepted for ${slot.principal} and matches every service`
          : `Converge delegated secret ${key} from an explicit plan input owned by ${slot.principal}`,
        metadata: {
          operation: DELEGATED_SECRET_OPERATION,
          principal: slot.principal,
          inputProvided: true,
          driftPolicy: slot.driftPolicy,
        },
      });
      continue;
    }

    if (
      binding
      && binding.principal === slot.principal
      && live.state === 'consistent'
      && live.hash === binding.valueHash
    ) {
      actions.push({
        id: actionId,
        type: 'noop',
        resource: { kind: 'secret', name: key, provider: params.hostingProvider },
        verified: true,
        reason: `Delegated secret ${key} matches the accepted value owned by ${slot.principal}`,
        metadata: {
          operation: DELEGATED_SECRET_OPERATION,
          principal: slot.principal,
          inputProvided: false,
          driftPolicy: slot.driftPolicy,
        },
      });
      continue;
    }

    if (binding && binding.principal === slot.principal && live.state === 'unknown') {
      actions.push({
        id: actionId,
        type: 'noop',
        resource: { kind: 'secret', name: key, provider: params.hostingProvider },
        verified: false,
        reason: `Preserving accepted delegated secret ${key}; live value could not be observed`,
        metadata: {
          operation: DELEGATED_SECRET_OPERATION,
          principal: slot.principal,
          inputProvided: false,
          driftPolicy: slot.driftPolicy,
        },
      });
      warnings.push(`Could not verify delegated secret ${key} for ${slot.principal}; Hypervibe preserved it and did not use local env input.`);
      continue;
    }

    if (!slot.required && !binding && live.state === 'missing') {
      actions.push({
        id: actionId,
        type: 'noop',
        resource: { kind: 'secret', name: key, provider: params.hostingProvider },
        verified: true,
        reason: `Optional delegated secret ${key} has not been supplied`,
        metadata: {
          operation: DELEGATED_SECRET_OPERATION,
          principal: slot.principal,
          inputProvided: false,
          driftPolicy: slot.driftPolicy,
        },
      });
      continue;
    }

    const reason = binding
      ? binding.principal !== slot.principal
        ? `Delegated secret ${key} was accepted for ${binding.principal} and must be re-accepted for ${slot.principal}`
        : live.state === 'missing'
        ? `Accepted delegated secret ${key} is missing from one or more services`
        : `Live delegated secret ${key} differs from the accepted value`
      : live.state === 'consistent' || live.state === 'inconsistent'
        ? `Live delegated secret ${key} has not been accepted for ${slot.principal}`
        : `Delegated secret ${key} has not been supplied by ${slot.principal}`;
    inputRequired.push({ key, principal: slot.principal, reason });
    warnings.push(`${reason}. Hypervibe preserved the live value and requires an explicit secretRefs["${key}"] input before apply.`);
    actions.push({
      id: actionId,
      type: 'update',
      resource: { kind: 'secret', name: key, provider: params.hostingProvider },
      verified: params.observed !== null,
      reason,
      metadata: {
        operation: DELEGATED_SECRET_OPERATION,
        principal: slot.principal,
        inputProvided: false,
        inputRequired: true,
        driftPolicy: slot.driftPolicy,
      },
    });
  }

  return { actions, desiredEnvVars, inputRequired, warnings };
}

export function isDelegatedSecretAction(action: PlanAction): boolean {
  return action.resource.kind === 'secret' && action.metadata?.operation === DELEGATED_SECRET_OPERATION;
}

export function recordDelegatedSecretBindings(params: {
  environment: Environment;
  spec: ProjectSpec;
  environmentName: string;
  suppliedValues: Record<string, string>;
  applyRunId: string;
  receipts: ActionReceipt[];
  now?: string;
}): Environment {
  const succeeded = new Set(
    params.receipts
      .filter((receipt) => receipt.status === 'succeeded')
      .map((receipt) => receipt.actionId)
  );
  const slots = new Map(delegatedSecretsForEnvironment(params.spec, params.environmentName));
  const existing = parseDelegatedSecretBindings(params.environment);
  const byName = new Map(existing.map((binding) => [binding.name, binding]));
  const syncedAt = params.now ?? new Date().toISOString();

  for (const [key, value] of Object.entries(params.suppliedValues)) {
    const actionId = delegatedSecretActionId(key);
    const slot = slots.get(key);
    if (!slot || !succeeded.has(actionId)) continue;
    byName.set(key, {
      name: key,
      principal: slot.principal,
      valueHash: hashEnvValue(value),
      source: 'delegated-plan-input',
      syncedAt,
      applyRunId: params.applyRunId,
      actionId,
    });
  }

  const delegatedEnvBindings = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(delegatedEnvBindings) === JSON.stringify(existing)) {
    return params.environment;
  }
  return new EnvironmentRepository().updatePlatformBindings(params.environment.id, {
    delegatedEnvBindings,
  }) ?? params.environment;
}
