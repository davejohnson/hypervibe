import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { DEPLOYMENT_ACCESS_PROVIDER, deploymentGrantSchema, deploymentGrantScope, deploymentIdentity,
  type DeploymentPersistence } from '../adapters/cloud/deployment-access.client.js';
import { cloudRetirementActions, cloudRetirementActionIds, cloudRetirementComplete, cloudRetirementDeclarationSchema, cloudRetirementPlanSchema,
  cloudRetirementResponseSchema, type CloudRetirementDeclaration, type CloudRetirementPlan, type CloudRetirementResponse } from '../domain/ports/cloud-retirement.port.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import { normalizeGitRemoteIdentity } from '../lib/git-remote.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { CloudHttpError, createCloudJsonClient } from './cloud-http.js';
import { SETUP_CONTINUATION_TIMEOUT_MS } from './cloud-setup-continuation.js';

const RETIREMENT_PROVIDER = 'hypervibe-cloud-retirement';
const journalSchema = z.object({ version: z.literal(1), declaration: cloudRetirementDeclarationSchema,
  repository: z.string(), projectId: z.string(), environment: z.string(),
  executionStarted: z.boolean().default(false), phase: z.enum(['proposed', 'observed', 'uncertain']), response: cloudRetirementResponseSchema.optional() }).strict();
const unavailable = () => new Error('Cloud cleanup needs the original app and environment connection, a current device approval, and the exact saved review. Existing resources and history are preserved.');
const storeDefault = (): DeploymentPersistence => ({ connections: new ConnectionRepository(), secretStore: getSecretStore() });

/** Historical cleanup never selects source revisions, creates deployment sessions,
 * requests new source approval, or falls back to machine cloud credentials. */
function select(project: Project, environment: string, declaration: CloudRetirementDeclaration, store: DeploymentPersistence) {
  const expected = normalizeGitRemoteIdentity(project.gitRemoteUrl ?? undefined);
  if (!expected) throw unavailable();
  const identity = deploymentIdentity(environment, expected);
  const scope = deploymentGrantScope(declaration.baseUrl, identity.repository, environment);
  const access = store.connections.findByProviderAndScope(DEPLOYMENT_ACCESS_PROVIDER, scope);
  if (!access || access.status !== 'verified') throw unavailable();
  const grant = deploymentGrantSchema.parse(store.secretStore.decryptObject(access.credentialsEncrypted));
  if (grant.status !== 'verified' || !grant.token || grant.repository !== identity.repository || grant.env !== environment
    || grant.baseUrl !== declaration.baseUrl || grant.environment?.key !== environment || !grant.project?.id
    || grant.revocation || Date.parse(grant.expiresAt) <= Date.now()) throw unavailable();
  const assertCurrent = () => {
    const current = store.connections.findById(access.id);
    if (!current || current.credentialsEncrypted !== access.credentialsEncrypted || current.status !== 'verified'
      || Date.parse(grant.expiresAt) <= Date.now() || !isDeepStrictEqual(identity, deploymentIdentity(environment, expected))) throw unavailable();
  };
  assertCurrent();
  const grantFingerprint = canonicalJsonSha256({ id: access.id, cipher: access.credentialsEncrypted, status: access.status });
  const projectId = grant.project.id;
  const prefix = `/api/v1/projects/${encodeURIComponent(projectId)}/cloud-retirements`;
  const reviewUrl = `${declaration.baseUrl}/apps/${encodeURIComponent(projectId)}/cloud-retirements/${declaration.id}`;
  const request = createCloudJsonClient(declaration.baseUrl, fetch, 30_000);
  const continuationRequest = createCloudJsonClient(declaration.baseUrl, fetch, SETUP_CONTINUATION_TIMEOUT_MS);
  const parse = (value: unknown): CloudRetirementResponse => {
    const wire = JSON.stringify(value);
    if (wire.includes(grant.token!)) throw unavailable();
    const result = cloudRetirementResponseSchema.parse(value);
    if (result.id !== declaration.id || result.environment !== environment || result.mode !== declaration.mode
      || !isDeepStrictEqual(result.connectionIds, declaration.connectionIds) || result.reviewUrl !== reviewUrl) throw unavailable();
    return result;
  };
  const call = async (pathname: string, method: string, body?: unknown) => {
    assertCurrent();
    const transport = pathname.endsWith('/continuations') ? continuationRequest : request;
    const result = parse(await transport(pathname, { method, token: grant.token, ...(body === undefined ? {} : { body }) }));
    assertCurrent();
    if (journal?.response?.planDigest && journal.response.planDigest === result.planDigest
      && !isDeepStrictEqual(cloudRetirementActionIds(journal.response), cloudRetirementActionIds(result))) throw unavailable();
    return result;
  };
  const journalScope = `${declaration.baseUrl}|${identity.repository}|${environment}|${declaration.id}`;
  let row = store.connections.findByProviderAndScope(RETIREMENT_PROVIDER, journalScope);
  let journal = row ? journalSchema.parse(store.secretStore.decryptObject(row.credentialsEncrypted)) : undefined;
  if (journal && (!isDeepStrictEqual(journal.declaration, declaration) || journal.repository !== identity.repository
    || journal.environment !== environment || journal.projectId !== projectId)) throw unavailable();
  const save = (phase: 'proposed' | 'observed' | 'uncertain', response?: CloudRetirementResponse) => {
    assertCurrent();
    const next = journalSchema.parse({ version: 1, declaration, repository: identity.repository, projectId, environment, phase, executionStarted: journal?.executionStarted === true || phase === 'uncertain' || response?.status === 'pending' || response?.status === 'retired', ...(response ? { response } : {}) });
    const saved = store.connections.compareAndSwap({ provider: RETIREMENT_PROVIDER, scope: journalScope,
      credentialsEncrypted: store.secretStore.encryptObject(next) }, row?.credentialsEncrypted ?? null, response && cloudRetirementComplete(response) ? 'verified' : 'pending', row?.status ?? null);
    if (!saved) throw unavailable();
    row = saved; journal = next;
  };
  return { repository: identity.repository, projectId, grantId: access.id, grantFingerprint, reviewUrl, assertCurrent,
    get exists() { return Boolean(journal); },
    get canReplayInitialProposal() { return journal?.phase === 'proposed' && !journal.executionStarted && !journal.response; }, save,
    propose: () => call(prefix, 'POST', { id: declaration.id, environment, mode: declaration.mode, connectionIds: declaration.connectionIds }),
    status: () => call(`${prefix}/${declaration.id}`, 'GET'),
    continue: (planDigest: string) => call(`${prefix}/${declaration.id}/continuations`, 'POST', { planDigest }) };
}

/** Destructive retirement remains authoritative even if its declaration is
 * accidentally removed. A collection disconnect is deliberately not an app latch. */
function retainedDeletion(project: Project, environment: string) {
  const repository = normalizeGitRemoteIdentity(project.gitRemoteUrl ?? undefined);
  if (!repository) return undefined;
  const candidates = new ConnectionRepository().findAllByProvider(RETIREMENT_PROVIDER).filter(row => {
    const parts = row.scope?.split('|'); return parts?.length === 4 && parts[1] === repository && parts[2] === environment;
  });
  if (!candidates.length) return undefined;
  const secretStore = getSecretStore();
  const retained = candidates.map(row => journalSchema.parse(secretStore.decryptObject(row.credentialsEncrypted)))
    .filter(journal => journal.repository === repository && journal.environment === environment && journal.declaration.mode === 'delete-owned'
      && (journal.executionStarted || journal.phase === 'uncertain' || journal.response?.status === 'pending' || journal.response?.status === 'retired'));
  if (retained.length > 1) throw unavailable();
  return retained[0];
}
export function cloudRetirementRecreationBlock(project: Project, environment: string, declaration?: CloudRetirementDeclaration): string | null {
  try {
    const retained = retainedDeletion(project, environment);
    if (!retained || declaration && isDeepStrictEqual(declaration, retained.declaration)) return null;
    return 'A saved owned GCP cleanup may be running or completed for this environment. Restore its exact cloudRetirement declaration to inspect or resolve it. Recreating the app requires a separate explicit reconnect review; removing the declaration does not authorize setup.';
  } catch { return 'Saved cloud cleanup history could not be verified. Resolve that retirement before any app setup; preserve the existing records.'; }
}

export async function planCloudRetirement(project: Project, environment: string, declaration: CloudRetirementDeclaration) {
  try {
    const selected = select(project, environment, declaration, storeDefault());
    const exists = selected.exists;
    if (!exists) selected.save('proposed'); // Durable before the idempotent proposal; uncertain results require GET.
    let response: CloudRetirementResponse;
    if (!exists) response = await selected.propose();
    else {
      try { response = await selected.status(); }
      catch (error) {
        // Scoped 404 also conceals denied access; it does not prove absence.
        // Only the original metadata proposal is idempotent. The hosted API
        // revalidates this same ID, device, environment and intent, and cannot
        // execute cloud actions here. Observed/started work never takes this path.
        if (!(error instanceof CloudHttpError) || error.status !== 404 || !selected.canReplayInitialProposal) throw error;
        selected.save('proposed'); // Recheck grant and journal CAS before recovery.
        response = await selected.propose();
      }
    }
    selected.save('observed', response);
    const proof = cloudRetirementPlanSchema.parse({ declaration, repository: selected.repository, projectId: selected.projectId, environment,
      grantId: selected.grantId, grantFingerprint: selected.grantFingerprint, response });
    const actions = cloudRetirementActions(proof);
    return { proof, response, actions, blocked: !actions.length && !cloudRetirementComplete(response)
      ? [{ category: 'prerequisite' as const, provider: 'hypervibe', reason: cloudRetirementHint(response) }] : [] };
  } catch { throw unavailable(); }
}

export function cloudRetirementHint(response: CloudRetirementResponse): string {
  if (response.status === 'disconnected') return 'Hosted collection access is removed. The app and its secret reader are retained. Remove the completed disconnect declaration to resume ordinary app planning; cleanup history remains.';
  if (response.status === 'retired') return 'The reviewed owned GCP resources are retired. Cleanup history and recorded identities are retained. Keep the cleanup declaration to prevent recreation.';
  if (response.status === 'authorization-required') return `Open ${response.reviewUrl} to sign in with current GCP administrator access for this cleanup. No deletion has been authorized.`;
  if (response.status === 'review-required') return `Open ${response.reviewUrl} to review and approve this exact cleanup. Then run hv_plan again.`;
  if (response.status === 'pending') return 'Cleanup is still pending. Inspect hv_status, then use a fresh hv_plan and its exact confirmation to recover the saved operation before any remaining action.';
  if (response.status === 'blocked') return `Cleanup is blocked${response.reason ? ` (${response.reason})` : ''}. Review ${response.reviewUrl}; existing records are retained.`;
  return 'The owner approved this exact cleanup. Review the saved plan and apply its exact confirmed action.';
}

export async function inspectCloudRetirement(project: Project, environment: string, spec?: ProjectSpec) {
  const desired = spec?.environments[environment]?.cloudRetirement;
  let declaration = desired;
  try { declaration = retainedDeletion(project, environment)?.declaration ?? declaration; }
  catch { return { scope: 'cloud-retirement' as const, environment, inSync: false, verified: false, cloudRetirement: { status: 'unknown' as const, reason: 'history_unavailable' as const }, hint: unavailable().message }; }
  if (!declaration) return null;
  const block = cloudRetirementRecreationBlock(project, environment, desired);
  try {
    const response = await select(project, environment, declaration, storeDefault()).status();
    return { scope: 'cloud-retirement' as const, environment, inSync: cloudRetirementComplete(response) && !block, verified: cloudRetirementComplete(response), cloudRetirement: response,
      ...(block ? { hint: block, blocked: [{ category: 'prerequisite' as const, provider: 'hypervibe', reason: block }] } : {}) };
  } catch { return { scope: 'cloud-retirement' as const, environment, inSync: false, verified: false, cloudRetirement: { id: declaration.id, mode: declaration.mode,
    status: 'unknown' as const, reason: 'status_unavailable' as const }, hint: unavailable().message }; }
}

export async function applyCloudRetirement(input: { project: Project; environment: string; proof: CloudRetirementPlan; action: PlanAction; authorize(): boolean }): Promise<ActionResult> {
  const { project, environment, proof, action } = input;
  const failure = (pending = false): ActionResult => ({ success: false, status: pending ? 'pending' : 'blocked',
    message: pending ? 'The cleanup response is uncertain. Inspect hv_status before creating a fresh recovery plan. No repeated deletion is authorized by this response.' : unavailable().message });
  let sent = false;
  try {
    if (!isDeepStrictEqual([action], cloudRetirementActions(proof)) || !proof.response.planDigest) return failure();
    const assertDeclaration = () => {
      const current = new SpecStore().get(project)?.spec.environments[environment]?.cloudRetirement;
      if (!input.authorize() || !isDeepStrictEqual(current, proof.declaration)) throw unavailable();
    };
    assertDeclaration();
    const selected = select(project, environment, proof.declaration, storeDefault());
    if (selected.projectId !== proof.projectId || selected.repository !== proof.repository || proof.environment !== environment
      || selected.grantId !== proof.grantId || selected.grantFingerprint !== proof.grantFingerprint || !selected.exists) return failure();
    const fresh = await selected.status();
    assertDeclaration();
    if (fresh.planDigest !== proof.response.planDigest
      || !isDeepStrictEqual(cloudRetirementActionIds(fresh), cloudRetirementActionIds(proof.response))) return failure();
    if (cloudRetirementComplete(fresh)) {
      selected.save('observed', fresh);
      return { success: true, message: cloudRetirementHint(fresh), data: { cloudRetirement: fresh } };
    }
    if (!['ready', 'pending'].includes(fresh.status)) return { ...failure(), message: cloudRetirementHint(fresh), data: { cloudRetirement: fresh } };
    selected.save('uncertain', fresh); // Reserve the exact operation locally before a possibly lost response.
    assertDeclaration(); selected.assertCurrent(); sent = true;
    const response = await selected.continue(proof.response.planDigest);
    assertDeclaration();
    if (response.planDigest !== proof.response.planDigest
      || !isDeepStrictEqual(cloudRetirementActionIds(response), cloudRetirementActionIds(proof.response))) return failure(true);
    selected.save('observed', response);
    return { success: cloudRetirementComplete(response), ...(!cloudRetirementComplete(response) ? { status: response.status === 'pending' ? 'pending' as const : 'blocked' as const } : {}),
      message: cloudRetirementHint(response), data: { cloudRetirement: response } };
  } catch { return failure(sent); }
}
