/** Read-only inventory of a Google project, and the one call that deletes it. Used only by project removal. */
type Read = { state: 'known'; names: string[] } | { state: 'off' } | { state: 'unknown'; reason: string };
interface Kind { label: string; url: (project: string) => string; key: string; name: (entry: Record<string, unknown>) => unknown; ignore?: true }

const metadataName = (entry: Record<string, unknown>) => (entry.metadata as { name?: unknown } | undefined)?.name;
const lastSegment = (entry: Record<string, unknown>) => typeof entry.name === 'string' ? entry.name.split('/').at(-1) : undefined;
/**
 * What costs money or holds data in an environment, plus keys that websites outside
 * Hypervibe may depend on. Not listed: schedules, workflows, container images,
 * regional secrets, Google sign-in clients and anything else Google offers.
 */
const KINDS: Kind[] = [
  { label: 'Cloud Run services', url: (p) => `https://run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${p}/services`, key: 'items', name: metadataName },
  { label: 'Cloud Run jobs', url: (p) => `https://run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${p}/jobs`, key: 'items', name: metadataName },
  { label: 'Cloud Run worker pools', url: (p) => `https://run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${p}/workerpools`, key: 'items', name: metadataName },
  { label: 'databases', url: (p) => `https://sqladmin.googleapis.com/v1/projects/${p}/instances`, key: 'items', name: (entry) => entry.name },
  { label: 'storage buckets', url: (p) => `https://storage.googleapis.com/storage/v1/b?project=${p}`, key: 'items', name: (entry) => entry.name, ignore: true },
  { label: 'secrets', url: (p) => `https://secretmanager.googleapis.com/v1/projects/${p}/secrets`, key: 'secrets', name: lastSegment },
  { label: 'Redis caches', url: (p) => `https://redis.googleapis.com/v1/projects/${p}/locations/-/instances`, key: 'instances', name: lastSegment },
  { label: 'queues', url: (p) => `https://pubsub.googleapis.com/v1/projects/${p}/topics`, key: 'topics', name: lastSegment },
  { label: 'queue subscriptions', url: (p) => `https://pubsub.googleapis.com/v1/projects/${p}/subscriptions`, key: 'subscriptions', name: lastSegment },
  { label: 'reCAPTCHA keys', url: (p) => `https://recaptchaenterprise.googleapis.com/v1/projects/${p}/keys`, key: 'keys', name: (entry) => entry.displayName ?? lastSegment(entry) },
  { label: 'API keys', url: (p) => `https://apikeys.googleapis.com/v2/projects/${p}/locations/global/keys`, key: 'keys', name: (entry) => entry.displayName ?? lastSegment(entry) },
];
export const GCP_PROJECT_REMOVAL_CHECKED = KINDS.map((kind) => kind.label);

/**
 * One kind of resource in the project. A switched-off API cannot be listed, which
 * is reported as `off`, not as empty: resources can outlive the API being turned
 * off. Any other failed, partial or oddly shaped answer is unknown.
 */
async function readKind(fetchImpl: typeof fetch, token: string, gcpProjectId: string, kind: Kind, ownBucket: string): Promise<Read> {
  let response: Response;
  try {
    response = await fetchImpl(kind.url(gcpProjectId), { headers: { Authorization: `Bearer ${token}`, 'x-goog-user-project': gcpProjectId } });
  } catch { return { state: 'unknown', reason: `Google did not answer when listing ${kind.label}.` }; }
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (response.status === 403) {
    const details = ((body?.error as { details?: Array<{ reason?: string }> } | undefined)?.details ?? []);
    if (details.some((detail) => detail.reason === 'SERVICE_DISABLED')) return { state: 'off' };
  }
  if (!response.ok || !body) return { state: 'unknown', reason: `Listing ${kind.label} returned HTTP ${response.status}.` };
  const entries = body[kind.key] ?? [];
  if (!Array.isArray(entries)) return { state: 'unknown', reason: `Google's list of ${kind.label} was not readable.` };
  const listed = entries.map((entry) => kind.name(entry as Record<string, unknown>));
  if (listed.some((name) => typeof name !== 'string' || !name)) return { state: 'unknown', reason: `Google listed ${kind.label} without a name.` };
  const names = (listed as string[]).filter((name) => !(kind.ignore && name === ownBucket));
  // One name is enough to refuse. Nothing found counts as empty only when Google says the list is whole.
  const metadata = body.metadata as { unreachable?: unknown; continue?: unknown } | undefined;
  const partial = [body.unreachable, metadata?.unreachable, body.warnings].some((value) => Array.isArray(value) && value.length) || body.nextPageToken || metadata?.continue;
  if (!names.length && partial) return { state: 'unknown', reason: `Google's list of ${kind.label} was incomplete.` };
  return { state: 'known', names };
}

/** What is still in the project, by kind. `ownBucket`, the build bucket Hypervibe's own setup created, is not counted. */
export async function readGcpProjectContents(fetchImpl: typeof fetch, token: string, gcpProjectId: string, ownBucket: string): Promise<{ state: 'known'; found: string[]; notChecked: string[] } | { state: 'unknown'; reason: string }> {
  const found: string[] = []; const notChecked: string[] = [];
  for (const kind of KINDS) {
    const read = await readKind(fetchImpl, token, gcpProjectId, kind, ownBucket);
    if (read.state === 'unknown') return read;
    if (read.state === 'off') { notChecked.push(kind.label); continue; }
    if (read.names.length) found.push(`${kind.label}: ${read.names.slice(0, 10).join(', ')}${read.names.length > 10 ? ` and ${read.names.length - 10} more` : ''}`);
  }
  return { state: 'known', found, notChecked };
}

export type GcpProjectLifecycle = { state: 'active' | 'deleting'; projectNumber: string } | { state: 'unknown'; reason: string };
export async function readGcpProjectLifecycle(fetchImpl: typeof fetch, token: string, gcpProjectId: string): Promise<GcpProjectLifecycle> {
  try {
    const response = await fetchImpl(`https://cloudresourcemanager.googleapis.com/v3/projects/${gcpProjectId}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => undefined) as { name?: unknown; projectId?: unknown; state?: unknown } | undefined;
    const number = typeof body?.name === 'string' ? /^projects\/([1-9]\d*)$/.exec(body.name)?.[1] : undefined;
    if (!response.ok || !number || body?.projectId !== gcpProjectId) return { state: 'unknown', reason: `Reading Google project ${gcpProjectId} returned HTTP ${response.status}.` };
    if (body.state === 'ACTIVE') return { state: 'active', projectNumber: number };
    if (body.state === 'DELETE_REQUESTED') return { state: 'deleting', projectNumber: number };
    return { state: 'unknown', reason: `Google project ${gcpProjectId} is in an unexpected state.` };
  } catch { return { state: 'unknown', reason: `Google did not answer when reading project ${gcpProjectId}.` }; }
}


/** Asks Google to delete the project. Returns the HTTP status, or undefined when no answer arrived; neither proves the outcome. */
export async function requestGcpProjectDeletion(fetchImpl: typeof fetch, token: string, gcpProjectId: string): Promise<number | undefined> {
  try {
    return (await fetchImpl(`https://cloudresourcemanager.googleapis.com/v3/projects/${gcpProjectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status;
  } catch { return undefined; }
}
