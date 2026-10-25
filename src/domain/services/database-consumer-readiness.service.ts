import type { Environment } from '../entities/environment.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { DATABASE_ENV_KEYS } from './database-env.js';
import type { RuntimeRolloutRequirement } from './runtime-rollout.service.js';

export interface DatabaseConsumerReadiness {
  service: string;
  provider: string;
  checkedNames: string[];
  resolvedConfiguration: 'known' | 'unknown';
  deployedConfiguration: 'match' | 'mismatch' | 'unknown';
  oldDeployments: 'drained' | 'pending' | 'unknown';
  activation: 'running' | 'not-running' | 'unknown';
  authentication: 'unchecked';
  applicationOperation: 'unchecked';
  reason?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Read-only comparison of two independently observed layers. Resolving the
 * current reference on every read detects upstream changes even when the
 * consumer's definition and desired spec have not changed. No credential or
 * credential-derived verifier leaves this projection or enters durable state. */
export function databaseConsumerReadiness(params: {
  spec: EnvironmentSpec;
  environment: Pick<Environment, 'platformBindings'> | null | undefined;
  observed: ObservedState | null;
}): DatabaseConsumerReadiness[] {
  if (!params.spec.database) return [];
  const { observed } = params;
  const bindings = params.environment?.platformBindings;
  const boundServices = record(bindings?.services);
  const scopeKnown = Boolean(observed && bindings && observed.provider === params.spec.hosting.provider
    && bindings.provider === observed.provider && observed.projectExists && !observed.partial
    && observed.completeness?.services !== 'unknown'
    && ['projectId', 'environmentId'].every(key => typeof bindings[key] === 'string' && bindings[key].length > 0
      && bindings[key] === observed[key as 'projectId' | 'environmentId']));
  return Object.entries(params.spec.services).sort(([a], [b]) => a.localeCompare(b)).map(([name, spec]) => {
    const matches = observed?.services.filter(service => service.name === name) ?? [];
    const service = matches.length === 1 ? matches[0] : undefined;
    const bound = record(boundServices?.[name]);
    const boundId = bound?.serviceId ?? bound?.jobName;
    const identityKnown = scopeKnown && typeof boundId === 'string' && boundId.length > 0
      && service?.externalId === boundId && observed!.services.filter(candidate => candidate.externalId === boundId).length === 1;
    const names = [...new Set([
      ...DATABASE_ENV_KEYS.filter(key => service?.envVarKeys.includes(key)),
      ...(service?.envVarKeys.filter(key => /^DATABASE_READ_URL_/.test(key)) ?? []),
      ...Object.keys(spec.databaseEnvAliases ?? {}),
    ])].sort();
    const configured = Boolean(identityKnown && names.length && service?.envVarState === 'resolved'
      && names.every(key => service.envVarKeys.includes(key) && digest(service.envVarHashes[key])));
    const snapshot = service?.deployment;
    const deployedKnown = Boolean(configured && snapshot?.configurationState === 'resolved'
      && snapshot.envVarHashes && names.every(key => digest(snapshot.envVarHashes![key])));
    const deployedConfiguration = !deployedKnown ? 'unknown'
      : names.every(key => service!.envVarHashes[key] === snapshot!.envVarHashes![key]) ? 'match' : 'mismatch';
    // A complete provider inventory with only the selected deployment is the
    // conservative retirement boundary. Multiple active revisions stay pending.
    const active = snapshot?.activeDeploymentIds;
    const oldDeployments = !identityKnown || !snapshot?.id || !active?.length || snapshot.activeDeploymentCoverage === 'traffic'
      || new Set(active).size !== active.length || !active.includes(snapshot.id)
      ? 'unknown' : active.every(id => id === snapshot.id) ? 'drained' : 'pending';
    const ready = deployedConfiguration === 'match' && oldDeployments === 'drained' && service?.status === 'running';
    const activation = !identityKnown || !service || service.status === 'unknown' ? 'unknown'
      : service.status === 'running' ? 'running' : 'not-running';
    return { service: name, provider: params.spec.hosting.provider, checkedNames: names,
      resolvedConfiguration: configured ? 'known' : 'unknown', deployedConfiguration, oldDeployments, activation,
      authentication: 'unchecked', applicationOperation: 'unchecked',
      ...(!ready ? { reason: !identityKnown ? 'Exact consumer identity and provider scope could not be verified.'
        : !configured ? 'Resolved database configuration is unsupported or unknown for this consumer.'
        : !deployedKnown ? 'Resolved configuration of the selected deployment is unsupported or unknown.'
        : deployedConfiguration === 'mismatch' ? 'The selected deployment retains different database configuration, including declared aliases.'
        : oldDeployments !== 'drained' ? 'Retirement of older deployments has not been verified.'
        : 'The selected consumer deployment is not running.' } : {}),
    };
  });
}

export function databaseConsumerRolloutRequirements(consumers: DatabaseConsumerReadiness[], observedAt: string): RuntimeRolloutRequirement[] {
  return consumers.filter(consumer => consumer.deployedConfiguration === 'mismatch' || consumer.oldDeployments === 'pending' || consumer.activation === 'not-running')
    .map(consumer => ({ service: consumer.service, provider: consumer.provider, requiredSince: observedAt,
      reason: consumer.reason!, actionIds: [] }));
}

export function databaseConsumersUnknown(consumers: DatabaseConsumerReadiness[]): boolean {
  return consumers.some(consumer => consumer.deployedConfiguration === 'unknown' || consumer.oldDeployments === 'unknown' || consumer.activation === 'unknown');
}
