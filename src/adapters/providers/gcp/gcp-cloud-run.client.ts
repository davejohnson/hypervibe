import type { EngineReleaseResult } from '../../../domain/ports/infrastructure-engine.port.js';
import { fetchWithRetry } from '../../../utils/fetch-retry.js';

/**
 * Cloud Run calls the engine makes beside OpenTofu: reading a workload,
 * switching its image, and running a job. Each write changes only the image and
 * is guarded by the resource's etag, so a concurrent change is never overwritten.
 */
const API = 'https://run.googleapis.com/v2';

export interface CloudRunTarget { gcpProjectId: string; region: string }
export type WorkloadKind = 'services' | 'jobs' | 'workerPools';

/** Present, absent or unknown: only a confirmed 404 is absence. */
export type CloudRunObservation<T> = { state: 'present'; value: T } | { state: 'absent' } | { state: 'unknown'; reason: string };

/** The single container of a service, or of a job's task template. */
export function workloadContainers(kind: WorkloadKind, value: Record<string, any>): Array<Record<string, any>> {
  const containers = kind === 'jobs' ? value.template?.template?.containers : value.template?.containers;
  return Array.isArray(containers) ? containers : [];
}

export async function cloudRunGet(token: string, gcpProjectId: string, region: string, name: string, kind: WorkloadKind = 'services'): Promise<CloudRunObservation<Record<string, any>>> {
  const response = await fetchWithRetry(`${API}/projects/${gcpProjectId}/locations/${region}/${kind}/${name}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return { state: 'absent' };
  if (!response.ok) return { state: 'unknown', reason: `Cloud Run returned HTTP ${response.status} for ${name}.` };
  return { state: 'present', value: await response.json() as Record<string, any> };
}

/** Google's error message (never request content), bounded for display. */
export async function googleErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return (body.error?.message ?? 'no details').slice(0, 300);
  } catch {
    return 'no details';
  }
}

/** Image-only, etag-guarded update of a scheduled job's task template; the next scheduled run uses it. */
export async function releaseJobImage(token: string, target: CloudRunTarget, resource: string, imageUri: string): Promise<Pick<EngineReleaseResult, 'status' | 'message' | 'url'>> {
  const url = `${API}/projects/${target.gcpProjectId}/locations/${target.region}/jobs/${resource}`;
  const observed = await cloudRunGet(token, target.gcpProjectId, target.region, resource, 'jobs');
  if (observed.state !== 'present') return { status: 'failed', message: observed.state === 'absent' ? `Job ${resource} does not exist.` : observed.reason };
  const containers = workloadContainers('jobs', observed.value).map((container) => ({ ...container }));
  if (containers.length !== 1) return { status: 'failed', message: `Job ${resource} must have exactly one container for an image release.` };
  containers[0]!.image = imageUri;
  // Jobs have no update mask: send the observed job back unchanged except for the image.
  // The etag still makes a concurrent change fail this release instead of being overwritten.
  const job = observed.value;
  const body = { ...job, template: { ...job.template, template: { ...job.template?.template, containers } } };
  const patch = await fetchWithRetry(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (patch.status === 409 || patch.status === 412) return { status: 'failed', message: `Job ${resource} changed while releasing. Nothing was overwritten; retry hv_deploy.` };
  if (!patch.ok) return { status: 'failed', message: `Cloud Run rejected the job image release (HTTP ${patch.status}): ${await googleErrorMessage(patch)}` };
  let operation = await patch.json() as { name?: string; done?: boolean; error?: { message?: string } };
  for (let attempt = 0; attempt < 100 && !operation.done && operation.name; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const polled = await readCloudRunOperation(token, operation.name);
    if (polled.ok) operation = await polled.json() as typeof operation;
  }
  if (!operation.done) return { status: 'unknown', message: `The job release for ${resource} did not finish in time.` };
  if (operation.error) return { status: 'failed', message: `Cloud Run could not update job ${resource}: ${operation.error.message ?? 'unknown error'}` };
  const after = await cloudRunGet(token, target.gcpProjectId, target.region, resource, 'jobs');
  if (after.state !== 'present' || workloadContainers('jobs', after.value)[0]?.image !== imageUri) {
    return { status: 'unknown', message: `Job ${resource} did not report the new image.` };
  }
  return { status: 'released', message: `Released ${imageUri.split('@')[0]} to scheduled job ${resource}; its next run uses it.` };
}

export async function releaseImage(token: string, target: CloudRunTarget, resource: string, imageUri: string, kind: WorkloadKind = 'services'): Promise<Pick<EngineReleaseResult, 'status' | 'message' | 'url'>> {
  if (kind === 'jobs') return releaseJobImage(token, target, resource, imageUri);
  // Services and worker pools share the template shape and the masked image PATCH.
  const url = `${API}/projects/${target.gcpProjectId}/locations/${target.region}/${kind}/${resource}`;
  const observed = await cloudRunGet(token, target.gcpProjectId, target.region, resource, kind);
  if (observed.state !== 'present') {
    return { status: 'failed', message: observed.state === 'absent' ? `Service ${resource} does not exist. Re-run hv_plan scope="infrastructure".` : observed.reason };
  }
  const current = observed.value;
  const containers = Array.isArray(current.template?.containers) ? current.template.containers.map((c: Record<string, unknown>) => ({ ...c })) : [];
  if (containers.length !== 1) return { status: 'failed', message: `Service ${resource} must have exactly one container for an image release.` };
  containers[0].image = imageUri;
  // Only the image changes; every other field is sent back exactly as observed.
  const patch = await fetchWithRetry(`${url}?updateMask=template.containers`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ etag: current.etag, template: { containers } }),
  });
  if (patch.status === 409 || patch.status === 412) {
    return { status: 'failed', message: `Service ${resource} changed while releasing (concurrent update). Nothing was overwritten; retry hv_deploy.` };
  }
  if (!patch.ok) return { status: 'failed', message: `Cloud Run rejected the image release (HTTP ${patch.status}): ${await googleErrorMessage(patch)}` };
  const operation = await patch.json() as { name?: string; done?: boolean; error?: { message?: string } };
  const deadline = Date.now() + 10 * 60 * 1000;
  let done = operation.done === true;
  let error = operation.error;
  while (!done && operation.name && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const polled = await readCloudRunOperation(token, operation.name);
    if (!polled.ok) continue;
    const body = await polled.json() as { done?: boolean; error?: { message?: string } };
    done = body.done === true;
    error = body.error;
  }
  if (!done) return { status: 'unknown', message: `The release of ${resource} did not finish in time. Check hv_status before retrying.` };
  if (error) return { status: 'failed', message: `Cloud Run could not roll out the new image: ${error.message ?? 'unknown error'}` };
  const after = await cloudRunGet(token, target.gcpProjectId, target.region, resource, kind);
  if (after.state !== 'present') return { status: 'unknown', message: 'The release finished but the service could not be observed.' };
  const running = after.value.template?.containers?.[0]?.image;
  const ready = after.value.terminalCondition?.state === 'CONDITION_SUCCEEDED' && after.value.latestReadyRevision === after.value.latestCreatedRevision;
  if (running !== imageUri || !ready) return { status: 'unknown', message: 'The service did not report the new image as ready.' };
  return { status: 'released', message: `Released ${imageUri.split('@')[0]} to ${resource}.`, ...(typeof after.value.uri === 'string' ? { url: after.value.uri } : {}) };
}

/** Starts one execution of a job. Attempted once: a thrown error means the outcome is unknown. */
export function startCloudRunJob(token: string, target: CloudRunTarget, job: string): Promise<Response> {
  return fetch(`${API}/projects/${target.gcpProjectId}/locations/${target.region}/jobs/${job}:run`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
}

/** Reads a long-running operation by its full name. */
export function readCloudRunOperation(token: string, operationName: string): Promise<Response> {
  return fetchWithRetry(`${API}/${operationName}`, { headers: { Authorization: `Bearer ${token}` } });
}

/** The most recent run of an on-demand worker's waker workflow. */
export function latestWakerExecution(token: string, target: CloudRunTarget, workerPool: string): Promise<Response> {
  return fetchWithRetry(`https://workflowexecutions.googleapis.com/v1/projects/${target.gcpProjectId}/locations/${target.region}/workflows/${workerPool}-waker/executions?pageSize=1&view=FULL`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** One request against a project's jobs collection: create (`?jobId=`), run (`/<id>:run`) or delete (`/<id>`). */
export function cloudRunJobRequest(token: string, target: CloudRunTarget, suffix: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(`${API}/projects/${target.gcpProjectId}/locations/${target.region}/jobs${suffix}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}
