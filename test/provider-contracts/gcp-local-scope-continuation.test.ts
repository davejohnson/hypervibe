import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGcpBillingPreparationDriver } from '../../src/adapters/providers/gcp/gcp-billing-installation.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../src/domain/services/cloud-installation-runtime.js';
import type { CloudInstallationRecord, LocalCloudScopePreparationIntent } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed native transport, independently specified by Google's Billing
// ProjectBillingInfo/updateBillingInfo and Resource Manager Project contracts.
// This is contract evidence, not a live-account compatibility claim.
const allocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectId = 'local-operator-project';
const billingAccountName = 'billingAccounts/ABCDEF-123456-789ABC';
const projectOwner = createHash('sha256').update(JSON.stringify(['app', 'app', 'test', allocationId])).digest('hex');
const intent = { schemaVersion: 1, installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', customerId: 'app', appId: 'app', environment: 'test',
  source: { kind: 'local-spec', repository: 'github.com/acme/app', specRevision: 2, specDigest: 'b'.repeat(64) },
  execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, hostingProvider: 'cloudrun',
  provider: 'gcp', mode: 'connect', stage: 'scope-preparation', keys: [],
  selection: { scopeKind: 'operator-hosting-v1', billingAccountName },
  predecessor: { installationId: allocationId, planDigest: 'a'.repeat(64) },
  nativeScope: { scopeKind: 'project-billing', projectId, projectNumber: '123456789012', projectCreateTime: '2026-10-25T00:00:00Z',
    projectParent: 'none', projectInstallationId: allocationId, projectAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    billingAccountName, assignmentMode: 'initial-reviewed-v1' } };
function fixture(lostAck = false) {
  let saved: CloudInstallationRecord<LocalCloudScopePreparationIntent> | null = null;
  let linked = false; let changedLifetime = false;
  const writes: string[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const method = init.method ?? 'GET';
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-user-token');
    expect(init.redirect).toBe('error');
    if (url.pathname === `/v3/projects/${projectId}`) return Response.json({ name: 'projects/123456789012', projectId, state: 'ACTIVE',
      createTime: changedLifetime ? '2026-10-25T01:00:00Z' : intent.nativeScope.projectCreateTime,
      labels: { 'hv-installation': projectOwner.slice(0, 63), 'hv-attempt': intent.nativeScope.projectAttemptId } });
    if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: url.host === 'cloudbilling.googleapis.com'
      ? ['billing.accounts.get', 'billing.resourceAssociations.create']
      : ['resourcemanager.projects.get', 'resourcemanager.projects.createBillingAssignment', 'serviceusage.services.list', 'serviceusage.effectivepolicy.get'] });
    if (url.pathname === `/v1/${billingAccountName}`) return Response.json({ name: billingAccountName, open: true });
    if (url.pathname === `/v1/projects/${projectId}/billingInfo`) {
      if (method === 'PUT') {
        expect(saved!.attempts.at(-1)?.status).toBe('attempted');
        expect(JSON.parse(String(init.body))).toEqual({ billingAccountName }); writes.push(url.href); linked = true;
        if (lostAck) throw new Error('lost acknowledgment synthetic-user-token');
      }
      return Response.json({ name: `projects/${projectId}/billingInfo`, projectId, billingAccountName: linked ? billingAccountName : '', billingEnabled: linked });
    }
    throw new Error('Unexpected reconstructed native request');
  };
  const context = { driver: createGcpBillingPreparationDriver({ fetch: request, local: true } as any) as any,
    authentication: { kind: 'local-administrator', administrator: { getAccessToken: async () => 'synthetic-user-token' } } as const,
    authorize: async () => true,
    store: { read: async () => structuredClone(saved), compareAndSwap: async (_id: string, revision: number | null, next: any) => {
      if ((saved?.revision ?? null) !== revision) return false; saved = structuredClone(next); return true;
    } } };
  const plan = () => planCloudInstallationV1({ ...context, intent });
  const apply = () => applyCloudInstallationV1({ ...context, installationId: saved!.installationId, planDigest: saved!.plan.digest, confirmActions: ['gcp:billing:initial-assignment-v1'] });
  const recover = () => reconcileCloudInstallationV1({ ...context, installationId: saved!.installationId, planDigest: saved!.plan.digest });
  return { plan, apply, recover, writes, saved: () => saved, changeLifetime: () => { changedLifetime = true; } };
}
describe('local operator continuation through the shared reviewed billing driver', () => {
  it('uses transient local authorization for only the reviewed assignment without a hosted principal', async () => {
    const f = fixture(); await f.plan(); expect(f.writes).toEqual([]);
    expect((await f.apply()).status).toBe('scope-ready'); expect(f.writes).toHaveLength(1);
    expect(JSON.stringify(f.saved())).not.toContain('synthetic-user-token');
    expect(JSON.stringify(f.saved())).not.toContain('hostIdentity');
  });
  it('recovers lost acknowledgment without repeating assignment', async () => {
    const f = fixture(true); await f.plan(); await f.apply(); await f.recover();
    expect(f.writes).toHaveLength(1); expect(f.saved()?.status).toBe('scope-ready');
  });
  it('blocks a replaced project lifetime before billing mutation', async () => {
    const f = fixture(); await f.plan(); f.changeLifetime(); expect((await f.apply()).status).toBe('blocked'); expect(f.writes).toEqual([]);
  });
});
