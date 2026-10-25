import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt,
  type CloudInstallationDriver, type CloudInstallationEvidence, type CloudInstallationIntent,
  type CloudInstallationObservation, type CloudInstallationProviderContext, type CloudInstallationReason,
} from '../../../domain/ports/cloud-installation.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { GcpBootstrapApiError, GcpBootstrapClient, type GcpBootstrapProject } from './gcp-bootstrap.client.js';

const TOKEN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const PROJECT = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const NUMBER = z.string().regex(/^[1-9]\d{5,29}$/);
const PARENT = z.string().regex(/^(organizations|folders)\/[1-9]\d*$/);
const BILLING = z.string().regex(/^billingAccounts\/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/);
export const gcpProjectPreparationScopeSchema = z.object({ scopeKind: z.literal('new-project'), projectId: PROJECT,
  displayName: z.string().min(4).max(30).regex(/^[A-Za-z0-9][A-Za-z0-9 '!\-]*[A-Za-z0-9]$/),
  parent: PARENT.optional(), billingAccountName: BILLING }).strict();
const proofSchema = z.object({ resources: z.array(z.object({ kind: z.literal('project'), id: z.string().regex(/^projects\/[1-9]\d{5,29}$/),
  identity: z.object({ projectId: PROJECT, projectNumber: NUMBER, createTime: z.string().datetime(), parent: z.union([PARENT, z.literal('none')]),
    owner: z.string().regex(/^[a-f0-9]{64}$/), attemptId: z.string().uuid() }).strict() }).strict()).max(1),
  native: z.object({ operation: z.enum(['create-project', 'verify-billing']), installationId: z.string().uuid(), owner: z.string().regex(/^[a-f0-9]{64}$/),
    attemptId: z.string().uuid().optional(), operationName: z.string().regex(/^operations\/[A-Za-z0-9._~-]{1,255}$/).optional(),
    billingAccountName: BILLING.optional() }).strict() }).strict();
type Context = CloudInstallationProviderContext;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
class ScopeError extends CloudInstallationBoundaryError {}
function errorReason(error: unknown): CloudInstallationReason {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof DestinationBoundaryError || error instanceof GcpBootstrapApiError) {
    if (error.status === 401) return 'authorization_expired';
    if (error.status === 403) return 'insufficient_permissions';
  }
  if (error instanceof DestinationBoundaryError && error.code === 'deadline_exceeded') return 'timeout';
  return 'provider_error';
}
function scope(intent: CloudInstallationIntent) {
  if (intent.provider !== 'gcp' || intent.stage !== 'scope-preparation' || intent.mode !== 'connect') throw new ScopeError('identity_mismatch');
  return gcpProjectPreparationScopeSchema.parse(intent.nativeScope);
}
function owner(intent: CloudInstallationIntent) {
  return createHash('sha256').update(JSON.stringify([intent.customerId, intent.appId, intent.environment, intent.installationId])).digest('hex');
}
function actions(intent: CloudInstallationIntent): CloudInstallationAction[] {
  const target = scope(intent);
  return [{ id: 'gcp:project', type: 'create', resource: { kind: 'project', name: target.projectId, provider: 'gcp' }, verified: true,
    requiresConfirm: true, billable: true, reason: 'Create the reviewed application project; retain it if later setup is blocked.',
    metadata: { operation: 'create-project', category: 'scope', execution: 'api', native: {} } }];
}
function parseEvidence(value: unknown, intent: CloudInstallationIntent): CloudInstallationEvidence {
  const parsed = proofSchema.parse(value); const target = scope(intent); const expectedOwner = owner(intent);
  if (parsed.native.installationId !== intent.installationId || parsed.native.owner !== expectedOwner) throw new ScopeError('ownership_mismatch');
  for (const resource of parsed.resources) {
    if (resource.identity.projectId !== target.projectId || resource.id !== `projects/${resource.identity.projectNumber}`
      || resource.identity.owner !== expectedOwner || target.parent && resource.identity.parent !== target.parent
      || parsed.native.operation === 'create-project' && parsed.native.attemptId !== resource.identity.attemptId) throw new ScopeError('identity_mismatch');
  }
  if (parsed.native.operation === 'verify-billing' && (parsed.resources.length !== 1 || parsed.native.billingAccountName !== target.billingAccountName)) throw new ScopeError('identity_mismatch');
  return parsed;
}
function proof(context: ActionContext, project?: GcpBootstrapProject, operationName?: string): CloudInstallationEvidence {
  const expectedOwner = owner(context.intent); const target = scope(context.intent);
  if (project && (project.projectId !== target.projectId || project.state !== 'ACTIVE' || !project.createTime
    || project.labels?.['hv-installation'] !== expectedOwner.slice(0, 63) || !z.string().uuid().safeParse(project.labels?.['hv-attempt']).success
    || context.attempt && project.labels?.['hv-attempt'] !== context.attempt.id || target.parent && project.parent !== target.parent)) throw new ScopeError('ownership_mismatch');
  return parseEvidence({ resources: project ? [{ kind: 'project', id: project.name, identity: {
    projectId: project.projectId, projectNumber: project.name.slice(9), createTime: project.createTime,
    parent: project.parent ?? 'none', owner: expectedOwner, attemptId: project.labels!['hv-attempt'],
  } }] : [], native: { operation: context.action.metadata.operation, installationId: context.intent.installationId, owner: expectedOwner,
    ...(context.attempt ? { attemptId: context.attempt.id } : {}), ...(operationName ? { operationName } : {}),
    ...(context.action.metadata.operation === 'verify-billing' ? { billingAccountName: target.billingAccountName } : {}) } }, context.intent);
}

/** Creates only the reviewed project; its actual parent is reviewed before billing. */
export function createGcpProjectPreparationDriver(options: { fetch?: typeof fetch } = {}): CloudInstallationDriver {
  const request = options.fetch ?? fetch;
  async function withClient<T>(context: Context, work: (client: GcpBootstrapClient, json: (url: string, init?: RequestInit) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
    scope(context.intent);
    if (!context.authentication.administrator) throw new ScopeError('authorization_expired');
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      const token = await budget.wait(context.authentication.administrator.getAccessToken(TOKEN_SCOPE, budget.signal));
      const json = (url: string, init?: RequestInit) => destinationJson(request, budget, url, token, init);
      const boundedFetch: typeof fetch = async (url, init = {}) => {
        const target = new URL(String(url));
        if (target.protocol !== 'https:' || !['cloudresourcemanager.googleapis.com', 'cloudbilling.googleapis.com'].includes(target.hostname)
          || target.username || target.password || target.port) throw new ScopeError('identity_mismatch');
        if (init.method && init.method !== 'GET') {
          if (target.href !== 'https://cloudresourcemanager.googleapis.com/v3/projects' || init.method !== 'POST') throw new ScopeError('ownership_mismatch');
          await budget.wait(context.beforeMutation());
        }
        try { return Response.json(await json(target.href, init)); }
        catch (error) { if (error instanceof DestinationBoundaryError && error.status) return Response.json({}, { status: error.status }); throw error; }
      };
      return await work(new GcpBootstrapClient({ accessToken: token, fetch: boundedFetch, sleep: async () => {}, maxAttempts: 1, delayMs: 0 }), json);
    } finally { budget.close(); }
  }
  async function authority(context: Context, json: (url: string, init?: RequestInit) => Promise<Record<string, unknown>>) {
    const target = scope(context.intent);
    const account = await json(`https://cloudbilling.googleapis.com/v1/${target.billingAccountName}`);
    if (account.name !== target.billingAccountName || account.open !== true) throw new ScopeError('insufficient_permissions');
    for (const [url, permissions] of [
      [`https://cloudbilling.googleapis.com/v1/${target.billingAccountName}:testIamPermissions`, ['billing.resourceAssociations.create', 'billing.accounts.getIamPolicy', 'billing.accounts.setIamPolicy']],
      ...(target.parent ? [[`https://cloudresourcemanager.googleapis.com/v3/${target.parent}:testIamPermissions`, ['resourcemanager.projects.create']]] : []),
    ] as Array<[string, string[]]>) {
      const result = await json(url, { method: 'POST', body: JSON.stringify({ permissions }) });
      const granted = result.permissions;
      if (!Array.isArray(granted) || !permissions.every(permission => granted.includes(permission))) throw new ScopeError('insufficient_permissions');
    }
  }
  async function observe(context: ActionContext, client: GcpBootstrapClient): Promise<CloudInstallationObservation> {
    const target = scope(context.intent);
    let acknowledged: GcpBootstrapProject | undefined;
    let operationName: string | undefined;
    if (context.action.metadata.operation === 'create-project' && context.attempt?.evidence) {
      const old = parseEvidence(context.attempt.evidence, context.intent);
      if (old.native.operationName) {
        operationName = String(old.native.operationName);
        const operation = await client.getProjectCreateOperation(operationName, target.projectId);
        if (operation?.state === 'pending') return { state: 'pending', reason: 'not_converged' };
        if (operation?.state === 'failed') return { state: 'unknown', reason: 'provider_error' };
        if (operation?.state === 'succeeded') acknowledged = operation.project;
      }
    }
    const project = await client.getProject(target.projectId);
    if (!project) return context.attempt || context.action.metadata.operation !== 'create-project'
      ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
    if (context.action.metadata.operation === 'create-project' && !context.attempt) return { state: 'conflict', reason: 'ownership_mismatch' };
    const observed = proof(context, project, operationName);
    if (acknowledged && !isDeepStrictEqual(proof(context, acknowledged).resources, observed.resources)) throw new ScopeError('identity_mismatch');
    const retained = context.completed['gcp:project'] ?? context.attempt?.evidence;
    if (retained) {
      const prior = parseEvidence(retained, context.intent);
      if (prior.resources.length && !isDeepStrictEqual(prior.resources, observed.resources)) throw new ScopeError('identity_mismatch');
    }
    if (context.action.metadata.operation === 'verify-billing') {
      if (!context.completed['gcp:project']) throw new ScopeError('ownership_mismatch');
      const billing = await client.getProjectBillingInfo(target.projectId);
      if (billing?.billingAccountName && billing.billingAccountName !== target.billingAccountName) return { state: 'conflict', reason: 'ownership_mismatch' };
      if (!billing?.billingEnabled || billing.billingAccountName !== target.billingAccountName) return { state: 'rejected', reason: 'billing_assignment_unverified' };
    }
    return { state: 'satisfied', evidence: observed };
  }
  const driver: CloudInstallationDriver = {
    provider: 'gcp', parseScope: value => gcpProjectPreparationScopeSchema.parse(value), parseEvidence,
    scopePreparation: { disconnectionIntent: () => null, continuationStage: () => 'scope-preparation', resolvedScope(record) {
      if (record.status !== 'scope-ready') throw new ScopeError('not_installed');
      const project = parseEvidence(record.completed['gcp:project'], record.intent).resources[0];
      if (!project) throw new ScopeError('identity_mismatch');
      return { scopeKind: 'project-billing', projectId: project.identity.projectId, projectNumber: project.identity.projectNumber,
        projectCreateTime: project.identity.createTime, projectParent: project.identity.parent, projectInstallationId: record.intent.installationId,
        projectAttemptId: project.identity.attemptId, billingAccountName: scope(record.intent).billingAccountName };
    }, reviewResources(record) {
      const resolved = driver.scopePreparation!.resolvedScope(record);
      const project = parseEvidence(record.completed['gcp:project'], record.intent).resources[0];
      return [{ kind: 'project', name: resolved.projectId, scope: project.identity.parent === 'none' ? 'No organization (observed)' : project.identity.parent },
        { kind: 'billing-account', name: scope(record.intent).billingAccountName, scope: `projects/${resolved.projectNumber}` }];
    } },
    parseAction(value, intent) {
      const action = actions(intent).find(item => item.id === (value as CloudInstallationAction)?.id);
      if (!action || !isDeepStrictEqual(value, action)) throw new ScopeError('identity_mismatch');
      return action;
    },
    async plan(context) {
      try {
        await withClient(context, async (client, json) => {
          await authority(context, json);
          if (await client.getProject(scope(context.intent).projectId)) throw new ScopeError('ownership_mismatch');
        });
        const target = scope(context.intent);
        return { actions: actions(context.intent), review: {
          resources: [{ kind: 'project', name: target.projectId, scope: target.parent ?? 'Google-selected parent, verified after creation' }],
          permissions: [{ principal: 'Browser-authorized administrator', scope: target.parent ?? 'Google-selected parent', actions: ['resourcemanager.projects.create'], purpose: 'installation-verification' },
            { principal: 'Browser-authorized administrator', scope: target.billingAccountName, actions: ['billing.resourceAssociations.create', 'billing.accounts.getIamPolicy', 'billing.accounts.setIamPolicy'], purpose: 'installation-verification' }],
          costs: [{ resource: target.projectId, description: 'Creating an empty project does not provision paid workloads. Enabling billing authorizes future resource usage charges; workloads need a separate review.', pricingUrl: 'https://cloud.google.com/pricing' }],
          warnings: ['This stage creates only the reviewed project and retains it on partial setup; it does not create secret containers, writer identities or workloads.',
            'A separate review will show the actual project parent, temporary billing identity, permissions and billing attachment before those operations can begin.',
            ...(target.parent ? [] : ['Google may automatically select an organization from the administrator’s domain. The actual parent is retained and verified before continuation.'])],
        } };
      } catch (error) { throw new ScopeError(errorReason(error)); }
    },
    async inspect(context) {
      try { driver.parseAction(context.action, context.intent); return await withClient(context, client => observe(context, client)); }
      catch (error) { return { state: 'unknown', reason: errorReason(error) }; }
    },
    async recover(context) {
      try { driver.parseAction(context.action, context.intent); return await withClient(context, client => observe(context, client)); }
      catch (error) { return { state: 'unknown', reason: errorReason(error) }; }
    },
    async mutate(context) {
      let dispatched = false;
      try {
        driver.parseAction(context.action, context.intent);
        if (context.action.metadata.operation !== 'create-project') throw new ScopeError('ownership_mismatch');
        return await withClient({ ...context, beforeMutation: async () => { await context.beforeMutation(); dispatched = true; } }, async (client, json) => {
          await authority(context, json);
          if (await client.getProject(scope(context.intent).projectId)) throw new ScopeError('ownership_mismatch');
          const target = scope(context.intent);
          const operation = await client.createProject({ projectId: target.projectId, displayName: target.displayName, parent: target.parent,
            labels: { 'hv-installation': owner(context.intent).slice(0, 63), 'hv-attempt': context.attempt.id } });
          return { state: 'acknowledged' as const, evidence: proof(context, undefined, operation.name) };
        });
      } catch (error) {
        const definite = error instanceof GcpBootstrapApiError && [400, 401, 403, 404, 409, 412, 422].includes(error.status ?? 0);
        return { state: !dispatched || definite ? 'rejected' : 'uncertain', reason: errorReason(error) };
      }
    },
    connections: () => [],
  };
  return driver;
}

/** Bounded new-project proposals; sign-in/discovery does not establish authority. */
export async function discoverGcpProjectPreparationScopes(context: Parameters<NonNullable<CloudInstallationDriver['discoverScopes']>>[0], request: typeof fetch) {
  if (!context.sourceScope || context.cursor || context.migrationTargets || !context.authentication.administrator) return { scopes: [], complete: true };
  const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 15_000 });
  try {
    const token = await budget.wait(context.authentication.administrator.getAccessToken(TOKEN_SCOPE, budget.signal));
    const accounts = await destinationJson(request, budget, 'https://cloudbilling.googleapis.com/v1/billingAccounts?pageSize=20', token);
    const open = z.array(z.object({ name: BILLING, open: z.boolean().nullish().transform(value => value ?? false), displayName: z.string().max(256).optional() })).max(20).parse(accounts.billingAccounts ?? []).filter(account => account.open);
    if (new Set(open.map(account => account.name)).size !== open.length) throw new ScopeError('identity_mismatch');
    if (accounts.nextPageToken !== undefined && typeof accounts.nextPageToken !== 'string') throw new ScopeError('provider_error');
    const projectId = resourceName('app', { maxLength: 30, scope: [context.sourceScope.customerId, context.sourceScope.appId, context.sourceScope.installationId] });
    return { complete: !accounts.nextPageToken, scopes: open.map(account => ({ stage: 'scope-preparation' as const,
      nativeScope: { scopeKind: 'new-project', projectId, displayName: 'Hypervibe application', billingAccountName: account.name },
      label: `Create ${projectId} · ${account.displayName ?? account.name} · Google-selected parent` })) };
  } finally { budget.close(); }
}
