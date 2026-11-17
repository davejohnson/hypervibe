import { strictHealthCheck } from '../domain/services/release-health.js';
import {
  AWS_DOCKERFILE, awsReleaseDockerfile, buildImage, releaseTask, releaseWebService, webServiceExists, type AwsReleaseTarget,
} from '../adapters/providers/aws/aws-release.client.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectRuntime } from '../domain/spec/project-runtime.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { CommandContext } from './context.js';
import { packageLocalCommit, runLocalCommitRelease, selectReleaseWorkloads } from './engine-release.js';
import { awsBinding, awsResourceName, resolveAwsEngineContext } from './infrastructure-engine-aws.js';
import { presentBuildTokenKey } from './engine-secrets.js';
import { parameterExists } from '../adapters/providers/aws/aws-engine.client.js';
import { releaseCommandFor, type EngineReleaseResult } from './infrastructure-engine.js';

/**
 * Releases a commit to an AWS engine environment: one CodeBuild image, then each
 * workload switches to it. The first release only builds the image, because the
 * engine creates workloads from an existing image; the next infrastructure plan
 * creates them. Never creates infrastructure itself.
 */
export async function releaseAwsEngineServices(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; environmentName: string; specRevision: number; services?: string[]; sourceDirectory?: string;
}): Promise<{ results: EngineReleaseResult[]; applyRunId: string; source?: { kind: 'local-commit'; revision: string; commitSha: string; uncommittedChangesExcluded?: boolean } } | { blocked: string }> {
  const environmentSpec = params.spec.environments[params.environmentName]!;
  if (releaseCommandFor(environmentSpec)) return { blocked: 'Release commands are not available on AWS yet; run migrations when the app starts instead.' };
  if (!params.sourceDirectory) return { blocked: 'AWS releases build from this project\'s local git repository; run Hypervibe from the repository.' };
  const context = await resolveAwsEngineContext(ctx, params.project, params.environmentName);
  if ('blocked' in context) return context;
  const token = await presentBuildTokenKey(params.spec, params.environmentName, (key) => parameterExists({ region: context.connection.region, credentials: context.credentials }, `${context.parameterPath}${key}`));
  if ('error' in token) return { blocked: token.error };
  const target: AwsReleaseTarget = { ...(token.key ? { packageTokenParameter: `${context.parameterPath}${token.key}` } : {}), region: context.connection.region, accountId: context.connection.accountId, prefix: context.prefix, credentials: context.credentials };
  const workloads = selectReleaseWorkloads(environmentSpec, params.services);
  if ('blocked' in workloads) return workloads;
  const { selected, web, startCommand } = workloads;
  const source = await packageLocalCommit(params.sourceDirectory, {
    format: 'zip', dockerfileName: AWS_DOCKERFILE,
    dockerfileFor: (repositoryDockerfile) => awsReleaseDockerfile({
      ...(repositoryDockerfile ? { repositoryDockerfile } : {}), ...(params.spec.runtime ? { runtime: params.spec.runtime as ProjectRuntime } : {}), ...(startCommand ? { startCommand } : {}),
    }),
  });
  if ('blocked' in source) return source;

  // Workloads exist only once an image does; until then this release only builds.
  const firstImage = !awsBinding(context.environment).imageUri;
  if (!firstImage && web) {
    const exists = await webServiceExists(target, awsResourceName(context.prefix, web), environmentSpec.services[web]!.public ?? true);
    if (exists === 'unknown') return { blocked: 'Hypervibe could not read the web service on AWS; try again.' };
    if (!exists) return { blocked: `Create the infrastructure first: ${web} does not exist yet. Run hv_plan scope="infrastructure" and hv_apply.` };
  }
  return runLocalCommitRelease(params, source, selected, {
    cloudName: 'AWS', provider: 'aws', environmentId: context.environment.id, buildPhrase: 'in CodeBuild', firstImage, createdNoun: 'services',
    resourceOf: (name) => awsResourceName(context.prefix, name),
    build: async (packaged) => {
      const built = await buildImage(target, packaged);
      return 'error' in built ? built : { image: built.imageUri, ...(built.logsUrl ? { logsUrl: built.logsUrl } : {}) };
    },
    recordImage: (imageUri) => {
      const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
      ctx.repos.environments.updatePlatformBindings(current.id, { aws: { ...awsBinding(current), imageUri } });
    },
    releaseWorkload: async ({ name, kind, resource, image }) => {
      // A private web service is an ordinary ECS service, released like a worker.
      const result = kind === 'web' && (environmentSpec.services[name]!.public ?? true)
        ? await releaseWebService(target, name, resource, image, environmentSpec.services[name]!.healthCheckPath ?? '/', strictHealthCheck(environmentSpec.services[name]!))
        : await releaseTask(target, name, resource, image, kind !== 'cron');
      if (result.status === 'released' && result.taskDefinitionArn) {
        const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
        const services = (current.platformBindings as { services?: Record<string, Record<string, unknown>> }).services ?? {};
        const binding = services[name];
        if (binding) ctx.repos.environments.updatePlatformBindings(current.id, { services: { ...services, [name]: { ...binding,
          taskDefinitionArn: result.taskDefinitionArn, ...(kind === 'cron' ? { serviceId: result.taskDefinitionArn } : {}) } } });
      }
      return result;
    },
  });
}

/**
 * Builds one reviewed commit of the local repository for an environment (used by
 * the infrastructure apply for the first image), returning the digest-pinned image.
 */
export async function buildAwsCommitImage(target: AwsReleaseTarget, spec: ProjectSpec, environmentName: string, directory: string, commitSha: string)
  : Promise<{ imageUri: string; logsUrl?: string } | { error: string; logsUrl?: string; unknown?: boolean }> {
  const workloads = selectReleaseWorkloads(spec.environments[environmentName]!, undefined);
  const startCommand = 'blocked' in workloads ? undefined : workloads.startCommand;
  const source = await packageLocalCommit(directory, {
    format: 'zip', dockerfileName: AWS_DOCKERFILE, commitSha,
    dockerfileFor: (repositoryDockerfile) => awsReleaseDockerfile({
      ...(repositoryDockerfile ? { repositoryDockerfile } : {}), ...(spec.runtime ? { runtime: spec.runtime as ProjectRuntime } : {}), ...(startCommand ? { startCommand } : {}),
    }),
  });
  if ('blocked' in source) return { error: source.blocked };
  return buildImage(target, source);
}
