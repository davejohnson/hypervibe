import { describe, expect, it } from 'vitest';
import { createGcpCloudInstallationDriver } from '../../src/adapters/providers/gcp/gcp-cloud-installation.js';
import * as lifecycle from '../../src/application/hosted/cloud-installation.js';
import type { CloudInstallationIntent, CloudInstallationRecord } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed native transport, not recorded/live evidence. Independent contract:
// googleapis/googleapis google/cloud/resourcemanager/v3/projects.proto (2026-10-24):
// POST projects creates, returns an expiring LRO; name/createTime identify the project.
// cloud/billing/v1/cloud_billing.proto: billing PUT replaces associations, no etag.
// Therefore no broad administrator billing PUT is authorized by this lifecycle.
const intent = {
  schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer-a', appId: 'sequence',
  environment: 'production', provider: 'gcp', mode: 'connect', stage: 'scope-preparation', keys: ['API_KEY'],
  source: { repository: 'github.com/example/sequence', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  nativeScope: { scopeKind: 'new-project', projectId: 'sequence-new-project', displayName: 'Sequence', parent: 'organizations/123456', billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
    serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
} as CloudInstallationIntent;
function fixture(options: { lostAck?: boolean; deniedLookup?: boolean; deniedBilling?: boolean; pendingOperation?: boolean; rejectCreate?: boolean; automaticParent?: 'none' | string; changeBillingOnPrewriteRead?: boolean } = {}) {
  const selectedIntent = structuredClone(intent);
  if (options.automaticParent) delete selectedIntent.nativeScope.parent;
  let project: Record<string, unknown> | null = null;
  let billing = '';
  let operationVisible = true;
  let serviceReads = 0;
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const records = new Map<string, CloudInstallationRecord>();
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method, body });
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-browser-token');
    if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: options.deniedBilling && url.hostname === 'cloudbilling.googleapis.com' ? [] : body.permissions });
    if (url.pathname === '/v1/billingAccounts/ABCDEF-123456-789ABC') return Response.json({ name: 'billingAccounts/ABCDEF-123456-789ABC', open: true, displayName: 'Studio' });
    if (url.pathname === '/v1/billingAccounts') return Response.json({ billingAccounts: [{ name: 'billingAccounts/ABCDEF-123456-789ABC', open: true, displayName: 'Studio' }, { name: 'billingAccounts/CLOSED-123456-789ABC' }] });
    if (url.pathname === '/v3/projects:search') return Response.json({});
    if (url.pathname === '/v3/projects' && method === 'POST') {
      const saved = records.get(intent.installationId)!;
      expect(saved.attempts.at(-1)?.status).toBe('attempted');
      expect(body).toMatchObject({ projectId: 'sequence-new-project', ...(selectedIntent.nativeScope.parent ? { parent: selectedIntent.nativeScope.parent } : {}) });
      expect(Object.values(body.labels)).toEqual(expect.arrayContaining([saved.attempts.at(-1)?.id]));
      for (const label of Object.values(body.labels)) expect(String(label).length).toBeLessThanOrEqual(63);
      if (options.rejectCreate) return Response.json({}, { status: 409 });
      project = { name: 'projects/987654321012', projectId: 'sequence-new-project', displayName: 'Sequence',
        ...(options.automaticParent === 'none' ? {} : { parent: options.automaticParent ?? 'organizations/123456' }),
        state: 'ACTIVE', createTime: '2026-10-24T12:00:00Z', labels: body.labels };
      if (options.lostAck) throw new Error('synthetic lost response');
      return Response.json({ name: 'operations/pc.123456789' });
    }
    if (url.pathname === '/v3/operations/pc.123456789') return operationVisible
      ? Response.json(options.pendingOperation ? { name: 'operations/pc.123456789' } : { name: 'operations/pc.123456789', done: true, response: project }) : Response.json({}, { status: 404 });
    if (url.pathname === '/v3/projects/sequence-new-project' || url.pathname === '/v3/projects/987654321012') {
      if (options.deniedLookup) return Response.json({}, { status: 403 });
      return project ? Response.json(project) : Response.json({}, { status: 404 });
    }
    if (url.pathname === '/v1/projects/sequence-new-project/billingInfo') return Response.json({ name: 'projects/sequence-new-project/billingInfo', projectId: 'sequence-new-project', billingAccountName: billing, billingEnabled: !!billing });
    if (url.pathname === '/v1/projects/sequence-new-project') return Response.json({ projectId: 'sequence-new-project', projectNumber: '987654321012', lifecycleState: 'ACTIVE' });
    if (url.hostname === 'serviceusage.googleapis.com' && method === 'GET') {
      serviceReads += 1;
      if (options.changeBillingOnPrewriteRead && serviceReads === 2) billing = 'billingAccounts/OTHER1-123456-789ABC';
      return Response.json({ name: url.pathname.slice(4), state: 'DISABLED' });
    }
    throw new Error('Unexpected transport request');
  };
  const driver = createGcpCloudInstallationDriver({ fetch: request });
  const context = { driver, authorize: async () => true, store: {
    read: async (id: string) => structuredClone(records.get(id) ?? null),
    compareAndSwap: async (id: string, revision: number | null, record: CloudInstallationRecord) => {
      if ((records.get(id)?.revision ?? null) !== revision) return false;
      records.set(id, structuredClone(record)); return true;
    },
  }, authentication: { administrator: { getAccessToken: async () => 'synthetic-browser-token' }, host: {
    verifyIdentity: async () => intent.hostIdentity, getAccessToken: async () => { throw new Error('No hosted cloud authority yet'); },
    getIdToken: async () => { throw new Error('No hosted cloud authority yet'); },
  } } };
  const plan = () => lifecycle.planCloudInstallationV1({ ...context, intent: selectedIntent });
  const apply = (record: CloudInstallationRecord) => lifecycle.applyCloudInstallationV1({ ...context, installationId: record.installationId,
    planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
  const reconcile = (record: CloudInstallationRecord) => lifecycle.reconcileCloudInstallationV1({ ...context, installationId: record.installationId, planDigest: record.plan.digest });
  return { context, calls, records, plan, apply, reconcile, setBilling: (value = intent.nativeScope.billingAccountName) => { billing = value; },
    setProject: (value: Record<string, unknown>) => { project = value; }, getProject: () => project!, expireOperation: () => { operationVisible = false; } };
}

describe('GCP fresh-project scope through real shared lifecycle and reconstructed native REST', () => {
  it('creates only the reviewed project, retains native ownership and requires a separate billing review', async () => {
    const f = fixture(); const planned = await f.plan();
    expect(planned.status).toBe('review-required');
    const result = await f.apply(planned);
    expect(result).toMatchObject({ status: 'scope-ready' });
    expect(result.completed['gcp:project']).toMatchObject({ resources: [{ kind: 'project', id: 'projects/987654321012' }] });
    expect(f.calls.filter(call => call.method !== 'GET' && !call.path.endsWith(':testIamPermissions')).map(call => call.path)).toEqual(['/v3/projects']);
    expect(() => lifecycle.cloudInstallationConnectionsV1(result, f.context.driver)).toThrow();
    expect(JSON.stringify(result)).not.toMatch(/synthetic-browser-token|private_key|accessToken/);
  });

  it('recovers a lost creation acknowledgment after restart without a second create, then requires a fresh billing review', async () => {
    const f = fixture({ lostAck: true }); const planned = await f.plan();
    expect((await f.apply(planned)).status).toBe('pending');
    f.expireOperation(); f.setBilling();
    const recovered = await f.reconcile(planned);
    expect(recovered.status).toBe('scope-ready');
    expect(f.calls.filter(call => call.path === '/v3/projects' && call.method === 'POST')).toHaveLength(1);
    expect(() => lifecycle.cloudInstallationConnectionsV1(recovered, f.context.driver)).toThrow();
  });

  it('preserves unknown project lookup and rejects insufficient billing authority before any create', async () => {
    for (const options of [{ deniedLookup: true }, { deniedBilling: true }]) {
      const f = fixture(options);
      await expect(f.plan()).rejects.toMatchObject({ code: 'insufficient_permissions' });
      expect(f.calls.filter(call => call.path === '/v3/projects' && call.method === 'POST')).toEqual([]);
    }
  });

  it('never adopts a foreign same-name project or overwrites a different billing association', async () => {
    const f = fixture(); const planned = await f.plan();
    await f.apply(planned);
    f.setBilling('billingAccounts/OTHER1-123456-789ABC');
    const result = await f.reconcile(planned);
    expect(result.status).toBe('scope-ready');
    await expect(lifecycle.planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: planned.installationId,
      scopePreparationDigest: planned.plan.digest, installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).rejects.toMatchObject({ code: 'ownership_mismatch' });
    expect(f.calls.some(call => call.method === 'PUT')).toBe(false);
    const g = fixture(); g.setProject({ ...f.getProject(), labels: {} });
    await expect(g.plan()).rejects.toMatchObject({ code: 'ownership_mismatch' });
  });

  it('proposes a deterministic new-project scope from browser billing discovery without local credentials', async () => {
    const f = fixture();
    const discovered = await f.context.driver.discoverScopes!({ authentication: f.context.authentication, signal: new AbortController().signal,
      sourceScope: { customerId: intent.customerId, appId: intent.appId, environment: intent.environment, installationId: intent.installationId } });
    expect(discovered).toMatchObject({ state: 'complete', authority: 'not-verified', scopes: [{ stage: 'scope-preparation',
      nativeScope: { scopeKind: 'new-project', billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' } }] });
    expect(discovered.scopes).toHaveLength(1);
    expect(discovered.scopes[0].nativeScope.projectId).toMatch(/^app-[a-f0-9]{10}$/);
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('retains pending operations and recovers their expiry using exact project markers and lifetime', async () => {
    const f = fixture({ pendingOperation: true }); const planned = await f.plan();
    const pending = await f.apply(planned);
    expect(pending.status).toBe('pending');
    expect(pending.attempts[0].evidence?.native.operationName).toBe('operations/pc.123456789');
    f.expireOperation(); f.setBilling();
    expect((await f.reconcile(planned)).status).toBe('scope-ready');
    expect(f.calls.filter(call => call.path === '/v3/projects' && call.method === 'POST')).toHaveLength(1);
    f.setProject({ ...f.getProject(), createTime: '2026-10-25T12:00:00Z' });
    expect((await f.reconcile(planned)).status).toBe('blocked');
  });

  it('requires independently reviewed continuation, exact predecessor scope, and current administrator authority', async () => {
    const f = fixture(); const planned = await f.plan(); await f.apply(planned); f.setBilling();
    const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const child = await lifecycle.planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: planned.installationId,
      scopePreparationDigest: planned.plan.digest, installationId: childId });
    expect(child).toMatchObject({ status: 'review-required', intent: { stage: 'scope-preparation', nativeScope: { projectId: 'sequence-new-project', projectNumber: '987654321012' },
      scopePreparation: { installationId: planned.installationId, planDigest: planned.plan.digest } } });
    expect(child.plan.actions.some(action => action.metadata.operation === 'verify-existing-billing')).toBe(true);
    expect(f.calls.some(call => call.path.includes('/secrets'))).toBe(false);
    await expect(lifecycle.planCloudInstallationV1({ ...f.context, intent: { ...child.intent, installationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', environment: 'staging' } })).rejects.toThrow();
    expect(f.records.size).toBe(2);
    f.setBilling('billingAccounts/OTHER1-123456-789ABC');
    await expect(lifecycle.planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: planned.installationId,
      scopePreparationDigest: planned.plan.digest, installationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })).rejects.toMatchObject({ code: 'ownership_mismatch' });
  });

  it('requires a fresh exact confirmation after a definite create rejection and preserves no-op mutation freedom', async () => {
    const f = fixture({ rejectCreate: true }); const planned = await f.plan();
    expect((await f.apply(planned)).attempts[0].status).toBe('rejected');
    expect((await f.apply(planned)).reason).toBe('retry_confirmation_required');
    expect(f.calls.filter(call => call.path === '/v3/projects' && call.method === 'POST')).toHaveLength(1);
    const g = fixture(); const next = await g.plan(); await g.apply(next); g.setBilling(); await g.reconcile(next);
    const before = g.calls.filter(call => call.path === '/v3/projects' && call.method === 'POST').length;
    expect((await g.apply(next)).status).toBe('scope-ready');
    expect(g.calls.filter(call => call.path === '/v3/projects' && call.method === 'POST')).toHaveLength(before);
  });

  it('accepts observed no-organization projects and shows Google-selected parent/billing before billing authorization', async () => {
    for (const parent of ['none', 'organizations/987654']) {
      const f = fixture({ automaticParent: parent }); const prepared = await f.plan();
      await f.apply(prepared); f.setBilling();
      const scope = await f.reconcile(prepared);
      expect(scope.status).toBe('scope-ready');
      expect(scope.completed['gcp:project'].resources[0].identity.parent).toBe(parent);
      const child = await lifecycle.planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: prepared.installationId,
        scopePreparationDigest: prepared.plan.digest, installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      expect(child.plan.review.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'project', name: 'sequence-new-project', scope: parent === 'none' ? 'No organization (observed)' : parent }),
        expect.objectContaining({ kind: 'billing-account', name: intent.nativeScope.billingAccountName }),
      ]));
    }
  });

  it('rechecks native prepared scope immediately before billing work, after the billing review was saved', async () => {
    const f = fixture(); const prepared = await f.plan(); await f.apply(prepared); f.setBilling();
    const child = await lifecycle.planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: prepared.installationId,
      scopePreparationDigest: prepared.plan.digest, installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    const priorCalls = f.calls.length;
    f.setBilling('billingAccounts/OTHER1-123456-789ABC');
    const result = await f.apply(child);
    expect(result).toMatchObject({ status: 'blocked', reason: 'ownership_mismatch' });
    expect(f.calls.slice(priorCalls).every(call => call.method === 'GET')).toBe(true);
    expect(result.attempts).toHaveLength(0);
  });

  it('rechecks prepared billing after the provider prerequisite read and immediately before the native setup write', async () => {
    const f = fixture({ changeBillingOnPrewriteRead: true }); const prepared = await f.plan(); await f.apply(prepared); f.setBilling();
    const billing = await lifecycle.planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: prepared.installationId,
      scopePreparationDigest: prepared.plan.digest, installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    await f.apply(billing);
    const child = await lifecycle.planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: billing.installationId,
      scopePreparationDigest: billing.plan.digest, installationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    const result = await f.apply(child);
    expect(result.status).toBe('blocked');
    expect(result.attempts).toHaveLength(1);
    expect(f.calls.some(call => call.path.endsWith(':enable') && call.method === 'POST')).toBe(false);
  });
});
