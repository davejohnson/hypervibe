import { awsKey, type AwsEngineInput, type AwsTaskInput } from './aws-engine.config.js';

/**
 * Which role runs each workload, and which secrets it receives.
 *
 * With no secret limited to named services, one runtime role runs every workload and
 * starts the environment's schedules, exactly as before. Once a secret names services:
 *
 * - each named service gets its own role, the only ones whose policy lists that secret;
 * - every other workload keeps the shared runtime role, which no longer lists it;
 * - no role a container holds can start tasks, pass roles, change schedules or scale
 *   services. That work moves to a control role only AWS's scheduler, Step Functions and
 *   EventBridge can assume, so app code cannot start a named service's task with its own
 *   command, or hand a named service's role to something it runs.
 */
export interface AwsRuntimeIdentity {
  /** False: the single shared role does everything, as before. */
  scoped: boolean;
  /** OpenTofu key of the `aws_iam_role` that is the workload's task and execution role. */
  roleKey(task: Pick<AwsTaskInput, 'logicalName'>): string;
  /** Runtime secrets wired into the workload. */
  secretKeys(task: Pick<AwsTaskInput, 'logicalName'>): string[];
  /** OpenTofu key of the role schedules, wakers and their events run as. */
  controlKey: string;
  /** Named services present in this configuration, each with its own role. */
  serviceRoles: Array<{ task: AwsTaskInput; key: string; name: string; arn: string; secretKeys: string[] }>;
  /** Secrets the shared runtime role may read: those no declaration limits. */
  sharedSecretKeys: string[];
}

export const awsRuntimeRoleArn = (input: Pick<AwsEngineInput, 'accountId' | 'prefix'>): string => `arn:aws:iam::${input.accountId}:role/hypervibe/app/${input.prefix}-runtime`;
export const awsControlRoleName = (prefix: string): string => `${prefix}-control`;
/** A named service's own role: its ECS name (at most 60 characters) and a mark no fixed role name ends in. */
export const awsServiceRoleName = (resourceName: string): string => `${resourceName}-rt`;
export const awsServiceRoleArn = (accountId: string, resourceName: string): string => `arn:aws:iam::${accountId}:role/hypervibe/app/${awsServiceRoleName(resourceName)}`;

/** Role ARNs CI or a scheduler may hand to ECS for these workloads: the shared role and each named service's own. */
export function awsTaskRoleArns(input: Pick<AwsEngineInput, 'accountId' | 'prefix' | 'secretScopes'>, tasks: Array<Pick<AwsTaskInput, 'logicalName' | 'resourceName'>>): string[] {
  const named = new Set(Object.values(input.secretScopes ?? {}).flat());
  return [...new Set(tasks.map((task) => named.has(task.logicalName) ? awsServiceRoleArn(input.accountId, task.resourceName) : awsRuntimeRoleArn(input)))].sort();
}

export function awsRuntimeIdentity(input: AwsEngineInput, runtimeSecretKeys: string[]): AwsRuntimeIdentity {
  const scopes = input.secretScopes ?? {};
  if (!Object.keys(scopes).length) {
    return { scoped: false, roleKey: () => 'runtime', secretKeys: () => runtimeSecretKeys, controlKey: 'runtime', serviceRoles: [], sharedSecretKeys: runtimeSecretKeys };
  }
  const tasks: AwsTaskInput[] = [...(input.services ?? []), ...(input.workers ?? []), ...(input.jobs ?? [])];
  // Two workloads that share a generated name would share a role or a task definition, and with it a limited secret.
  for (const value of [(task: AwsTaskInput) => awsKey(task.logicalName), (task: AwsTaskInput) => task.resourceName]) {
    const seen = new Map<string, string>();
    for (const task of tasks) {
      const other = seen.get(value(task));
      if (other !== undefined) throw new Error(`Services ${other} and ${task.logicalName} would both be named "${value(task)}" on AWS, so a secret limited to named services could not be kept from one of them. Rename one.`);
      seen.set(value(task), task.logicalName);
    }
  }
  const named = new Set(Object.values(scopes).flat());
  const keysFor = (logicalName: string) => runtimeSecretKeys.filter((key) => !scopes[key] || scopes[key]!.includes(logicalName));
  const serviceRoles = tasks.filter((task) => named.has(task.logicalName)).map((task) => ({
    task, key: `service_${awsKey(task.logicalName)}`, name: awsServiceRoleName(task.resourceName), arn: awsServiceRoleArn(input.accountId, task.resourceName), secretKeys: keysFor(task.logicalName),
  }));
  const fixed = new Set([`${input.prefix}-runtime`, awsControlRoleName(input.prefix), `${input.prefix}-ci`, `${input.prefix}-build`]);
  for (const role of serviceRoles) if (role.name.length > 64 || fixed.has(role.name)) throw new Error(`Service ${role.task.logicalName} cannot be given its own AWS role name. Rename it.`);
  return {
    scoped: true,
    roleKey: (task) => named.has(task.logicalName) ? `service_${awsKey(task.logicalName)}` : 'runtime',
    secretKeys: (task) => keysFor(task.logicalName),
    controlKey: 'control',
    serviceRoles,
    sharedSecretKeys: runtimeSecretKeys.filter((key) => !scopes[key]),
  };
}
