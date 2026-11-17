import {
  APPS_API, AZURE_DOCKERFILE, azureReleaseDockerfile, buildWithAcrTasks, releaseAzureApp, releaseAzureJob,
} from '../adapters/providers/azure/azure-release.client.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectRuntime } from '../domain/spec/project-runtime.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { ARM, AZURE_SCOPES, azureError, azureRest } from '../adapters/providers/azure/azure-ops.client.js';
import type { CommandContext } from './context.js';
import { azureCiRegistry, type AzureBuildRegistry } from '../adapters/providers/azure/azure-ci-registry.js';
import { engineCiIntent } from '../domain/spec/engine-ci.js';
import { presentBuildTokenKey } from './engine-secrets.js';
import { azureBuildTaskName } from '../adapters/providers/azure/azure-build-task.js';
import { azureEnvironmentSecretStore, azureBinding, azureResourceName, resolveAzureEngineContext, type AzureEngineContext } from './infrastructure-engine-azure.js';
import { packageLocalCommit, runLocalCommitRelease, selectReleaseWorkloads, type LocalCommitSource } from './engine-release.js';
import { releaseCommandFor, type EngineReleaseResult } from './infrastructure-engine.js';

type Source = LocalCommitSource;

export function azureAppliedBuildRegistry(context: AzureEngineContext, spec: ProjectSpec): AzureBuildRegistry | { error: string } {
  const applied = azureBinding(context.environment).buildRegistry;
  if (!applied && !engineCiIntent(spec, context.environmentName)) return { id: context.shared.registryId, loginServer: context.shared.registryLoginServer };
  const expected = azureCiRegistry({ subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup, environmentId: context.environment.id });
  if (!applied || applied.id.toLowerCase() !== expected.id.toLowerCase() || applied.loginServer !== expected.loginServer) return { error: 'The environment image registry has not been verified in the applied engine state. Run hv_plan and hv_apply before deploying.' };
  return applied;
}

export async function azureBuildTaskFor(context: AzureEngineContext, spec: ProjectSpec): Promise<{ taskId?: string; registryId: string; loginServer: string } | { error: string }> {
  const registry = azureAppliedBuildRegistry(context, spec);
  if ('error' in registry) return registry;
  const store = azureEnvironmentSecretStore(context);
  const token = await presentBuildTokenKey(spec, context.environmentName, (key) => store.observe(key));
  if ('error' in token) return token;
  const managedTask = Boolean(token.key || engineCiIntent(spec, context.environmentName) || azureBinding(context.environment).buildRegistry);
  return { registryId: registry.id, loginServer: registry.loginServer, ...(managedTask ? { taskId: `${registry.id}/tasks/${azureBuildTaskName(context.prefix)}` } : {}) };
}

/** The exact commit as a tar.gz (ACR Tasks' source format), with the Dockerfile Hypervibe builds. */
export function azureLocalSource(directory: string, dockerfileFor: (repositoryDockerfile?: string) => string, commitSha?: string): Promise<Source | { blocked: string }> {
  return packageLocalCommit(directory, { format: 'tar.gz', dockerfileName: AZURE_DOCKERFILE, dockerfileFor, ...(commitSha ? { commitSha } : {}) });
}

/** Builds the commit the infrastructure plan recorded, for the apply that creates the workloads. */
export async function buildAzureImage(context: AzureEngineContext, source: { directory: string; commitSha: string }): ReturnType<typeof buildWithAcrTasks> {
  const spec = new SpecStore().get(context.project)?.spec;
  if (!spec) return { error: 'The reviewed project spec is unavailable.' };
  const task = await azureBuildTaskFor(context, spec);
  if ('error' in task) return task;
  const environmentSpec = spec.environments[context.environmentName];
  const web = Object.values(environmentSpec?.services ?? {}).find((service) => (service.workloadKind ?? 'web') === 'web');
  const packaged = await azureLocalSource(source.directory, (repositoryDockerfile) => azureReleaseDockerfile({
    ...(repositoryDockerfile ? { repositoryDockerfile } : {}), ...(spec?.runtime ? { runtime: spec.runtime as ProjectRuntime } : {}), ...(web?.startCommand ? { startCommand: web.startCommand } : {}),
  }), source.commitSha);
  if ('blocked' in packaged) return { error: packaged.blocked };
  return buildWithAcrTasks(context.tokens, { ...task, source: packaged });
}

/**
 * Releases a commit to an Azure engine environment: one ACR Tasks image, then
 * each workload switches to it. When the workloads do not exist yet this only
 * builds; the next infrastructure plan creates them from that image.
 */
export async function releaseAzureEngineServices(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; environmentName: string; specRevision: number; services?: string[]; sourceDirectory?: string;
}): Promise<{ results: EngineReleaseResult[]; applyRunId: string; source?: { kind: 'local-commit'; revision: string; commitSha: string; uncommittedChangesExcluded?: boolean } } | { blocked: string }> {
  const environmentSpec = params.spec.environments[params.environmentName]!;
  if (releaseCommandFor(environmentSpec)) return { blocked: 'Release commands are not available on Azure yet; run migrations when the app starts instead.' };
  if (!params.sourceDirectory) return { blocked: 'Azure releases build from this project\'s local git repository; run Hypervibe from the repository.' };
  const context = await resolveAzureEngineContext(ctx, params.project, params.environmentName);
  if ('blocked' in context) return context;
  const task = await azureBuildTaskFor(context, params.spec);
  if ('error' in task) return { blocked: task.error };
  const workloads = selectReleaseWorkloads(environmentSpec, params.services);
  if ('blocked' in workloads) return workloads;
  const { selected, startCommand } = workloads;
  const source = await azureLocalSource(params.sourceDirectory, (repositoryDockerfile) => azureReleaseDockerfile({
    ...(repositoryDockerfile ? { repositoryDockerfile } : {}), ...(params.spec.runtime ? { runtime: params.spec.runtime as ProjectRuntime } : {}), ...(startCommand ? { startCommand } : {}),
  }));
  if ('blocked' in source) return source;
  const group = `/subscriptions/${context.connection.subscriptionId}/resourceGroups/${context.connection.resourceGroup}`;
  const idOf = (name: string) => `${group}/providers/Microsoft.App/${environmentSpec.services[name]!.workloadKind === 'cron' ? 'jobs' : 'containerApps'}/${azureResourceName(context.prefix, name)}`;
  // Workloads exist only once an image does; until then this release only builds.
  let firstImage = !azureBinding(context.environment).image;
  if (!firstImage) {
    const probe = await azureRest(context.tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${idOf(selected[0]!)}?${APPS_API}`);
    if (probe.status === 404) firstImage = true;
    else if (probe.status !== 200) return { blocked: `Hypervibe could not read ${selected[0]} on Azure (${azureError(probe)}); try again.` };
  }
  return runLocalCommitRelease(params, source, selected, {
    cloudName: 'Azure', provider: 'azure', environmentId: context.environment.id, buildPhrase: 'with ACR Tasks', firstImage, createdNoun: 'workloads',
    resourceOf: idOf,
    build: (packaged) => {
      // The commit the apply already built: release that image instead of building again.
      const existing = azureBinding(ctx.repos.environments.findById(context.environment.id) ?? context.environment);
      if (!firstImage && existing.image && existing.imageCommit === packaged.commitSha) return Promise.resolve({ image: existing.image });
      return buildWithAcrTasks(context.tokens, { ...task, source: packaged });
    },
    recordImage: (image, packaged) => {
      const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
      ctx.repos.environments.updatePlatformBindings(current.id, { azure: { ...azureBinding(current), kind: 'opentofu', image, imageCommit: packaged.commitSha } });
    },
    releaseWorkload: ({ name, kind, resource, image }) => kind === 'cron'
      ? releaseAzureJob(context.tokens, { id: resource, name, image })
      : releaseAzureApp(context.tokens, { id: resource, name, image, web: kind === 'web', ...(environmentSpec.services[name]!.healthCheckPath ? { healthCheckPath: environmentSpec.services[name]!.healthCheckPath } : {}) }),
  });
}
