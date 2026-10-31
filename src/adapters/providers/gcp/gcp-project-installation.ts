import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt,
  type CloudInstallationDriver, type CloudInstallationEvidence, type CloudInstallationIntent,
  type CloudInstallationObservation, type CloudInstallationProviderContext, type CloudInstallationReason,
  type CloudInstallationExecutableIntent, type LocalCloudScopePreparationIntent,
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
  parent: PARENT.optional(), billingAccountName: BILLING,
  allocationMode: z.literal('create-exclusive-v1').optional(),
  assignmentMode: z.literal('initial-reviewed-v1').optional() }).strict();
export const gcpLocalProjectAllocationScopeSchema = gcpProjectPreparationScopeSchema.omit({ billingAccountName: true, assignmentMode: true }).extend({
  scopeKind: z.literal('project-allocation'), allocationMode: z.literal('create-exclusive-v1'),
}).strict();
const proofSchema = z.object({ resources: z.array(z.object({ kind: z.literal('project'), id: z.string().regex(/^projects\/[1-9]\d{5,29}$/),
  identity: z.object({ projectId: PROJECT, projectNumber: NUMBER, createTime: z.string().datetime(), parent: z.union([PARENT, z.literal('none')]),
    owner: z.string().regex(/^[a-f0-9]{64}$/), attemptId: z.string().guid() }).strict() }).strict()).max(1),
  native: z.object({ operation: z.enum(['create-project', 'verify-billing']), installationId: z.string().guid(), owner: z.string().regex(/^[a-f0-9]{64}$/),
    attemptId: z.string().guid().optional(), operationName: z.string().regex(/^operations\/[A-Za-z0-9._~-]{1,255}$/).optional(),
    operationCompleted: z.literal(true).optional(),
    billingAccountName: BILLING.optional() }).strict() }).strict();
type Context = CloudInstallationProviderContext<CloudInstallationExecutableIntent>;
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
function scope(intent: CloudInstallationExecutableIntent) {
  if (intent.provider !== 'gcp' || intent.stage !== 'scope-preparation' || intent.mode !== 'connect') throw new ScopeError('identity_mismatch');
  if ('execution' in intent) {
    if (!('hostingProvider' in intent) || intent.hostingProvider !== 'cloudrun') throw new ScopeError('identity_mismatch');
    return { ...gcpLocalProjectAllocationScopeSchema.parse(intent.nativeScope), billingAccountName: undefined, assignmentMode: undefined };
  }
  return gcpProjectPreparationScopeSchema.parse(intent.nativeScope);
}
function billingAccount(target: ReturnType<typeof scope>): string {
  if (!target.billingAccountName) throw new ScopeError('identity_mismatch');
  return target.billingAccountName;
}
function owner(intent: CloudInstallationExecutableIntent) {
  return createHash('sha256').update(JSON.stringify([intent.customerId, intent.appId, intent.environment, intent.installationId])).digest('hex');
}
function actions(intent: CloudInstallationExecutableIntent): CloudInstallationAction[] {
  const target = scope(intent);
  return [{ id: 'gcp:project', type: 'create', resource: { kind: 'project', name: target.projectId, provider: 'gcp' }, verified: true,
    requiresConfirm: true, billable: true, reason: target.allocationMode
      ? 'Attempt exclusive allocation of the exact reviewed new project ID once; never adopt or overwrite an existing project.'
      : 'Create the reviewed application project; retain it if later setup is blocked.',
    metadata: { operation: 'create-project', category: 'scope', execution: 'api', native: target.allocationMode ? { allocationMode: target.allocationMode } : {} } }];
}
function parseEvidence(value: unknown, intent: CloudInstallationExecutableIntent): CloudInstallationEvidence {
  const parsed = proofSchema.parse(value); const target = scope(intent); const expectedOwner = owner(intent);
  if (parsed.native.installationId !== intent.installationId || parsed.native.owner !== expectedOwner) throw new ScopeError('ownership_mismatch');
  if (target.allocationMode && parsed.resources.length && (!parsed.native.operationName || !parsed.native.operationCompleted)
    || parsed.native.operationCompleted && (!target.allocationMode || parsed.resources.length !== 1 || !parsed.native.operationName)) throw new ScopeError('identity_mismatch');
  for (const resource of parsed.resources) {
    if (resource.identity.projectId !== target.projectId || resource.id !== `projects/${resource.identity.projectNumber}`
      || resource.identity.owner !== expectedOwner || target.parent && resource.identity.parent !== target.parent
      || parsed.native.operation === 'create-project' && parsed.native.attemptId !== resource.identity.attemptId) throw new ScopeError('identity_mismatch');
  }
  if (parsed.native.operation === 'verify-billing' && (parsed.resources.length !== 1 || parsed.native.billingAccountName !== billingAccount(target))) throw new ScopeError('identity_mismatch');
  return parsed;
}
function proof(context: ActionContext, project?: GcpBootstrapProject, operationName?: string, operationCompleted?: true): CloudInstallationEvidence {
  const expectedOwner = owner(context.intent); const target = scope(context.intent);
  if (project && (project.projectId !== target.projectId || project.state !== 'ACTIVE' || !project.createTime
    || project.labels?.['hv-installation'] !== expectedOwner.slice(0, 63) || !z.string().guid().safeParse(project.labels?.['hv-attempt']).success
    || context.attempt && project.labels?.['hv-attempt'] !== context.attempt.id || target.parent && project.parent !== target.parent)) throw new ScopeError('ownership_mismatch');
  return parseEvidence({ resources: project ? [{ kind: 'project', id: project.name, identity: {
    projectId: project.projectId, projectNumber: project.name.slice(9), createTime: project.createTime,
    parent: project.parent ?? 'none', owner: expectedOwner, attemptId: project.labels!['hv-attempt'],
  } }] : [], native: { operation: context.action.metadata.operation, installationId: context.intent.installationId, owner: expectedOwner,
    ...(context.attempt ? { attemptId: context.attempt.id } : {}), ...(operationName ? { operationName } : {}),
    ...(operationCompleted ? { operationCompleted } : {}),
    ...(context.action.metadata.operation === 'verify-billing' ? { billingAccountName: billingAccount(target) } : {}) } }, context.intent);
}

/** Creates only the reviewed project; its actual parent is reviewed before billing. */
export function createGcpProjectPreparationDriver(options: { fetch?: typeof fetch } = {}): CloudInstallationDriver {
  return createProjectDriver<CloudInstallationIntent>(options, false);
}
export function createGcpLocalProjectAllocationDriver(options: { fetch?: typeof fetch } = {}): CloudInstallationDriver<LocalCloudScopePreparationIntent> {
  return createProjectDriver<LocalCloudScopePreparationIntent>(options, true);
}
function createProjectDriver<I extends CloudInstallationExecutableIntent>(options: { fetch?: typeof fetch }, local: boolean): CloudInstallationDriver<I> {
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
    if (target.scopeKind !== 'project-allocation') {
      const account = await json(`https://cloudbilling.googleapis.com/v1/${billingAccount(target)}`);
      if (account.name !== billingAccount(target) || account.open !== true) throw new ScopeError('insufficient_permissions');
    }
    for (const [url, permissions] of [
      ...(target.scopeKind === 'project-allocation' ? [] : [[`https://cloudbilling.googleapis.com/v1/${billingAccount(target)}:testIamPermissions`, target.assignmentMode
        ? ['billing.resourceAssociations.create', 'billing.accounts.get'] : ['billing.resourceAssociations.create', 'billing.accounts.getIamPolicy', 'billing.accounts.setIamPolicy']]]),
      ...(target.parent ? [[`https://cloudresourcemanager.googleapis.com/v3/${target.parent}:testIamPermissions`, ['resourcemanager.projects.create']]] : []),
    ] as Array<[string, string[]]>) {
      const result = await json(url, { method: 'POST', body: JSON.stringify({ permissions }) });
      const granted = result.permissions;
      if (!Array.isArray(granted) || !permissions.every(permission => granted.includes(permission))) throw new ScopeError('insufficient_permissions');
    }
  }
  // This is an allocation preflight, not absence inference. Only the separately
  // reviewed exclusive POST contract permits a denied lookup to remain unknown.
  async function allocationLookup(client: GcpBootstrapClient, intent: CloudInstallationExecutableIntent): Promise<'absent' | 'unknown'> {
    const target = scope(intent);
    let project: GcpBootstrapProject | null;
    try { project = await client.getProject(target.projectId); }
    catch (error) {
      if (target.allocationMode && error instanceof GcpBootstrapApiError && error.status === 403) return 'unknown';
      throw error;
    }
    if (project) throw new ScopeError('ownership_mismatch');
    return 'absent';
  }
  async function observe(context: ActionContext, client: GcpBootstrapClient): Promise<CloudInstallationObservation> {
    const target = scope(context.intent);
    if (target.allocationMode && !context.attempt) {
      if (context.attempts?.some(attempt => attempt.actionId === context.action.id)) return { state: 'rejected', reason: 'retry_confirmation_required' };
      await allocationLookup(client, context.intent);
      // Required work is one explicitly approved allocation attempt, not a
      // create inferred from an absent resource. Unknown lookup stays in review.
      return { state: 'action-required' };
    }
    let acknowledged: GcpBootstrapProject | undefined;
    let operationName: string | undefined;
    let operationCompleted: true | undefined;
    if (context.action.metadata.operation === 'create-project' && context.attempt?.evidence) {
      const old = parseEvidence(context.attempt.evidence, context.intent);
      if (old.native.operationName) {
        operationName = String(old.native.operationName);
        if (target.allocationMode && old.native.operationCompleted) operationCompleted = true;
        else {
          const operation = await client.getProjectCreateOperation(operationName, target.projectId, target.allocationMode ? { requireProjectType: true } : {});
          if (operation?.state === 'pending') return { state: 'pending', reason: 'not_converged' };
          if (operation?.state === 'failed') return { state: 'unknown', reason: 'provider_error' };
          if (operation?.state === 'succeeded') { acknowledged = operation.project; if (target.allocationMode) operationCompleted = true; }
        }
      }
    }
    // A visible same-name project (even with matching labels) cannot replace a
    // lost/expired native operation. Previously completed operation proof remains
    // durable, but its exact project lifetime is still freshly checked below.
    if (target.allocationMode && !operationCompleted) return { state: 'pending', reason: 'not_converged' };
    const project = await client.getProject(target.projectId);
    if (!project) return context.attempt || context.action.metadata.operation !== 'create-project'
      ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
    if (context.action.metadata.operation === 'create-project' && !context.attempt) return { state: 'conflict', reason: 'ownership_mismatch' };
    const observed = proof(context, project, operationName, operationCompleted);
    if (acknowledged && !isDeepStrictEqual(proof(context, acknowledged, operationName, operationCompleted).resources, observed.resources)) throw new ScopeError('identity_mismatch');
    const retained = context.completed['gcp:project'] ?? context.attempt?.evidence;
    if (retained) {
      const prior = parseEvidence(retained, context.intent);
      if (prior.resources.length && !isDeepStrictEqual(prior.resources, observed.resources)) throw new ScopeError('identity_mismatch');
    }
    if (context.action.metadata.operation === 'verify-billing') {
      if (!context.completed['gcp:project']) throw new ScopeError('ownership_mismatch');
      const billing = await client.getProjectBillingInfo(target.projectId);
      if (billing?.billingAccountName && billing.billingAccountName !== billingAccount(target)) return { state: 'conflict', reason: 'ownership_mismatch' };
      if (!billing?.billingEnabled || billing.billingAccountName !== billingAccount(target)) return { state: 'rejected', reason: 'billing_assignment_unverified' };
    }
    return { state: 'satisfied', evidence: observed };
  }
  const driver: CloudInstallationDriver<I> = {
    ...(local ? { localScopePreparation: { hostingProvider: 'cloudrun' } } : {}),
    provider: 'gcp', parseScope: value => local ? gcpLocalProjectAllocationScopeSchema.parse(value) : gcpProjectPreparationScopeSchema.parse(value), parseEvidence,
    scopePreparation: { disconnectionIntent: () => null, continuationStage: () => 'scope-preparation', resolvedScope(record) {
      if (record.status !== 'scope-ready') throw new ScopeError('not_installed');
      const project = parseEvidence(record.completed['gcp:project'], record.intent).resources[0];
      if (!project) throw new ScopeError('identity_mismatch');
      if (local) return { projectId: project.identity.projectId, projectNumber: project.identity.projectNumber,
        projectCreateTime: project.identity.createTime, projectParent: project.identity.parent, projectInstallationId: record.intent.installationId, projectAttemptId: project.identity.attemptId };
      return { scopeKind: 'project-billing', projectId: project.identity.projectId, projectNumber: project.identity.projectNumber,
        projectCreateTime: project.identity.createTime, projectParent: project.identity.parent, projectInstallationId: record.intent.installationId,
        projectAttemptId: project.identity.attemptId, billingAccountName: billingAccount(scope(record.intent)),
        ...(scope(record.intent).assignmentMode ? { assignmentMode: scope(record.intent).assignmentMode! } : {}) };
    }, reviewResources(record) {
      const resolved = driver.scopePreparation!.resolvedScope(record);
      const project = parseEvidence(record.completed['gcp:project'], record.intent).resources[0];
      return [{ kind: 'project', name: resolved.projectId, scope: project.identity.parent === 'none' ? 'No organization (observed)' : project.identity.parent },
        ...(local ? [] : [{ kind: 'billing-account', name: billingAccount(scope(record.intent)), scope: `projects/${resolved.projectNumber}` }])];
    } },
    parseAction(value, intent) {
      const action = actions(intent).find(item => item.id === (value as CloudInstallationAction)?.id);
      if (!action || !isDeepStrictEqual(value, action)) throw new ScopeError('identity_mismatch');
      return action;
    },
    async plan(context) {
      try {
        const observation = await withClient(context, async (client, json) => {
          await authority(context, json);
          return allocationLookup(client, context.intent);
        });
        const target = scope(context.intent);
        return { actions: actions(context.intent), review: {
          resources: [{ kind: 'project', name: target.projectId, scope: target.parent ?? 'Google-selected parent, verified after creation' }],
          permissions: [{ principal: local ? 'Local user administrator (ADC)' : 'Browser-authorized administrator', scope: target.parent ?? 'Google-selected parent', actions: ['resourcemanager.projects.create'], purpose: 'installation-verification' },
            ...(local ? [] : [{ principal: 'Browser-authorized administrator', scope: billingAccount(target), actions: target.assignmentMode
              ? ['billing.resourceAssociations.create', 'billing.accounts.get'] : ['billing.resourceAssociations.create', 'billing.accounts.getIamPolicy', 'billing.accounts.setIamPolicy'], purpose: 'installation-verification' as const }])],
          costs: [{ resource: target.projectId, description: local ? 'This operation creates only an empty project. No billing account is attached, APIs enabled or paid workloads provisioned.' : 'Creating an empty project does not provision paid workloads. Enabling billing authorizes future resource usage charges; workloads need a separate review.', pricingUrl: 'https://cloud.google.com/pricing' }],
          warnings: ['This stage creates only the reviewed project and retains it on partial setup; it does not create secret containers, writer identities or workloads.',
            ...(target.allocationMode ? [
              observation === 'unknown' ? 'The exact project lookup is unknown: Google denied access. This is not evidence that the ID is available.' : 'Google returned not-found for the exact project ID; creation still depends on native global ID availability.',
              'This review authorizes one exclusive CreateProject attempt for this exact ID. A collision fails without adopting, updating or renaming another project. A lost acknowledgment cannot be retried or replaced by a same-name lookup.',
              ...(target.parent ? [] : ['No explicit parent is selected, so parent-level project-creation authority is unverified until Google accepts the native allocation. Sign-in alone does not prove that permission.']),
            ] : []),
            local ? 'This local stage stops after native project allocation. Billing, API setup, connections, identities and workloads require separate desired-state plans.' : target.assignmentMode ? 'A separate review will show the actual project parent, selected billing account, costs and native initial-assignment behavior before billing is enabled.'
              : 'A separate review will show the actual project parent, temporary billing identity, permissions and billing attachment before those operations can begin.',
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
        if (scope(context.intent).allocationMode) {
          const attempts = (context.attempts ?? []).filter(attempt => attempt.actionId === context.action.id);
          if (attempts.length !== 1 || attempts[0].id !== context.attempt.id || attempts[0].status !== 'attempted') throw new ScopeError('retry_confirmation_required');
        }
        return await withClient({ ...context, beforeMutation: async () => { await context.beforeMutation(); dispatched = true; } }, async (client, json) => {
          await authority(context, json);
          await allocationLookup(client, context.intent);
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
      nativeScope: { scopeKind: 'new-project', projectId, displayName: 'Hypervibe application', billingAccountName: account.name,
        allocationMode: 'create-exclusive-v1', assignmentMode: 'initial-reviewed-v1' },
      label: `Create ${projectId} · ${account.displayName ?? account.name} · Google-selected parent` })) };
  } finally { budget.close(); }
}
