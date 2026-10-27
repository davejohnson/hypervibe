import { describe, expect, it } from 'vitest';
import { createGcpCloudInstallationDriver } from '../../src/adapters/providers/gcp/gcp-cloud-installation.js';
import { applyCloudInstallationV1, planCloudInstallationContinuationV1, planCloudInstallationV1 } from '../../src/application/hosted/cloud-installation.js';
import type { CloudInstallationIntent, CloudInstallationRecord } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed serialized transport, not a recorded response or live evidence.
// Official GET returns ProjectBillingInfo; no association is represented by
// empty/default billingAccountName + false/default billingEnabled, not HTTP404.
// Identity fields remain required evidence even when protobuf scalars default:
// https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo
// https://docs.cloud.google.com/billing/docs/reference/rest/v1/ProjectBillingInfo
const projectId = 'sequence-review-project';
const projectOperationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const billingOperationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const selectedAccount = 'billingAccounts/ABCDEF-123456-789ABC';
const intent: CloudInstallationIntent = {
  schemaVersion: 1, installationId: projectOperationId, customerId: 'customer-a', appId: 'sequence',
  environment: 'production', provider: 'gcp', mode: 'connect', stage: 'scope-preparation', keys: ['API_KEY'],
  source: { repository: 'github.com/example/sequence', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  nativeScope: { scopeKind: 'new-project', projectId, displayName: 'Sequence', billingAccountName: selectedAccount, assignmentMode: 'initial-reviewed-v1' },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
    serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
};
type BillingReply = 'normal' | 'not-found' | 'missing-name' | 'missing-project-id' | 'omitted-defaults' | 'null-defaults';
function fixture(options: { accountDisplayName?: unknown; initiallyLinked?: boolean; legacyAssignment?: boolean } = {}) {
  const records = new Map<string, CloudInstallationRecord>();
  const calls: Array<{ method: string; path: string }> = [];
  let project: Record<string, unknown> | undefined;
  let billingReply: BillingReply = 'normal'; let finalReadFault = false; let attemptedReads = 0; let linked = options.initiallyLinked ?? false;
  const request: typeof fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname; const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ method, path });
    if (path.endsWith(':testIamPermissions')) return Response.json({ permissions: body.permissions });
    if (path === `/v1/${selectedAccount}`) return Response.json({ name: selectedAccount, open: true, displayName: options.accountDisplayName });
    if (path === '/v3/projects' && method === 'POST') {
      expect(records.get(projectOperationId)?.attempts.at(-1)?.status).toBe('attempted');
      project = { name: 'projects/987654321012', projectId, displayName: 'Sequence', state: 'ACTIVE',
        parent: 'organizations/987654', createTime: '2026-10-25T12:00:00Z', labels: body.labels };
      return Response.json({ name: 'operations/pc.123456' });
    }
    if (path === '/v3/operations/pc.123456') return Response.json({ name: 'operations/pc.123456', done: true, response: project });
    if ([`/v3/projects/${projectId}`, '/v3/projects/987654321012'].includes(path)) return project ? Response.json(project) : Response.json({}, { status: 404 });
    if (path === `/v1/projects/${projectId}/billingInfo`) {
      if (method === 'PUT') {
        expect(records.get(billingOperationId)?.attempts.at(-1)?.status).toBe('attempted');
        expect(body).toEqual({ billingAccountName: selectedAccount }); linked = true;
      }
      const attempted = records.get(billingOperationId)?.attempts.at(-1)?.status === 'attempted';
      if (method === 'GET' && attempted) attemptedReads += 1;
      if (method === 'GET' && (billingReply === 'not-found' || finalReadFault && attemptedReads === 3)) return Response.json({}, { status: 404 });
      const value: Record<string, unknown> = { name: `projects/${projectId}/billingInfo`, projectId,
        billingAccountName: linked ? selectedAccount : '', billingEnabled: linked };
      if (method === 'GET' && billingReply === 'missing-name') delete value.name;
      if (method === 'GET' && billingReply === 'missing-project-id') delete value.projectId;
      if (method === 'GET' && !linked && billingReply === 'omitted-defaults') { delete value.billingAccountName; delete value.billingEnabled; }
      if (method === 'GET' && !linked && billingReply === 'null-defaults') { value.billingAccountName = null; value.billingEnabled = null; }
      return Response.json(value);
    }
    if (method === 'GET') return Response.json({}, { status: 404 });
    throw new Error('Unexpected reconstructed transport request');
  };
  const context = {
    driver: createGcpCloudInstallationDriver({ fetch: request }), authorize: async () => true,
    store: { read: async (id: string) => structuredClone(records.get(id) ?? null),
      compareAndSwap: async (id: string, revision: number | null, record: CloudInstallationRecord) => {
        if ((records.get(id)?.revision ?? null) !== revision) return false;
        records.set(id, structuredClone(record)); return true;
      } },
    authentication: { administrator: { getAccessToken: async () => 'synthetic-admin-token' },
      host: { verifyIdentity: async () => intent.hostIdentity, getAccessToken: async () => 'synthetic-host-token', getIdToken: async () => 'synthetic-id-token' } },
  };
  const apply = (record: CloudInstallationRecord) => applyCloudInstallationV1({ ...context, installationId: record.installationId,
    planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
  const prepareProject = async () => {
    const selectedIntent = structuredClone(intent);
    if (options.legacyAssignment) delete selectedIntent.nativeScope.assignmentMode;
    const record = await apply(await planCloudInstallationV1({ ...context, intent: selectedIntent }));
    expect(record.status).toBe('scope-ready'); return record;
  };
  const planBilling = (projectRecord: CloudInstallationRecord) => planCloudInstallationContinuationV1({ ...context,
    scopePreparationId: projectRecord.installationId, scopePreparationDigest: projectRecord.plan.digest, installationId: billingOperationId });
  return { calls, records, apply, prepareProject, planBilling, setReply: (reply: BillingReply) => { billingReply = reply; },
    failFinalRead: () => { finalReadFault = true; } };
}

describe('independent reviewed initial billing boundary', () => {
  // BillingAccount.displayName is a human label, independent of its resource name:
  // https://docs.cloud.google.com/billing/docs/reference/rest/v1/billingAccounts
  // These serialized responses reconstruct that contract; they are not live evidence.
  it.each(['initial assignment', 'already linked', 'blocked legacy assignment'] as const)(
    'keeps the verified billing name and exact account ID in the %s review', async mode => {
      const f = fixture({ accountDisplayName: 'Studio & Partners', initiallyLinked: mode === 'already linked',
        legacyAssignment: mode === 'blocked legacy assignment' });
      const project = await f.prepareProject(); const before = f.calls.length;
      const plan = await f.planBilling(project);
      expect(plan.plan.review.warnings).toContain(`Billing account: Studio & Partners (${selectedAccount}).`);
      expect(plan.intent.nativeScope.billingAccountName).toBe(selectedAccount);
      expect(plan.plan.actions[0].type).toBe(mode === 'already linked' ? 'noop' : mode === 'initial assignment' ? 'update' : 'create');
      if (mode === 'blocked legacy assignment') expect(plan.plan.blockedReason).toBe('billing_assignment_unverified');
      expect(f.calls.slice(before).every(call => call.method === 'GET' || call.path.endsWith(':testIamPermissions'))).toBe(true);
    });

  it.each([undefined, null, '', '  ', 42, {}, 'x'.repeat(257), 'Studio\nInjected review'])(
    'retains exact account identity when the optional human label is absent or unsafe (%j)', async accountDisplayName => {
      const f = fixture({ accountDisplayName });
      const plan = await f.planBilling(await f.prepareProject());
      expect(plan.plan.review.warnings).toContain(`Billing account: ${selectedAccount}.`);
      expect(plan.intent.nativeScope.billingAccountName).toBe(selectedAccount);
      expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    });

  it.each(['synthetic-admin-token', 'ghp_' + 'a'.repeat(30)])('redacts reflected credentials from a human billing label (%s)', async secret => {
    const f = fixture({ accountDisplayName: `Studio ${secret}` });
    const plan = await f.planBilling(await f.prepareProject());
    expect(plan.plan.review.warnings).toContain(`Billing account: Studio [redacted] (${selectedAccount}).`);
    expect(JSON.stringify([...f.records.values()])).not.toContain(secret);
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });

  it('does not turn a known project’s missing BillingInfo into an unassociated project during review', async () => {
    const f = fixture(); const project = await f.prepareProject(); f.setReply('not-found');
    await expect(f.planBilling(project)).rejects.toMatchObject({ code: 'provider_error' });
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });
  it('does not dispatch billing PUT if the final known-project BillingInfo read returns 404', async () => {
    const f = fixture(); const plan = await f.planBilling(await f.prepareProject()); f.failFinalRead();
    expect((await f.apply(plan)).status).not.toBe('scope-ready');
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });
  it.each(['missing-name', 'missing-project-id'] as const)('rejects a successful response with %s instead of synthesizing identity', async reply => {
    const f = fixture(); const project = await f.prepareProject(); f.setReply(reply);
    await expect(f.planBilling(project)).rejects.toMatchObject({ code: 'provider_error' });
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });
  it.each(['omitted-defaults', 'null-defaults'] as const)('accepts native %s for an identified, unassociated project', async reply => {
    const f = fixture(); const project = await f.prepareProject(); f.setReply(reply);
    const plan = await f.planBilling(project); expect(plan.status).toBe('review-required');
    expect((await f.apply(plan)).status).toBe('scope-ready');
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(JSON.stringify([...f.records.values()])).not.toContain('synthetic-admin-token');
  });
});
