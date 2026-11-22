import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { engineStatePaths } from '../../adapters/engine/opentofu/workspace.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { getDataDir } from '../../adapters/storage/paths.js';
import type { Project } from '../entities/project.entity.js';
import { buildSourceBucketName, getDefaultAdminAccessToken } from './cloud-prepare.execute.js';
import { GCP_PROJECT_ID_PATTERN } from './gcp-environment-target.js';
import { readGcpBootstrappedProject } from './gcp-project-setup.service.js';

export interface GcpProjectRemovalDependencies {
  getDefaultAdminAccessToken: () => Promise<string>;
  fetch: typeof fetch;
  readCreatedProject: typeof readGcpBootstrappedProject;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  dataDir?: string;
}

export interface GcpProjectRemovalResult {
  success: boolean;
  mode: 'preview' | 'confirm';
  /** `blocked`: nothing was deleted. `pending`: a deletion was sent and its outcome could not be read. */
  status?: 'blocked' | 'pending';
  error?: string;
  message?: string;
  gcpProjectId?: string;
  projectNumber?: string;
  previewId?: string;
  /** What the check looked for in the project. Anything else in the project is not checked. */
  checked?: string[];
  /** What still exists in the project and stops the removal. */
  found?: string[];
  warnings?: string[];
  removedConnections?: string[];
}

type Read = { state: 'known'; names: string[] } | { state: 'unknown'; reason: string };
interface Kind { label: string; url: (project: string) => string; key: string; name: (entry: Record<string, unknown>) => unknown }

const metadataName = (entry: Record<string, unknown>) => (entry.metadata as { name?: unknown } | undefined)?.name;
const lastSegment = (entry: Record<string, unknown>) => typeof entry.name === 'string' ? entry.name.split('/').at(-1) : undefined;
/** Everything an environment can hold, plus keys that websites outside Hypervibe may depend on. */
const KINDS: Kind[] = [
  { label: 'Cloud Run services', url: (p) => `https://run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${p}/services`, key: 'items', name: metadataName },
  { label: 'Cloud Run jobs', url: (p) => `https://run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${p}/jobs`, key: 'items', name: metadataName },
  { label: 'Cloud Run worker pools', url: (p) => `https://run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${p}/workerpools`, key: 'items', name: metadataName },
  { label: 'databases', url: (p) => `https://sqladmin.googleapis.com/v1/projects/${p}/instances`, key: 'items', name: (entry) => entry.name },
  { label: 'storage buckets', url: (p) => `https://storage.googleapis.com/storage/v1/b?project=${p}`, key: 'items', name: (entry) => entry.name },
  { label: 'secrets', url: (p) => `https://secretmanager.googleapis.com/v1/projects/${p}/secrets`, key: 'secrets', name: lastSegment },
  { label: 'Redis caches', url: (p) => `https://redis.googleapis.com/v1/projects/${p}/locations/-/instances`, key: 'instances', name: lastSegment },
  { label: 'queues', url: (p) => `https://pubsub.googleapis.com/v1/projects/${p}/topics`, key: 'topics', name: lastSegment },
  { label: 'reCAPTCHA keys', url: (p) => `https://recaptchaenterprise.googleapis.com/v1/projects/${p}/keys`, key: 'keys', name: (entry) => entry.displayName ?? lastSegment(entry) },
  { label: 'API keys', url: (p) => `https://apikeys.googleapis.com/v2/projects/${p}/locations/global/keys`, key: 'keys', name: (entry) => entry.displayName ?? lastSegment(entry) },
];
export const GCP_PROJECT_REMOVAL_CHECKED = KINDS.map((kind) => kind.label);
const PREVIEW_MINUTES = 10;

/**
 * One kind of resource in the project. An API that was never switched on holds
 * nothing. Any other failed, partial or oddly shaped answer is unknown, never empty.
 */
async function readKind(fetchImpl: typeof fetch, token: string, gcpProjectId: string, kind: Kind): Promise<Read> {
  let response: Response;
  try {
    response = await fetchImpl(kind.url(gcpProjectId), { headers: { Authorization: `Bearer ${token}`, 'x-goog-user-project': gcpProjectId } });
  } catch { return { state: 'unknown', reason: `Google did not answer when listing ${kind.label}.` }; }
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (response.status === 403) {
    const details = ((body?.error as { details?: Array<{ reason?: string }> } | undefined)?.details ?? []);
    if (details.some((detail) => detail.reason === 'SERVICE_DISABLED')) return { state: 'known', names: [] };
  }
  if (!response.ok || !body) return { state: 'unknown', reason: `Listing ${kind.label} returned HTTP ${response.status}.` };
  const entries = body[kind.key] ?? [];
  const unreachable = body.unreachable ?? (body.metadata as { unreachable?: unknown } | undefined)?.unreachable;
  if (!Array.isArray(entries) || (Array.isArray(unreachable) && unreachable.length)) return { state: 'unknown', reason: `Google's list of ${kind.label} was incomplete.` };
  const names = entries.map((entry) => kind.name(entry as Record<string, unknown>));
  if (names.some((name) => typeof name !== 'string' || !name)) return { state: 'unknown', reason: `Google listed ${kind.label} without a name.` };
  if (!names.length && (body.nextPageToken || (body.metadata as { continue?: unknown } | undefined)?.continue)) return { state: 'unknown', reason: `Google's list of ${kind.label} was incomplete.` };
  return { state: 'known', names: names as string[] };
}

/** What is still in the project, by kind. The build bucket Hypervibe's own setup created is not counted. */
export async function readGcpProjectContents(fetchImpl: typeof fetch, token: string, gcpProjectId: string): Promise<{ state: 'known'; found: string[] } | { state: 'unknown'; reason: string }> {
  const found: string[] = [];
  for (const kind of KINDS) {
    const read = await readKind(fetchImpl, token, gcpProjectId, kind);
    if (read.state === 'unknown') return read;
    const names = kind.label === 'storage buckets' ? read.names.filter((name) => name !== buildSourceBucketName(gcpProjectId)) : read.names;
    if (names.length) found.push(`${kind.label}: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ` and ${names.length - 10} more` : ''}`);
  }
  return { state: 'known', found };
}

type ProjectRead = { state: 'active' | 'deleting'; projectNumber: string } | { state: 'unknown'; reason: string };
async function readProject(fetchImpl: typeof fetch, token: string, gcpProjectId: string): Promise<ProjectRead> {
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

const environmentRepo = new EnvironmentRepository();
const projectRepo = new ProjectRepository();
const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Environments Hypervibe still records as running in the Google project, in any Hypervibe project. */
function recordedEnvironments(gcpProjectId: string): string[] {
  return projectRepo.findAll().flatMap((project) => environmentRepo.findByProjectId(project.id)
    .filter((environment) => {
      const bindings = asRecord(environment.platformBindings);
      const engine = asRecord(bindings.engine);
      // Empty lists and settings left behind by an environment that was emptied do not count; Google's own answer below is the proof.
      const holds = (value: unknown) => Array.isArray(value) ? value.length > 0 : Boolean(value && typeof value === 'object' && Object.keys(value).length);
      return bindings.projectId === gcpProjectId
        && (holds(bindings.services) || ['database', 'cache', 'storage', 'queues', 'secrets', 'releaseJob'].some((key) => typeof engine[key] === 'string' ? Boolean(engine[key]) : holds(engine[key])));
    }).map((environment) => `${project.name}/${environment.name}`));
}

/** After Google accepts the deletion: the keys, the setup record and the saved state for the project are of no further use. */
function forgetProject(project: Project, gcpProjectId: string, dataDir: string, now: number): string[] {
  const removed: string[] = [];
  for (const provider of ['cloudrun', 'cloudsql']) {
    for (const connection of connectionRepo.findAllByProvider(provider)) {
      let target: unknown;
      try { target = getSecretStore().decryptObject<{ projectId?: string }>(connection.credentialsEncrypted).projectId; } catch { continue; }
      if (target !== gcpProjectId || !connectionRepo.delete(connection.id)) continue;
      removed.push(`${provider} (${connection.scope ?? 'global'})`);
      auditRepo.create({ action: 'connection.deleted', resourceType: 'connection', resourceId: connection.id, details: { provider, scope: connection.scope ?? null, reason: 'gcp-project-removed' } });
    }
  }
  for (const other of projectRepo.findAll()) {
    const policies = asRecord(other.policies);
    const legacy = asRecord(policies.cloudPreparation); const perProject = asRecord(policies.gcpProjectPreparations);
    if (asRecord(legacy.cloudrun).gcpProjectId !== gcpProjectId && !(gcpProjectId in perProject)) continue;
    projectRepo.updatePolicies(other.id, (current) => {
      const next = { ...asRecord(current.policies) };
      const currentLegacy = { ...asRecord(next.cloudPreparation) };
      if (asRecord(currentLegacy.cloudrun).gcpProjectId === gcpProjectId) { delete currentLegacy.cloudrun; next.cloudPreparation = currentLegacy; }
      const currentPerProject = { ...asRecord(next.gcpProjectPreparations) };
      if (gcpProjectId in currentPerProject) { delete currentPerProject[gcpProjectId]; next.gcpProjectPreparations = currentPerProject; }
      return next as Project['policies'];
    });
  }
  // Kept, not deleted: Google can restore the project for 30 days, and the state is what would manage it again.
  const root = engineStatePaths({ provider: 'gcp', projectId: project.id, environmentId: gcpProjectId, partition: 'project-shared' }, dataDir).root;
  if (fs.existsSync(root)) fs.renameSync(root, `${root}.removed-${now}`);
  return removed;
}

const defaultDependencies: GcpProjectRemovalDependencies = {
  getDefaultAdminAccessToken, fetch: (...args) => globalThis.fetch(...args), readCreatedProject: readGcpBootstrappedProject, now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * Deletes a Google project that this Hypervibe project's own setup created, once
 * nothing is left in it. Preview first; confirming needs that preview's id, and
 * every check is made again against Google before the one delete call.
 */
export async function runGcpProjectRemoval(
  params: { project: Project; gcpProjectId?: string; previewId?: string; confirm?: boolean },
  overrides: Partial<GcpProjectRemovalDependencies> = {},
): Promise<GcpProjectRemovalResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const dataDir = deps.dataDir ?? getDataDir();
  const mode = params.confirm === true ? 'confirm' : 'preview';
  const gcpProjectId = params.gcpProjectId?.trim() ?? '';
  const blocked = (error: string, extra: Partial<GcpProjectRemovalResult> = {}): GcpProjectRemovalResult =>
    ({ success: false, mode, status: 'blocked', error, ...(gcpProjectId ? { gcpProjectId } : {}), ...extra });
  if (!GCP_PROJECT_ID_PATTERN.test(gcpProjectId)) return blocked('Give the exact Google project id to remove as gcpProjectId.');
  if (mode === 'confirm' && !params.previewId) return blocked('Preview the removal first, then confirm with that preview\'s previewId.');
  if (mode === 'preview' && params.previewId) return blocked('previewId is only used when confirming.');

  const paths = engineStatePaths({ provider: 'gcp', projectId: params.project.id, environmentId: gcpProjectId, partition: 'project-shared' }, dataDir);
  const previewFile = path.join(paths.plans, 'project-removal-preview.json');
  let token: string;
  try { token = await deps.getDefaultAdminAccessToken(); } catch { return blocked('Hypervibe could not sign in to Google with your administrator account.'); }

  let created: Awaited<ReturnType<typeof readGcpBootstrappedProject>>;
  try {
    created = await deps.readCreatedProject({ projectId: params.project.id, gcpProjectId, auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token, GOOGLE_PROJECT: gcpProjectId }, redact: [token] }, dataDir });
  } catch { return blocked('Hypervibe could not read its saved setup for this Google project.'); }
  if (!created.ok) return blocked(`Hypervibe could not read its saved setup for this Google project (${created.error}).`);
  if (!created.created) {
    return blocked(`Hypervibe project ${params.project.name} did not create Google project ${gcpProjectId}, so it will not delete it. Hypervibe only removes Google projects it created itself.`);
  }

  const observed = await readProject(deps.fetch, token, gcpProjectId);
  if (observed.state === 'unknown') return blocked(observed.reason);
  if (observed.projectNumber !== created.projectNumber) return blocked(`Google project ${gcpProjectId} is not the one Hypervibe created (its project number differs).`);
  const projectNumber = observed.projectNumber;
  const finish = (): GcpProjectRemovalResult => {
    const removedConnections = forgetProject(params.project, gcpProjectId, dataDir, deps.now());
    auditRepo.create({ action: 'gcp.project.removed', resourceType: 'project', resourceId: params.project.id, details: { gcpProjectId, projectNumber, removedConnections } });
    return { success: true, mode, gcpProjectId, projectNumber, removedConnections,
      message: `Google project ${gcpProjectId} is scheduled for deletion and its resources are shut down. Google keeps it for 30 days, during which it can be restored in the Google Cloud console. Hypervibe removed its saved access to the project.` };
  };
  // A deletion that Google already accepted (an earlier confirm whose answer was lost) only needs the local records cleared.
  if (observed.state === 'deleting') return mode === 'confirm' ? finish() : { success: true, mode, gcpProjectId, projectNumber, message: `Google project ${gcpProjectId} is already scheduled for deletion. Confirm to remove Hypervibe's saved access to it.`, ...savePreview() };

  const environments = recordedEnvironments(gcpProjectId);
  if (environments.length) return blocked(`These environments still run in ${gcpProjectId}: ${environments.join(', ')}. Tear each one down first (hv_plan scope="teardown").`, { found: environments.map((name) => `environment ${name}`) });
  const contents = await readGcpProjectContents(deps.fetch, token, gcpProjectId);
  if (contents.state === 'unknown') return blocked(`${contents.reason} Whether the project is empty is unknown, so nothing was deleted.`);
  if (contents.found.length) {
    return blocked(`Google project ${gcpProjectId} still holds resources, so it was not deleted. Remove them first, or delete the project yourself in the Google Cloud console if you are sure nothing depends on them.`,
      { found: contents.found, checked: GCP_PROJECT_REMOVAL_CHECKED, projectNumber });
  }

  if (mode === 'preview') {
    return { success: true, mode, gcpProjectId, projectNumber, checked: GCP_PROJECT_REMOVAL_CHECKED, ...savePreview(),
      message: `Google project ${gcpProjectId} (${projectNumber}) holds none of the resources Hypervibe checks for. Confirming deletes the whole project and everything in it.`,
      warnings: [
        'Everything in the project is deleted, including things Hypervibe did not check for, such as Google sign-in clients and container images.',
        'Google keeps a deleted project for 30 days, during which it can be restored in the Google Cloud console. After that it is gone for good and its id cannot be reused.',
        'Hypervibe will also remove its saved Cloud Run and Cloud SQL connections for this project.',
      ] };
  }

  const saved = readPreview();
  if (!saved || saved.previewId !== params.previewId || saved.gcpProjectId !== gcpProjectId || saved.projectNumber !== projectNumber || saved.expiresAt < deps.now()) {
    return blocked('That preview is missing, expired or for a different project. Preview the removal again.');
  }
  fs.rmSync(previewFile, { force: true });
  let status: number | undefined;
  try {
    status = (await deps.fetch(`https://cloudresourcemanager.googleapis.com/v3/projects/${gcpProjectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status;
  } catch { /* The answer was lost; the project's own state below is the evidence. */ }
  // Google answers the delete before the project shows as deleting, so an accepted or lost request is read again for a minute.
  const accepted = status === undefined || (status >= 200 && status < 300);
  let after = await readProject(deps.fetch, token, gcpProjectId);
  for (let attempt = 0; accepted && after.state !== 'deleting' && attempt < 30; attempt++) {
    await deps.sleep(2000);
    after = await readProject(deps.fetch, token, gcpProjectId);
  }
  if (after.state === 'deleting' && after.projectNumber === projectNumber) return finish();
  if (after.state === 'active' && !accepted) return { success: false, mode, gcpProjectId, projectNumber, error: `Google did not delete project ${gcpProjectId}${status ? ` (HTTP ${status})` : ''}. It is unchanged. Preview the removal again.` };
  return { success: false, mode, status: 'pending', gcpProjectId, projectNumber,
    error: `Hypervibe asked Google to delete project ${gcpProjectId} but could not confirm the result. Preview the removal again to see whether it was deleted.` };

  function savePreview(): { previewId: string } {
    const previewId = randomUUID();
    fs.mkdirSync(paths.plans, { recursive: true, mode: 0o700 });
    fs.writeFileSync(previewFile, JSON.stringify({ previewId, gcpProjectId, projectNumber, expiresAt: deps.now() + PREVIEW_MINUTES * 60_000 }), { mode: 0o600 });
    return { previewId };
  }
  function readPreview(): { previewId?: string; gcpProjectId?: string; projectNumber?: string; expiresAt: number } | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(previewFile, 'utf8')) as Record<string, unknown>;
      return typeof value.expiresAt === 'number' ? value as never : undefined;
    } catch { return undefined; }
  }
}
