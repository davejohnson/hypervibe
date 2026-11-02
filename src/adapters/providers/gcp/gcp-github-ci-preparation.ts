import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationProviderContext, type CloudInstallationRecord, type LocalCloudScopePreparationIntent } from '../../../domain/ports/cloud-installation.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { GcpSecretWriterClient, type WriterIamPolicy } from './gcp-secret-writer.client.js';
import { gcpLocalArtifactRegistryScopeSchema, gcpLocalArtifactRegistryBinding, gcpLocalPublicArtifactProofShape, gcpLocalPublicArtifactRegistryScopeSchema, gcpLocalPublicArtifactBinding } from './gcp-local-artifact-registry.js';
import { gcpGithubWorkloadIdentitySchema, type GcpGithubWorkloadIdentity } from './gcp-github-workload-identity.js';

export const gcpGithubCiPreparationSelectionSchema = z.object({
  githubRepository: gcpGithubWorkloadIdentitySchema.shape.repository,
  githubRepositoryId: gcpGithubWorkloadIdentitySchema.shape.repositoryId,
  githubRepositoryOwnerId: gcpGithubWorkloadIdentitySchema.shape.repositoryOwnerId,
  githubBranch: gcpGithubWorkloadIdentitySchema.shape.branch,
  githubWorkflow: gcpGithubWorkloadIdentitySchema.shape.workflow,
  githubBackupWorkflow: gcpGithubWorkloadIdentitySchema.shape.backupWorkflow,
}).strict();
const optionalPublicProof = { artifactInstallationId: z.string().guid().optional(), artifactAttemptId: z.string().guid().optional(),
  publicArtifactRepository: gcpLocalPublicArtifactProofShape.publicArtifactRepository.optional(),
  publicArtifactRepositoryName: gcpLocalPublicArtifactProofShape.publicArtifactRepositoryName.optional(),
  publicArtifactRepositoryCreateTime: gcpLocalPublicArtifactProofShape.publicArtifactRepositoryCreateTime.optional(),
  publicArtifactInstallationId: gcpLocalPublicArtifactProofShape.publicArtifactInstallationId.optional(),
  publicArtifactAttemptId: gcpLocalPublicArtifactProofShape.publicArtifactAttemptId.optional(),
};
function registryScope(value: { projectId: string; region: string; artifactRepository: string; artifactRepositoryName: string;
  artifactInstallationId?: string; artifactAttemptId?: string; publicArtifactRepository?: string; publicArtifactRepositoryName?: string;
  publicArtifactRepositoryCreateTime?: string; publicArtifactInstallationId?: string; publicArtifactAttemptId?: string }, ctx: z.RefinementCtx) {
  if (value.artifactRepositoryName !== `projects/${value.projectId}/locations/${value.region}/repositories/${value.artifactRepository}`)
    ctx.addIssue({ code: 'custom', message: 'Image repository does not match the reviewed project and region.' });
  const privateCount = ['artifactInstallationId', 'artifactAttemptId'].filter(key => (value as Record<string, unknown>)[key] !== undefined).length;
  const count = Object.keys(gcpLocalPublicArtifactProofShape).filter(key => (value as Record<string, unknown>)[key] !== undefined).length;
  if (privateCount !== 0 && privateCount !== 2 || count !== 0 && (count !== Object.keys(gcpLocalPublicArtifactProofShape).length || privateCount !== 2) || count > 0
    && value.publicArtifactRepositoryName !== `projects/${value.projectId}/locations/${value.region}/repositories/operator-public`)
    ctx.addIssue({ code: 'custom', message: 'Public helper proof must be complete and retain its separate exact repository.' });
}
export const gcpGithubCiPreparationScopeSchema = z.object({ ...gcpLocalArtifactRegistryScopeSchema.shape,
  scopeKind: z.literal('github-ci-identity'), artifactRepositoryCreateTime: z.string().datetime(), ...optionalPublicProof, ...gcpGithubCiPreparationSelectionSchema.shape,
}).strict().superRefine(registryScope);
export const gcpGithubCiDisconnectionScopeSchema = z.object({ ...gcpGithubCiPreparationScopeSchema.shape,
  scopeKind: z.literal('github-ci-disconnection'), ciInstallationId: z.string().guid(), ciPlanDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ciAccountUniqueId: z.string().regex(/^[1-9]\d{5,29}$/), ciAccountAttemptId: z.string().guid(), ciPoolAttemptId: z.string().guid(),
  ciProviderAttemptId: z.string().guid(), ciRoleAttemptId: z.string().guid(),
  quotaPrerequisiteInstallationId: z.string().guid().optional(), quotaPrerequisitePlanDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((scope, context) => {
  registryScope(scope, context);
  if (Boolean(scope.quotaPrerequisiteInstallationId) !== Boolean(scope.quotaPrerequisitePlanDigest))
    context.addIssue({ code: 'custom', message: 'The retained quota prerequisite identity must be complete.' });
});
function parseScope(value: unknown) { return z.union([gcpGithubCiPreparationScopeSchema, gcpGithubCiDisconnectionScopeSchema]).parse(value); }
type Intent = LocalCloudScopePreparationIntent;
type Context = CloudInstallationProviderContext<Intent>;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
type InstallationRecord = CloudInstallationRecord<Intent>;
const operations = ['create-pool', 'create-account', 'create-provider', 'create-role', 'grant-role', 'grant-registry', 'grant-trust', 'revoke-trust', 'revoke-registry', 'revoke-role'] as const;
type Operation = typeof operations[number];
// A dedicated app/environment project is verified from the allocation journal.
// Deployment cannot create services, databases, IAM identities or persistent
// registries. Backup's separately declared controller may create ephemeral jobs.
const releasePermissions = [ 'iam.serviceAccounts.get', 'iam.serviceAccounts.getIamPolicy',
  'resourcemanager.projects.get', 'run.services.get', 'run.services.update', 'run.jobs.get', 'run.jobs.update', 'run.jobs.run',
  'run.operations.get', 'run.executions.get'];
const backupPermissions = ['cloudsql.instances.get', 'resourcemanager.projects.getIamPolicy', 'run.jobs.create', 'run.jobs.delete',
  'run.executions.delete', 'run.tasks.get', 'run.tasks.list', 'secretmanager.secrets.get', 'secretmanager.secrets.getIamPolicy',
  'secretmanager.versions.get', 'secretmanager.versions.list', 'storage.buckets.get', 'storage.buckets.list', 'storage.buckets.getIamPolicy',
  // Object reads/writes belong to the separately reviewed exact archive bucket grant.
];
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['workloadIdentityPool', 'workloadIdentityProvider', 'serviceAccount', 'role']),
  id: z.string().max(1024), identity: z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/), attemptId: z.string().guid(),
    uniqueId: z.string().regex(/^[1-9]\d{5,29}$/).optional() }).strict() }).strict()).max(1),
  native: z.object({ operation: z.enum(operations), actionId: z.string(), installationId: z.string().guid(),
    attemptId: z.string().guid().optional(), operationName: z.string().max(2048).optional(), policyResource: z.string().max(1024).optional(),
    role: z.string().max(1024).optional(), member: z.string().max(2048).optional() }).strict() }).strict();
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'ownership_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function names(intent: Intent) {
  const scope = parseScope(intent.nativeScope);
  if (intent.provider !== 'gcp' || intent.hostingProvider !== 'cloudrun' || intent.stage !== 'scope-preparation' || !intent.predecessor
    || intent.source.repository.replace(/^https:\/\//, '').replace(/\.git$/, '') !== `github.com/${scope.githubRepository}`) fail();
  if (scope.scopeKind === 'github-ci-disconnection' && (intent.predecessor.installationId !== (scope.quotaPrerequisiteInstallationId ?? scope.ciInstallationId)
    || intent.predecessor.planDigest !== (scope.quotaPrerequisitePlanDigest ?? scope.ciPlanDigest) || intent.installationId === scope.ciInstallationId)) fail('identity_mismatch');
  const parts = [intent.customerId, intent.appId, intent.environment, scope.scopeKind === 'github-ci-disconnection' ? scope.ciInstallationId : intent.installationId];
  const owner = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const poolId = resourceName('ci', { minLength: 4, maxLength: 32, scope: parts });
  const accountId = resourceName('ci', { minLength: 6, maxLength: 30, scope: parts });
  const roleId = resourceName('ci', { compact: true, scope: parts });
  const pool = `projects/${scope.projectNumber}/locations/global/workloadIdentityPools/${poolId}`;
  const accountEmail = `${accountId}@${scope.projectId}.iam.gserviceaccount.com`;
  return { ...scope, owner, poolId, pool, provider: `${pool}/providers/github`, accountId, accountEmail,
    account: `projects/${scope.projectId}/serviceAccounts/${accountEmail}`, roleId, role: `projects/${scope.projectId}/roles/${roleId}`,
    member: `principalSet://iam.googleapis.com/${pool}/attribute.repository_id/${scope.githubRepositoryId}`,
    permissions: [...new Set([...releasePermissions, ...(scope.githubBackupWorkflow ? backupPermissions : [])])].sort() };
}
export function gcpGithubCiAttributeCondition(intent: Intent): string {
  const n = names(intent), quote = JSON.stringify;
  const workflow = `${n.githubRepository}/${n.githubWorkflow}@refs/heads/${n.githubBranch}`;
  const release = `(assertion.workflow_ref == ${quote(workflow)} && assertion.event_name in ['push', 'workflow_dispatch'])`;
  const backup = n.githubBackupWorkflow ? ` || (assertion.workflow_ref == ${quote(`${n.githubRepository}/${n.githubBackupWorkflow}@refs/heads/${n.githubBranch}`)} && assertion.event_name in ['schedule', 'workflow_dispatch'])` : '';
  return `assertion.repository_id == ${quote(n.githubRepositoryId)} && assertion.repository_owner_id == ${quote(n.githubRepositoryOwnerId)} && assertion.repository == ${quote(n.githubRepository)} && assertion.ref == ${quote(`refs/heads/${n.githubBranch}`)} && assertion.sub == ${quote(`repo:${n.githubRepository}:environment:${intent.environment}`)} && (${release}${backup})`;
}
function providerBody(intent: Intent, attemptId: string) {
  const n = names(intent);
  return { displayName: 'Hypervibe GitHub CI', description: `hypervibe:${n.owner}:${attemptId}`, disabled: false,
    attributeMapping: { 'google.subject': 'assertion.sub', 'attribute.repository_id': 'assertion.repository_id',
      'attribute.repository_owner_id': 'assertion.repository_owner_id', 'attribute.repository': 'assertion.repository',
      'attribute.ref': 'assertion.ref', 'attribute.workflow_ref': 'assertion.workflow_ref', 'attribute.event_name': 'assertion.event_name' },
    attributeCondition: gcpGithubCiAttributeCondition(intent),
    oidc: { issuerUri: 'https://token.actions.githubusercontent.com', allowedAudiences: [`https://iam.googleapis.com/${n.provider}`] } };
}
function isRevocation(operation: string) { return operation.startsWith('revoke-'); }
function actions(intent: Intent): CloudInstallationAction[] {
  const n = names(intent);
  const action = (operation: Operation, resource: string, dependencies: Operation[] = []): CloudInstallationAction => ({
    id: `gcp:github-ci:${operation}`, type: operation.startsWith('create-') ? 'create' : 'update',
    resource: { kind: 'project', name: resource, provider: 'gcp' }, verified: true, requiresConfirm: true,
    dependsOn: dependencies.map(dependency => `gcp:github-ci:${dependency}`),
    reason: isRevocation(operation) ? 'Remove only this installation’s verified CI grant, preserving unrelated permissions, native identities, stored secrets and separately authorized runtime access.'
      : operation === 'grant-trust' ? 'Allow only the reviewed GitHub workflow identity to impersonate this dedicated CI service account for short-lived access.'
      : operation.startsWith('grant-') ? 'Grant only the reviewed deployment and optional backup-controller permissions inside this isolated app/environment project.'
        : 'Prepare one owned identity resource for this exact app, environment and reviewed GitHub source; create no keys or workloads.',
    metadata: { operation, category: operation.startsWith('grant-') || isRevocation(operation) ? 'trust' : 'identity', execution: 'api', native: {} },
  });
  if (n.scopeKind === 'github-ci-disconnection') return [action('revoke-trust', n.account),
    action('revoke-registry', n.artifactRepositoryName, ['revoke-trust']),
    action('revoke-role', `projects/${n.projectNumber}`, ['revoke-registry'])];
  return [action('create-pool', n.pool), action('create-account', n.account), action('create-provider', n.provider, ['create-pool']),
    action('create-role', n.role), action('grant-role', `projects/${n.projectNumber}`, ['create-account', 'create-role']),
    action('grant-registry', n.artifactRepositoryName, ['create-account']),
    action('grant-trust', n.account, ['create-account', 'create-provider', 'grant-role', 'grant-registry'])];
}
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const parsed = evidenceSchema.parse(value), n = names(intent);
  const action = actions(intent).find(item => item.id === parsed.native.actionId);
  if (!action || parsed.native.installationId !== intent.installationId || parsed.native.operation !== action.metadata.operation) fail();
  if (parsed.native.operationName && (!parsed.native.operationName.startsWith((parsed.native.operation === 'create-pool' ? n.pool : n.provider) + '/operations/')
    || !/^[A-Za-z0-9._~-]+$/.test(parsed.native.operationName.split('/').at(-1)!))) fail('identity_mismatch');
  const operation = parsed.native.operation;
  const expectedKind = operation === 'create-pool' ? 'workloadIdentityPool' : operation === 'create-provider' ? 'workloadIdentityProvider'
    : operation === 'create-role' ? 'role' : 'serviceAccount';
  for (const resource of parsed.resources) {
    const expectedId = expectedKind === 'workloadIdentityPool' ? n.pool : expectedKind === 'workloadIdentityProvider' ? n.provider : expectedKind === 'role' ? n.role : n.account;
    if (resource.kind !== expectedKind || resource.id !== expectedId || resource.identity.owner !== n.owner
      || expectedKind === 'serviceAccount' && !resource.identity.uniqueId
      || operation.startsWith('create-') && resource.identity.attemptId !== parsed.native.attemptId) fail();
  }
  if (!parsed.resources.length && (!['create-pool', 'create-provider'].includes(operation) || !parsed.native.operationName)) fail();
  if (!isRevocation(operation) && !parsed.native.attemptId) fail();
  if (operation.startsWith('grant-') || isRevocation(operation)) {
    const resource = operation.endsWith('-trust') ? `projects/${n.projectId}/serviceAccounts/${parsed.resources[0]?.identity.uniqueId}`
      : operation.endsWith('-registry') ? n.artifactRepositoryName : `projects/${n.projectNumber}`;
    const role = operation.endsWith('-trust') ? 'roles/iam.workloadIdentityUser' : operation.endsWith('-registry') ? 'roles/artifactregistry.writer' : n.role;
    const member = operation.endsWith('-trust') ? n.member : `serviceAccount:${n.accountEmail}`;
    if (parsed.native.policyResource !== resource || parsed.native.role !== role || parsed.native.member !== member) fail();
  }
  return parsed;
}
function proof(context: ActionContext, resources: CloudInstallationEvidence['resources'], extra: { operationName?: string; policyResource?: string; role?: string; member?: string } = {}): CloudInstallationEvidence {
  if (!context.attempt && !isRevocation(context.action.metadata.operation)) fail();
  const operationName = extra.operationName ?? (typeof context.attempt?.evidence?.native.operationName === 'string' ? context.attempt.evidence.native.operationName : undefined);
  return parseEvidence({ resources, native: { operation: context.action.metadata.operation, actionId: context.action.id,
    installationId: context.intent.installationId, ...(context.attempt ? { attemptId: context.attempt.id } : {}),
    ...(operationName ? { operationName } : {}),
    ...(extra.policyResource ? { policyResource: extra.policyResource, role: extra.role, member: extra.member } : {}) } }, context.intent);
}
function reason(error: unknown) {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof DestinationBoundaryError) return error.status === 403 ? 'insufficient_permissions' as const
    : error.status === 401 ? 'authorization_expired' as const : error.code === 'deadline_exceeded' ? 'timeout' as const : 'provider_error' as const;
  return 'provider_error' as const;
}

export function createGcpGithubCiPreparationDriver(options: { fetch?: typeof fetch } = {}): CloudInstallationDriver<Intent> {
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
      const registry = await client.json(`https://artifactregistry.googleapis.com/v1/${n.artifactRepositoryName}`);
      if (registry.name !== n.artifactRepositoryName || registry.format !== 'DOCKER' || registry.mode !== 'STANDARD_REPOSITORY'
        || registry.createTime !== n.artifactRepositoryCreateTime) fail('identity_mismatch');
      const ownerHash = (id: string) => createHash('sha256').update(JSON.stringify([context.intent.customerId, context.intent.appId, context.intent.environment, id])).digest('hex');
      if (n.artifactInstallationId) {
        if (registry.description !== `hypervibe:operator-registry:${ownerHash(n.artifactInstallationId)}:${n.artifactAttemptId}`) fail('identity_mismatch');
      }
      if (n.publicArtifactRepositoryName) {
        const helper = await client.json(`https://artifactregistry.googleapis.com/v1/${n.publicArtifactRepositoryName}`);
        if (helper.name !== n.publicArtifactRepositoryName || helper.format !== 'DOCKER' || helper.mode !== 'STANDARD_REPOSITORY'
          || helper.createTime !== n.publicArtifactRepositoryCreateTime
          || helper.description !== `hypervibe:operator-registry:${ownerHash(n.publicArtifactInstallationId!)}:${n.publicArtifactAttemptId}`) fail('identity_mismatch');
      }
      return await work(client);
    } finally { budget.close(); }
  }
  async function resource(client: GcpSecretWriterClient, context: Context, operation: Operation) {
    const n = names(context.intent);
    const id = operation === 'create-pool' ? n.pool : operation === 'create-provider' ? n.provider : operation === 'create-role' ? n.role : n.account;
    let value;
    try { value = await client.json(`https://iam.googleapis.com/v1/${id}`); }
    catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
    const marker = typeof value.description === 'string' && /^hypervibe:([a-f0-9]{64}):([a-f0-9-]{36})$/.exec(value.description);
    if (value.name !== id || !marker || marker[1] !== n.owner || value.disabled !== undefined && value.disabled !== false) fail();
    const kind = operation === 'create-pool' ? 'workloadIdentityPool' : operation === 'create-provider' ? 'workloadIdentityProvider' : operation === 'create-role' ? 'role' : 'serviceAccount';
    if (kind === 'serviceAccount' && (value.email !== n.accountEmail || value.projectId !== n.projectId || typeof value.uniqueId !== 'string' || !/^[1-9]\d{5,29}$/.test(value.uniqueId))) fail();
    if (kind === 'role' && (value.stage !== 'GA' || value.deleted !== undefined && value.deleted !== false
      || !Array.isArray(value.includedPermissions) || !isDeepStrictEqual([...value.includedPermissions].sort(), n.permissions))) fail();
    if (kind === 'workloadIdentityPool' && (value.state !== 'ACTIVE' || value.mode !== 'FEDERATION_ONLY' || value.inlineTrustConfig || value.inlineCertificateIssuanceConfig)) fail();
    if (kind === 'workloadIdentityProvider') {
      const expected = providerBody(context.intent, marker[2]);
      if (value.state !== 'ACTIVE' || !isDeepStrictEqual(value.attributeMapping, expected.attributeMapping)
        || value.attributeCondition !== expected.attributeCondition || !isDeepStrictEqual(value.oidc, expected.oidc)
        || value.aws || value.saml || value.x509) fail();
    }
    return { kind, id, identity: { owner: n.owner, attemptId: z.string().guid().parse(marker[2]),
      ...(kind === 'serviceAccount' ? { uniqueId: String(value.uniqueId) } : {}) } } satisfies CloudInstallationEvidence['resources'][number];
  }
  async function owned(client: GcpSecretWriterClient, context: Context, operation: Operation) {
    const n = names(context.intent);
    const retained = context.completed[`gcp:github-ci:${operation}`];
    const existing = n.scopeKind === 'github-ci-disconnection' ? {
      kind: operation === 'create-pool' ? 'workloadIdentityPool' : operation === 'create-provider' ? 'workloadIdentityProvider'
        : operation === 'create-role' ? 'role' : 'serviceAccount',
      id: operation === 'create-pool' ? n.pool : operation === 'create-provider' ? n.provider : operation === 'create-role' ? n.role : n.account,
      identity: { owner: n.owner, attemptId: operation === 'create-pool' ? n.ciPoolAttemptId : operation === 'create-provider'
        ? n.ciProviderAttemptId : operation === 'create-role' ? n.ciRoleAttemptId : n.ciAccountAttemptId,
        ...(operation === 'create-account' ? { uniqueId: n.ciAccountUniqueId } : {}) },
    } : retained && parseEvidence(retained, context.intent).resources[0];
    const current = await resource(client, context, operation);
    if (!current || !existing || !isDeepStrictEqual(current, existing)) fail('identity_mismatch');
    return current;
  }
  async function grant(client: GcpSecretWriterClient, context: ActionContext) {
    const n = names(context.intent), account = await owned(client, context, 'create-account');
    if (context.action.metadata.operation.endsWith('-role')) await owned(client, context, 'create-role');
    if (context.action.metadata.operation.endsWith('-trust')) { await owned(client, context, 'create-pool'); await owned(client, context, 'create-provider'); }
    const trust = context.action.metadata.operation.endsWith('-trust');
    const policyResource = trust ? `projects/${n.projectId}/serviceAccounts/${account.identity.uniqueId}`
      : context.action.metadata.operation.endsWith('-registry') ? n.artifactRepositoryName : `projects/${n.projectNumber}`;
    const role = trust ? 'roles/iam.workloadIdentityUser' : context.action.metadata.operation.endsWith('-registry') ? 'roles/artifactregistry.writer' : n.role;
    const member = trust ? n.member : `serviceAccount:${n.accountEmail}`;
    const kind = trust ? 'account' as const : context.action.metadata.operation.endsWith('-registry') ? 'registry' as const : 'project' as const;
    const policy = await client.policy(kind, policyResource);
    if (isRevocation(context.action.metadata.operation) && policy.bindings.some(binding => binding.role === role && binding.condition && binding.members.includes(member))) fail('ownership_mismatch');
    const present = policy.bindings.some(binding => binding.role === role && !binding.condition && binding.members.includes(member));
    return { account, policyResource, role, member, kind, policy, present };
  }
  async function observe(client: GcpSecretWriterClient, context: ActionContext) {
    const operation = context.action.metadata.operation as Operation;
    if (operation.startsWith('grant-') || isRevocation(operation)) {
      const value = await grant(client, context);
      if (isRevocation(operation) ? value.present : !value.present) return context.attempt ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
      if (!context.attempt && !isRevocation(operation)) fail();
      return { state: 'satisfied' as const, evidence: proof(context, [value.account], value) };
    }
    if (operation === 'create-provider') await owned(client, context, 'create-pool');
    const observed = await resource(client, context, operation);
    if (!observed) return context.attempt ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
    if (!context.attempt || observed.identity.attemptId !== context.attempt.id) fail();
    const retained = context.completed[context.action.id] ?? context.attempt.evidence;
    if (retained && parseEvidence(retained, context.intent).resources.length && !isDeepStrictEqual(parseEvidence(retained, context.intent).resources, [observed])) fail('identity_mismatch');
    return { state: 'satisfied' as const, evidence: proof(context, [observed]) };
  }
  const driver: CloudInstallationDriver<Intent> = {
    provider: 'gcp', localScopePreparation: { hostingProvider: 'cloudrun', continuation: true },
    parseScope, parseEvidence,
    parseAction(value, intent) { const expected = actions(intent).find(item => isDeepStrictEqual(item, value)); if (!expected) fail('identity_mismatch'); return expected; },
    scopePreparation: { resolvedScope(record) {
      if (record.intent.nativeScope.scopeKind === 'github-ci-disconnection') gcpGithubCiDisconnectionReady(record); else gcpGithubCiPreparationBinding(record);
      return parseScope(record.intent.nativeScope); },
      reviewResources(record) { return actions(record.intent).filter(action => action.type === 'create' || isRevocation(action.metadata.operation)).map(action => ({ kind: action.metadata.operation,
        name: action.resource.name, scope: `projects/${record.intent.nativeScope.projectNumber}` })); } },
    async plan(context) {
      const n = names(context.intent);
      await withClient(context, async client => {
        const permissions = n.scopeKind === 'github-ci-disconnection' ? ['iam.serviceAccounts.setIamPolicy', 'resourcemanager.projects.setIamPolicy']
          : ['iam.workloadIdentityPools.create', 'iam.workloadIdentityPoolProviders.create', 'iam.serviceAccounts.create',
            'iam.serviceAccounts.setIamPolicy', 'iam.roles.create', 'resourcemanager.projects.setIamPolicy'];
        const result = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}:testIamPermissions`, {
          method: 'POST', body: JSON.stringify({ permissions }),
        });
        if (!Array.isArray(result.permissions) || !permissions.every(permission => (result.permissions as unknown[]).includes(permission))) fail('insufficient_permissions');
        const registryAuthority = await client.json(`https://artifactregistry.googleapis.com/v1/${n.artifactRepositoryName}:testIamPermissions`, {
          method: 'POST', body: JSON.stringify({ permissions: ['artifactregistry.repositories.setIamPolicy'] }),
        });
        if (!Array.isArray(registryAuthority.permissions) || !registryAuthority.permissions.includes('artifactregistry.repositories.setIamPolicy')) fail('insufficient_permissions');
        if (n.scopeKind === 'github-ci-disconnection') {
          for (const operation of ['create-pool', 'create-account', 'create-provider', 'create-role'] as const) await owned(client, context, operation);
          for (const action of actions(context.intent)) await grant(client, { ...context, action });
        } else for (const operation of ['create-pool', 'create-account', 'create-role'] as const) {
          if (context.completed[`gcp:github-ci:${operation}`]) await owned(client, context, operation);
          else if (await resource(client, context, operation)) fail();
        }
      });
      return { actions: actions(context.intent), review: { resources: actions(context.intent).filter(action => action.type === 'create' || isRevocation(action.metadata.operation))
        .map(action => ({ kind: action.metadata.operation, name: action.resource.name, scope: `projects/${n.projectNumber}` })),
        permissions: n.scopeKind === 'github-ci-disconnection' ? actions(context.intent).map(action => ({ principal: action.metadata.operation === 'revoke-trust' ? n.member : `serviceAccount:${n.accountEmail}`,
          scope: action.resource.name, actions: ['remove-owned-iam-binding'], purpose: 'deployment-release' as const })) : [{ principal: n.member, scope: n.account, actions: ['iam.serviceAccounts.getAccessToken'], purpose: 'deployment-release' },
          { principal: `serviceAccount:${n.accountEmail}`, scope: `projects/${n.projectNumber}`, actions: n.permissions, purpose: 'deployment-release' },
          { principal: `serviceAccount:${n.accountEmail}`, scope: n.artifactRepositoryName, actions: ['roles/artifactregistry.writer'], purpose: 'deployment-release' }],
        costs: [], warnings: [...(n.scopeKind === 'github-ci-disconnection' ? ['Previously issued impersonated access tokens can remain usable until their original expiry (up to 15 minutes). Native identities, unrelated grants, runtime access and secrets remain; only the three installed CI grants are removed.'] : []), 'The identity is restricted to the reviewed numeric GitHub owner/repository, branch, environment and workflow paths. No cloud private key or administrator refresh token is created or copied.',
          'The reviewed permissions cover the isolated app/environment project. Future deployment and backup executions can incur separately reviewed usage charges.',
          'IAM propagation can delay first use. Uncertain writes retain their exact attempts and are re-observed; they are never blindly resubmitted.',
          'Workload pools and providers expose no immutable lifetime ID. Exact creation attempts, native operation names and ownership descriptions are retained; a same-named unowned resource blocks setup.'] } };
    },
    async inspect(context) { try { driver.parseAction(context.action, context.intent); return await withClient(context, client => observe(client, context)); }
      catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let client: GcpSecretWriterClient | undefined;
      try {
        driver.parseAction(context.action, context.intent);
        return await withClient(context, async current => {
          client = current; const n = names(context.intent), operation = context.action.metadata.operation as Operation;
          // Observe before dispatch but do not pass the new attempt: absence is
          // action-required only before a request has actually been sent.
          if ((await observe(client, { ...context, attempt: undefined })).state !== 'action-required') fail('not_converged');
          client.beginMutation();
          const description = `hypervibe:${n.owner}:${context.attempt.id}`;
          if (operation === 'create-pool' || operation === 'create-provider') {
            const url = operation === 'create-pool'
              ? `https://iam.googleapis.com/v1/projects/${n.projectNumber}/locations/global/workloadIdentityPools?workloadIdentityPoolId=${n.poolId}`
              : `https://iam.googleapis.com/v1/${n.pool}/providers?workloadIdentityPoolProviderId=github`;
            const body = operation === 'create-pool' ? { displayName: 'Hypervibe CI', description, disabled: false, mode: 'FEDERATION_ONLY' }
              : providerBody(context.intent, context.attempt.id);
            const result = await client.json(url, { method: 'POST', body: JSON.stringify(body) }, true);
            return { state: 'acknowledged' as const, evidence: proof(context, [], { operationName: z.string().parse(result.name) }) };
          }
          if (operation === 'create-account') await client.createAccount(n.projectId, n.accountId, description, 'Hypervibe CI deployer');
          else if (operation === 'create-role') await client.createRole(n.projectId, n.roleId, description, n.permissions, 'Hypervibe CI deployment');
          else {
            const value = await grant(client, context);
            if (isRevocation(operation) ? !value.present : value.present) fail('not_converged');
            const next: WriterIamPolicy = structuredClone(value.policy);
            if (isRevocation(operation)) next.bindings = next.bindings.map(binding => binding.role === value.role && !binding.condition
              ? { ...binding, members: binding.members.filter(member => member !== value.member) } : binding).filter(binding => binding.members.length);
            else {
              const existing = next.bindings.find(binding => binding.role === value.role && !binding.condition);
              if (existing) existing.members.push(value.member); else next.bindings.push({ role: value.role, members: [value.member] });
            }
            await client.setPolicy(value.kind, value.policyResource, next);
            return { state: 'acknowledged' as const, evidence: proof(context, [value.account], value) };
          }
          const result = await resource(client, context, operation);
          if (!result || result.identity.attemptId !== context.attempt.id) fail('not_converged');
          return { state: 'acknowledged' as const, evidence: proof(context, [result]) };
        });
      } catch (error) { return { state: client?.canRetryRejectedMutation() === false ? 'uncertain' : 'rejected', reason: reason(error) }; }
    },
    async recover(context) { try {
      driver.parseAction(context.action, context.intent);
      return await withClient(context, async client => {
        const operationName = context.attempt.evidence?.native.operationName;
        if (operationName !== undefined) {
          parseEvidence(context.attempt.evidence, context.intent);
          const operation = await client.json(`https://iam.googleapis.com/v1/${operationName}`);
          if (operation.name !== operationName || operation.error) fail('provider_error');
          if (operation.done !== true) return { state: 'pending' as const, reason: 'not_converged' as const };
        }
        return observe(client, context);
      });
    } catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    connections: () => [],
  };
  return driver;
}

export function deriveGcpGithubCiPreparationScope(record: InstallationRecord, selection: Record<string, string>): Record<string, string> {
  if (record.status !== 'scope-ready') fail('not_converged');
  const publicStage = record.intent.nativeScope.scopeKind === 'operator-public-artifact-registry-v1';
  const scope = publicStage ? gcpLocalPublicArtifactRegistryScopeSchema.parse(record.intent.nativeScope)
    : gcpLocalArtifactRegistryScopeSchema.parse(record.intent.nativeScope);
  const registry = publicStage ? gcpLocalPublicArtifactBinding(record) : gcpLocalArtifactRegistryBinding(record);
  const chosen = gcpGithubCiPreparationSelectionSchema.parse(Object.fromEntries(Object.keys(gcpGithubCiPreparationSelectionSchema.shape)
    .filter(key => selection[key] !== undefined).map(key => [key, selection[key]])));
  return gcpGithubCiPreparationScopeSchema.parse({ ...scope, ...registry, ...chosen, scopeKind: 'github-ci-identity' });
}
export function gcpGithubCiPreparationBinding(record: InstallationRecord): GcpGithubWorkloadIdentity {
  if (record.status !== 'scope-ready') fail('not_converged');
  const n = names(record.intent);
  for (const action of actions(record.intent)) if (!record.completed[action.id]) fail('not_converged');
  for (const value of Object.values(record.completed)) parseEvidence(value, record.intent);
  const account = record.completed['gcp:github-ci:create-account'].resources[0];
  return descriptor(n, record.intent.environment, account.identity.uniqueId);
}
function descriptor(n: ReturnType<typeof names>, environment: string, uniqueId: string | undefined): GcpGithubWorkloadIdentity {
  return gcpGithubWorkloadIdentitySchema.parse({ schemaVersion: 1, projectId: n.projectId, projectNumber: n.projectNumber,
    workloadIdentityProvider: n.provider, serviceAccountEmail: n.accountEmail, serviceAccountUniqueId: uniqueId,
    repository: n.githubRepository, repositoryId: n.githubRepositoryId, repositoryOwnerId: n.githubRepositoryOwnerId,
    branch: n.githubBranch, environment, workflow: n.githubWorkflow,
    ...(n.githubBackupWorkflow ? { backupWorkflow: n.githubBackupWorkflow } : {}) });
}

/** Immutable succeeded receipts survive grant-readiness drift during an approved removal. */
export function deriveGcpGithubCiDisconnectionScope(record: InstallationRecord): Record<string, string> {
  const scope = gcpGithubCiPreparationScopeSchema.parse(record.intent.nativeScope);
  const retained = Object.fromEntries(actions(record.intent).map(action => {
    const attempt = [...record.attempts].reverse().find(item => item.actionId === action.id && item.status === 'succeeded' && item.evidence);
    if (!attempt?.evidence) fail('not_converged');
    const evidence = parseEvidence(attempt.evidence, record.intent);
    if (evidence.native.attemptId !== attempt.id) fail('identity_mismatch');
    return [action.id, evidence];
  }));
  const resource = (operation: string) => retained[`gcp:github-ci:${operation}`].resources[0];
  return gcpGithubCiDisconnectionScopeSchema.parse({ ...scope, scopeKind: 'github-ci-disconnection',
    ciInstallationId: record.installationId, ciPlanDigest: record.plan.digest,
    ciAccountUniqueId: resource('create-account').identity.uniqueId, ciAccountAttemptId: resource('create-account').identity.attemptId,
    ciPoolAttemptId: resource('create-pool').identity.attemptId, ciProviderAttemptId: resource('create-provider').identity.attemptId,
    ciRoleAttemptId: resource('create-role').identity.attemptId });
}
export function gcpGithubCiDisconnectionReady(record: InstallationRecord): true {
  gcpGithubCiDisconnectionScopeSchema.parse(record.intent.nativeScope);
  if (record.status !== 'scope-ready') fail('not_converged');
  for (const action of actions(record.intent)) parseEvidence(record.completed[action.id], record.intent);
  return true;
}

export function gcpGithubCiDisconnectionBinding(record: InstallationRecord): GcpGithubWorkloadIdentity {
  gcpGithubCiDisconnectionReady(record);
  const n = names(record.intent);
  if (n.scopeKind !== 'github-ci-disconnection') fail();
  return descriptor(n, record.intent.environment, n.ciAccountUniqueId);
}
