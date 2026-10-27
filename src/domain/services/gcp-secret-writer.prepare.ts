import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Project } from '../entities/project.entity.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { SecretWriterPreparationRepository } from '../../adapters/db/repositories/secret-writer-preparation.repository.js';
import { GcpSecretWriterClient, type WriterIamPolicy, type WriterMutationContext } from '../../adapters/providers/gcp/gcp-secret-writer.client.js';
import { DestinationBoundaryError, DestinationBudget } from '../../adapters/providers/secret-destination-http.js';
import { gcpSecretDestinationSchema } from '../ports/secret-destination.port.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { resourceName } from './resource-names.js';
import { getDefaultAdminAccessToken } from './cloud-prepare.execute.js';

const sourceSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), environmentName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: gcpSecretDestinationSchema.shape.projectId, projectNumber: gcpSecretDestinationSchema.shape.projectNumber,
  hostServiceAccountEmail: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/),
  secretIds: z.array(gcpSecretDestinationSchema.shape.secretId).min(1).max(100),
  retainedSecretIds: z.array(gcpSecretDestinationSchema.shape.secretId).max(100).default([]),
}).strict();
const recordSchema = z.object({ version: z.literal(1), repository: z.string(), environmentName: z.string(), projectId: z.string(), projectNumber: z.string(),
  hostServiceAccountEmail: z.string(), attemptId: z.string().guid(), uniqueId: z.string().regex(/^[1-9]\d*$/).optional(),
  mutations: z.record(z.string(), z.enum(['attempted', 'confirmed', 'rejected'])), state: z.enum(['pending', 'ready']),
  sourceRevision: z.string(), sourceDigest: z.string(), secretIds: z.array(z.string()),
}).strict();
type WriterRecord = z.infer<typeof recordSchema>;
type Scope = z.infer<typeof sourceSchema>;
export interface GcpSecretWriterPrepareParams extends Omit<Scope, 'retainedSecretIds'> {
  /** Current declared pinned slots; preserve only grants already in our durable scope. */
  retainedSecretIds?: string[];
  project: Project; confirm?: boolean; expectedPlanDigest?: string; adminAuth?: 'default';
  defaultAdminAccessTokenProvider?: () => Promise<string>; beforeWrite?: (context?: WriterMutationContext) => Promise<void>;
}
export interface GcpSecretWriterPreparePlan extends Scope {
  version: 'gcp-secret-writer-v1'; serviceAccountEmail: string; accountId: string;
  enableApis: string[]; roles: { name: string; roleId: string; scope: 'project' | 'secret'; permissions: string[] }[];
  impersonationRole: 'roles/iam.serviceAccountTokenCreator';
}
export interface GcpSecretWriterPrepareResult {
  success: boolean; mode: 'preview' | 'confirm'; planDigest?: string; plan?: GcpSecretWriterPreparePlan;
  writerIdentity?: { serviceAccountEmail: string; uniqueId: string }; failureCode?: string; error?: string;
}
export interface GcpSecretWriterPrepareDependencies { fetch?: typeof fetch; randomUUID?: () => string; sleep?: (milliseconds: number) => Promise<void> }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
class PreparationFailure extends Error { constructor(readonly code: string) { super(code); } }

/** One-time reviewed IAM preparation. Admin values exist only for this call. */
export async function runGcpSecretWriterPrepare(params: GcpSecretWriterPrepareParams,
  dependencies: GcpSecretWriterPrepareDependencies = {}): Promise<GcpSecretWriterPrepareResult> {
  const mode = params.confirm ? 'confirm' : 'preview';
  let plan: GcpSecretWriterPreparePlan | undefined; let planDigest: string | undefined; let budget: DestinationBudget | undefined;
  try {
    const scope = sourceSchema.safeParse({ repository: params.repository, environmentName: params.environmentName, sourceRevision: params.sourceRevision,
      sourceDigest: params.sourceDigest, projectId: params.projectId, projectNumber: params.projectNumber,
      hostServiceAccountEmail: params.hostServiceAccountEmail, secretIds: params.secretIds, retainedSecretIds: params.retainedSecretIds });
    if (!scope.success || parseGitHubRepoFromRemote(params.project.gitRemoteUrl)?.toLowerCase() !== params.repository.toLowerCase()
      || new Set(params.secretIds).size !== params.secretIds.length
      || new Set(scope.data.retainedSecretIds).size !== scope.data.retainedSecretIds.length
      || scope.data.retainedSecretIds.some(id => params.secretIds.includes(id))) throw new PreparationFailure('scope_mismatch');
    const target = { ...scope.data, repository: scope.data.repository.toLowerCase(), secretIds: [...scope.data.secretIds].sort(),
      retainedSecretIds: [...scope.data.retainedSecretIds].sort() };
    const nativeScope = [target.repository, target.environmentName];
    const accountId = resourceName('secret-writer', { scope: nativeScope, maxLength: 30, minLength: 6 });
    const metadataRole = resourceName('secretmetadata', { scope: nativeScope, compact: true, maxLength: 64 });
    const valuesRole = resourceName('secretwriter', { scope: nativeScope, compact: true, maxLength: 64 });
    plan = { ...target, version: 'gcp-secret-writer-v1', accountId, serviceAccountEmail: `${accountId}@${target.projectId}.iam.gserviceaccount.com`,
      enableApis: ['iam.googleapis.com', 'iamcredentials.googleapis.com'], impersonationRole: 'roles/iam.serviceAccountTokenCreator',
      roles: [{ name: `projects/${target.projectId}/roles/${metadataRole}`, roleId: metadataRole, scope: 'project', permissions: ['resourcemanager.projects.get'] },
        { name: `projects/${target.projectId}/roles/${valuesRole}`, roleId: valuesRole, scope: 'secret',
          permissions: ['secretmanager.secrets.get', 'secretmanager.versions.add', 'secretmanager.versions.list'] }] };
    planDigest = hash(plan);
    if (!params.confirm) return { success: true, mode, plan, planDigest };
    if (params.expectedPlanDigest !== planDigest) throw new PreparationFailure('review_changed');
    if (params.adminAuth !== 'default' || typeof params.beforeWrite !== 'function') throw new PreparationFailure('admin_authorization_required');
    budget = new DestinationBudget({ deadlineMs: 30_000 });
    const projects = new ProjectRepository(); const records = new SecretWriterPreparationRepository();
    const fresh = projects.findById(params.project.id);
    if (!fresh || parseGitHubRepoFromRemote(fresh.gitRemoteUrl)?.toLowerCase() !== target.repository) throw new PreparationFailure('scope_mismatch');
    let previous = records.read(fresh.id, target.environmentName);
    const parsed = previous === undefined ? undefined : recordSchema.safeParse(previous);
    if (parsed && !parsed.success) throw new PreparationFailure('recovery_state_invalid');
    let record: WriterRecord = parsed?.success ? parsed.data : { version: 1, repository: target.repository,
      environmentName: target.environmentName, projectId: target.projectId, projectNumber: target.projectNumber,
      hostServiceAccountEmail: target.hostServiceAccountEmail, attemptId: (dependencies.randomUUID ?? randomUUID)(), mutations: {}, state: 'pending',
      sourceRevision: target.sourceRevision, sourceDigest: target.sourceDigest, secretIds: target.secretIds };
    for (const key of ['repository', 'environmentName', 'projectId', 'projectNumber', 'hostServiceAccountEmail'] as const) {
      if (record[key] !== target[key]) throw new PreparationFailure('scope_mismatch');
    }
    if (!recordSchema.safeParse(record).success) throw new PreparationFailure('recovery_state_invalid');
    // A new source can resume the same native identity, but may not silently
    // remove previously granted destinations. Removal needs separate IAM review.
    if (record.secretIds.some(id => !target.secretIds.includes(id) && !target.retainedSecretIds.includes(id))) throw new PreparationFailure('scope_reduction_requires_review');
    const retainedIds = record.secretIds.filter(id => target.retainedSecretIds.includes(id));
    const recordedSecretIds = [...target.secretIds, ...retainedIds].sort();
    const persist = () => {
      record = { ...record, secretIds: recordedSecretIds, sourceRevision: target.sourceRevision, sourceDigest: target.sourceDigest };
      const next = structuredClone(record);
      try { records.save(fresh.id, target.environmentName, previous, next); }
      catch { throw new PreparationFailure('concurrent_preparation'); }
      previous = next;
    };
    const authorize = async (context?: WriterMutationContext) => {
      try { await budget!.wait(params.beforeWrite!(context)); }
      catch { throw new PreparationFailure(budget!.signal.aborted ? 'deadline_exceeded' : 'authorization_unconfirmed'); }
    };
    const token = await budget.wait((params.defaultAdminAccessTokenProvider ?? getDefaultAdminAccessToken)());
    const client = new GcpSecretWriterClient({ token, budget, request: dependencies.fetch ?? fetch, beforeWrite: authorize,
      sleep: dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) });
    await client.project(target.projectId, target.projectNumber);
    for (const id of target.secretIds) await client.secret(`projects/${target.projectNumber}/secrets/${id}`);
    // Inspect the existing principal before granting/enabling anything when IAM
    // is already available. An API permission error never means missing account.
    const apiEnabled = async (api: string) => {
      const state = await client.bootstrap.getServiceState(target.projectId, api);
      if (state !== 'ENABLED' && state !== 'DISABLED') throw new DestinationBoundaryError('invalid_response');
      return state === 'ENABLED';
    };
    const iamEnabled = await apiEnabled('iam.googleapis.com');
    let account = iamEnabled ? await client.account(target.projectId, accountId) : null;
    const marker = (kind: string) => `Hypervibe secret-writer v1 ${hash(nativeScope)} ${record.attemptId} ${kind}`;
    const verifyAccount = () => {
      if (!account) {
        if (record.uniqueId) throw new PreparationFailure('unowned_or_replaced_writer');
        return;
      }
      if (previous === undefined || !record.mutations['account:create'] || account.description !== marker('account')
        || account.disabled === true || (record.uniqueId && record.uniqueId !== account.uniqueId)) throw new PreparationFailure('unowned_or_replaced_writer');
    };
    if (iamEnabled) verifyAccount();
    const mutation = async (key: string, action: () => Promise<unknown>, observed: () => Promise<boolean>) => {
      if (await observed()) {
        if (record.mutations[key] === 'attempted') { record.mutations[key] = 'confirmed'; persist(); }
        return;
      }
      if (record.mutations[key] === 'attempted') throw new PreparationFailure('write_uncertain');
      await authorize();
      record.mutations[key] = 'attempted'; record.state = 'pending'; persist();
      let rejected = false;
      client.beginMutation();
      try { await action(); } catch {
        rejected = client.canRetryRejectedMutation();
        if (rejected) { record.mutations[key] = 'rejected'; persist(); }
      }
      // Definite native rejection permits another explicitly confirmed call;
      // a transport failure still permits read-only recovery and no replay.
      if (!await observed()) throw new PreparationFailure(rejected ? 'provider_rejected' : 'write_uncertain');
      record.mutations[key] = 'confirmed'; persist();
    };
    for (const api of plan.enableApis) {
      await mutation(`api:${api}`, () => client.bootstrap.enableService(target.projectId, api),
        () => apiEnabled(api));
    }
    await mutation('account:create', async () => {
      const created = await client.createAccount(target.projectId, accountId, marker('account'));
      record.uniqueId = created.uniqueId; persist();
    }, async () => {
      account = await client.account(target.projectId, accountId); verifyAccount(); return account !== null;
    });
    if (!account) throw new PreparationFailure('write_uncertain');
    record.uniqueId = account.uniqueId; persist();
    for (const role of plan.roles) {
      await mutation(`role:${role.roleId}`, () => client.createRole(target.projectId, role.roleId, marker(role.scope), role.permissions), async () => {
        const observed = await client.role(role.name);
        if (!observed) {
          if (record.mutations[`role:${role.roleId}`] === 'confirmed') throw new PreparationFailure('unowned_or_modified_role');
          return false;
        }
        if (!record.mutations[`role:${role.roleId}`] || observed.description !== marker(role.scope)
          || JSON.stringify([...observed.includedPermissions].sort()) !== JSON.stringify(role.permissions)) throw new PreparationFailure('unowned_or_modified_role');
        return true;
      });
    }
    const member = `serviceAccount:${plan.serviceAccountEmail}`;
    for (const id of retainedIds) {
      const resource = `projects/${target.projectNumber}/secrets/${id}`;
      const key = `iam:${resource}:${plan.roles[1].name}`;
      if (record.mutations[key] !== 'attempted') continue;
      const policy = await client.policy('secret', resource);
      if (!policy.bindings.some(binding => binding.role === plan!.roles[1].name && !binding.condition && binding.members.includes(member))) {
        throw new PreparationFailure('write_uncertain');
      }
      record.mutations[key] = 'confirmed'; persist();
    }
    const grant = async (kind: 'project' | 'secret' | 'account', resource: string, role: string, principal: string) => {
      let policy: WriterIamPolicy;
      await mutation(`iam:${resource}:${role}`, async () => {
        // The final policy/identity reads precede the host source/grant check.
        account = await client.account(target.projectId, accountId); verifyAccount();
        if (!account) throw new PreparationFailure('unowned_or_replaced_writer');
        policy = await client.policy(kind, resource);
        const bindings = structuredClone(policy.bindings);
        const binding = bindings.find(value => value.role === role && !value.condition);
        if (binding) { if (!binding.members.includes(principal)) binding.members.push(principal); }
        else bindings.push({ role, members: [principal] });
        return client.setPolicy(kind, resource, { ...policy, bindings });
      }, async () => {
        policy = await client.policy(kind, resource);
        return policy.bindings.some(binding => binding.role === role && !binding.condition && binding.members.includes(principal));
      });
    };
    await grant('project', `projects/${target.projectNumber}`, plan.roles[0].name, member);
    for (const id of target.secretIds) await grant('secret', `projects/${target.projectNumber}/secrets/${id}`, plan.roles[1].name, member);
    await grant('account', `projects/${target.projectId}/serviceAccounts/${record.uniqueId}`, plan.impersonationRole, `serviceAccount:${target.hostServiceAccountEmail}`);
    await authorize();
    record = { ...record, state: 'ready', sourceRevision: target.sourceRevision, sourceDigest: target.sourceDigest, secretIds: recordedSecretIds };
    persist();
    return { success: true, mode, plan, planDigest, writerIdentity: { serviceAccountEmail: plan.serviceAccountEmail, uniqueId: record.uniqueId! } };
  } catch (error) {
    const failureCode = error instanceof PreparationFailure ? error.code : error instanceof DestinationBoundaryError ? error.code : 'provider_unavailable';
    return { success: false, mode, ...(plan ? { plan, planDigest } : {}), failureCode,
      error: 'Secret-writer preparation did not complete. Review the scoped status before continuing; no administrator credentials were stored.' };
  } finally { budget?.close(); }
}
