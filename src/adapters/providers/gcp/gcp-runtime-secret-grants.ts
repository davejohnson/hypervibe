import { z } from 'zod';
import { fetchWithRetry } from '../../../utils/fetch-retry.js';
import { readGcpProject } from './gcp-data.client.js';
import { secretEngineKey } from './tofu/gcp-engine.backend.js';

const accessor = 'roles/secretmanager.secretAccessor';
const resourceType = 'google_secret_manager_secret_iam_member';
const grantValues = z.object({
  project: z.string(), secret_id: z.string(), member: z.string(), role: z.literal(accessor),
  condition: z.array(z.never()).nullish(),
});
const policy = z.object({
  version: z.union([z.literal(0), z.literal(1), z.literal(3)]).optional(), etag: z.string().min(1).optional(),
  bindings: z.array(z.object({ role: z.string().min(1), members: z.array(z.string().min(1)),
    condition: z.object({ expression: z.string().min(1) }).optional() })).optional(), auditConfigs: z.array(z.unknown()).optional(),
}).strict().refine(value => !value.bindings?.some(binding => binding.condition) || value.version === 3);

export interface RuntimeSecretGrant {
  secretId: string;
  before?: string;
  after?: string;
}
export interface ReviewedRuntimeSecretGrant extends RuntimeSecretGrant {
  name: string;
  createTime: string;
}

/** Keep only the exact IAM principals from the refreshed private engine plan. */
export function runtimeSecretGrantChanges(shown: unknown, projectId: string, runtimeEmail: string): RuntimeSecretGrant[] {
  const rows = (shown as { resource_changes?: Array<{ address: string; type: string;
    deposed?: unknown; change: { actions: string[]; importing?: unknown; before: unknown; after: unknown } }> }).resource_changes ?? [];
  return rows.filter(row => row.type === resourceType && (row.change.importing || !row.change.actions.includes('no-op'))).map(row => {
    if (row.change.importing || row.deposed) throw new Error('An existing or superseded runtime grant cannot be adopted.');
    const before = row.change.before == null ? undefined : grantValues.parse(row.change.before);
    const after = row.change.after == null ? undefined : grantValues.parse(row.change.after);
    const secretId = (after ?? before)?.secret_id.split('/').at(-1);
    if (!secretId || !/^[A-Za-z0-9_-]{1,255}$/.test(secretId) || row.address !== `${resourceType}.${secretEngineKey(secretId)}`
      || after && after.member !== `serviceAccount:${runtimeEmail}`
      || [before, after].some(value => value && (value.project !== projectId || !value.member.startsWith('serviceAccount:')
        || !value.member.endsWith(`@${projectId}.iam.gserviceaccount.com`) || ![secretId, `projects/${projectId}/secrets/${secretId}`].includes(value.secret_id)))) {
      throw new Error('The runtime secret grant has an unexpected identity.');
    }
    return { secretId, ...(before ? { before: before.member } : {}), ...(after ? { after: after.member } : {}) };
  });
}

/** Resolve Google's numeric project name once per plan or apply when a secret uses it. */
export function runtimeSecretGrantReviewer(token: string, projectId: string, environmentId: string) {
  let projectName: Promise<string | undefined> | undefined;
  const readProjectName = async () => {
    const response = await readGcpProject(token, projectId);
    if (!response.ok) return;
    const project = await response.json() as { name?: string; projectId?: string };
    return project.projectId === projectId ? project.name : undefined;
  };
  return (grant: RuntimeSecretGrant) => reviewRuntimeSecretGrant(token, projectId, environmentId, grant, () => projectName ??= readProjectName());
}

/** Check the actual secret and its directly attached policy. Read only metadata. */
async function reviewRuntimeSecretGrant(token: string, projectId: string, environmentId: string,
  grant: RuntimeSecretGrant, projectName: () => Promise<string | undefined>): Promise<ReviewedRuntimeSecretGrant | { blocked: string }> {
  const url = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(grant.secretId)}`;
  const headers = { Authorization: `Bearer ${token}` };
  const unknown = { blocked: `The identity, ownership or access policy of ${grant.secretId} could not be verified. No runtime grant change is authorized.` };
  try {
    const secret = await fetchWithRetry(url, { headers });
    if (!secret.ok) return unknown;
    const meta = await secret.json() as { name?: string; createTime?: string; labels?: Record<string, string> };
    const [projects, scope, secrets, id, extra] = (meta.name ?? '').split('/');
    if (!meta.name || projects !== 'projects' || (scope !== projectId && (!/^[1-9][0-9]*$/.test(scope ?? '') || await projectName() !== `projects/${scope}`))
      || secrets !== 'secrets' || id !== grant.secretId || extra !== undefined || !meta.createTime || !z.iso.datetime({ offset: true }).safeParse(meta.createTime).success
      || meta.labels?.['managed-by'] !== 'hypervibe' || meta.labels['hv-environment'] !== environmentId.toLowerCase()) return unknown;
    const read = await fetchWithRetry(`${url}:getIamPolicy?options.requestedPolicyVersion=3`, { headers });
    if (!read.ok) return unknown;
    const observed = policy.parse(await read.json());
    const readers = new Set((observed.bindings ?? []).filter(binding => binding.role === accessor && !binding.condition)
      .flatMap(binding => binding.members).map(member => member.toLowerCase()));
    if (grant.before && !readers.has(grant.before.toLowerCase())) return { blocked: `The reviewed runtime grant on ${grant.secretId} is missing. Review its current plan.` };
    if (grant.after && grant.after !== grant.before && readers.has(grant.after.toLowerCase())) {
      return { blocked: `An existing grant already gives ${grant.after} access to ${grant.secretId}. Hypervibe cannot take ownership of this grant through a create action.` };
    }
    return { ...grant, name: meta.name, createTime: meta.createTime };
  } catch { return unknown; }
}
