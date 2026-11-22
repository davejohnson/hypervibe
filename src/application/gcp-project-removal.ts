import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { engineStatePaths } from '../adapters/engine/opentofu/workspace.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { getDataDir } from '../adapters/storage/paths.js';
import { GCP_PROJECT_REMOVAL_CHECKED, readGcpProjectContents, readGcpProjectLifecycle, requestGcpProjectDeletion } from '../adapters/providers/gcp/gcp-project-removal.client.js';
import { redactExactValues } from '../utils/redact-exact-values.js';
import type { Project } from '../domain/entities/project.entity.js';
import { buildSourceBucketName, getDefaultAdminAccessToken } from '../domain/services/cloud-prepare.execute.js';
import { GCP_PROJECT_ID_PATTERN } from '../domain/services/gcp-environment-target.js';
import { readGcpBootstrappedProject } from '../domain/services/gcp-project-setup.service.js';

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
  /** Kinds that could not be listed because their Google API is switched off in the project. Something may still exist there. */
  notChecked?: string[];
  /** What still exists in the project and stops the removal. */
  found?: string[];
  warnings?: string[];
  removedConnections?: string[];
}

const PREVIEW_MINUTES = 10;

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
  if (!created.ok) return blocked(`Hypervibe could not read its saved setup for this Google project (${redactExactValues(created.error, [token])}).`);
  if (!created.created) {
    return blocked(`Hypervibe project ${params.project.name} did not create Google project ${gcpProjectId}, so it will not delete it. Hypervibe only removes Google projects it created itself.`);
  }

  const observed = await readGcpProjectLifecycle(deps.fetch, token, gcpProjectId);
  if (observed.state === 'unknown') return blocked(observed.reason);
  if (observed.projectNumber !== created.projectNumber) return blocked(`Google project ${gcpProjectId} is not the one Hypervibe created (its project number differs).`);
  const projectNumber = observed.projectNumber;
  const finish = (): GcpProjectRemovalResult => {
    const removedConnections = forgetProject(params.project, gcpProjectId, dataDir, deps.now());
    auditRepo.create({ action: 'gcp.project.removed', resourceType: 'project', resourceId: params.project.id, details: { gcpProjectId, projectNumber, removedConnections } });
    return { success: true, mode, gcpProjectId, projectNumber, removedConnections,
      message: `Google project ${gcpProjectId} is scheduled for deletion and its resources are shut down. Google keeps it for 30 days, during which it can be restored in the Google Cloud console. Hypervibe removed its saved access to the project.` };
  };
  const stale = 'That preview is missing, expired or for a different project. Preview the removal again.';
  const reviewed = (): boolean => {
    const saved = readPreview();
    const matches = Boolean(saved && saved.previewId === params.previewId && saved.gcpProjectId === gcpProjectId && saved.projectNumber === projectNumber && saved.expiresAt >= deps.now());
    // A preview is used once, whatever happens next.
    fs.rmSync(previewFile, { force: true });
    return matches;
  };
  // A deletion that Google already accepted (an earlier confirm whose answer was lost, or one made in the console) only needs the local records cleared.
  if (observed.state === 'deleting') {
    if (mode === 'confirm') return reviewed() ? finish() : blocked(stale);
    return { success: true, mode, gcpProjectId, projectNumber, ...savePreview(),
      message: `Google project ${gcpProjectId} is already scheduled for deletion. Confirming removes Hypervibe's saved access to it.`,
      warnings: ['Hypervibe will remove its saved Cloud Run and Cloud SQL connections for this project. If you restore the project in the Google Cloud console later, Hypervibe will no longer be able to manage it.'] };
  }

  const environments = recordedEnvironments(gcpProjectId);
  if (environments.length) return blocked(`These environments still run in ${gcpProjectId}: ${environments.join(', ')}. Tear each one down first (hv_plan scope="teardown").`, { found: environments.map((name) => `environment ${name}`) });
  const contents = await readGcpProjectContents(deps.fetch, token, gcpProjectId, buildSourceBucketName(gcpProjectId));
  if (contents.state === 'unknown') return blocked(`${contents.reason} Whether the project is empty is unknown, so nothing was deleted.`);
  if (contents.found.length) {
    return blocked(`Google project ${gcpProjectId} still holds resources, so it was not deleted. Remove them first, or delete the project yourself in the Google Cloud console if you are sure nothing depends on them.`,
      { found: contents.found, checked: GCP_PROJECT_REMOVAL_CHECKED.filter((label) => !contents.notChecked.includes(label)), notChecked: contents.notChecked, projectNumber });
  }

  if (mode === 'preview') {
    return { success: true, mode, gcpProjectId, projectNumber, checked: GCP_PROJECT_REMOVAL_CHECKED.filter((label) => !contents.notChecked.includes(label)), notChecked: contents.notChecked, ...savePreview(),
      message: `Google project ${gcpProjectId} (${projectNumber}) holds none of the resources Hypervibe could check for. Confirming deletes the whole project and everything in it.`,
      warnings: [
        ...(contents.notChecked.length ? [`Not checked, because their Google API is switched off in this project: ${contents.notChecked.join(', ')}. If any were ever created here they may still exist and will be deleted.`] : []),
        'Everything in the project is deleted, including things Hypervibe did not check for, such as Google sign-in clients and container images.',
        'Google keeps a deleted project for 30 days, during which it can be restored in the Google Cloud console. After that it is gone for good and its id cannot be reused.',
        'Hypervibe will also remove its saved Cloud Run and Cloud SQL connections for this project.',
      ] };
  }

  if (!reviewed()) return blocked(stale);
  const status = await requestGcpProjectDeletion(deps.fetch, token, gcpProjectId);
  // Google answers the delete before the project shows as deleting, so an accepted or lost request is read again for a minute.
  const accepted = status === undefined || (status >= 200 && status < 300);
  let after = await readGcpProjectLifecycle(deps.fetch, token, gcpProjectId);
  for (let attempt = 0; accepted && after.state !== 'deleting' && attempt < 30; attempt++) {
    await deps.sleep(2000);
    after = await readGcpProjectLifecycle(deps.fetch, token, gcpProjectId);
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
