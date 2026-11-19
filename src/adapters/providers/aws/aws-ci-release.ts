import { strictHealthCheck } from '../../../domain/services/release-health.js';
import { CodeBuildClient } from '@aws-sdk/client-codebuild';
import { DescribeExpressGatewayServiceCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient } from '@aws-sdk/client-ecs';
import type { EngineCiReleaseTarget, GitHubOidcContext } from '../../../domain/ports/engine-ci.port.js';
import type { EngineCiBinding } from '../../../domain/spec/engine-ci-binding.js';
import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { awsCiAccess } from './aws-ci-auth.js';
import { AWS_DOCKERFILE, awsReleaseDockerfile, buildImage, releaseTask, releaseWebService, awsRequiredDockerfile, awsWorkloadImages, inspectAwsBuildProject, usesAwsWebCommand, type AwsBuildTarget } from './aws-release.client.js';
import { matchesTaskDefinitionFamily, taskDefinitionIdentity } from './aws-task-identity.js';

export async function createAwsCiReleaseTarget(binding: EngineCiBinding, context: GitHubOidcContext, spec: ProjectSpec): Promise<EngineCiReleaseTarget> {
  const access = await awsCiAccess(binding, context); const a = binding.aws!;
  const services = spec.environments[binding.environmentName]!.services;
  const webOverrides = Object.keys(binding.services).filter(name => usesAwsWebCommand(services[name]!));
  let buildProject: { webCommands: boolean } | undefined;
  const target: AwsBuildTarget = { environmentId: binding.environmentId, webCommands: webOverrides.length > 0, region: binding.region, accountId: a.accountId, prefix: binding.prefix, credentials: access.credentials,
    deadlineMs: context.deadlineMs ?? Date.now() + 35 * 60_000, requestTimeoutMs: 30_000, buildProjectArn: a.buildProjectArn, sourceBucket: a.sourceBucket, repositoryUrl: a.repositoryUrl, ...(a.packageParameter ? { packageTokenParameter: a.packageParameter } : {}) };
  const options = { region: binding.region, credentials: access.credentials, maxAttempts: 1, requestHandler: { requestTimeout: 30_000, connectionTimeout: 5000 } };
  const ecs = new ECSClient(options);
  const taskDefinitions = new Map<string, string>();
  const inspect = async (name: string) => {
    if (Date.now() + 30_000 >= target.deadlineMs!) throw new Error('The release observation deadline has elapsed.');
    const w = binding.services[name]!;
    if (w.resourceType === 'ecs-express') {
      const found = (await ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn: w.serviceId }))).service;
      if (found?.serviceArn !== w.serviceId || found.status?.statusCode !== 'ACTIVE') throw new Error('AWS did not confirm an active exact web service target.');
      return;
    }
    const recorded = taskDefinitionIdentity(w.taskDefinitionArn);
    if (!recorded) throw new Error('The recorded ECS task definition is not an exact native identity.');
    let definition = recorded.family;
    if (w.resourceType === 'ecs-service') {
      const found = await ecs.send(new DescribeServicesCommand({ cluster: w.clusterArn!, services: [w.serviceId] }));
      const service = found.services?.[0];
      if (found.failures?.length || found.services?.length !== 1 || service?.serviceArn !== w.serviceId || service.clusterArn !== w.clusterArn
        || service.status !== 'ACTIVE' || !matchesTaskDefinitionFamily(service.taskDefinition, w.taskDefinitionArn!)) throw new Error('AWS did not confirm the exact ECS service and current task family.');
      definition = service.taskDefinition!;
    }
    const found = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: definition }));
    const current = found.taskDefinition;
    if (!matchesTaskDefinitionFamily(current?.taskDefinitionArn, w.taskDefinitionArn!) || current?.family !== recorded.family
      || (w.resourceType === 'ecs-service' && current.taskDefinitionArn !== definition) || !current.containerDefinitions?.some((c) => c.name === 'app') || current.status !== 'ACTIVE') throw new Error('AWS did not confirm the bound current task definition.');
    const role = `arn:aws:iam::${a.accountId}:role/hypervibe/app/${binding.prefix}-runtime`;
    if (current.taskRoleArn !== role || current.executionRoleArn !== role) throw new Error('The ECS task uses runtime roles outside the applied release scope.');
    taskDefinitions.set(name, current.taskDefinitionArn!);
  };
  return { cloudName: 'AWS', buildPhrase: 'in CodeBuild', format: 'zip', dockerfileName: AWS_DOCKERFILE,
    missingDockerfileMessage: awsRequiredDockerfile(Object.values(services)), dockerfileFor: awsReleaseDockerfile, redact: access.redact,
    preflight: async () => {
      const observed = await inspectAwsBuildProject(target, new CodeBuildClient(options));
      if ('error' in observed) return { blocked: observed.error };
      if (target.webCommands && !observed.webCommands) return { blocked: 'Apply the current AWS build project infrastructure before releasing web start commands from CI.' };
      buildProject = observed;
      for (const name of Object.keys(binding.services).sort()) await inspect(name);
    },
    build: async (source) => {
      const built = await buildImage(target, source, {}, buildProject);
      return 'error' in built ? built : awsWorkloadImages(built, webOverrides);
    },
    releaseWorkload: async ({ name, image }) => {
      await inspect(name); const w = binding.services[name]!;
      const result = await (w.resourceType === 'ecs-express'
        ? releaseWebService(target, name, w.serviceId, image, spec.environments[binding.environmentName]!.services[name]!.healthCheckPath ?? '/', strictHealthCheck(spec.environments[binding.environmentName]!.services[name]!), undefined, spec.environments[binding.environmentName]!.services[name]!.startCommand)
        : releaseTask(target, name, w.serviceId, image, w.resourceType === 'ecs-service', { clusterArn: w.clusterArn!, taskDefinitionArn: taskDefinitions.get(name)!, ...(w.resourceType === 'ecs-service' ? { serviceArn: w.serviceId } : {}) }));
      if (result.status !== 'released') return result;
      if (w.resourceType === 'ecs-express') return result.health && result.health.status >= 200 && result.health.status < 400 ? result
        : { ...result, status: 'failed', message: 'The released web service did not pass its application HTTP check.' };
      if (w.resourceType !== 'ecs-service') return result;
      for (let attempt = 0; attempt < 60 && Date.now() < target.deadlineMs!; attempt++) {
        const observed = await ecs.send(new DescribeServicesCommand({ cluster: w.clusterArn!, services: [w.serviceId] }));
        const service = observed.services?.[0]; const primary = service?.deployments?.filter((d) => d.status === 'PRIMARY');
        if (observed.failures?.length || observed.services?.length !== 1 || service?.serviceArn !== w.serviceId || service.clusterArn !== w.clusterArn) return { ...result, status: 'unknown', message: 'AWS did not confirm the exact service after release.' };
        if (primary?.length === 1 && primary[0]?.taskDefinition === result.taskDefinitionArn) {
          if (primary[0].rolloutState === 'FAILED') return { ...result, status: 'failed', message: 'The current ECS rollout failed.' };
          if (primary[0].rolloutState === 'COMPLETED' && service.taskDefinition === result.taskDefinitionArn && service.pendingCount === 0 && typeof service.desiredCount === 'number' && service.runningCount === service.desiredCount) return result;
        }
        if (attempt < 59) await new Promise((done) => setTimeout(done, 5000));
      }
      return { ...result, status: 'unknown', message: 'AWS did not confirm the exact current ECS rollout before the observation deadline.' };
    },
  };
}
