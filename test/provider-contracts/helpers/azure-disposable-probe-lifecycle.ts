/** Test-only lifecycle. Never registered as a production provider capability.
 * Explicit synthetic-resource upsert approval is not proof of safe first creation.
 * Uses the real saved-plan executor; no cloud operation occurs while planning.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ConvergeExecutor, planRunDocumentSchema, type ActionResult } from '../../../src/domain/plan/converge.executor.js';
import type { PlanAction } from '../../../src/domain/plan/plan.types.js';
import { RunRepository } from '../../../src/adapters/db/repositories/run.repository.js';
import { resourceName } from '../../../src/domain/services/resource-names.js';
import { DestinationBudget } from '../../../src/adapters/providers/secret-destination-http.js';

const ARM = 'https://management.azure.com';
const kinds = ['group', 'identity', 'vault'] as const;
type Kind = typeof kinds[number];
type Step = 'prepare' | 'control' | 'conditional' | 'delete';
const guid = z.string().guid();
const inputSchema = z.object({ operationId: guid, sourceProjectId: guid, subscriptionId: guid, tenantId: guid,
  authorizationOriginDigest: z.string().regex(/^[a-f0-9]{64}$/),
  location: z.literal('canadacentral'), environment: z.literal('ownership-proof') }).strict();
const absolutePath = z.string().min(2).max(2048).regex(/^\/(?:[^\0\r\n]+)$/);
export const azureProbeOriginSchema = z.object({ runtime: absolutePath, store: absolutePath,
  connectionId: guid, sessionId: guid, subscriptionId: guid, tenantId: guid, sourceProjectId: guid,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
}).strict();
export type AzureProbeOrigin = z.infer<typeof azureProbeOriginSchema>;
type Input = z.infer<typeof inputSchema>;
export interface AzureDisposableProbeSpec extends Input {
  kind: 'azure-disposable-create-only-probe-v1';
  resources: Record<Kind, { id: string; apiVersion: string; body: Record<string, unknown> }>;
}
interface Snapshot { id: string; lifetime: Record<string, string>; fingerprint: string }
interface Event { phase: 'attempted' | 'acknowledged' | 'complete'; attemptId: string; requestId: string;
  status?: number; nativeRequestId?: string; echoedClientRequestId?: string; baseline?: Snapshot; observed?: Snapshot; guard?: 'verified' | 'not-supported' }
interface Access {
  authorizationOriginDigest: string;
  fetch: typeof fetch;
  getAccessToken(signal: AbortSignal): Promise<string>;
  authorize(input: { planId: string; planDigest: string; actionId: string; signal: AbortSignal }): Promise<boolean>;
  signal?: AbortSignal;
}
function fail(code = 'probe_invalid_contract'): never { throw new Error(code); }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const azureProbeOriginDigest = (value: unknown) => digest(azureProbeOriginSchema.parse(value));
const runs = () => new RunRepository();

export function createAzureDisposableProbeSpec(value: Input): AzureDisposableProbeSpec {
  const input = inputSchema.parse(value);
  const scope = [input.sourceProjectId, input.environment, input.operationId];
  const group = resourceName(input.environment, { scope, maxLength: 90 });
  const groupId = `/subscriptions/${input.subscriptionId}/resourceGroups/${group}`;
  const tags = { 'managed-by': 'hypervibe', 'hypervibe-purpose': 'disposable-create-only-probe',
    'hypervibe-probe-operation': input.operationId, 'hypervibe-source-project': input.sourceProjectId };
  return { kind: 'azure-disposable-create-only-probe-v1', ...input, resources: {
    group: { id: groupId, apiVersion: '2021-04-01', body: { location: input.location, tags } },
    identity: { id: `${groupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${resourceName('probe', { scope, maxLength: 128 })}`,
      apiVersion: '2024-11-30', body: { location: input.location, tags } },
    vault: { id: `${groupId}/providers/Microsoft.KeyVault/vaults/${resourceName('probe', { scope, maxLength: 24 })}`,
      apiVersion: '2024-11-01', body: { location: input.location, tags, properties: {
        tenantId: input.tenantId, sku: { family: 'A', name: 'standard' }, accessPolicies: [], enableRbacAuthorization: true,
        enableSoftDelete: true, softDeleteRetentionInDays: 7, enablePurgeProtection: true, publicNetworkAccess: 'Disabled',
      } } },
  } };
}
function parseSpec(value: unknown): AzureDisposableProbeSpec {
  const raw = value as AzureDisposableProbeSpec;
  const input = inputSchema.parse(Object.fromEntries(Object.keys(inputSchema.shape).map(key => [key, raw?.[key as keyof Input]])));
  const expected = createAzureDisposableProbeSpec(input);
  if (!isDeepStrictEqual(value, expected)) fail();
  return expected;
}
function action(spec: AzureDisposableProbeSpec, kind: Kind, step: Step, dependsOn?: string[], expected?: Snapshot): PlanAction {
  return { id: `probe:${kind}:${step}`, type: step === 'prepare' ? 'create' : step === 'delete' ? 'destroy' : 'update',
    resource: { kind: kind === 'group' ? 'project' : kind === 'vault' ? 'secret' : 'service',
      provider: 'azure-container-apps', name: spec.resources[kind].id },
    verified: false, requiresConfirm: true, billable: true, dataBearing: step === 'delete', ...(dependsOn ? { dependsOn } : {}),
    reason: step === 'prepare' ? 'Explicit disposable fixture upsert; does not establish production create-only support'
      : step === 'delete' ? 'Remove only the retained disposable fixture lifetime; retain soft-deleted vault without purge'
        : step === 'control' ? 'One reviewed same-body PUT control on the exact disposable fixture'
          : 'One If-None-Match:* PUT; require native 412 and unchanged disposable fixture lifetime',
    metadata: { operation: 'azureDisposableProbe', authority: 'explicit-disposable-upsert', spec, resourceKind: kind, step,
      ...(expected ? { expected } : {}) } };
}
function persist(projectId: string, environmentId: string, actions: PlanAction[]) {
  const plan = planRunDocumentSchema.parse({ kind: 'hv_plan', scope: 'full', environmentName: 'ownership-proof',
    specRevision: 1, observedFingerprint: null, actions, warnings: [
      'Test-only synthetic namespace authority, not production first-create ownership proof.',
      'No secret values, FIC, IAM/RBAC grants, registry or workloads. Vault deletion retains seven-day soft-delete protection.',
    ] });
  const record = runs().create({ projectId, environmentId, type: 'plan', plan });
  return { id: record.id, digest: digest(plan), actions: plan.actions };
}
export async function planAzureDisposableProbe(input: { projectId: string; environmentId: string; spec: AzureDisposableProbeSpec }) {
  const spec = parseSpec(input.spec); const actions: PlanAction[] = [];
  for (const kind of kinds) for (const step of ['prepare', 'control', 'conditional'] as const)
    actions.push(action(spec, kind, step, actions.length ? [actions.at(-1)!.id] : undefined));
  return persist(input.projectId, input.environmentId, actions);
}
function events(planId: string, environmentId: string, actionId: string): Event[] {
  return runs().findByEnvironmentId(environmentId).filter(run => run.type === 'apply' && (run.plan as any).planRunId === planId)
    .flatMap(run => run.receipts).filter(receipt => receipt.step === `probe-journal:${actionId}`)
    .map(receipt => receipt.result as unknown as Event);
}
function lastEvent(planId: string, environmentId: string, actionId: string): Event | undefined {
  const all = events(planId, environmentId, actionId);
  const complete = all.filter(event => event.phase === 'complete');
  if (complete.length) return complete.at(-1);
  return all.filter(event => event.phase === 'acknowledged').at(-1) ?? all.at(-1);
}
function completeSnapshot(planId: string, environmentId: string, kind: Kind): Snapshot {
  const complete = lastEvent(planId, environmentId, `probe:${kind}:prepare`);
  if (complete?.phase !== 'complete' || !complete.observed) return fail('probe_ownership_unverified');
  return complete.observed;
}
export async function planAzureDisposableProbeCleanup(input: { projectId: string; environmentId: string; preparationPlanId: string }) {
  const prior = runs().findById(input.preparationPlanId);
  if (!prior || prior.projectId !== input.projectId || prior.environmentId !== input.environmentId) fail();
  const document = planRunDocumentSchema.parse(prior.plan);
  const spec = parseSpec(document.actions[0]?.metadata?.spec);
  const actions: PlanAction[] = [];
  // A parent's cleanup must never race an unresolved child write. Unattempted
  // resources do not establish ownership and are simply absent from cleanup.
  for (const item of document.actions) {
    const retained = lastEvent(prior.id, input.environmentId, item.id);
    if (retained && retained.phase !== 'complete') fail('probe_ownership_unverified');
  }
  for (const kind of [...kinds].reverse()) {
    if (!lastEvent(prior.id, input.environmentId, `probe:${kind}:prepare`)) continue;
    const expected = completeSnapshot(prior.id, input.environmentId, kind);
    actions.push(action(spec, kind, 'delete', actions.length ? [actions.at(-1)!.id] : undefined, expected));
  }
  if (!actions.length) fail('probe_ownership_unverified');
  return persist(input.projectId, input.environmentId, actions);
}
function snapshot(raw: any, spec: AzureDisposableProbeSpec, kind: Kind): Snapshot {
  const resource = spec.resources[kind];
  if (!raw || String(raw.id).toLowerCase() !== resource.id.toLowerCase() || raw.location !== spec.location
    || !isDeepStrictEqual(raw.tags, resource.body.tags)) return fail('probe_identity_mismatch');
  const lifetime: Record<string, string> = {};
  if (kind === 'identity') {
    for (const key of ['clientId', 'principalId', 'tenantId']) lifetime[key] = guid.parse(raw.properties?.[key]);
    if (lifetime.tenantId !== spec.tenantId) fail('probe_identity_mismatch');
  }
  if (kind === 'vault') {
    lifetime.createdAt = z.string().datetime({ offset: true }).parse(raw.systemData?.createdAt);
    const expected = resource.body.properties as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) if (!isDeepStrictEqual(raw.properties?.[key], value)) fail('probe_identity_mismatch');
    if (raw.properties?.provisioningState !== 'Succeeded') fail('probe_not_converged');
  }
  // Ignore only documented volatile/generated fields; raw bodies never persist.
  return { id: resource.id, lifetime, fingerprint: digest({ id: resource.id, lifetime, body: resource.body }) };
}
async function responseJson(response: Response, budget: DestinationBudget) {
  const reader = response.body?.getReader(); if (!reader) return fail('probe_invalid_response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await budget.wait(reader.read()); if (next.done) break;
      size += next.value.byteLength; if (size > 1_048_576) fail('probe_invalid_response'); chunks.push(next.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { void reader.cancel().catch(() => {}); return fail('probe_invalid_response'); }
  finally { reader.releaseLock(); }
}
export async function applyAzureDisposableProbe(input: Access & { planId: string; planDigest: string; confirmActions: string[]; readOnly?: boolean }) {
  const plan = runs().findById(input.planId);
  if (!plan || digest(plan.plan) !== input.planDigest) fail('probe_plan_mismatch');
  const document = planRunDocumentSchema.parse(plan.plan);
  const spec = parseSpec(document.actions[0]?.metadata?.spec);
  if (input.authorizationOriginDigest !== spec.authorizationOriginDigest) fail('probe_origin_mismatch');
  const transientCredentials = new Set<string>();
  const assertValueFree = (value: unknown): void => {
    if (typeof value === 'string') {
      if ([...transientCredentials].some(token => value.includes(token))) fail('probe_credential_echo');
    } else if (Array.isArray(value)) value.forEach(assertValueFree);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      assertValueFree(key); assertValueFree(item);
    }
  };
  for (const item of document.actions) {
    const kind = z.enum(kinds).parse(item.metadata?.resourceKind);
    const step = z.enum(['prepare', 'control', 'conditional', 'delete']).parse(item.metadata?.step);
    if (!isDeepStrictEqual(item, action(spec, kind, step, item.dependsOn, item.metadata?.expected as Snapshot | undefined))) fail();
  }
  return new ConvergeExecutor().execute({ planRunId: input.planId, currentSpecRevision: 1,
    confirmActions: input.readOnly ? document.actions.map(item => item.id) : input.confirmActions,
    handler: async (current, execution): Promise<ActionResult> => {
      const budget = new DestinationBudget({ signal: input.signal, deadlineMs: 30_000 });
      const kind = current.metadata!.resourceKind as Kind; const step = current.metadata!.step as Step;
      const resource = spec.resources[kind];
      let attempted = false;
      const authorize = async () => {
        if (runs().findById(execution.applyRunId)?.status !== 'running' || !await budget.wait(input.authorize({
          planId: input.planId, planDigest: input.planDigest, actionId: current.id, signal: budget.signal,
        }))) fail('probe_authorization_revoked');
        if (runs().findById(execution.applyRunId)?.status !== 'running') fail('probe_authorization_revoked');
        if (budget.signal.aborted) fail('probe_cancelled');
      };
      const request = async (method: 'GET' | 'PUT' | 'DELETE', suffix = '', event?: Event): Promise<Response> => {
        const token = await budget.wait(input.getAccessToken(budget.signal));
        if (!token || /[\r\n]/.test(token)) fail('probe_authentication_unavailable');
        transientCredentials.add(token);
        await authorize();
        if (input.readOnly && method !== 'GET') fail('probe_recovery_is_read_only');
        if (method !== 'GET') attempted = true;
        const response = await budget.wait(input.fetch(`${ARM}${resource.id}${suffix}?api-version=${resource.apiVersion}`, {
          method, signal: budget.signal, redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
            ...(event ? { 'x-ms-client-request-id': event.requestId, 'x-ms-return-client-request-id': 'true' } : {}),
            ...(step === 'conditional' && method === 'PUT' ? { 'If-None-Match': '*' } : {}) },
          ...(method === 'PUT' ? { body: JSON.stringify(resource.body) } : {}),
        }));
        if (response.redirected) { void response.body?.cancel().catch(() => {}); fail('probe_redirect_rejected'); }
        return response;
      };
      const observe = async (): Promise<Snapshot | null> => {
        const response = await request('GET');
        if (response.status === 404) { void response.body?.cancel().catch(() => {}); return null; }
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return fail('probe_observation_unknown'); }
        const raw = await responseJson(response, budget); assertValueFree(raw);
        return snapshot(raw, spec, kind);
      };
      const journal = (event: Event) => {
        assertValueFree(event);
        if (!runs().addReceipt(execution.applyRunId, { step: `probe-journal:${current.id}`, status: 'pending',
          timestamp: new Date().toISOString(), result: { ...event } })) fail('probe_journal_unavailable');
      };
      try {
        await authorize();
        let retained = lastEvent(plan.id, plan.environmentId, current.id);
        if (retained?.phase === 'attempted') return { success: false, status: 'pending', message: 'Probe write outcome unknown; no replay permitted' };
        if (!retained) {
          if (input.readOnly) return { success: false, status: 'blocked', message: 'Action was never attempted; read-only recovery cannot start it' };
          const baseline = await observe();
          if (step === 'prepare' && baseline !== null) fail('probe_target_already_exists');
          if (step !== 'prepare') {
            const expected = step === 'delete' ? current.metadata!.expected : completeSnapshot(plan.id, plan.environmentId, kind);
            if (!baseline || !isDeepStrictEqual(baseline, expected)) fail('probe_identity_mismatch');
          }
          if (step === 'delete' && kind === 'group') {
            const response = await request('GET', '/resources');
            if (!response.ok) fail('probe_observation_unknown');
            const listed = await responseJson(response, budget);
            assertValueFree(listed);
            if (!Array.isArray(listed.value) || listed.value.length || listed.nextLink) fail('probe_group_not_empty');
          }
          const event: Event = { phase: 'attempted', attemptId: randomUUID(), requestId: randomUUID(), ...(baseline ? { baseline } : {}) };
          journal(event); // durable before dispatch; a crash here forbids replay too
          const response = await request(step === 'delete' ? 'DELETE' : 'PUT', '', event);
          const acknowledged: Event = { ...event, phase: 'acknowledged', status: response.status };
          const nativeRequestId = guid.safeParse(response.headers.get('x-ms-request-id'));
          if (nativeRequestId.success) acknowledged.nativeRequestId = nativeRequestId.data;
          if (response.headers.get('x-ms-client-request-id') === event.requestId) acknowledged.echoedClientRequestId = event.requestId;
          if (step === 'prepare' && response.ok) {
            const raw = await responseJson(response, budget); assertValueFree(raw);
            acknowledged.observed = snapshot(raw, spec, kind);
          }
          else void response.body?.cancel().catch(() => {});
          journal(acknowledged); retained = acknowledged;
        }
        const after = await observe();
        if (step === 'delete') {
          if (after !== null || !retained.baseline || ![200, 202, 204, 404].includes(retained.status ?? 0))
            return { success: false, status: 'pending', message: 'Exact fixture deletion not yet verified' };
        } else {
          const expected = step === 'prepare' ? retained.observed : retained.baseline;
          if (!after || !expected || !isDeepStrictEqual(after, expected)) fail('probe_identity_mismatch');
          if (step !== 'conditional' && ![200, 201].includes(retained.status ?? 0)) fail('probe_not_converged');
          if (step === 'conditional' && retained.status !== 412 && ![200, 201].includes(retained.status ?? 0)) fail('probe_guard_unknown');
        }
        const guard = step === 'conditional' ? retained.status === 412 ? 'verified' as const : 'not-supported' as const : undefined;
        journal({ ...retained, phase: 'complete', ...(after ? { observed: after } : {}), ...(guard ? { guard } : {}) });
        assertValueFree(resource.id);
        return { success: true, message: step === 'delete' ? 'Exact disposable target absent; vault purge not attempted'
          : 'Disposable experiment observed; production first-create capability unchanged', data: { ...(guard ? { guard } : {}), nativeId: resource.id } };
      } catch {
        return { success: false, status: attempted ? 'pending' : 'blocked', message: attempted
          ? 'Probe write outcome requires exact read-only recovery; no replay permitted' : 'Probe authorization or exact target verification failed; no new write authorized' };
      } finally { budget.close(); }
    } });
}
