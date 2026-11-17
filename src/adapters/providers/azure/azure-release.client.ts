import { healthCheckFailed } from '../../../domain/services/release-health.js';
import { azureBuildTaskContent } from './azure-build-task.js';
import type { EngineReleaseResult } from '../../../domain/ports/infrastructure-engine.port.js';
import { generatedContainerDockerfile } from '../../../domain/services/generated-container.js';
import type { ProjectRuntime } from '../../../domain/spec/project-runtime.js';
import { ARM, AZURE_SCOPES, azureError, azureRest, type AzureTokenProvider } from './azure-ops.client.js';

/**
 * Azure calls a release makes: build an image with ACR Tasks, then point a
 * Container App or job at it. Orchestration, receipts and bindings stay in the
 * application layer; this module only talks to Azure.
 */
/** One packaged commit: its SHA and the tar.gz source archive to build. */
export interface AzureBuildSource { commitSha: string; archive: Buffer }

/** The one image repository of a project's registry; every environment's workloads run from it. */
export const AZURE_IMAGE_REPOSITORY = 'app';
export const AZURE_DOCKERFILE = '.hypervibe-azure.Dockerfile';
const TASKS_API = 'api-version=2019-06-01-preview';
export const APPS_API = 'api-version=2024-03-01';

/** The repository's Dockerfile, or the generated one; Container Apps need nothing added. */
export function azureReleaseDockerfile(params: { repositoryDockerfile?: string; runtime?: ProjectRuntime; startCommand?: string }): string {
  if (params.repositoryDockerfile) return params.repositoryDockerfile;
  return generatedContainerDockerfile(params.runtime ?? (() => { throw new Error('No repository Dockerfile and no project runtime: run hv_spec to review the runtime.'); })(), params.startCommand);
}

/**
 * Builds a commit with ACR Tasks (no local Docker): upload the archive to the
 * registry's build-source blob, schedule a Docker build, wait, and return the
 * digest-pinned image from the run's output.
 */
export async function buildWithAcrTasks(tokens: AzureTokenProvider, params: { registryId: string; loginServer: string; source: AzureBuildSource; taskId?: string; pollMs?: number; timeoutMs?: number; deadlineMs?: number }): Promise<{ image: string; logsUrl?: string } | { error: string; unknown?: boolean; logsUrl?: string }> {
  if (params.deadlineMs && Date.now() >= params.deadlineMs) return { error: 'The release deadline elapsed before the build started.' };
  const registry = `${ARM}${params.registryId}`;
  const upload = await azureRest(tokens, AZURE_SCOPES.arm, 'POST', `${registry}/listBuildSourceUploadUrl?${TASKS_API}`);
  if (upload.status !== 200 || typeof upload.body.uploadUrl !== 'string') return { error: `ACR did not give an upload address (${azureError(upload)}).` };
  const put = await tokens.fetchImpl(upload.body.uploadUrl, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/gzip' }, body: new Uint8Array(params.source.archive), signal: AbortSignal.timeout(Math.max(1, Math.min(10 * 60_000, (params.deadlineMs ?? Date.now() + 10 * 60_000) - Date.now()))) });
  await put.body?.cancel();
  if (put.status !== 201) return { error: `Uploading the source to ACR failed (HTTP ${put.status}).` };
  const values = [{ name: 'IMAGE_TAG', value: params.source.commitSha, isSecret: false }];
  const request = params.taskId ? {
    type: 'TaskRunRequest', taskId: params.taskId,
    overrideTaskStepProperties: { contextPath: upload.body.relativePath, values },
  } : {
    type: 'EncodedTaskRunRequest', encodedTaskContent: Buffer.from(azureBuildTaskContent()).toString('base64'), values,
    sourceLocation: upload.body.relativePath, platform: { os: 'Linux', architecture: 'amd64' }, agentConfiguration: { cpu: 2 }, timeout: 3600,
  };
  if (params.deadlineMs && Date.now() >= params.deadlineMs) return { error: 'The release deadline elapsed after uploading source; no build was started.' };
  const scheduled = await azureRest(tokens, AZURE_SCOPES.arm, 'POST', `${registry}/scheduleRun?${TASKS_API}`, request);
  const runId = (scheduled.body.properties as { runId?: string } | undefined)?.runId ?? (scheduled.body.name as string | undefined);
  if (![200, 201, 202].includes(scheduled.status) || !runId) {
    const code = (scheduled.body.error as { code?: string } | undefined)?.code;
    return { error: code === 'TasksOperationsNotAllowed'
      ? 'Microsoft pauses ACR Tasks on free-credit (trial or student) subscriptions. Upgrade the subscription to pay-as-you-go in the Azure portal, then deploy again.'
      : `ACR did not start the build (${azureError(scheduled)}).` };
  }
  // A portal link, never the signed log URL (anyone holding that can read the log).
  const logsUrl = `https://portal.azure.com/#resource${params.registryId}/runs`;
  const deadline = params.deadlineMs ?? Date.now() + (params.timeoutMs ?? 35 * 60_000);
  for (;;) {
    const run = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${registry}/runs/${runId}?${TASKS_API}`).catch(() => undefined);
    const properties = (run?.body.properties ?? {}) as { status?: string; outputImages?: Array<{ repository?: string; tag?: string; digest?: string }> };
    if (properties.status === 'Succeeded') {
      const digest = properties.outputImages?.find((image) => image.repository === AZURE_IMAGE_REPOSITORY)?.digest;
      if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) return { error: 'The build finished without an image digest; refusing to release a mutable tag.', ...(logsUrl ? { logsUrl } : {}) };
      return { image: `${params.loginServer}/${AZURE_IMAGE_REPOSITORY}@${digest}`, ...(logsUrl ? { logsUrl } : {}) };
    }
    if (properties.status && ['Failed', 'Canceled', 'Error', 'Timeout'].includes(properties.status)) {
      return { error: `The image build (ACR run ${runId}) ${properties.status.toLowerCase()}; see its log.`, logsUrl };
    }
    if (Date.now() > deadline) return { error: 'The image build is still running.', unknown: true, ...(logsUrl ? { logsUrl } : {}) };
    await new Promise((done) => setTimeout(done, params.pollMs ?? 10_000));
  }
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

async function waitForApp(tokens: AzureTokenProvider, id: string, previousRevision: string | undefined, deadline: number): Promise<Record<string, unknown> | undefined> {
  for (;;) {
    const app = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${id}?${APPS_API}`);
    const properties = (app.body.properties ?? {}) as { provisioningState?: string; latestRevisionName?: string };
    if (app.status === 200 && properties.provisioningState === 'Succeeded' && properties.latestRevisionName !== previousRevision) return app.body;
    if (properties.provisioningState === 'Failed' || Date.now() > deadline) return undefined;
    await new Promise((done) => setTimeout(done, 5000));
  }
}

export function runsImage(template: Record<string, unknown> | undefined, image: string): boolean {
  return ((template?.containers ?? []) as Array<{ name?: string; image?: string }>).some((container) => container.name === 'app' && container.image === image);
}

/** Swaps the image in a Container App or job template; only the running image changes, so the engine sees no drift. */
export function templateWithImage(template: Record<string, unknown>, image: string): Record<string, unknown> {
  const { revisionSuffix: _suffix, ...rest } = template as { revisionSuffix?: string; containers?: Array<Record<string, unknown>> };
  return { ...rest, containers: ((template.containers ?? []) as Array<Record<string, unknown>>).map((container) => container.name === 'app' ? { ...container, image } : container) };
}

export async function releaseAzureApp(tokens: AzureTokenProvider, params: { id: string; name: string; image: string; healthCheckPath?: string; strictHealth?: boolean; web: boolean; fetchTimeoutMs?: number; waitMs?: number; retryMs?: number; requireExactIdentity?: boolean }): Promise<EngineReleaseResult> {
  const current = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${params.id}?${APPS_API}`);
  if (current.status === 404) return { service: params.name, status: 'failed', message: `${params.name} does not exist yet. Run hv_plan scope="infrastructure" and hv_apply.` };
  if (current.status !== 200) return { service: params.name, status: 'unknown', message: `${params.name} could not be read (${azureError(current)}).` };
  if (params.requireExactIdentity && (typeof current.body.id !== 'string' || current.body.id.toLowerCase() !== params.id.toLowerCase())) return { service: params.name, status: 'unknown', message: 'Azure did not confirm the exact current workload identity.' };
  const properties = current.body.properties as { template: Record<string, unknown>; latestRevisionName?: string; provisioningState?: string };
  // Already running this image (for example right after the apply that created it): Azure makes no new revision, so only check it.
  const running = runsImage(properties.template, params.image) && properties.provisioningState === 'Succeeded';
  let app: Record<string, unknown> | undefined = current.body;
  if (!running) {
    if (typeof current.body.location !== 'string' || !current.body.location) return { service: params.name, status: 'unknown', message: 'Azure did not return the existing app location required for an update.' };
    const patched = await azureRest(tokens, AZURE_SCOPES.arm, 'PATCH', `${ARM}${params.id}?${APPS_API}`, { location: current.body.location, properties: { template: templateWithImage(properties.template, params.image) } });
    if (![200, 201, 202].includes(patched.status)) return { service: params.name, imageUri: params.image, status: 'failed', message: `Azure rejected the release (${azureError(patched)}).` };
    app = await waitForApp(tokens, params.id, properties.latestRevisionName, Date.now() + (params.waitMs ?? 10 * 60_000));
  }
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
  if (healthCheckFailed(status, params.strictHealth === true)) return { ...result, status: 'failed', message: `The new release is serving, but ${path} returned HTTP ${status}. Check hv_logs.` };
  return result;
}

export async function releaseAzureJob(tokens: AzureTokenProvider, params: { id: string; name: string; image: string; requireExactIdentity?: boolean }): Promise<EngineReleaseResult> {
  const current = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${params.id}?${APPS_API}`);
  if (current.status === 404) return { service: params.name, status: 'failed', message: `${params.name} does not exist yet. Run hv_plan scope="infrastructure" and hv_apply.` };
  if (current.status !== 200) return { service: params.name, status: 'unknown', message: `${params.name} could not be read (${azureError(current)}).` };
  if (params.requireExactIdentity && (typeof current.body.id !== 'string' || current.body.id.toLowerCase() !== params.id.toLowerCase())) return { service: params.name, status: 'unknown', message: 'Azure did not confirm the exact current job identity.' };
  const template = (current.body.properties as { template: Record<string, unknown> }).template;
  if (runsImage(template, params.image)) return { service: params.name, imageUri: params.image, status: 'released', message: `Scheduled job ${params.name} already runs this image.` };
  const patched = await azureRest(tokens, AZURE_SCOPES.arm, 'PATCH', `${ARM}${params.id}?${APPS_API}`, { properties: { template: templateWithImage(template, params.image) } });
  if (![200, 201, 202].includes(patched.status)) return { service: params.name, imageUri: params.image, status: 'failed', message: `Azure rejected the release (${azureError(patched)}).` };
  return { service: params.name, imageUri: params.image, status: 'released', message: `Released to scheduled job ${params.name}; its next run uses it.` };
}
