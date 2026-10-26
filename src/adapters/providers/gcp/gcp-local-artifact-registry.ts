import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt,
  type CloudInstallationDriver, type CloudInstallationEvidence, type CloudInstallationProviderContext,
  type CloudInstallationRecord, type LocalCloudScopePreparationIntent } from '../../../domain/ports/cloud-installation.port.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { GcpSecretWriterClient } from './gcp-secret-writer.client.js';
import { hasGcpRuntimeRole, parseGcpRuntimePolicy, withGcpRuntimeRole } from './gcp-runtime-client.js';
import { gcpLocalServicesScopeSchema } from './gcp-local-services-installation.js';

export const gcpLocalArtifactRegistryScopeSchema = gcpLocalServicesScopeSchema.extend({
  scopeKind: z.literal('operator-artifact-registry-v1'), region: z.string().regex(/^[a-z]+(?:-[a-z0-9]+)+$/),
  artifactRepository: z.literal('hypervibe'), artifactRepositoryName: z.string().max(1024),
  artifactRepositoryCreateTime: z.string().datetime().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.artifactRepositoryName !== `projects/${value.projectId}/locations/${value.region}/repositories/${value.artifactRepository}`)
    ctx.addIssue({ code: 'custom', message: 'Image repository does not match the exact reviewed project and region.' });
});
export const gcpLocalPublicArtifactProofShape = {
  publicArtifactRepository: z.literal('operator-public'), publicArtifactRepositoryName: z.string().max(1024),
  publicArtifactRepositoryCreateTime: z.string().datetime(), publicArtifactInstallationId: z.string().guid(), publicArtifactAttemptId: z.string().guid(),
};
export const gcpLocalPublicArtifactRegistryScopeSchema = z.object({ ...gcpLocalArtifactRegistryScopeSchema.shape,
  scopeKind: z.literal('operator-public-artifact-registry-v1'), artifactRepositoryCreateTime: z.string().datetime(),
  artifactInstallationId: z.string().guid(), artifactAttemptId: z.string().guid(), ...gcpLocalPublicArtifactProofShape,
  publicArtifactRepositoryCreateTime: z.string().datetime().optional(), publicArtifactInstallationId: z.string().guid().optional(), publicArtifactAttemptId: z.string().guid().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.artifactRepositoryName !== `projects/${value.projectId}/locations/${value.region}/repositories/hypervibe`
    || value.publicArtifactRepositoryName !== `projects/${value.projectId}/locations/${value.region}/repositories/operator-public`)
    ctx.addIssue({ code: 'custom', message: 'Private and public image repositories must remain separately scoped in the reviewed project and region.' });
});
type Intent = LocalCloudScopePreparationIntent;
type Context = CloudInstallationProviderContext<Intent>;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
const ACTION = 'gcp:local-scope:artifact-registry';
const PUBLIC_CREATE = 'gcp:local-scope:public-artifact-registry';
const PUBLIC_GRANT = 'gcp:local-scope:public-artifact-reader';
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.literal('registry'), id: z.string().max(1024),
  identity: z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/), attemptId: z.string().guid(), createTime: z.string().datetime() }).strict() }).strict()).max(1),
  native: z.object({ operation: z.literal('create-operator-registry-v1'), installationId: z.string().guid(), attemptId: z.string().guid(),
    acknowledgment: z.enum(['acknowledged', 'unknown']), operationName: z.string().max(1024).optional() }).strict() }).strict();
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'ownership_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function names(intent: Intent) {
  const publicRepository = intent.nativeScope.scopeKind === 'operator-public-artifact-registry-v1';
  const scope = publicRepository ? gcpLocalPublicArtifactRegistryScopeSchema.parse(intent.nativeScope) : gcpLocalArtifactRegistryScopeSchema.parse(intent.nativeScope);
  if (publicRepository ? ['publicArtifactRepositoryCreateTime', 'publicArtifactInstallationId', 'publicArtifactAttemptId'].some(key => Object.hasOwn(scope, key)) : scope.artifactRepositoryCreateTime !== undefined) fail('identity_mismatch');
  if (intent.provider !== 'gcp' || intent.hostingProvider !== 'cloudrun' || intent.mode !== 'connect' || !intent.predecessor) fail('identity_mismatch');
  const owner = createHash('sha256').update(JSON.stringify([intent.customerId, intent.appId, intent.environment, intent.installationId])).digest('hex');
  return { ...scope, owner, publicRepository, repositoryId: publicRepository ? 'operator-public' : scope.artifactRepository, repositoryName: 'publicArtifactRepositoryName' in scope ? scope.publicArtifactRepositoryName : scope.artifactRepositoryName, operationPrefix: `projects/${scope.projectId}/locations/${scope.region}/operations/` };
}
function action(intent: Intent): CloudInstallationAction {
  const n = names(intent);
  return { id: n.publicRepository ? PUBLIC_CREATE : ACTION, type: 'create', resource: { kind: 'project', name: n.repositoryName, provider: 'gcp' },
    verified: true, requiresConfirm: true, billable: true, dataBearing: true,
    reason: n.publicRepository ? 'Create a separate operator-public image repository for reviewed public holding and backup helpers; upload no application images.' : 'Create the exact isolated application image repository before CI deployment; preserve every existing repository and permission.',
    metadata: { operation: 'create-operator-registry-v1', category: 'scope', execution: 'api', native: {} } };
}
function publicGrantAction(intent: Intent): CloudInstallationAction {
  const n = names(intent); if (!n.publicRepository) fail('identity_mismatch');
  return { id: PUBLIC_GRANT, type: 'update', resource: { kind: 'project', name: n.repositoryName, provider: 'gcp' },
    verified: true, requiresConfirm: true, dependsOn: [PUBLIC_CREATE],
    reason: 'Make all images in only the owned operator-public repository publicly readable; preserve the private application registry and unrelated IAM bindings.',
    metadata: { operation: 'grant-public-operator-registry-v1', category: 'trust', execution: 'api', native: {} } };
}
const publicEvidenceSchema = z.object({ resources: evidenceSchema.shape.resources,
  native: z.object({ operation: z.literal('grant-public-operator-registry-v1'), installationId: z.string().guid(), attemptId: z.string().guid(),
    policyResource: z.string(), role: z.literal('roles/artifactregistry.reader'), member: z.literal('allUsers') }).strict() }).strict();
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const n = names(intent);
  if ((value as any)?.native?.operation === 'grant-public-operator-registry-v1') {
    const grant = publicEvidenceSchema.parse(value);
    if (!n.publicRepository || grant.native.installationId !== intent.installationId || grant.native.policyResource !== n.repositoryName
      || grant.resources.length !== 1 || grant.resources.some(resource => resource.id !== n.repositoryName || resource.identity.owner !== n.owner)) fail('identity_mismatch');
    return grant;
  }
  const parsed = evidenceSchema.parse(value);
  if (parsed.native.installationId !== intent.installationId
    || parsed.native.operationName && (!parsed.native.operationName.startsWith(n.operationPrefix)
      || !/^[A-Za-z0-9._~-]{1,255}$/.test(parsed.native.operationName.slice(n.operationPrefix.length)))
    || parsed.native.acknowledgment === 'acknowledged' && !parsed.native.operationName
    || parsed.resources.some(resource => resource.id !== n.repositoryName || resource.identity.owner !== n.owner
      || resource.identity.attemptId !== parsed.native.attemptId)) fail('identity_mismatch');
  return parsed;
}
function evidence(context: ActionContext, attemptId: string, acknowledgment: 'acknowledged' | 'unknown',
  operationName?: string, resource?: CloudInstallationEvidence['resources'][number]): CloudInstallationEvidence {
  return parseEvidence({ resources: resource ? [resource] : [], native: { operation: 'create-operator-registry-v1',
    installationId: context.intent.installationId, attemptId, acknowledgment, ...(operationName ? { operationName } : {}) } }, context.intent);
}
function reason(error: unknown) {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof DestinationBoundaryError) return error.status === 401 ? 'authorization_expired' as const
    : error.status === 403 ? 'insufficient_permissions' as const : 'provider_error' as const;
  return 'provider_error' as const;
}

export function deriveGcpLocalArtifactRegistryScope(record: CloudInstallationRecord<Intent>, selection: Record<string, string>): Record<string, string> {
  if (record.status !== 'scope-ready' || record.intent.nativeScope.scopeKind !== 'project-services') fail('not_converged');
  const scope = gcpLocalServicesScopeSchema.parse(record.intent.nativeScope), region = selection.hostingRegion ?? 'us-central1';
  return gcpLocalArtifactRegistryScopeSchema.parse({ ...scope, scopeKind: 'operator-artifact-registry-v1', region,
    artifactRepository: 'hypervibe', artifactRepositoryName: `projects/${scope.projectId}/locations/${region}/repositories/hypervibe` });
}
export function gcpLocalArtifactRegistryBinding(record: CloudInstallationRecord<Intent>) {
  if (record.intent.nativeScope.scopeKind !== 'operator-artifact-registry-v1') fail('identity_mismatch');
  if (record.status !== 'scope-ready') fail('not_converged');
  const n = names(record.intent), proof = parseEvidence(record.completed[action(record.intent).id], record.intent), resource = proof.resources[0];
  if (!resource) fail('not_converged');
  return { region: n.region, artifactRepository: n.artifactRepository, artifactRepositoryName: n.artifactRepositoryName,
    artifactRepositoryCreateTime: resource.identity.createTime };
}

export function deriveGcpLocalPublicArtifactRegistryScope(record: CloudInstallationRecord<Intent>): Record<string, string> {
  if (record.status !== 'scope-ready' || record.intent.nativeScope.scopeKind !== 'operator-artifact-registry-v1') fail('not_converged');
  const binding = gcpLocalArtifactRegistryBinding(record), proof = parseEvidence(record.completed[ACTION], record.intent);
  return gcpLocalPublicArtifactRegistryScopeSchema.parse({ ...record.intent.nativeScope, ...binding, scopeKind: 'operator-public-artifact-registry-v1',
    artifactInstallationId: record.intent.installationId, artifactAttemptId: proof.resources[0]!.identity.attemptId,
    publicArtifactRepository: 'operator-public', publicArtifactRepositoryName: `projects/${record.intent.nativeScope.projectId}/locations/${binding.region}/repositories/operator-public` });
}
export function gcpLocalPublicArtifactBinding(record: CloudInstallationRecord<Intent>) {
  if (record.status !== 'scope-ready') fail('not_converged');
  const n = names(record.intent), created = parseEvidence(record.completed[PUBLIC_CREATE], record.intent), grant = parseEvidence(record.completed[PUBLIC_GRANT], record.intent);
  if (!n.publicRepository || !created.resources[0] || !isDeepStrictEqual(created.resources, grant.resources)) fail('not_converged');
  return { publicArtifactRepository: 'operator-public', publicArtifactRepositoryName: n.repositoryName,
    publicArtifactRepositoryCreateTime: created.resources[0].identity.createTime,
    publicArtifactInstallationId: record.intent.installationId, publicArtifactAttemptId: created.resources[0].identity.attemptId };
}

export function createGcpLocalArtifactRegistryDriver(options: { fetch?: typeof fetch; public?: boolean } = {}): CloudInstallationDriver<Intent> {
  const request = options.fetch ?? fetch;
  async function withClient<T>(context: Context, work: (client: GcpSecretWriterClient) => Promise<T>): Promise<T> {
    const n = names(context.intent), budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', budget.signal));
      const client = new GcpSecretWriterClient({ token, budget, request, beforeWrite: context.beforeMutation, sleep: async () => {} });
      const project = await client.bootstrap.getProject(n.projectId);
      const owner = createHash('sha256').update(JSON.stringify([context.intent.customerId, context.intent.appId, context.intent.environment, n.projectInstallationId])).digest('hex');
      if (!project || project.name !== `projects/${n.projectNumber}` || project.projectId !== n.projectId || project.state !== 'ACTIVE'
        || project.createTime !== n.projectCreateTime || (project.parent ?? 'none') !== n.projectParent
        || project.labels?.['hv-installation'] !== owner.slice(0, 63) || project.labels?.['hv-attempt'] !== n.projectAttemptId) fail();
      const billing = await client.bootstrap.getProjectBillingInfo(n.projectId);
      if (!billing || billing.billingAccountName !== n.billingAccountName || !billing.billingEnabled) fail();
      if (n.publicRepository) {
        const scope = gcpLocalPublicArtifactRegistryScopeSchema.parse(context.intent.nativeScope);
        const privateRepository = await client.json(`https://artifactregistry.googleapis.com/v1/${scope.artifactRepositoryName}`);
        const privateOwner = createHash('sha256').update(JSON.stringify([context.intent.customerId, context.intent.appId, context.intent.environment, scope.artifactInstallationId])).digest('hex');
        if (privateRepository.name !== scope.artifactRepositoryName || privateRepository.createTime !== scope.artifactRepositoryCreateTime
          || privateRepository.description !== `hypervibe:operator-registry:${privateOwner}:${scope.artifactAttemptId}`
          || privateRepository.format !== 'DOCKER' || privateRepository.mode !== 'STANDARD_REPOSITORY') fail();
      }
      return await work(client);
    } finally { budget.close(); }
  }
  async function read(client: GcpSecretWriterClient, context: Context): Promise<Record<string, unknown> | null> {
    try { return await client.json(`https://artifactregistry.googleapis.com/v1/${names(context.intent).repositoryName}`); }
    catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
  }
  function owned(value: Record<string, unknown>, context: ActionContext, attemptId: string, createTime?: string) {
    const n = names(context.intent);
    if (value.name !== n.repositoryName || value.format !== 'DOCKER' || value.mode !== 'STANDARD_REPOSITORY'
      || value.description !== `hypervibe:operator-registry:${n.owner}:${attemptId}` || !z.string().datetime().safeParse(value.createTime).success
      || createTime && value.createTime !== createTime || value.remoteRepositoryConfig || value.virtualRepositoryConfig || value.kmsKeyName) fail();
    return { kind: 'registry', id: n.repositoryName, identity: { owner: n.owner, attemptId, createTime: String(value.createTime) } };
  }
  async function createdPublic(client: GcpSecretWriterClient, context: ActionContext) {
    const completed = context.completed[PUBLIC_CREATE]; if (!completed) fail('not_converged');
    const proof = parseEvidence(completed, context.intent), previous = proof.resources[0];
    const value = await read(client, context); if (!value || !previous) fail();
    return owned(value, context, previous.identity.attemptId, previous.identity.createTime);
  }
  async function publicPolicy(client: GcpSecretWriterClient, context: Context) {
    return parseGcpRuntimePolicy(await client.json(`https://artifactregistry.googleapis.com/v1/${names(context.intent).repositoryName}:getIamPolicy?options.requestedPolicyVersion=3`));
  }
  function grantEvidence(context: ActionContext, resource: CloudInstallationEvidence['resources'][number]) {
    if (!context.attempt) fail('identity_mismatch');
    return parseEvidence({ resources: [resource], native: { operation: 'grant-public-operator-registry-v1', installationId: context.intent.installationId,
      attemptId: context.attempt.id, policyResource: names(context.intent).repositoryName, role: 'roles/artifactregistry.reader', member: 'allUsers' } }, context.intent);
  }
  async function inspectGrant(client: GcpSecretWriterClient, context: ActionContext, recovering: boolean) {
    if (!context.completed[PUBLIC_CREATE]) return { state: 'action-required' as const };
    const resource = await createdPublic(client, context), policy = await publicPolicy(client, context);
    const present = hasGcpRuntimeRole(policy, 'roles/artifactregistry.reader', 'allUsers');
    if (recovering) return present ? { state: 'satisfied' as const, evidence: grantEvidence(context, resource) } : { state: 'pending' as const, reason: 'not_converged' as const };
    const completed = context.completed[PUBLIC_GRANT];
    if (completed) {
      const proof = parseEvidence(completed, context.intent);
      if (!present || !isDeepStrictEqual(proof.resources, [resource])) fail();
      return { state: 'satisfied' as const, evidence: proof };
    }
    if (present) fail();
    return { state: 'action-required' as const };
  }
  const driver: CloudInstallationDriver<Intent> = {
    provider: 'gcp', localScopePreparation: { hostingProvider: 'cloudrun', continuation: true },
    parseScope: value => (options.public ? gcpLocalPublicArtifactRegistryScopeSchema : gcpLocalArtifactRegistryScopeSchema).parse(value), parseEvidence,
    parseAction(value, intent) { const expected = [action(intent), ...(names(intent).publicRepository ? [publicGrantAction(intent)] : [])].find(candidate => isDeepStrictEqual(candidate, value)); if (!expected) fail('identity_mismatch'); return expected; },
    scopePreparation: { resolvedScope: record => names(record.intent).publicRepository
      ? { ...gcpLocalPublicArtifactRegistryScopeSchema.parse(record.intent.nativeScope), ...gcpLocalPublicArtifactBinding(record) }
      : { ...gcpLocalArtifactRegistryScopeSchema.parse(record.intent.nativeScope), ...gcpLocalArtifactRegistryBinding(record) },
      reviewResources: record => [{ kind: 'registry', name: names(record.intent).repositoryName, scope: names(record.intent).region }] },
    async plan(context) {
      const requestedPermissions = ['artifactregistry.repositories.get', 'artifactregistry.repositories.create', ...(options.public ? ['artifactregistry.repositories.getIamPolicy', 'artifactregistry.repositories.setIamPolicy'] : [])];
      await withClient(context, async client => {
        if (names(context.intent).publicRepository && context.completed[PUBLIC_CREATE])
          await createdPublic(client, { ...context, action: publicGrantAction(context.intent) });
        else if (await read(client, context)) fail();
        const permissions = (await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${names(context.intent).projectNumber}:testIamPermissions`,
          { method: 'POST', body: JSON.stringify({ permissions: requestedPermissions }) })).permissions;
        if (!Array.isArray(permissions) || !requestedPermissions.every(permission => permissions.includes(permission))) fail('insufficient_permissions');
      });
      const n = names(context.intent);
      return { actions: [action(context.intent), ...(n.publicRepository ? [publicGrantAction(context.intent)] : [])], review: { resources: [{ kind: 'registry', name: n.repositoryName, scope: n.region }],
        permissions: [{ principal: 'Local browser-authorized administrator', scope: n.repositoryName,
          actions: requestedPermissions, purpose: 'installation-verification' }],
        costs: [{ resource: n.repositoryName, description: 'Image storage and network transfer can incur charges; this step uploads no images.',
          pricingUrl: 'https://cloud.google.com/artifact-registry/pricing' }],
        warnings: [n.publicRepository ? 'The separate reader action makes every current and future image in operator-public public. Never upload application images or secrets there. Creation alone does not authorize the reader grant.' : 'No image upload, public access, IAM grant or deletion is authorized by this repository creation action.',
          'Uncertain creation is recovered only by the exact durable attempt marker and native lifetime; it is never blindly resubmitted.'] } };
    },
    async inspect(context) {
      try { driver.parseAction(context.action, context.intent); return await withClient(context, async client => {
        if (context.action.id === PUBLIC_GRANT) return inspectGrant(client, context, false);
        const value = await read(client, context), completed = context.completed[action(context.intent).id];
        if (!completed) { if (value) fail(); return { state: 'action-required' as const }; }
        if (!value) fail();
        const proof = parseEvidence(completed, context.intent), prior = proof.resources[0];
        if (!prior) fail(); owned(value, context, prior.identity.attemptId, prior.identity.createTime);
        return { state: 'satisfied' as const, evidence: proof };
      }); } catch (error) { return { state: 'unknown', reason: reason(error) }; }
    },
    async mutate(context) {
      let write = false, retry = () => true;
      try { driver.parseAction(context.action, context.intent); return await withClient(context, async client => {
        if (context.action.id === PUBLIC_GRANT) {
          const n = names(context.intent), resource = await createdPublic(client, context);
          const policy = await publicPolicy(client, context);
          if (hasGcpRuntimeRole(policy, 'roles/artifactregistry.reader', 'allUsers')) fail();
          client.beginMutation(); retry = () => client.canRetryRejectedMutation(); write = true;
          await client.json(`https://artifactregistry.googleapis.com/v1/${n.repositoryName}:setIamPolicy`, { method: 'POST',
            body: JSON.stringify({ policy: withGcpRuntimeRole(policy, 'roles/artifactregistry.reader', 'allUsers') }) }, true);
          return { state: 'acknowledged' as const, evidence: grantEvidence(context, resource) };
        }
        if (await read(client, context)) fail();
        const n = names(context.intent); client.beginMutation(); retry = () => client.canRetryRejectedMutation(); write = true;
        const response = await client.json(`https://artifactregistry.googleapis.com/v1/projects/${n.projectId}/locations/${n.region}/repositories?repositoryId=${n.repositoryId}`,
          { method: 'POST', body: JSON.stringify({ format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
            description: `hypervibe:operator-registry:${n.owner}:${context.attempt.id}` }) }, true);
        let proof: CloudInstallationEvidence;
        try { proof = evidence(context, context.attempt.id, 'acknowledged', z.string().parse(response.name)); }
        catch { return { state: 'uncertain' as const, reason: 'identity_mismatch' as const }; }
        return { state: 'acknowledged' as const, evidence: proof };
      }); } catch (error) { return write && !retry()
        ? { state: 'uncertain', reason: reason(error) }
        : { state: 'rejected', reason: reason(error) }; }
    },
    async recover(context) {
      try { driver.parseAction(context.action, context.intent); return await withClient(context, async client => {
        if (context.action.id === PUBLIC_GRANT) return inspectGrant(client, context, true);
        if (context.attempt.reason === 'identity_mismatch') fail('identity_mismatch');
        const proof = context.attempt.evidence ? parseEvidence(context.attempt.evidence, context.intent) : undefined;
        let verifiedCreateTime = proof?.resources[0]?.identity.createTime;
        const operationName = proof?.native.operationName as string | undefined;
        if (operationName) {
          const result = await client.json(`https://artifactregistry.googleapis.com/v1/${operationName}`);
          if (result.name !== operationName || result.error) fail('not_converged');
          if (result.done !== true) return { state: 'pending' as const, reason: 'not_converged' as const };
          const resource = result.response;
          if (!resource || typeof resource !== 'object' || Array.isArray(resource)
            || (resource as Record<string, unknown>)['@type'] !== 'type.googleapis.com/google.devtools.artifactregistry.v1.Repository') fail('identity_mismatch');
          verifiedCreateTime = owned(resource as Record<string, unknown>, context, context.attempt.id, verifiedCreateTime).identity.createTime;
        }
        const value = await read(client, context);
        if (!value) return { state: 'pending' as const, reason: 'not_converged' as const };
        const resource = owned(value, context, context.attempt.id, verifiedCreateTime);
        return { state: 'satisfied' as const, evidence: evidence(context, context.attempt.id,
          operationName ? 'acknowledged' : 'unknown', operationName, resource) };
      }); } catch (error) { return { state: 'unknown', reason: reason(error) }; }
    }, connections: () => [],
  };
  return driver;
}
