import type { BranchDeployTarget } from '../../../domain/ports/ci-deploy.port.js';
import { HYPERVIBE_MANAGED_NODE_VERSION } from '../../../domain/services/managed-runtime.js';
import { reviewedCloudDeploymentCiAccess } from '../../../domain/services/cloud-deployment-ci.js';

export const ECS_BOOTSTRAP_IMAGE = `public.ecr.aws/docker/library/node:${HYPERVIBE_MANAGED_NODE_VERSION}-alpine`;
export const ECS_BOOTSTRAP_COMMAND = ['node', '-e', "require('http').createServer((_,res)=>{res.writeHead(200);res.end('hypervibe bootstrap')}).listen(8080)"];

/** A bootstrap is executable code. Native references would inject their payloads
 * at task start, so no application values or task authority may be attached. */
export function ecsInstalledBootstrapConfiguration(container: any, taskRoleArn: unknown): boolean {
  return Boolean(container && container.image === ECS_BOOTSTRAP_IMAGE
    && (container.portMappings === undefined ? container.containerPort === 8080 : Array.isArray(container.portMappings)
      && container.portMappings.length === 1 && container.portMappings[0].containerPort === 8080
      && [undefined, 'tcp'].includes(container.portMappings[0].protocol))
    && JSON.stringify(container.command) === JSON.stringify(ECS_BOOTSTRAP_COMMAND)
    && taskRoleArn === undefined
    && [container.environment, container.secrets, container.environmentFiles, container.logConfiguration?.secretOptions, container.mountPoints, container.volumesFrom]
      .every(entries => entries === undefined || Array.isArray(entries) && entries.length === 0)
    && container.repositoryCredentials === undefined);
}
export function ecsInstalledBootstrapTask(task: any): boolean {
  return Boolean(task && task.status === 'ACTIVE' && task.networkMode === 'awsvpc'
    && Array.isArray(task.requiresCompatibilities) && task.requiresCompatibilities.includes('FARGATE')
    && Array.isArray(task.containerDefinitions) && task.containerDefinitions.length === 1
    && task.containerDefinitions[0].name === 'Main'
    && (task.volumes === undefined || Array.isArray(task.volumes) && task.volumes.length === 0)
    && ecsInstalledBootstrapConfiguration(task.containerDefinitions[0], task.taskRoleArn));
}

/** Only committed nonsecret settings and immutable installation references are
 * rendered. Resolved/generated/delegated values never enter this projection. */
export function ecsInstalledReleaseTargets(target: BranchDeployTarget) {
  if (!target.deploymentAccess) return undefined;
  const { connection } = reviewedCloudDeploymentCiAccess(target);
  if (connection.provider !== 'aws' || connection.hostingProvider !== 'ecs') throw new Error('Installed ECS release scope is invalid.');
  return connection.deployment.workloads.map(workload => {
    const resource = target.runtimeResources?.find(item => item.logicalName === workload.name);
    const principals = connection.runtimeIdentities.filter(item => item.workload === workload.name);
    const role = (purpose: string) => {
      const matches = principals.filter(item => item.principal.kind === 'aws-role' && item.principal.purpose === purpose);
      if (matches.length !== 1 || matches[0].principal.kind !== 'aws-role') throw new Error('Installed ECS runtime identity is unavailable.');
      return matches[0];
    };
    const task = role('task'), execution = role('execution');
    const secrets = workload.runtimeSecrets.map(({ key, reference }) => {
      const d = reference.destination;
      if (d.provider !== 'aws-secrets' || d.accountId !== connection.nativeScope.accountId || d.region !== connection.deployment.region) throw new Error('Installed ECS runtime reference is invalid.');
      return { name: key, valueFrom: `${d.secretArn}:::${reference.version}` };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { serviceArn: resource?.providerResourceId, lifetimeId: resource?.providerResourceUid, owner: task.owner,
      installationId: connection.installationId, taskRoleArn: task.principal.kind === 'aws-role' ? task.principal.roleArn : '',
      executionRoleArn: execution.principal.kind === 'aws-role' ? execution.principal.roleArn : '', secrets,
      startCommand: resource?.startCommand ?? null, healthCheckPath: resource?.healthCheckPath ?? '/' };
  });
}

/** Values come from the exact workflow source bytes already checked by the
 * release broker. They are transient and do not affect workflow declarations. */
export function ecsInstalledReleaseEnvironment(source: any, environmentName: string, expected: any) {
  const environment = source?.environments?.[environmentName];
  if (!environment || environment.hosting?.provider !== 'ecs') throw new Error('Installed ECS source environment is unavailable.');
  const values = environment.envVars ?? {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Installed ECS source configuration is invalid.');
  return Object.entries(values).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith('HYPERVIBE_') || typeof value !== 'string'
      || expected.secrets.some((item: any) => item.name === name) || source.secrets?.[name]?.environments?.includes(environmentName)) throw new Error('Installed ECS source must keep credentials as immutable native references.');
    return { name, value };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Self-contained checks also executed in the generated native release program. */
export function ecsInstalledReleaseIdentity(service: any, expected: any): void {
  const tags = Array.isArray(service?.tags) ? service.tags : [];
  if (!expected || typeof expected.lifetimeId !== 'string' || !Number.isFinite(Date.parse(expected.lifetimeId))
    || service?.serviceArn !== expected.serviceArn || !(service.createdAt instanceof Date)
    || service.createdAt.toISOString() !== expected.lifetimeId
    || new Set(tags.map((item: any) => item.key)).size !== tags.length
    || tags.filter((item: any) => item.key === 'hypervibe-owner' && item.value === expected.owner).length !== 1
    || tags.filter((item: any) => item.key === 'hypervibe-installation' && item.value === expected.installationId).length !== 1) {
    throw new Error('Installed ECS service lifetime or ownership changed.');
  }
}
export function ecsInstalledFinalConfiguration(runtime: any, expected: any, verifyApplication = false): void {
  const executionRoleArn = runtime.definition?.executionRoleArn ?? runtime.executionRoleArn;
  const secrets = runtime.container?.secrets ?? [];
  if (runtime.taskRoleArn !== expected.taskRoleArn || executionRoleArn !== expected.executionRoleArn
    || !Array.isArray(secrets) || secrets.length !== expected.secrets.length
    || expected.secrets.some((item: any) => secrets.filter((actual: any) => actual.name === item.name && actual.valueFrom === item.valueFrom).length !== 1)
    || (runtime.container.environment ?? []).some((item: any) => expected.secrets.some((secret: any) => item.name === secret.name))) {
    throw new Error('Installed ECS final runtime identity or immutable references did not converge.');
  }
  if (verifyApplication) {
    const environment = runtime.container.environment, command = expected.startCommand ? ['sh', '-lc', expected.startCommand] : [];
    if (!Array.isArray(environment) || expected.environment.some((item: any) => environment.filter((actual: any) => actual.name === item.name && actual.value === item.value).length !== 1)
      || JSON.stringify(runtime.container.command ?? []) !== JSON.stringify(command)) throw new Error('Installed ECS application configuration did not converge.');
  }
}
export function ecsInstalledConfigurationRuntime(): string {
  return `const ECS_BOOTSTRAP_IMAGE = ${JSON.stringify(ECS_BOOTSTRAP_IMAGE)};
const ECS_BOOTSTRAP_COMMAND = ${JSON.stringify(ECS_BOOTSTRAP_COMMAND)};
${ecsInstalledBootstrapConfiguration.toString()}
${ecsInstalledBootstrapTask.toString()}
${ecsInstalledReleaseIdentity.toString()}
${ecsInstalledReleaseEnvironment.toString()}
${ecsInstalledFinalConfiguration.toString()}
`;
}
