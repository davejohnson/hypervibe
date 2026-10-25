import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt,
  type CloudInstallationDriver, type CloudInstallationEvidence, type CloudInstallationIntent, type CloudInstallationObservation,
  type CloudInstallationProviderContext, type CloudInstallationReason } from '../../../domain/ports/cloud-installation.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { GcpSecretWriterClient, type WriterIamPolicy } from './gcp-secret-writer.client.js';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
export const gcpBillingPreparationScopeSchema = z.object({ scopeKind: z.literal('project-billing'),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/), projectNumber: z.string().regex(/^[1-9]\d{5,29}$/),
  projectCreateTime: z.string().datetime(), projectParent: z.string().regex(/^(?:none|(?:organizations|folders)\/[1-9]\d*)$/),
  projectInstallationId: z.string().guid(), projectAttemptId: z.string().guid(),
  billingAccountName: z.string().regex(/^billingAccounts\/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/),
  assignmentMode: z.literal('initial-reviewed-v1').optional() }).strict();
const rolePermissions = {
  link: ['resourcemanager.projects.get', 'resourcemanager.projects.createBillingAssignment', 'serviceusage.services.list', 'serviceusage.effectivepolicy.get'],
  impersonator: ['iam.serviceAccounts.get', 'iam.serviceAccounts.getAccessToken'],
};
const apiNames = ['iam.googleapis.com', 'iamcredentials.googleapis.com', 'cloudbilling.googleapis.com'];
const operations = ['enable-api', 'create-account', 'create-role', 'grant', 'attach-billing', 'revoke', 'verify-existing-billing', 'assign-initial-billing'] as const;
const proofSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['project', 'service', 'serviceAccount', 'role']), id: z.string().max(1024),
  identity: z.object({ uniqueId: z.string().regex(/^[1-9]\d{5,29}$/).optional(), owner: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    attemptId: z.string().guid().optional(), createTime: z.string().datetime().optional(), parent: z.string().max(256).optional() }).strict() }).strict()).max(3),
  native: z.object({ operation: z.enum(operations), actionId: z.string().max(256), installationId: z.string().guid(), owner: z.string().regex(/^[a-f0-9]{64}$/),
    attemptId: z.string().guid().optional(), operationName: z.string().regex(/^operations\/[A-Za-z0-9._~-]{1,255}$/).optional(),
    billingAccountName: z.string().max(100).optional(), assignmentMode: z.literal('initial-reviewed-v1').optional(),
    policyResource: z.string().max(1024).optional(), role: z.string().max(1024).optional(), member: z.string().max(1024).optional(),
  }).strict() }).strict();
type Context = CloudInstallationProviderContext;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
type Target = 'project' | 'billing' | 'account';
class BillingError extends CloudInstallationBoundaryError {}
function failure(error: unknown): CloudInstallationReason {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof DestinationBoundaryError) {
    if (error.status === 401) return 'authorization_expired';
    if (error.status === 403) return 'insufficient_permissions';
    if (error.code === 'deadline_exceeded') return 'timeout';
  }
  return 'provider_error';
}
function names(intent: CloudInstallationIntent) {
  if (intent.provider !== 'gcp' || intent.stage !== 'scope-preparation' || intent.mode === 'migrate') throw new BillingError('identity_mismatch');
  const native = gcpBillingPreparationScopeSchema.parse(intent.nativeScope);
  if (intent.mode === 'connect' && intent.scopePreparation?.installationId !== native.projectInstallationId) throw new BillingError('ownership_mismatch');
  const connectionId = intent.mode === 'disconnect' ? z.string().guid().parse(intent.installed?.[0]?.native.installationId) : intent.installationId;
  const parts = [intent.customerId, intent.appId, intent.environment];
  const owner = createHash('sha256').update(JSON.stringify([...parts, connectionId])).digest('hex');
  const projectOwner = createHash('sha256').update(JSON.stringify([...parts, native.projectInstallationId])).digest('hex');
  const accountId = resourceName('billing', { maxLength: 30, scope: [...parts, connectionId] });
  const email = `${accountId}@${native.projectId}.iam.gserviceaccount.com`;
  const roles = Object.fromEntries(Object.keys(rolePermissions).map(key => [key, `projects/${native.projectId}/roles/${resourceName(key, { compact: true, scope: [...parts, connectionId] })}`])) as Record<keyof typeof rolePermissions, string>;
  return { ...native, connectionId, owner, projectOwner, accountId, email, account: `projects/${native.projectId}/serviceAccounts/${email}`, roles };
}
function allActions(intent: CloudInstallationIntent): CloudInstallationAction[] {
  const n = names(intent);
  if (n.assignmentMode === 'initial-reviewed-v1' && intent.mode === 'connect') return [initialAssignmentAction(intent)];
  const action = (id: string, operation: typeof operations[number], name: string, category: CloudInstallationAction['metadata']['category'], native: Record<string, unknown>, dependsOn: string[] = []): CloudInstallationAction => ({
    id: `gcp:billing:${id}`, type: ['grant', 'attach-billing', 'revoke'].includes(operation) ? 'update' : 'create',
    resource: { kind: 'project', name, provider: 'gcp' }, verified: true, requiresConfirm: true,
    ...(operation === 'attach-billing' ? { billable: true } : {}), dependsOn: dependsOn.map(value => `gcp:billing:${value}`),
    reason: operation === 'revoke' ? 'Remove only the temporary billing principal’s reviewed grant; preserve billing and unrelated access.'
      : operation === 'attach-billing' ? 'Enable the reviewed billing account using a short-lived link-only principal.' : 'Prepare reviewed temporary access for this project’s first billing attachment.',
    metadata: { operation, category, execution: 'api', native },
  });
  const result = apiNames.map(api => action(`api:${api}`, 'enable-api', `projects/${n.projectNumber}/services/${api}`, 'scope', { api }));
  result.push(action('account', 'create-account', n.account, 'identity', {}, ['api:iam.googleapis.com']));
  for (const role of Object.keys(rolePermissions)) result.push(action(`role:${role}`, 'create-role', n.roles[role as keyof typeof rolePermissions], 'identity', { role }, ['api:iam.googleapis.com']));
  result.push(action('grant:project', 'grant', `projects/${n.projectNumber}`, 'trust', { target: 'project' }, ['account', 'role:link']));
  result.push(action('grant:billing', 'grant', n.billingAccountName, 'trust', { target: 'billing' }, ['account', 'api:cloudbilling.googleapis.com']));
  result.push(action('grant:account', 'grant', n.account, 'trust', { target: 'account' }, ['account', 'role:impersonator']));
  result.push(action('attach', 'attach-billing', `projects/${n.projectNumber}`, 'scope', {}, ['grant:project', 'grant:billing', 'grant:account', 'api:iamcredentials.googleapis.com']));
  result.push(action('revoke:project', 'revoke', `projects/${n.projectNumber}`, 'trust', { target: 'project' }, ['attach']));
  result.push(action('revoke:billing', 'revoke', n.billingAccountName, 'trust', { target: 'billing' }, ['revoke:project']));
  result.push(action('revoke:account', 'revoke', n.account, 'trust', { target: 'account' }, ['revoke:billing']));
  return result;
}
function initialAssignmentAction(intent: CloudInstallationIntent): CloudInstallationAction {
  const n = names(intent);
  if (n.assignmentMode !== 'initial-reviewed-v1') throw new BillingError('billing_assignment_unverified');
  return { id: 'gcp:billing:initial-assignment-v1', type: 'update', resource: { kind: 'project', name: `projects/${n.projectNumber}`, provider: 'gcp' },
    verified: true, requiresConfirm: true, billable: true,
    reason: 'Assign the reviewed billing account to this exact newly created project using transient browser authorization.',
    metadata: { operation: 'assign-initial-billing', category: 'scope', execution: 'api', native: { assignmentMode: n.assignmentMode } } };
}
function actions(intent: CloudInstallationIntent): CloudInstallationAction[] {
  if (intent.mode !== 'disconnect') return allActions(intent);
  const grants = new Set(intent.installed?.map(item => item.native.actionId));
  const result = allActions(intent).filter(action => action.metadata.operation === 'revoke' && grants.has(`gcp:billing:grant:${action.metadata.native.target}`));
  return result.map((action, index) => ({ ...action, dependsOn: index ? [result[index - 1].id] : [] }));
}
function verificationAction(intent: CloudInstallationIntent): CloudInstallationAction {
  const n = names(intent);
  return { id: 'gcp:billing:existing', type: 'noop', resource: { kind: 'project', name: `projects/${n.projectNumber}`, provider: 'gcp' },
    verified: true, requiresConfirm: false, reason: 'Verify the existing selected billing association without changing billing or permissions.',
    metadata: { operation: 'verify-existing-billing', category: 'verification', execution: 'api', native: {} } };
}
function parseEvidence(value: unknown, intent: CloudInstallationIntent): CloudInstallationEvidence {
  const p = proofSchema.parse(value); const n = names(intent); const action = [...allActions(intent), verificationAction(intent)].find(item => item.id === p.native.actionId);
  if (!action || action.metadata.operation !== p.native.operation || p.native.owner !== n.owner || p.native.installationId !== n.connectionId) throw new BillingError('ownership_mismatch');
  const kinds = p.resources.map(resource => resource.kind).sort();
  const expectedKinds = ['verify-existing-billing', 'assign-initial-billing'].includes(p.native.operation) ? ['project'] : p.native.operation === 'attach-billing' ? ['project', 'serviceAccount']
    : p.native.operation === 'create-role' ? ['role'] : p.native.operation === 'enable-api' ? ['service'] : ['serviceAccount'];
  if (!isDeepStrictEqual(kinds, expectedKinds) && !(p.native.operation === 'enable-api' && !kinds.length && p.native.operationName)) throw new BillingError('identity_mismatch');
  if (['create-account', 'create-role'].includes(p.native.operation) && p.resources[0]?.identity.attemptId !== p.native.attemptId) throw new BillingError('ownership_mismatch');
  for (const resource of p.resources) {
    const expected = resource.kind === 'project' ? [`projects/${n.projectNumber}`] : resource.kind === 'serviceAccount' ? [n.account]
      : resource.kind === 'role' ? Object.values(n.roles) : apiNames.map(api => `projects/${n.projectNumber}/services/${api}`);
    if (!expected.includes(resource.id)) throw new BillingError('identity_mismatch');
    if (resource.kind === 'project' && (resource.identity.createTime !== n.projectCreateTime || resource.identity.parent !== n.projectParent)) throw new BillingError('identity_mismatch');
    if (['role', 'serviceAccount'].includes(resource.kind) && (resource.identity.owner !== n.owner || !resource.identity.attemptId)) throw new BillingError('ownership_mismatch');
    if (resource.kind === 'serviceAccount' && !resource.identity.uniqueId) throw new BillingError('identity_mismatch');
  }
  if (p.native.billingAccountName !== undefined && p.native.billingAccountName !== n.billingAccountName) throw new BillingError('identity_mismatch');
  if (['attach-billing', 'verify-existing-billing', 'assign-initial-billing'].includes(p.native.operation) && p.native.billingAccountName !== n.billingAccountName) throw new BillingError('identity_mismatch');
  if (p.native.operation === 'assign-initial-billing' && (n.assignmentMode !== 'initial-reviewed-v1' || p.native.assignmentMode !== n.assignmentMode)) throw new BillingError('identity_mismatch');
  if (['grant', 'revoke'].includes(p.native.operation)) {
    const account = p.resources.find(item => item.kind === 'serviceAccount');
    const target = action.metadata.native.target as Target;
    if (!account || p.native.policyResource !== (target === 'project' ? `projects/${n.projectNumber}` : target === 'billing' ? n.billingAccountName : `projects/${n.projectId}/serviceAccounts/${account.identity.uniqueId}`)
      || p.native.role !== (target === 'project' ? n.roles.link : target === 'billing' ? 'roles/billing.user' : n.roles.impersonator)
      || p.native.member !== `serviceAccount:${target === 'account' ? intent.hostIdentity.serviceAccountEmail : n.email}`) throw new BillingError('ownership_mismatch');
  }
  return p;
}
function proof(context: ActionContext, resources: CloudInstallationEvidence['resources'] = [], native: Record<string, unknown> = {}) {
  const n = names(context.intent);
  return parseEvidence({ resources, native: { actionId: context.action.id, operation: context.action.metadata.operation, installationId: n.connectionId,
    owner: n.owner, ...(context.attempt ? { attemptId: context.attempt.id } : {}), ...native } }, context.intent);
}
function completed(context: Context, id: string, kind: string) {
  const record = context.completed[`gcp:billing:${id}`] ?? context.intent.installed?.find(item => item.native.actionId === `gcp:billing:${id}`);
  const resource = record && parseEvidence(record, context.intent).resources.find(item => item.kind === kind);
  if (!resource) throw new BillingError('ownership_mismatch'); return resource;
}

export function createGcpBillingPreparationDriver(options: { fetch?: typeof fetch } = {}): CloudInstallationDriver {
  const request = options.fetch ?? fetch;
  async function knownProjectBilling(client: GcpSecretWriterClient, projectId: string) {
    const billing = await client.bootstrap.getProjectBillingInfo(projectId);
    // CRM already proved this exact project exists. Billing's successful empty
    // association is ProjectBillingInfo with empty/default scalar fields; 404
    // is incomplete evidence and cannot authorize assigning a billing account.
    if (!billing) throw new BillingError('provider_error');
    return billing;
  }
  async function verifyBilling(client: GcpSecretWriterClient, intent: CloudInstallationIntent) {
    if (intent.mode === 'disconnect') return;
    const n = names(intent); const billing = await knownProjectBilling(client, n.projectId);
    if (billing?.billingAccountName && billing.billingAccountName !== n.billingAccountName) throw new BillingError('ownership_mismatch');
  }
  async function withClient<T>(context: Context, run: (client: GcpSecretWriterClient, budget: DestinationBudget) => Promise<T>, recovery = false): Promise<T> {
    const n = names(context.intent); if (!context.authentication.administrator) throw new BillingError('authorization_expired');
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      const token = await budget.wait(context.authentication.administrator.getAccessToken(SCOPE, budget.signal));
      const client: GcpSecretWriterClient = new GcpSecretWriterClient({ token, budget, request, beforeWrite: async () => {
        await verifyBilling(client, context.intent); await context.beforeMutation();
      }, sleep: async () => {} });
      const project = await client.bootstrap.getProject(n.projectId);
      if (!project || project.name !== `projects/${n.projectNumber}` || project.state !== 'ACTIVE' || project.createTime !== n.projectCreateTime
        || (project.parent ?? 'none') !== n.projectParent || project.labels?.['hv-installation'] !== n.projectOwner.slice(0, 63)
        || project.labels?.['hv-attempt'] !== n.projectAttemptId) throw new BillingError('ownership_mismatch');
      if (!recovery) await verifyBilling(client, context.intent);
      return await run(client, budget);
    } finally { budget.close(); }
  }
  async function account(client: GcpSecretWriterClient, context: Context) {
    const n = names(context.intent); let result: Record<string, unknown>;
    try { result = await client.json(`https://iam.googleapis.com/v1/${n.account}`); }
    catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
    const marker = typeof result.description === 'string' && /^hypervibe:([a-f0-9]{64}):([a-f0-9-]{36})$/.exec(result.description);
    if (result.name !== n.account || result.email !== n.email || result.projectId !== n.projectId || typeof result.uniqueId !== 'string' || !/^[1-9]\d{5,29}$/.test(result.uniqueId)
      || !marker || marker[1] !== n.owner || result.disabled !== undefined && result.disabled !== false) throw new BillingError('ownership_mismatch');
    return { kind: 'serviceAccount', id: n.account, identity: { uniqueId: result.uniqueId, owner: n.owner, attemptId: marker[2] } };
  }
  async function verifiedAccount(client: GcpSecretWriterClient, context: Context) {
    const current = await account(client, context); const previous = completed(context, 'account', 'serviceAccount');
    if (!current || !isDeepStrictEqual(current, previous)) throw new BillingError('identity_mismatch'); return current;
  }
  async function details(client: GcpSecretWriterClient, context: ActionContext) {
    const n = names(context.intent); const target = context.action.metadata.native.target as Target;
    const writer = await verifiedAccount(client, context);
    if (target !== 'billing') {
      const roleName = target === 'project' ? 'link' : 'impersonator'; const existing = completed(context, `role:${roleName}`, 'role');
      const role = await client.role(n.roles[roleName]);
      if (!role || role.description !== `hypervibe:${n.owner}:${existing.identity.attemptId}`
        || !isDeepStrictEqual([...role.includedPermissions].sort(), [...rolePermissions[roleName]].sort())) throw new BillingError('ownership_mismatch');
    }
    return { writer, target, policyResource: target === 'project' ? `projects/${n.projectNumber}` : target === 'billing' ? n.billingAccountName : `projects/${n.projectId}/serviceAccounts/${writer.identity.uniqueId}`,
      role: target === 'project' ? n.roles.link : target === 'billing' ? 'roles/billing.user' : n.roles.impersonator,
      member: `serviceAccount:${target === 'account' ? context.intent.hostIdentity.serviceAccountEmail : n.email}` };
  }
  async function policy(client: GcpSecretWriterClient, target: Target, resource: string): Promise<WriterIamPolicy> {
    if (target !== 'billing') return client.policy(target, resource);
    const value = await client.json(`https://cloudbilling.googleapis.com/v1/${resource}:getIamPolicy?options.requestedPolicyVersion=3`);
    const bindings = value.bindings ?? [];
    if (typeof value.etag !== 'string' || !value.etag || !Array.isArray(bindings)
      || bindings.some(binding => typeof binding.role !== 'string' || !Array.isArray(binding.members) || !binding.members.every((member: unknown) => typeof member === 'string')
        || binding.condition !== undefined && (value.version !== 3 || !binding.condition || typeof binding.condition !== 'object'))) throw new BillingError('provider_error');
    return { ...value, etag: value.etag, bindings };
  }
  async function observe(client: GcpSecretWriterClient, context: ActionContext): Promise<CloudInstallationObservation> {
    const n = names(context.intent); const op = context.action.metadata.operation;
    if (op === 'enable-api') {
      const value = await client.json(`https://serviceusage.googleapis.com/v1/${context.action.resource.name}`);
      if (value.name !== context.action.resource.name || !['ENABLED', 'DISABLED'].includes(String(value.state))) throw new BillingError('identity_mismatch');
      return value.state === 'ENABLED' ? { state: 'satisfied', evidence: proof(context, [{ kind: 'service', id: value.name as string, identity: {} }]) }
        : context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
    }
    if (op === 'create-account' || op === 'create-role') {
      let resource: CloudInstallationEvidence['resources'][number] | null = null;
      if (op === 'create-account') resource = await account(client, context);
      else {
        const key = context.action.metadata.native.role as keyof typeof rolePermissions; const value = await client.role(n.roles[key]);
        if (value) {
          const marker = /^hypervibe:([a-f0-9]{64}):([a-f0-9-]{36})$/.exec(value.description);
          if (!marker || marker[1] !== n.owner || !isDeepStrictEqual([...value.includedPermissions].sort(), [...rolePermissions[key]].sort())) throw new BillingError('ownership_mismatch');
          resource = { kind: 'role', id: value.name, identity: { owner: n.owner, attemptId: marker[2] } };
        }
      }
      if (!resource) return context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
      if (!context.attempt || context.attempt.id !== resource.identity.attemptId) throw new BillingError('ownership_mismatch');
      const retained = context.completed[context.action.id] ?? context.attempt.evidence;
      if (retained && parseEvidence(retained, context.intent).resources.length && !isDeepStrictEqual(parseEvidence(retained, context.intent).resources, [resource])) throw new BillingError('identity_mismatch');
      return { state: 'satisfied', evidence: proof(context, [resource]) };
    }
    if (op === 'attach-billing' || op === 'verify-existing-billing' || op === 'assign-initial-billing') {
      const writer = op === 'attach-billing' ? await verifiedAccount(client, context) : null; const info = await knownProjectBilling(client, n.projectId);
      if (info?.billingAccountName && info.billingAccountName !== n.billingAccountName) return { state: 'conflict', reason: 'ownership_mismatch' };
      if (info?.billingEnabled && info.billingAccountName === n.billingAccountName) return { state: 'satisfied', evidence: proof(context, [...(writer ? [writer] : []),
        { kind: 'project', id: `projects/${n.projectNumber}`, identity: { createTime: n.projectCreateTime, parent: n.projectParent } }],
        { billingAccountName: n.billingAccountName, ...(op === 'assign-initial-billing' ? { assignmentMode: n.assignmentMode } : {}) }) };
      if (op === 'verify-existing-billing') return { state: 'rejected', reason: 'billing_assignment_unverified' };
      return context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
    }
    const grant = await details(client, context); const live = await policy(client, grant.target, grant.policyResource);
    const present = live.bindings.some(binding => !binding.condition && binding.role === grant.role && binding.members.includes(grant.member));
    const native = { policyResource: grant.policyResource, role: grant.role, member: grant.member };
    if (op === 'grant' && (context.completed[`gcp:billing:revoke:${grant.target}`]
      || context.attempts?.some(attempt => attempt.actionId === `gcp:billing:revoke:${grant.target}` && attempt.status !== 'rejected'))) {
      const prior = context.completed[context.action.id];
      if (!prior || present) throw new BillingError('ownership_mismatch');
      return { state: 'satisfied', evidence: parseEvidence(prior, context.intent) };
    }
    if (op === 'revoke') {
      const original = context.completed[`gcp:billing:grant:${grant.target}`]
        ?? context.intent.installed?.find(item => item.native.actionId === `gcp:billing:grant:${grant.target}`);
      if (!original || context.intent.mode !== 'disconnect' && !context.completed['gcp:billing:attach']) throw new BillingError('ownership_mismatch');
      const prior = parseEvidence(original, context.intent);
      if (!isDeepStrictEqual(prior.resources, [grant.writer]) || ['policyResource', 'role', 'member'].some(key => prior.native[key] !== native[key as keyof typeof native])) throw new BillingError('ownership_mismatch');
    }
    return present === (op === 'grant') ? { state: 'satisfied', evidence: proof(context, [grant.writer], native) }
      : context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
  }
  async function billingToken(client: GcpSecretWriterClient, context: Context, budget: DestinationBudget): Promise<string> {
    const n = names(context.intent); const writer = await verifiedAccount(client, context);
    const host = await budget.wait(context.authentication.host.verifyIdentity(budget.signal));
    if (!isDeepStrictEqual(host, context.intent.hostIdentity)) throw new BillingError('identity_mismatch');
    const hostToken = await budget.wait(context.authentication.host.getAccessToken(budget.signal));
    const accountValue = await destinationJson(request, budget, `https://iam.googleapis.com/v1/projects/${n.projectId}/serviceAccounts/${writer.identity.uniqueId}`, hostToken);
    if (accountValue.uniqueId !== writer.identity.uniqueId || accountValue.email !== n.email) throw new BillingError('identity_mismatch');
    const result = await destinationJson(request, budget, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${writer.identity.uniqueId}:generateAccessToken`, hostToken,
      { method: 'POST', body: JSON.stringify({ scope: [SCOPE], lifetime: '900s' }) });
    const expiration = typeof result.expireTime === 'string' ? Date.parse(result.expireTime) : NaN;
    if (typeof result.accessToken !== 'string' || !Number.isFinite(expiration) || expiration <= Date.now() || expiration > Date.now() + 960_000) throw new BillingError('authorization_expired');
    for (const [url, positive, negative] of [
      [`https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}:testIamPermissions`, rolePermissions.link, ['resourcemanager.projects.deleteBillingAssignment']],
      [`https://cloudbilling.googleapis.com/v1/${n.billingAccountName}:testIamPermissions`, ['billing.accounts.get', 'billing.resourceAssociations.create'], ['billing.resourceAssociations.delete']],
    ] as Array<[string, string[], string[]]>) {
      const observed = await destinationJson(request, budget, url, result.accessToken, { method: 'POST', body: JSON.stringify({ permissions: [...positive, ...negative] }) });
      const granted = observed.permissions;
      if (!Array.isArray(granted) || !positive.every(permission => granted.includes(permission)) || negative.some(permission => granted.includes(permission))) throw new BillingError('insufficient_permissions');
    }
    return result.accessToken;
  }
  const driver: CloudInstallationDriver = {
    provider: 'gcp', parseScope: value => gcpBillingPreparationScopeSchema.parse(value), parseEvidence,
    scopePreparation: { disconnectionIntent(record, installationId) {
      names(record.intent);
      const pending = record.attempts.some(attempt => attempt.actionId.startsWith('gcp:billing:grant:')
        && attempt.status !== 'rejected' && !record.completed[attempt.actionId]);
      if (pending) throw new BillingError('not_converged');
      const grants = Object.values(record.completed).filter(item => item.native.operation === 'grant');
      if (!grants.length) return null;
      const { scopePreparation: _predecessor, ...original } = record.intent;
      return { ...original, installationId, mode: 'disconnect', installed: Object.values(record.completed) };
    }, continuationStage: () => 'collection', resolvedScope(record) {
      const n = names(record.intent);
      if (record.status === 'scope-ready' && n.assignmentMode === 'initial-reviewed-v1' && record.completed['gcp:billing:initial-assignment-v1']) {
        parseEvidence(record.completed['gcp:billing:initial-assignment-v1'], record.intent);
        return { projectId: n.projectId, projectNumber: n.projectNumber };
      }
      if (record.status === 'scope-ready' && record.completed['gcp:billing:existing']) {
        parseEvidence(record.completed['gcp:billing:existing'], record.intent);
        return { projectId: n.projectId, projectNumber: n.projectNumber };
      }
      if (record.status !== 'scope-ready' || !record.completed['gcp:billing:attach'] || ['project', 'billing', 'account'].some(target => !record.completed[`gcp:billing:revoke:${target}`])) throw new BillingError('not_converged');
      parseEvidence(record.completed['gcp:billing:attach'], record.intent);
      return { projectId: n.projectId, projectNumber: n.projectNumber };
    }, reviewResources(record) {
      const n = names(record.intent);
      return [{ kind: 'project', name: n.projectId, scope: n.projectParent === 'none' ? 'No organization (observed)' : n.projectParent },
        { kind: 'billing-account', name: n.billingAccountName, scope: `projects/${n.projectNumber}` }];
    } },
    parseAction(value, intent) { const match = [...actions(intent), ...(intent.mode === 'connect' ? [verificationAction(intent)] : [])].find(item => item.id === (value as CloudInstallationAction)?.id);
      if (!match || !isDeepStrictEqual(match, value)) throw new BillingError('identity_mismatch'); return match; },
    async plan(context) {
      try {
        const n = names(context.intent);
        if (context.intent.mode === 'disconnect') {
          await withClient(context, async client => {
            for (const action of actions(context.intent)) {
              const observed = await observe(client, { ...context, action });
              if (!['satisfied', 'action-required'].includes(observed.state)) throw new BillingError('not_converged');
            }
          });
          return { actions: actions(context.intent), review: { resources: [{ kind: 'temporary-service-account', name: n.email, scope: `projects/${n.projectNumber}` }],
            permissions: [{ principal: n.email, scope: n.billingAccountName, actions: ['Remove only the exact previously installed temporary grants'], purpose: 'hosted-trust-removal' }],
            costs: [], warnings: ['Billing, the project, service account and custom roles are preserved. Only proven temporary grants are removed.',
              'Previously minted tokens expire within 15 minutes; IAM revocation can take time to propagate. Failed or unknown removal remains recoverable.'] } };
        }
        let alreadyLinked = false;
        await withClient(context, async client => {
          const account = await client.json(`https://cloudbilling.googleapis.com/v1/${n.billingAccountName}`);
          if (account.name !== n.billingAccountName || account.open !== true) throw new BillingError('insufficient_permissions');
          const billing = await knownProjectBilling(client, n.projectId);
          if (billing?.billingAccountName && billing.billingAccountName !== n.billingAccountName) throw new BillingError('ownership_mismatch');
          alreadyLinked = billing?.billingAccountName === n.billingAccountName && billing.billingEnabled === true;
          if (alreadyLinked) return;
          const required = n.assignmentMode === 'initial-reviewed-v1' ? [
            [`https://cloudbilling.googleapis.com/v1/${n.billingAccountName}:testIamPermissions`, ['billing.accounts.get', 'billing.resourceAssociations.create']],
            [`https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}:testIamPermissions`, rolePermissions.link],
          ] : [
            [`https://cloudbilling.googleapis.com/v1/${n.billingAccountName}:testIamPermissions`, ['billing.accounts.get', 'billing.accounts.getIamPolicy', 'billing.accounts.setIamPolicy']],
            [`https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}:testIamPermissions`, ['resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'resourcemanager.projects.setIamPolicy',
              'iam.roles.create', 'iam.roles.get', 'iam.serviceAccounts.create', 'iam.serviceAccounts.get', 'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.setIamPolicy', 'serviceusage.services.get', 'serviceusage.services.enable']],
          ];
          for (const [url, permissions] of required as Array<[string, string[]]>) {
            const result = await client.json(url, { method: 'POST', body: JSON.stringify({ permissions }) }); const granted = result.permissions;
            if (!Array.isArray(granted) || !permissions.every(permission => granted.includes(permission))) throw new BillingError('insufficient_permissions');
          }
        });
        if (alreadyLinked) return { actions: [verificationAction(context.intent)], review: { resources: [
          { kind: 'project', name: n.projectId, scope: n.projectParent === 'none' ? 'No organization (observed)' : n.projectParent },
          { kind: 'billing-account', name: n.billingAccountName, scope: `projects/${n.projectNumber}` }],
          permissions: [], costs: [], warnings: ['The selected billing association already exists. This stage verifies it without any billing or IAM changes.'] } };
        if (n.assignmentMode === 'initial-reviewed-v1') return { actions: [initialAssignmentAction(context.intent)], review: {
          resources: [{ kind: 'project', name: n.projectId, scope: `${n.projectParent}; projects/${n.projectNumber}; created ${n.projectCreateTime}` },
            { kind: 'billing-account', name: n.billingAccountName, scope: `projects/${n.projectNumber}` }],
          permissions: [{ principal: 'Browser-authorized administrator', scope: `projects/${n.projectNumber}`, actions: rolePermissions.link, purpose: 'installation-verification' },
            { principal: 'Browser-authorized administrator', scope: n.billingAccountName, actions: ['billing.accounts.get', 'billing.resourceAssociations.create'], purpose: 'installation-verification' }],
          costs: [{ resource: n.billingAccountName, description: 'This account will pay for resource usage in the exact newly created project. This step creates no application workloads.', pricingUrl: 'https://cloud.google.com/pricing' }],
          warnings: ['Reserve this newly created project for this setup and coordinate billing changes with other administrators until it finishes.',
            'Google’s billing API can replace a concurrent external billing selection after our final check. This review authorizes the selected account for this initial assignment; it is not an atomic link-only operation.',
            'A different account observed before the write is preserved and blocks setup. An uncertain response is recovered by reading, never by automatically repeating the assignment.',
            'Only transient browser authorization is used. This step creates no temporary identities or IAM grants, and stores no administrator credential.'] } };
        return { actions: actions(context.intent), blockedReason: 'billing_assignment_unverified' as const, review: {
          resources: [{ kind: 'temporary-service-account', name: n.email, scope: `projects/${n.projectNumber}` }, ...Object.values(n.roles).map(name => ({ kind: 'temporary-custom-role', name, scope: `projects/${n.projectNumber}` }))],
          permissions: [{ principal: n.email, scope: `projects/${n.projectNumber}`, actions: rolePermissions.link, purpose: 'installation-verification' },
            { principal: n.email, scope: n.billingAccountName, actions: ['roles/billing.user'], purpose: 'installation-verification' },
            { principal: context.intent.hostIdentity.serviceAccountEmail, scope: n.account, actions: rolePermissions.impersonator, purpose: 'installation-verification' },
            { principal: 'Browser administrator', scope: n.billingAccountName, actions: ['billing.accounts.getIamPolicy', 'billing.accounts.setIamPolicy'], purpose: 'installation-verification' }],
          costs: [{ resource: n.billingAccountName, description: 'Enable billing for this exact project. Future approved resources can incur charges; this stage creates no paid workloads.', pricingUrl: 'https://cloud.google.com/pricing' }],
          warnings: ['Automatic attachment is blocked before temporary resources or grants are installed. No verified native guard currently prevents replacing a concurrent billing association when the principal has inherited unlink permission on another account.',
            'The displayed temporary-principal actions are an unverified candidate and cannot be authorized by confirmation. Selected-account permission probes do not prove absence of permissions on all other accounts.',
            'All temporary project, billing-account and host-impersonation grants are removed after verification. The service account and custom roles remain without these Hypervibe grants.',
            'Partial cleanup stays pending and needs renewed administrator authorization. Previously minted tokens expire within 15 minutes; IAM changes can take time to propagate.',
            'Native switch rejection still requires a disposable-account walkthrough. Administrators can independently change effective permissions; this flow cannot prevent those concurrent authorization changes.'],
        } };
      } catch (error) { throw new BillingError(failure(error)); }
    },
    async inspect(context) { try { driver.parseAction(context.action, context.intent); return await withClient(context, client => observe(client, context)); }
      catch (error) { return { state: 'unknown', reason: failure(error) }; } },
    async recover(context) { try { driver.parseAction(context.action, context.intent); return await withClient(context, client => observe(client, context), true); }
      catch (error) { return { state: 'unknown', reason: failure(error) }; } },
    async mutate(context) {
      let canRetry = () => true;
      try {
        driver.parseAction(context.action, context.intent);
        if (context.intent.mode === 'connect' && context.action.metadata.operation !== 'revoke'
          && !(names(context.intent).assignmentMode === 'initial-reviewed-v1' && context.action.metadata.operation === 'assign-initial-billing'))
          throw new BillingError('billing_assignment_unverified');
        return await withClient(context, async (client, budget) => {
          canRetry = () => client.canRetryRejectedMutation();
          const n = names(context.intent); const op = context.action.metadata.operation;
          const current = await observe(client, { ...context, attempt: undefined });
          if (current.state !== 'action-required') throw new BillingError('ownership_mismatch');
          if (op === 'assign-initial-billing') {
            // The separately reviewed versioned action deliberately uses the
            // transient administrator, never an implicit credential fallback.
            // Native PUT has no conditional-empty guard; the review states its
            // concurrent-change semantics. The shared attempt is already durable.
            client.beginMutation();
            const result = await client.json(`https://cloudbilling.googleapis.com/v1/projects/${n.projectId}/billingInfo`, {
              method: 'PUT', body: JSON.stringify({ billingAccountName: n.billingAccountName }),
            }, true);
            if (result.projectId !== n.projectId || result.name !== `projects/${n.projectId}/billingInfo`
              || result.billingAccountName !== n.billingAccountName || result.billingEnabled !== true) throw new BillingError('not_converged');
            const observed = await observe(client, context);
            return observed.state === 'satisfied' ? { state: 'acknowledged' as const, evidence: observed.evidence }
              : { state: 'uncertain' as const, reason: 'not_converged' as const };
          }
          if (op === 'enable-api') {
            const result = await client.json(`https://serviceusage.googleapis.com/v1/${context.action.resource.name}:enable`, { method: 'POST', body: '{}' }, true);
            if (typeof result.name !== 'string') throw new BillingError('provider_error');
            return { state: 'acknowledged' as const, evidence: proof(context, [], { operationName: result.name }) };
          }
          if (op === 'create-account') await client.createAccount(n.projectId, n.accountId, `hypervibe:${n.owner}:${context.attempt.id}`);
          else if (op === 'create-role') {
            const role = context.action.metadata.native.role as keyof typeof rolePermissions;
            await client.createRole(n.projectId, n.roles[role].split('/').at(-1)!, `hypervibe:${n.owner}:${context.attempt.id}`, rolePermissions[role]);
          } else if (op === 'attach-billing') {
            const token = await billingToken(client, context, budget);
            const fresh = await observe(client, { ...context, attempt: undefined });
            if (fresh.state !== 'action-required') throw new BillingError('ownership_mismatch');
            // Only this client holds the temporary principal; an administrator
            // token is never passed to the billing update, even as fallback.
            const writer = new GcpSecretWriterClient({ token, budget, request, beforeWrite: () => context.beforeMutation(), sleep: async () => {} });
            canRetry = () => writer.canRetryRejectedMutation();
            const result = await writer.json(`https://cloudbilling.googleapis.com/v1/projects/${n.projectId}/billingInfo`, { method: 'PUT', body: JSON.stringify({ billingAccountName: n.billingAccountName }) }, true);
            if (result.projectId !== n.projectId || result.name !== `projects/${n.projectId}/billingInfo` || result.billingAccountName !== n.billingAccountName || result.billingEnabled !== true) throw new BillingError('not_converged');
          } else {
            const grant = await details(client, context); const original = await policy(client, grant.target, grant.policyResource);
            const bindings = structuredClone(original.bindings);
            if (op === 'grant') {
              const binding = bindings.find(item => item.role === grant.role && !item.condition);
              if (binding) { if (!binding.members.includes(grant.member)) binding.members.push(grant.member); }
              else bindings.push({ role: grant.role, members: [grant.member] });
            } else for (const binding of bindings) if (binding.role === grant.role && !binding.condition) binding.members = binding.members.filter(member => member !== grant.member);
            const next = { ...original, bindings: bindings.filter(binding => binding.members.length) };
            if (grant.target === 'billing') await client.json(`https://cloudbilling.googleapis.com/v1/${grant.policyResource}:setIamPolicy`, { method: 'POST', body: JSON.stringify({ policy: next }) }, true);
            else await client.setPolicy(grant.target, grant.policyResource, next);
          }
          const observed = await observe(client, context);
          return observed.state === 'satisfied' ? { state: 'acknowledged' as const, evidence: observed.evidence } : { state: 'uncertain' as const, reason: 'not_converged' as const };
        });
      } catch (error) { return { state: canRetry() ? 'rejected' : 'uncertain', reason: failure(error) }; }
    },
    connections: () => [],
  };
  return driver;
}
