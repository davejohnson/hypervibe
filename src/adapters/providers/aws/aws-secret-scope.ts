import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { awsRuntimeRoleArn, awsServiceRoleArn } from './tofu/aws-engine.identity.js';

/**
 * The declared secrets of one environment that name services, as the AWS engine reads them
 * (secret key to service names). Undefined when none does: the environment then keeps its
 * single runtime role and its generated configuration does not change.
 */
export function awsSecretScopes(spec: Pick<ProjectSpec, 'secrets'>, environmentName: string): Record<string, string[]> | undefined {
  const secrets = (spec.secrets ?? {}) as Record<string, { environments: string[]; services?: string[] } | undefined>;
  const scoped = Object.entries(secrets)
    .filter(([, secret]) => secret?.services && secret.environments.includes(environmentName))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, secret]) => [key, [...secret!.services!].sort()] as const);
  return scoped.length ? Object.fromEntries(scoped) : undefined;
}

/**
 * The role a workload's task definition must name (task and execution role alike): its own
 * when a limited secret names the service, otherwise the environment's shared runtime role.
 * `family` is the workload's ECS task family.
 */
export function awsWorkloadRoleArn(spec: Pick<ProjectSpec, 'secrets'>, environmentName: string, target: { accountId: string; prefix: string }, service: string, family: string): string {
  const named = Object.values(awsSecretScopes(spec, environmentName) ?? {}).some((services) => services.includes(service));
  return named ? awsServiceRoleArn(target.accountId, family) : awsRuntimeRoleArn(target);
}
