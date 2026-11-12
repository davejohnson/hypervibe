import { execFile } from 'child_process';
import crypto from 'crypto';
import { promisify } from 'util';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import type { Project } from '../domain/entities/project.entity.js';
import { ConvergeExecutor } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { generatedContainerDockerfile } from '../domain/services/generated-container.js';
import type { ProjectRuntime } from '../domain/spec/project-runtime.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { ARM, AZURE_SCOPES, azureError, azureRest, type AzureTokens } from './azure-ops.js';
import type { CommandContext } from './context.js';
import { AZURE_IMAGE_REPOSITORY, azureBinding, azureResourceName, resolveAzureEngineContext, type AzureEngineContext } from './infrastructure-engine-azure.js';
import { ENGINE_PLAN_SCOPE, ENGINE_RELEASE_OPERATION, releaseCommandFor, type EngineReleaseResult } from './infrastructure-engine.js';

const execFileAsync = promisify(execFile);
const AZURE_DOCKERFILE = '.hypervibe-azure.Dockerfile';
const TASKS_API = 'api-version=2019-06-01-preview';
const APPS_API = 'api-version=2024-03-01';

/** The repository's Dockerfile, or the generated one; Container Apps need nothing added. */
export function azureReleaseDockerfile(params: { repositoryDockerfile?: string; runtime?: ProjectRuntime; startCommand?: string }): string {
  return params.repositoryDockerfile
    ?? generatedContainerDockerfile(params.runtime ?? (() => { throw new Error('No repository Dockerfile and no project runtime: run hv_spec to review the runtime.'); })(), params.startCommand);
}

interface Source { commitSha: string; archive: Buffer; uncommittedChangesExcluded: boolean }

/** The exact commit as a tar.gz (ACR Tasks' source format), with the Dockerfile Hypervibe builds. */
export async function azureLocalSource(directory: string, dockerfileFor: (repositoryDockerfile?: string) => string, commitSha?: string): Promise<Source | { blocked: string }> {
  try {
    const git = async (args: string[]) => String((await execFileAsync('git', ['-C', directory, ...args])).stdout);
    const sha = commitSha ?? (await git(['rev-parse', 'HEAD'])).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return { blocked: 'The local repository has no commit to release.' };
    let repositoryDockerfile: string | undefined;
    try { repositoryDockerfile = await git(['show', `${sha}:Dockerfile`]); } catch { /* no repository Dockerfile */ }
    const archive = (await execFileAsync('git', ['-C', directory, 'archive', '--format=tar.gz', `--add-virtual-file=${AZURE_DOCKERFILE}:${dockerfileFor(repositoryDockerfile)}`, sha],
      { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })).stdout as Buffer;
    const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
    return { commitSha: sha, archive, uncommittedChangesExcluded: dirty };
  } catch (error) {
    return { blocked: `Hypervibe could not package this repository: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
  }
}

/**
 * Builds a commit with ACR Tasks (no local Docker): upload the archive to the
 * registry's build-source blob, schedule a Docker build, wait, and return the
 * digest-pinned image from the run's output.
 */
export async function buildWithAcrTasks(tokens: AzureTokens, params: { registryId: string; loginServer: string; source: Source; pollMs?: number; timeoutMs?: number }): Promise<{ image: string; logsUrl?: string } | { error: string; unknown?: boolean; logsUrl?: string }> {
  const registry = `${ARM}${params.registryId}`;
  const upload = await azureRest(tokens, AZURE_SCOPES.arm, 'POST', `${registry}/listBuildSourceUploadUrl?${TASKS_API}`);
  if (upload.status !== 200 || typeof upload.body.uploadUrl !== 'string') return { error: `ACR did not give an upload address (${azureError(upload)}).` };
  const put = await tokens.fetchImpl(upload.body.uploadUrl, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/gzip' }, body: new Uint8Array(params.source.archive), signal: AbortSignal.timeout(10 * 60_000) });
  await put.body?.cancel();
  if (put.status !== 201) return { error: `Uploading the source to ACR failed (HTTP ${put.status}).` };
  const tag = `${AZURE_IMAGE_REPOSITORY}:${params.source.commitSha}`;
  const scheduled = await azureRest(tokens, AZURE_SCOPES.arm, 'POST', `${registry}/scheduleRun?${TASKS_API}`, {
    type: 'DockerBuildRequest', imageNames: [tag], isPushEnabled: true, noCache: false, dockerFilePath: AZURE_DOCKERFILE,
    sourceLocation: upload.body.relativePath, platform: { os: 'Linux', architecture: 'amd64' }, agentConfiguration: { cpu: 2 }, timeout: 3600,
  });
  const runId = (scheduled.body.properties as { runId?: string } | undefined)?.runId ?? (scheduled.body.name as string | undefined);
  if (![200, 201, 202].includes(scheduled.status) || !runId) {
    const code = (scheduled.body.error as { code?: string } | undefined)?.code;
    return { error: code === 'TasksOperationsNotAllowed'
      ? 'Microsoft pauses ACR Tasks on free-credit (trial or student) subscriptions. Upgrade the subscription to pay-as-you-go in the Azure portal, then deploy again.'
      : `ACR did not start the build (${azureError(scheduled)}).` };
  }
  let logsUrl: string | undefined;
  const logs = await azureRest(tokens, AZURE_SCOPES.arm, 'POST', `${registry}/runs/${runId}/listLogSasUrl?${TASKS_API}`).catch(() => undefined);
  if (logs && typeof logs.body.logLink === 'string') logsUrl = logs.body.logLink;
  const deadline = Date.now() + (params.timeoutMs ?? 35 * 60_000);
  for (;;) {
    const run = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${registry}/runs/${runId}?${TASKS_API}`).catch(() => undefined);
    const properties = (run?.body.properties ?? {}) as { status?: string; outputImages?: Array<{ repository?: string; tag?: string; digest?: string }> };
    if (properties.status === 'Succeeded') {
      const digest = properties.outputImages?.find((image) => image.repository === AZURE_IMAGE_REPOSITORY)?.digest;
      if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) return { error: 'The build finished without an image digest; refusing to release a mutable tag.', ...(logsUrl ? { logsUrl } : {}) };
      return { image: `${params.loginServer}/${AZURE_IMAGE_REPOSITORY}@${digest}`, ...(logsUrl ? { logsUrl } : {}) };
    }
    if (properties.status && ['Failed', 'Canceled', 'Error', 'Timeout'].includes(properties.status)) {
      return { error: `The image build ${properties.status.toLowerCase()}; see its log.`, ...(logsUrl ? { logsUrl } : {}) };
    }
    if (Date.now() > deadline) return { error: 'The image build is still running.', unknown: true, ...(logsUrl ? { logsUrl } : {}) };
    await new Promise((done) => setTimeout(done, params.pollMs ?? 10_000));
  }
}

/** Builds the commit the infrastructure plan recorded, for the apply that creates the workloads. */
export async function buildAzureImage(context: AzureEngineContext, source: { directory: string; commitSha: string }) {
  const spec = new SpecStore().get(context.project)?.spec;
  const environmentSpec = spec?.environments[context.environmentName];
  const web = Object.values(environmentSpec?.services ?? {}).find((service) => (service.workloadKind ?? 'web') === 'web');
  const packaged = await azureLocalSource(source.directory, (repositoryDockerfile) => azureReleaseDockerfile({
    ...(repositoryDockerfile ? { repositoryDockerfile } : {}), ...(spec?.runtime ? { runtime: spec.runtime as ProjectRuntime } : {}), ...(web?.startCommand ? { startCommand: web.startCommand } : {}),
  }), source.commitSha);
  if ('blocked' in packaged) return { error: packaged.blocked };
  return buildWithAcrTasks(context.tokens, { registryId: context.shared.registryId, loginServer: context.shared.registryLoginServer, source: packaged });
}

/**
 * Whether a response is Azure's own page rather than the app's: the gateway's
 * 502/503/504 while no replica answers, or the "stopped or does not exist" page.
 */
export function azurePlatformError(status: number, body: string): string | undefined {
  if (status === 502 || status === 503 || status === 504) return `HTTP ${status} from the Container Apps gateway`;
  if (status === 404 && /Container App/i.test(body) && /(does not exist|stopped)/i.test(body)) return 'the Container Apps "stopped or does not exist" page';
  return undefined;
}

async function waitForApp(tokens: AzureTokens, id: string, previousRevision: string | undefined, deadline: number): Promise<Record<string, unknown> | undefined> {
  for (;;) {
    const app = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${id}?${APPS_API}`);
    const properties = (app.body.properties ?? {}) as { provisioningState?: string; latestRevisionName?: string };
    if (app.status === 200 && properties.provisioningState === 'Succeeded' && properties.latestRevisionName !== previousRevision) return app.body;
    if (properties.provisioningState === 'Failed' || Date.now() > deadline) return undefined;
    await new Promise((done) => setTimeout(done, 5000));
  }
}

/** Swaps the image in a Container App or job template; only the running image changes, so the engine sees no drift. */
export function templateWithImage(template: Record<string, unknown>, image: string): Record<string, unknown> {
  const { revisionSuffix: _suffix, ...rest } = template as { revisionSuffix?: string; containers?: Array<Record<string, unknown>> };
  return { ...rest, containers: ((template.containers ?? []) as Array<Record<string, unknown>>).map((container) => container.name === 'app' ? { ...container, image } : container) };
}

export async function releaseAzureApp(tokens: AzureTokens, params: { id: string; name: string; image: string; healthCheckPath?: string; web: boolean; fetchTimeoutMs?: number; waitMs?: number; retryMs?: number }): Promise<EngineReleaseResult> {
  const current = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${params.id}?${APPS_API}`);
  if (current.status === 404) return { service: params.name, status: 'failed', message: `${params.name} does not exist yet. Run hv_plan scope="infrastructure" and hv_apply.` };
  if (current.status !== 200) return { service: params.name, status: 'unknown', message: `${params.name} could not be read (${azureError(current)}).` };
  const properties = current.body.properties as { template: Record<string, unknown>; latestRevisionName?: string };
  const patched = await azureRest(tokens, AZURE_SCOPES.arm, 'PATCH', `${ARM}${params.id}?${APPS_API}`, { properties: { template: templateWithImage(properties.template, params.image) } });
  if (![200, 201, 202].includes(patched.status)) return { service: params.name, imageUri: params.image, status: 'failed', message: `Azure rejected the release (${azureError(patched)}).` };
  const app = await waitForApp(tokens, params.id, properties.latestRevisionName, Date.now() + (params.waitMs ?? 10 * 60_000));
  if (!app) return { service: params.name, imageUri: params.image, status: 'unknown', message: `${params.name} did not report a new ready revision.` };
  const latest = (app.properties as { latestRevisionName?: string; configuration?: { ingress?: { fqdn?: string } } });
  if (!params.web) return { service: params.name, imageUri: params.image, status: 'released', message: `Released to ${params.name}; it starts with the new image when work is queued.` };
  const fqdn = latest.configuration?.ingress?.fqdn;
  const result: EngineReleaseResult = { service: params.name, imageUri: params.image, status: 'released', message: `Released to ${params.name}.`, ...(fqdn ? { url: `https://${fqdn}` } : {}) };
  if (!fqdn) return result;
  const path = params.healthCheckPath ?? '/';
  // A scaled-to-zero app starts on the first request; the gateway answers 502-504 until a replica is ready.
  let status = 0; let body = ''; let platform: string | undefined;
  const until = Date.now() + (params.fetchTimeoutMs ?? 3 * 60_000);
  for (;;) {
    try {
      const response = await tokens.fetchImpl(new URL(path, `https://${fqdn}`), { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      status = response.status; body = (await response.text()).slice(0, 4096);
      platform = azurePlatformError(status, body);
    } catch { status = 0; platform = 'no answer'; }
    if (!platform || Date.now() > until) break;
    await new Promise((done) => setTimeout(done, params.retryMs ?? 10_000));
  }
  result.health = { status, path };
  if (platform) return { ...result, status: 'failed', message: `The new release did not start (${platform}): check hv_logs for the app's error.` };
  // The page was the app's; confirm the platform also counts the revision healthy.
  const revision = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${params.id}/revisions/${latest.latestRevisionName}?${APPS_API}`);
  const health = (revision.body.properties as { healthState?: string } | undefined)?.healthState;
  if (health === 'Unhealthy') return { ...result, status: 'failed', message: `Azure reports revision ${latest.latestRevisionName} unhealthy. Check hv_logs.` };
  if (status >= 500) return { ...result, status: 'failed', message: `The new release is serving, but ${path} returned HTTP ${status}. Check hv_logs.` };
  return result;
}

export async function releaseAzureJob(tokens: AzureTokens, params: { id: string; name: string; image: string }): Promise<EngineReleaseResult> {
  const current = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${params.id}?${APPS_API}`);
  if (current.status === 404) return { service: params.name, status: 'failed', message: `${params.name} does not exist yet. Run hv_plan scope="infrastructure" and hv_apply.` };
  if (current.status !== 200) return { service: params.name, status: 'unknown', message: `${params.name} could not be read (${azureError(current)}).` };
  const template = (current.body.properties as { template: Record<string, unknown> }).template;
  const patched = await azureRest(tokens, AZURE_SCOPES.arm, 'PATCH', `${ARM}${params.id}?${APPS_API}`, { properties: { template: templateWithImage(template, params.image) } });
  if (![200, 201, 202].includes(patched.status)) return { service: params.name, imageUri: params.image, status: 'failed', message: `Azure rejected the release (${azureError(patched)}).` };
  return { service: params.name, imageUri: params.image, status: 'released', message: `Released to scheduled job ${params.name}; its next run uses it.` };
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
  const selected = params.services?.length ? params.services : Object.keys(environmentSpec.services);
  const unknownNames = selected.filter((name) => !environmentSpec.services[name]);
  if (unknownNames.length) return { blocked: `${unknownNames.join(', ')} is not a service in this environment.` };
  const web = selected.find((name) => (environmentSpec.services[name]!.workloadKind ?? 'web') === 'web');
  const startCommand = environmentSpec.services[web ?? selected[0]!]?.startCommand;
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
  const provider = 'azure';
  const actions: PlanAction[] = [
    { id: 'build:image', type: 'update', verified: true, resource: { kind: 'service', name: 'image', provider },
      reason: `Build commit ${source.commitSha.slice(0, 12)} with ACR Tasks.`, metadata: { operation: ENGINE_RELEASE_OPERATION, workloadKind: 'build' } },
    ...(firstImage ? [] : selected.map((name): PlanAction => ({
      id: `release:${name}`, type: 'update', verified: true, dependsOn: ['build:image'], resource: { kind: 'service', name, provider },
      reason: `Release commit ${source.commitSha.slice(0, 12)} to ${name}; only the running image changes.`,
      metadata: { operation: ENGINE_RELEASE_OPERATION, resource: idOf(name), workloadKind: environmentSpec.services[name]!.workloadKind ?? 'web' },
    }))),
  ];
  const runRepo = new RunRepository();
  const planRun = runRepo.create({ projectId: params.project.id, environmentId: context.environment.id, type: 'plan', plan: {
    kind: 'hv_plan', scope: ENGINE_PLAN_SCOPE, environmentName: params.environmentName, specRevision: params.specRevision,
    observedFingerprint: null, actions, unmanaged: [], warnings: [], engine: { planId: `release-${crypto.randomUUID()}`, release: true },
  } as unknown as Record<string, unknown> });
  runRepo.updateStatus(planRun.id, 'succeeded');

  const results: EngineReleaseResult[] = [];
  let image: string | undefined;
  const execution = await new ConvergeExecutor().execute({
    planRunId: planRun.id, currentSpecRevision: params.specRevision,
    handler: async (action) => {
      try {
        if (action.id === 'build:image') {
          const built = await buildWithAcrTasks(context.tokens, { registryId: context.shared.registryId, loginServer: context.shared.registryLoginServer, source });
          if ('error' in built) {
            results.push({ service: 'image', status: built.unknown ? 'unknown' : 'failed', message: built.error, ...(built.logsUrl ? { buildLogsUrl: built.logsUrl } : {}) });
            return { success: false, ...(built.unknown ? { status: 'pending' as const } : {}), message: built.error, error: built.error };
          }
          image = built.image;
          // Recorded before any workload switches, so the engine creates new workloads from this image.
          const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
          ctx.repos.environments.updatePlatformBindings(current.id, { azure: { ...azureBinding(current), kind: 'opentofu', image, imageCommit: source.commitSha } });
          if (firstImage) {
            results.push({ service: 'image', status: 'released', imageUri: image, ...(built.logsUrl ? { buildLogsUrl: built.logsUrl } : {}),
              message: 'Built the first image. Run hv_plan scope="infrastructure" and hv_apply to create the workloads from it.' });
          }
          return { success: true, message: `Built ${image}.`, data: { imageUri: image } };
        }
        const name = action.resource.name;
        const kind = String(action.metadata?.workloadKind);
        const id = String(action.metadata?.resource);
        const result = kind === 'cron'
          ? await releaseAzureJob(context.tokens, { id, name, image: image! })
          : await releaseAzureApp(context.tokens, { id, name, image: image!, web: kind === 'web', ...(environmentSpec.services[name]!.healthCheckPath ? { healthCheckPath: environmentSpec.services[name]!.healthCheckPath } : {}) });
        results.push(result);
        const data = { ...(result.imageUri ? { imageUri: result.imageUri } : {}), ...(result.url ? { url: result.url } : {}) };
        if (result.status === 'released') return { success: true, message: result.message, data };
        return { success: false, ...(result.status === 'unknown' ? { status: 'pending' as const } : {}), message: result.message, error: result.message, data };
      } catch (error) {
        const message = `Azure rejected the release step: ${error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error)}`;
        results.push({ service: action.resource.name, status: 'unknown', message });
        return { success: false, status: 'pending', message, error: message };
      }
    },
  });
  if (!execution.applyRunId) return { blocked: execution.error ?? 'The release could not start.' };
  for (const name of firstImage ? ['image'] : selected) {
    if (!results.some((result) => result.service === name)) {
      results.push({ service: name, status: 'failed', message: `${name} was not released because an earlier step did not finish. ${execution.error ?? ''}`.trim() });
    }
  }
  return { results, applyRunId: execution.applyRunId,
    source: { kind: 'local-commit', revision: source.commitSha, commitSha: source.commitSha, ...(source.uncommittedChangesExcluded ? { uncommittedChangesExcluded: true } : {}) } };
}
