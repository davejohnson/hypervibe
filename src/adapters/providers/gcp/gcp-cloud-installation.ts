import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CloudInstallationAction, CloudInstallationAttempt, CloudInstallationDriver, CloudInstallationEvidence,
  CloudInstallationIntent, CloudInstallationObservation, CloudInstallationProviderContext, CloudInstallationReason,
} from '../../../domain/ports/cloud-installation.port.js';
import { CloudInstallationBoundaryError } from '../../../domain/ports/cloud-installation.port.js';
import { gcpSecretDestinationSchema } from '../../../domain/ports/secret-destination.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { GcpSecretWriterClient, type WriterIamPolicy } from './gcp-secret-writer.client.js';
import { createGcpProjectPreparationDriver, discoverGcpProjectPreparationScopes, gcpProjectPreparationScopeSchema } from './gcp-project-installation.js';
import { createGcpBillingPreparationDriver, gcpBillingPreparationScopeSchema } from './gcp-billing-installation.js';
import { createGcpCloudDeploymentDriver } from './gcp-cloud-deployment.js';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const scopeSchema = z.object({ projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/), projectNumber: z.string().regex(/^[1-9]\d{5,29}$/) }).strict();
const permissions = {
  writer: ['secretmanager.secrets.get', 'secretmanager.versions.add', 'secretmanager.versions.list'],
  verifier: ['resourcemanager.projects.get'],
  impersonator: ['iam.serviceAccounts.get', 'iam.serviceAccounts.getAccessToken'],
};
const installPermissions = [
  'resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'resourcemanager.projects.setIamPolicy',
  'iam.roles.create', 'iam.roles.get', 'iam.serviceAccounts.create', 'iam.serviceAccounts.get',
  'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.setIamPolicy', 'secretmanager.secrets.create',
  'secretmanager.secrets.get', 'secretmanager.secrets.getIamPolicy', 'secretmanager.secrets.setIamPolicy',
  'serviceusage.services.get', 'serviceusage.services.enable',
];
const operations = ['enable-api', 'create-role', 'create-account', 'create-secret', 'inspect-existing-secret', 'grant', 'revoke', 'verify-writer'] as const;
const identitySchema = z.object({
  uniqueId: z.string().regex(/^[1-9]\d{5,29}$/).optional(), createTime: z.string().datetime().optional(),
  adoption: z.literal('reviewed-existing').optional(),
  owner: z.string().regex(/^[a-f0-9]{64}$/).optional(), attemptId: z.string().guid().optional(),
}).strict();
const evidenceSchema = z.object({
  resources: z.array(z.object({ kind: z.enum(['project', 'service', 'role', 'serviceAccount', 'secret', 'iamBinding']),
    id: z.string().max(1024).regex(/^projects\/[a-z0-9-]+(?:\/[A-Za-z0-9_.@\/-]+)?$/), identity: identitySchema }).strict()).max(5),
  native: z.object({ operation: z.enum(operations), attemptId: z.string().guid().optional(), installationId: z.string().guid(),
    owner: z.string().regex(/^[a-f0-9]{64}$/), key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    role: z.string().regex(/^projects\/[a-z0-9-]+\/roles\/[a-zA-Z0-9_.]+$/).optional(),
    member: z.string().regex(/^serviceAccount:[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/).optional(),
    policyKind: z.enum(['project', 'account', 'secret']).optional(),
    policyResource: z.string().max(1024).regex(/^projects\/[a-z0-9-]+(?:\/serviceAccounts\/[1-9]\d*|\/secrets\/[A-Za-z0-9_-]+)?$/).optional(),
    operationName: z.string().regex(/^operations\/[a-zA-Z0-9_.-]{1,255}$/).optional(),
  }).strict(),
}).strict();
type Context = CloudInstallationProviderContext;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
class InstallationError extends CloudInstallationBoundaryError {}
function reason(error: unknown): CloudInstallationReason {
  if (error instanceof InstallationError) return error.reason;
  if (error instanceof DestinationBoundaryError) {
    if (error.status === 401) return 'authorization_expired';
    if (error.status === 403) return 'insufficient_permissions';
    if (error.code === 'deadline_exceeded') return 'timeout';
    if (error.code === 'scope_mismatch') return 'identity_mismatch';
  }
  return 'provider_error';
}
function scope(intent: CloudInstallationIntent) {
  if (intent.provider !== 'gcp') throw new InstallationError('identity_mismatch');
  return scopeSchema.parse(intent.nativeScope);
}
function names(intent: CloudInstallationIntent) {
  const native = scope(intent);
  const parts = [intent.customerId, intent.appId, intent.environment, intent.installationId];
  const owner = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const accountId = resourceName('writer', { maxLength: 30, scope: parts });
  const email = `${accountId}@${native.projectId}.iam.gserviceaccount.com`;
  const roles = Object.fromEntries(Object.keys(permissions).map(key => [key,
    `projects/${native.projectId}/roles/${resourceName(key, { scope: parts, compact: true })}`])) as Record<keyof typeof permissions, string>;
  const secrets = Object.fromEntries(intent.keys.map(key => [key,
    `projects/${native.projectNumber}/secrets/${resourceName(key, { scope: parts })}`]));
  if (intent.migrationTargets) {
    if (intent.mode === 'connect' || intent.migrationTargets.length !== intent.keys.length) throw new InstallationError('identity_mismatch');
    const seen = new Set<string>();
    for (const target of intent.migrationTargets) {
      const destination = gcpSecretDestinationSchema.parse(target.destination);
      if (!intent.keys.includes(target.key) || seen.has(target.key) || destination.projectId !== native.projectId
        || destination.projectNumber !== native.projectNumber) throw new InstallationError('identity_mismatch');
      seen.add(target.key); secrets[target.key] = `projects/${native.projectNumber}/secrets/${destination.secretId}`;
    }
    if (new Set(Object.values(secrets)).size !== intent.keys.length) throw new InstallationError('identity_mismatch');
  } else if (intent.mode === 'migrate') throw new InstallationError('identity_mismatch');
  return { ...native, owner, accountId, email, account: `projects/${native.projectId}/serviceAccounts/${email}`, roles, secrets };
}
function makeAction(id: string, operation: typeof operations[number], name: string, category: CloudInstallationAction['metadata']['category'],
  native: Record<string, unknown>, dependsOn: string[] = []): CloudInstallationAction {
  return { id, type: operation === 'revoke' ? 'update' : operation === 'grant' ? 'update' : ['verify-writer', 'inspect-existing-secret'].includes(operation) ? 'noop' : 'create',
    resource: { kind: category === 'secret-container' ? 'secret' : 'project', name, provider: 'gcp' },
    verified: true, reason: operation === 'revoke' ? 'Remove only this connection’s hosted writer access; retain secrets and runtime access.'
      : operation === 'verify-writer' ? 'Verify the dedicated writer can inspect targets and add versions without reading secret values.'
      : 'Prepare reviewed Google Cloud resources for this app and environment.',
    requiresConfirm: true, ...(operation === 'create-secret' ? { billable: true, dataBearing: true } : {}),
    dependsOn, metadata: { operation, category, execution: 'api', native } };
}
function actionsFor(intent: CloudInstallationIntent, existing: Record<string, string> = {}): CloudInstallationAction[] {
  const n = names(intent);
  if (intent.mode === 'disconnect') {
    if (!intent.installed?.length) throw new InstallationError('ownership_mismatch');
    return intent.installed.map(value => parseEvidence(value, intent)).filter(value => value.native.operation === 'grant').map((value, index) =>
      makeAction(`gcp:revoke:${index}`, 'revoke', String(value.native.policyResource), 'trust', { evidence: value }));
  }
  const apis = ['iam.googleapis.com', 'secretmanager.googleapis.com', 'iamcredentials.googleapis.com'];
  const actions: CloudInstallationAction[] = apis.map(api => makeAction(`gcp:api:${api}`, 'enable-api',
    `projects/${n.projectNumber}/services/${api}`, 'scope', { api }));
  actions.push(makeAction('gcp:account', 'create-account', n.account, 'identity', { accountId: n.accountId }, ['gcp:api:iam.googleapis.com']));
  for (const role of Object.keys(permissions) as Array<keyof typeof permissions>) actions.push(makeAction(`gcp:role:${role}`, 'create-role',
    n.roles[role], 'identity', { role }, ['gcp:api:iam.googleapis.com']));
  for (const key of [...intent.keys].sort()) {
    actions.push(intent.mode === 'migrate'
      ? makeAction(`gcp:secret:${key}`, 'inspect-existing-secret', n.secrets[key], 'secret-container', { key, createTime: existing[key] }, ['gcp:api:secretmanager.googleapis.com'])
      : makeAction(`gcp:secret:${key}`, 'create-secret', n.secrets[key], 'secret-container', { key }, ['gcp:api:secretmanager.googleapis.com']));
    actions.push(makeAction(`gcp:grant:${key}`, 'grant', n.secrets[key], 'trust', { policyKind: 'secret', key, role: 'writer' },
      ['gcp:account', 'gcp:role:writer', `gcp:secret:${key}`]));
  }
  actions.push(makeAction('gcp:grant:project', 'grant', `projects/${n.projectNumber}`, 'trust', { policyKind: 'project', role: 'verifier' },
    ['gcp:account', 'gcp:role:verifier']));
  actions.push(makeAction('gcp:grant:impersonation', 'grant', n.account, 'trust', { policyKind: 'account', role: 'impersonator' },
    ['gcp:account', 'gcp:role:impersonator']));
  // Verification is read-only in the infrastructure sense, but it mints a
  // short-lived access token. Keep it explicit and out of noop actions.
  const verify = makeAction('gcp:verify', 'verify-writer', n.account, 'verification', {}, actions.map(action => action.id));
  verify.type = 'update'; actions.push(verify);
  return actions;
}
function parseEvidence(value: unknown, intent: CloudInstallationIntent): CloudInstallationEvidence {
  const parsed = evidenceSchema.parse(value); const native = scope(intent);
  const n = names({ ...intent, installationId: parsed.native.installationId });
  if (parsed.native.owner !== n.owner || intent.mode !== 'disconnect' && parsed.native.installationId !== intent.installationId)
    throw new InstallationError('ownership_mismatch');
  const expectedIds: Record<string, string[]> = { serviceAccount: [n.account], role: Object.values(n.roles), secret: Object.values(n.secrets),
    project: [`projects/${n.projectNumber}`], service: ['iam.googleapis.com', 'iamcredentials.googleapis.com', 'secretmanager.googleapis.com'].map(api => `projects/${n.projectNumber}/services/${api}`) };
  for (const resource of parsed.resources) {
    if (!expectedIds[resource.kind]?.includes(resource.id)) throw new InstallationError('identity_mismatch');
    const adopted = resource.kind === 'secret' && resource.identity.adoption === 'reviewed-existing';
    if (adopted && (!intent.migrationTargets || resource.identity.owner || resource.identity.attemptId)) throw new InstallationError('ownership_mismatch');
    if (['serviceAccount', 'secret', 'role'].includes(resource.kind) && !adopted && (resource.identity.owner !== n.owner || !resource.identity.attemptId))
      throw new InstallationError('ownership_mismatch');
    if (resource.kind === 'serviceAccount' && !resource.identity.uniqueId || resource.kind === 'secret' && !resource.identity.createTime)
      throw new InstallationError('identity_mismatch');
  }
  for (const name of [parsed.native.role, parsed.native.policyResource]) {
    if (name && !name.startsWith(`projects/${native.projectId}/`) && !name.startsWith(`projects/${native.projectNumber}/`)
      && name !== `projects/${native.projectNumber}`) throw new InstallationError('identity_mismatch');
  }
  if (parsed.native.operation === 'grant' || parsed.native.operation === 'revoke') {
    const x = parsed.native; const writer = parsed.resources.find(item => item.kind === 'serviceAccount');
    if (!writer || !x.policyKind) throw new InstallationError('ownership_mismatch');
    const role = x.policyKind === 'account' ? n.roles.impersonator : x.policyKind === 'secret' ? n.roles.writer : n.roles.verifier;
    const member = `serviceAccount:${x.policyKind === 'account' ? intent.hostIdentity.serviceAccountEmail : n.email}`;
    const resource = x.policyKind === 'account' ? `projects/${n.projectId}/serviceAccounts/${writer.identity.uniqueId}`
      : x.policyKind === 'secret' ? parsed.resources.find(item => item.kind === 'secret')?.id : `projects/${n.projectNumber}`;
    if (x.role !== role || x.member !== member || !resource || x.policyResource !== resource) throw new InstallationError('ownership_mismatch');
  }
  return parsed;
}
function marker(intent: CloudInstallationIntent, attempt: CloudInstallationAttempt) {
  return `hypervibe:${names(intent).owner}:${attempt.id}`;
}
function evidence(context: ActionContext, resources: CloudInstallationEvidence['resources'], native: Record<string, unknown> = {}) {
  return parseEvidence({ resources, native: { operation: context.action.metadata.operation, owner: names(context.intent).owner, installationId: context.intent.installationId,
    ...(context.attempt ? { attemptId: context.attempt.id } : {}), ...native } }, context.intent);
}
function completedResource(context: Context, actionId: string, kind: string) {
  const value = context.completed?.[actionId];
  const resource = value && parseEvidence(value, context.intent).resources.find(item => item.kind === kind);
  if (!resource) throw new InstallationError('ownership_mismatch');
  return resource;
}
function sameIdentity(actual: CloudInstallationEvidence['resources'][number], expected: CloudInstallationEvidence['resources'][number]) {
  if (actual.id !== expected.id || JSON.stringify(actual.identity) !== JSON.stringify(expected.identity)) throw new InstallationError('identity_mismatch');
}

/** Hosted GCP installation; only injected, short-lived browser/host credentials.
 * The caller supplies a durable CAS store through the shared lifecycle engine.
 * No ADC, SQLite, cloud CLI, refresh token, service-account key, or secret value. */
export function createGcpCloudInstallationDriver(options: { fetch?: typeof fetch; holdingImage?: string } = {}): CloudInstallationDriver {
  const request = options.fetch ?? fetch;
  async function withClient<T>(context: Context, run: (client: GcpSecretWriterClient, budget: DestinationBudget, token: string) => Promise<T>): Promise<T> {
    scope(context.intent);
    if (!context.authentication.administrator) throw new InstallationError('authorization_expired');
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      const token = await budget.wait(context.authentication.administrator.getAccessToken(SCOPE, budget.signal));
      const client = new GcpSecretWriterClient({ token, budget, request, beforeWrite: async () => {
        if (context.signal.aborted) throw new InstallationError('cancelled');
        await context.beforeMutation();
      }, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
      await client.project(context.intent.nativeScope.projectId, context.intent.nativeScope.projectNumber);
      return await run(client, budget, token);
    } finally { budget.close(); }
  }
  async function account(client: GcpSecretWriterClient, context: Context) {
    const n = names(context.intent);
    let result: Record<string, unknown>;
    try { result = await client.json(`https://iam.googleapis.com/v1/${n.account}`); }
    catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
    if (result.name !== n.account || result.projectId !== n.projectId || result.email !== n.email
      || typeof result.uniqueId !== 'string' || !/^[1-9]\d{5,29}$/.test(result.uniqueId) || typeof result.description !== 'string'
      || result.disabled !== undefined && result.disabled !== false) throw new InstallationError('identity_mismatch');
    return result as { name: string; uniqueId: string; description: string };
  }
  async function observe(client: GcpSecretWriterClient, context: ActionContext): Promise<CloudInstallationObservation> {
    const n = names(context.intent); const op = context.action.metadata.operation; const native = context.action.metadata.native;
    if (op === 'enable-api') {
      const name = context.action.resource.name;
      const value = await client.json(`https://serviceusage.googleapis.com/v1/${name}`);
      if (value.name !== name || !['ENABLED', 'DISABLED'].includes(String(value.state))) throw new InstallationError('identity_mismatch');
      return value.state === 'ENABLED' ? { state: 'satisfied', evidence: evidence(context, [{ kind: 'service', id: name, identity: {} }]) }
        : context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
    }
    if (op === 'inspect-existing-secret') {
      const result = await client.json(`https://secretmanager.googleapis.com/v1/${context.action.resource.name}`);
      if (result.name !== context.action.resource.name || result.createTime !== native.createTime)
        return { state: 'conflict', reason: 'identity_mismatch' };
      return { state: 'satisfied', evidence: evidence(context, [{ kind: 'secret', id: context.action.resource.name,
        identity: { createTime: String(result.createTime), adoption: 'reviewed-existing' } }], { key: native.key }) };
    }
    if (op === 'create-account' || op === 'create-role' || op === 'create-secret') {
      let found: { id: string; kind: 'serviceAccount' | 'role' | 'secret'; identity: z.infer<typeof identitySchema> } | null = null;
      if (op === 'create-account') {
        const result = await account(client, context);
        if (result) {
          const match = /^hypervibe:([a-f0-9]{64}):([a-f0-9-]{36})$/.exec(result.description);
          if (!match || match[1] !== n.owner || context.attempt && match[2] !== context.attempt.id) return { state: 'conflict', reason: 'ownership_mismatch' };
          found = { kind: 'serviceAccount', id: result.name, identity: { uniqueId: result.uniqueId, owner: match[1], attemptId: match[2] } };
        }
      } else if (op === 'create-role') {
        const role = native.role as keyof typeof permissions;
        const result = await client.role(n.roles[role]);
        if (result) {
          const match = /^hypervibe:([a-f0-9]{64}):([a-f0-9-]{36})$/.exec(result.description);
          if (!match || match[1] !== n.owner || context.attempt && match[2] !== context.attempt.id
            || JSON.stringify([...result.includedPermissions].sort()) !== JSON.stringify([...permissions[role]].sort())) return { state: 'conflict', reason: 'ownership_mismatch' };
          found = { kind: 'role', id: result.name, identity: { owner: match[1], attemptId: match[2] } };
        }
      } else {
        let result: Record<string, unknown> | null;
        try { result = await client.json(`https://secretmanager.googleapis.com/v1/${context.action.resource.name}`); }
        catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) result = null; else throw error; }
        if (result) {
          const labels = z.record(z.string(), z.string()).parse(result.labels ?? {});
          if (result.name !== context.action.resource.name || !z.string().datetime().safeParse(result.createTime).success
            || labels['hv-installation'] !== n.owner.slice(0, 63) || context.attempt && labels['hv-attempt'] !== context.attempt.id) return { state: 'conflict', reason: 'ownership_mismatch' };
          found = { kind: 'secret', id: String(result.name), identity: { createTime: String(result.createTime), owner: n.owner, attemptId: labels['hv-attempt'] } };
        }
      }
      if (!found) return context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
      // A matching marker without our retained attempt/completion is not adoption authority.
      if (!context.attempt && !context.completed?.[context.action.id]) return { state: 'conflict', reason: 'ownership_mismatch' };
      const previous = context.completed?.[context.action.id]?.resources[0];
      if (previous) sameIdentity(found, previous);
      return { state: 'satisfied', evidence: evidence(context, [found], native.key ? { key: native.key } : {}) };
    }
    if (op === 'grant' || op === 'revoke') {
      const grant = await grantDetails(client, context);
      const policy = await client.policy(grant.policyKind, grant.policyResource);
      const present = policy.bindings.some(binding => binding.role === grant.role && !binding.condition && binding.members.includes(grant.member));
      const satisfied = op === 'revoke' ? !present : present;
      if (op === 'grant' && present && !context.attempt && !context.completed?.[context.action.id])
        return { state: 'conflict', reason: 'ownership_mismatch' };
      if (satisfied) return { state: 'satisfied', evidence: evidence(context, grant.resources, grant.native) };
      return context.attempt ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
    }
    if (op === 'verify-writer' && context.attempt) return verifyWriter(context);
    return { state: 'action-required' };
  }
  async function grantDetails(client: GcpSecretWriterClient, context: ActionContext) {
    const n = names(context.intent); const native = context.action.metadata.native;
    if (context.action.metadata.operation === 'revoke') {
      const original = parseEvidence(native.evidence, context.intent);
      const x = original.native;
      if (x.operation !== 'grant' || !x.role || !x.member || !x.policyKind || !x.policyResource) throw new InstallationError('ownership_mismatch');
      // Compare immutable IDs before removing access; retain every unrelated binding.
      for (const resource of original.resources) {
        if (resource.kind === 'serviceAccount') {
          const observed = await client.json(`https://iam.googleapis.com/v1/${resource.id}`);
          if (observed.uniqueId !== resource.identity.uniqueId || observed.name !== resource.id) throw new InstallationError('identity_mismatch');
        } else if (resource.kind === 'secret') {
          const observed = await client.json(`https://secretmanager.googleapis.com/v1/${resource.id}`);
          if (observed.createTime !== resource.identity.createTime || observed.name !== resource.id) throw new InstallationError('identity_mismatch');
        }
      }
      return { role: String(x.role), member: String(x.member), policyKind: x.policyKind as 'project' | 'account' | 'secret',
        policyResource: String(x.policyResource), resources: original.resources, native: { ...x, operation: 'revoke' } };
    }
    const expected = completedResource(context, 'gcp:account', 'serviceAccount');
    const actual = await account(client, context);
    if (!actual || actual.uniqueId !== expected.identity.uniqueId || actual.description !== `hypervibe:${expected.identity.owner}:${expected.identity.attemptId}`) throw new InstallationError('identity_mismatch');
    const role = native.role as keyof typeof permissions;
    const expectedRole = completedResource(context, `gcp:role:${role}`, 'role');
    const roleValue = await client.role(expectedRole.id);
    if (!roleValue || roleValue.description !== `hypervibe:${expectedRole.identity.owner}:${expectedRole.identity.attemptId}`
      || JSON.stringify([...roleValue.includedPermissions].sort()) !== JSON.stringify([...permissions[role]].sort())) throw new InstallationError('identity_mismatch');
    const policyKind = native.policyKind as 'project' | 'account' | 'secret';
    const member = `serviceAccount:${policyKind === 'account' ? context.intent.hostIdentity.serviceAccountEmail : n.email}`;
    const resources = [expected];
    let policyResource = policyKind === 'account' ? `projects/${n.projectId}/serviceAccounts/${actual.uniqueId}` : `projects/${n.projectNumber}`;
    if (policyKind === 'secret') {
      const secret = completedResource(context, `gcp:secret:${native.key}`, 'secret');
      const observed = await client.json(`https://secretmanager.googleapis.com/v1/${secret.id}`);
      if (observed.name !== secret.id || observed.createTime !== secret.identity.createTime) throw new InstallationError('identity_mismatch');
      resources.push(secret); policyResource = secret.id;
    }
    return { role: n.roles[role], member, policyKind, policyResource, resources,
      native: { role: n.roles[role], member, policyKind, policyResource } };
  }
  async function verifyWriter(context: ActionContext): Promise<CloudInstallationObservation> {
    const n = names(context.intent); const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      const writer = completedResource(context, 'gcp:account', 'serviceAccount');
      const hostToken = await budget.wait(context.authentication.host.getAccessToken(budget.signal));
      const accountValue = await destinationJson(request, budget, `https://iam.googleapis.com/v1/${writer.id}`, hostToken);
      if (accountValue.name !== writer.id || accountValue.uniqueId !== writer.identity.uniqueId) throw new InstallationError('identity_mismatch');
      const minted = await destinationJson(request, budget, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${n.email}:generateAccessToken`, hostToken,
        { method: 'POST', body: JSON.stringify({ scope: [SCOPE], lifetime: '900s' }) });
      const expires = typeof minted.expireTime === 'string' ? Date.parse(minted.expireTime) : NaN;
      if (typeof minted.accessToken !== 'string' || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 960_000) throw new InstallationError('provider_error');
      for (const resource of Object.values(n.secrets)) {
        const result = await destinationJson(request, budget, `https://secretmanager.googleapis.com/v1/${resource}:testIamPermissions`, minted.accessToken,
          { method: 'POST', body: JSON.stringify({ permissions: permissions.writer }) });
        const actual = result.permissions;
        if (!Array.isArray(actual) || !permissions.writer.every(permission => actual.includes(permission))) throw new InstallationError('insufficient_permissions');
      }
      return { state: 'satisfied', evidence: evidence(context, [writer]) };
    } finally { budget.close(); }
  }
  const driver: CloudInstallationDriver = {
    provider: 'gcp', parseScope: value => scopeSchema.parse(value), parseEvidence,
    parseAction(value, intent) {
      const selected = value as CloudInstallationAction;
      const existing: Record<string, string> = {};
      if (selected?.metadata?.operation === 'inspect-existing-secret') {
        const native = z.object({ key: z.string(), createTime: z.string().datetime() }).strict().parse(selected.metadata.native);
        existing[native.key] = native.createTime;
      }
      const match = actionsFor(intent, existing).find(action => action.id === selected?.id);
      if (!match || !isDeepStrictEqual(value, match)) throw new InstallationError('identity_mismatch');
      return match;
    },
    async discoverScopes(context) {
      const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
      try {
        if (!context.authentication.administrator) throw new InstallationError('authorization_expired');
        const token = await budget.wait(context.authentication.administrator.getAccessToken(SCOPE, budget.signal));
        const query = new URLSearchParams({ pageSize: '100', ...(context.cursor ? { pageToken: context.cursor } : {}) });
        const result = await destinationJson(request, budget, `https://cloudresourcemanager.googleapis.com/v3/projects:search?${query}`, token);
        const projects = z.array(z.object({ name: z.string().regex(/^projects\/[1-9]\d*$/), projectId: scopeSchema.shape.projectId,
          state: z.enum(['ACTIVE', 'DELETE_REQUESTED']) })).max(100).parse(result.projects ?? []);
        const seen = new Set<string>();
        const scopes = projects.filter(project => project.state === 'ACTIVE').map(project => {
          if (seen.has(project.name)) throw new InstallationError('identity_mismatch'); seen.add(project.name);
          return { nativeScope: scopeSchema.parse({ projectId: project.projectId, projectNumber: project.name.slice(9) }), label: project.projectId };
        });
        const cursor = z.string().max(4096).optional().parse(result.nextPageToken) || undefined;
        return { state: cursor ? 'partial' : 'complete', scopes, authority: 'not-verified', ...(cursor ? { cursor } : {}) };
      } catch { return { state: 'unknown', scopes: [], authority: 'not-verified' }; }
      finally { budget.close(); }
    },
    async plan(context) {
      const n = names(context.intent);
      let actions: CloudInstallationAction[] = [];
      await withClient(context, async client => {
        const required = context.intent.mode === 'disconnect' ? installPermissions.filter(value => /getIamPolicy|setIamPolicy|\.get$/.test(value)) : installPermissions.filter(value => context.intent.mode !== 'migrate' || value !== 'secretmanager.secrets.create');
        const result = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}:testIamPermissions`,
          { method: 'POST', body: JSON.stringify({ permissions: required }) });
        const actual = result.permissions;
        if (!Array.isArray(actual) || !required.every(permission => actual.includes(permission))) throw new InstallationError('insufficient_permissions');
        const existing: Record<string, string> = {};
        if (context.intent.mode === 'migrate') for (const [key, name] of Object.entries(n.secrets)) {
          const observed = await client.json(`https://secretmanager.googleapis.com/v1/${name}`);
          if (observed.name !== name || !z.string().datetime().safeParse(observed.createTime).success) throw new InstallationError('identity_mismatch');
          existing[key] = String(observed.createTime);
        }
        actions = actionsFor(context.intent, existing);
      });
      return { actions, review: {
        permissions: context.intent.mode === 'disconnect' ? actions.map(action => {
          const original = parseEvidence(action.metadata.native.evidence, context.intent).native;
          return { principal: String(original.member).slice('serviceAccount:'.length), scope: String(original.policyResource),
            actions: [String(original.role)], purpose: 'writer' as const };
        }) : [
          ...Object.values(n.secrets).map(resource => ({ principal: n.email, scope: resource, actions: permissions.writer, purpose: 'writer' as const })),
          { principal: n.email, scope: `projects/${n.projectNumber}`, actions: permissions.verifier, purpose: 'installation-verification' },
          { principal: context.intent.hostIdentity.serviceAccountEmail, scope: n.account, actions: permissions.impersonator, purpose: 'writer' },
        ], costs: [{ resource: 'Secret Manager', description: 'Active secret versions and API operations may incur charges after values are submitted.', pricingUrl: 'https://cloud.google.com/secret-manager/pricing' }],
        warnings: ['Hypercloud handles submitted secret values transiently while delivering them to Google Secret Manager.',
          'Removing collection access preserves stored versions and separately authorized runtime readers. Previously minted tokens may remain valid until expiry; IAM changes can take time to propagate.'],
      } };
    },
    async inspect(context) {
      try { driver.parseAction(context.action, context.intent); return await withClient(context, client => observe(client, context)); }
      catch (error) { return { state: 'unknown', reason: reason(error) }; }
    },
    async recover(context) {
      try {
        driver.parseAction(context.action, context.intent);
        return await withClient(context, client => observe(client, context));
      } catch (error) { return { state: 'unknown', reason: reason(error) }; }
    },
    async mutate(context) {
      let canRetry = () => true;
      try {
        driver.parseAction(context.action, context.intent);
        return await withClient(context, async client => {
          canRetry = () => client.canRetryRejectedMutation();
          const n = names(context.intent); const op = context.action.metadata.operation; const native = context.action.metadata.native;
          // Each mutation begins with a fresh read. A create never replaces or adopts.
          if (op !== 'verify-writer') {
            const current = await observe(client, { ...context, attempt: undefined });
            if (current.state !== 'action-required') return { state: 'rejected' as const, reason: 'ownership_mismatch' as const };
          }
          if (op === 'create-account') { await client.createAccount(n.projectId, n.accountId, marker(context.intent, context.attempt)); }
          else if (op === 'create-role') {
            const role = native.role as keyof typeof permissions;
            await client.createRole(n.projectId, n.roles[role].split('/').at(-1)!, marker(context.intent, context.attempt), permissions[role]);
          } else if (op === 'create-secret') {
            await client.json(`https://secretmanager.googleapis.com/v1/projects/${n.projectNumber}/secrets?${new URLSearchParams({ secretId: context.action.resource.name.split('/').at(-1)! })}`,
              { method: 'POST', body: JSON.stringify({ replication: { automatic: {} }, labels: { 'hv-installation': n.owner.slice(0, 63), 'hv-attempt': context.attempt.id } }) }, true);
          } else if (op === 'enable-api') {
            const operation = await client.json(`https://serviceusage.googleapis.com/v1/${context.action.resource.name}:enable`, { method: 'POST', body: '{}' }, true);
            if (typeof operation.name !== 'string' || !/^operations\/[a-zA-Z0-9_.-]{1,255}$/.test(operation.name)) throw new InstallationError('provider_error');
            return { state: 'acknowledged' as const, evidence: evidence(context, [], { operationName: operation.name }) };
          } else if (op === 'grant' || op === 'revoke') {
            const grant = await grantDetails(client, context);
            const policy = await client.policy(grant.policyKind, grant.policyResource);
            const bindings = structuredClone(policy.bindings);
            if (op === 'grant') {
              const existing = bindings.find(binding => binding.role === grant.role && !binding.condition);
              if (existing) { if (!existing.members.includes(grant.member)) existing.members.push(grant.member); }
              else bindings.push({ role: grant.role, members: [grant.member] });
            } else {
              for (const binding of bindings) if (binding.role === grant.role && !binding.condition) binding.members = binding.members.filter(member => member !== grant.member);
            }
            const next: WriterIamPolicy = { ...policy, bindings: bindings.filter(binding => binding.members.length) };
            await client.setPolicy(grant.policyKind, grant.policyResource, next);
          } else if (op === 'verify-writer') {
            await context.beforeMutation();
            const verified = await verifyWriter(context);
            if (verified.state !== 'satisfied') throw new InstallationError('not_converged');
            return { state: 'acknowledged' as const, evidence: verified.evidence };
          }
          const observed = await observe(client, context);
          if (observed.state !== 'satisfied') return { state: 'uncertain' as const, reason: 'not_converged' as const };
          return { state: 'acknowledged' as const, evidence: observed.evidence };
        });
      } catch (error) {
        return { state: canRetry() ? 'rejected' : 'uncertain', reason: reason(error) };
      }
    },
    connections(record) {
      if (record.status !== 'ready' || record.intent.mode === 'disconnect' || record.intent.provider !== 'gcp') return [];
      const n = names(record.intent); const writer = parseEvidence(record.completed['gcp:account'], record.intent).resources[0];
      if (writer.id !== n.account || !writer.identity.uniqueId) throw new InstallationError('identity_mismatch');
      return record.intent.keys.map(key => {
        const target = parseEvidence(record.completed[`gcp:secret:${key}`], record.intent).resources[0];
        if (target.id !== n.secrets[key]) throw new InstallationError('identity_mismatch');
        return { key, destination: { provider: 'gcp-secret-manager', projectId: n.projectId, projectNumber: n.projectNumber, secretId: target.id.split('/').at(-1)! },
          writerAuthorization: { projectId: n.projectId, projectNumber: n.projectNumber, serviceAccountEmail: n.email,
            serviceAccountUniqueId: writer.identity.uniqueId, hostServiceAccountEmail: record.intent.hostIdentity.serviceAccountEmail,
            hostSubject: record.intent.hostIdentity.subject, installationId: record.intent.installationId } };
      });
    },
  };
  const preparation = createGcpProjectPreparationDriver(options);
  const billing = createGcpBillingPreparationDriver(options);
  const deployment = createGcpCloudDeploymentDriver(options);
  const selected = (intent: CloudInstallationIntent) => intent.stage === 'scope-preparation'
    ? intent.nativeScope.scopeKind === 'project-billing' ? billing : preparation : intent.purpose === 'deployment' ? deployment : driver;
  return {
    ...driver, deployment: deployment.deployment, scopePreparation: {
      continuationStage: record => selected(record.intent).scopePreparation!.continuationStage?.(record) ?? 'collection',
      resolvedScope: record => selected(record.intent).scopePreparation!.resolvedScope(record),
      reviewResources: record => selected(record.intent).scopePreparation!.reviewResources(record),
      disconnectionIntent: (record, id) => {
        const project = selected(record.intent).scopePreparation;
        if (!project?.disconnectionIntent) throw new InstallationError('not_installed');
        return project.disconnectionIntent(record, id);
      },
    },
    parseScope: value => value && typeof value === 'object' && 'scopeKind' in value
      ? z.union([gcpProjectPreparationScopeSchema, gcpBillingPreparationScopeSchema]).parse(value) : scopeSchema.parse(value),
    parseAction: (value, intent) => selected(intent).parseAction(value, intent),
    parseEvidence: (value, intent) => selected(intent).parseEvidence(value, intent),
    plan: context => selected(context.intent).plan(context),
    inspect: context => selected(context.intent).inspect(context),
    mutate: context => selected(context.intent).mutate(context),
    recover: context => selected(context.intent).recover(context),
    connections: record => selected(record.intent).connections(record),
    async discoverScopes(context) {
      const existing = await driver.discoverScopes!(context);
      try {
        const proposed = await discoverGcpProjectPreparationScopes(context, request);
        return { ...existing, scopes: [...existing.scopes, ...proposed.scopes],
          state: existing.state === 'complete' && proposed.complete ? 'complete' : 'partial' };
      } catch { return { ...existing, state: existing.state === 'unknown' ? 'unknown' : 'partial' }; }
    },
  };
}
