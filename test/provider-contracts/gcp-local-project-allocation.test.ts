import { describe, expect, it } from 'vitest';
import { createGcpLocalProjectAllocationDriver } from '../../src/adapters/providers/gcp/gcp-project-installation.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1, cloudInstallationResolvedScopeV1 } from '../../src/application/hosted/cloud-installation.js';
import type { CloudInstallationContext, CloudInstallationRecord, LocalCloudScopePreparationIntent } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed official CRM v3 projects.create/GetOperation/GetProject transport.
// https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/create
// googleapis/googleapis google/cloud/resourcemanager/v3/projects.proto: Project parent
// is an implicit-presence string; Any response must identify the terminal Project.
// No live compatibility is claimed. Billing is deliberately not part of this scope.
const intent: LocalCloudScopePreparationIntent = { schemaVersion: 1,
  installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'local-app', appId: 'local-app', environment: 'test',
  provider: 'gcp', mode: 'connect', stage: 'scope-preparation', keys: [],
  execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, hostingProvider: 'cloudrun',
  source: { kind: 'local-spec', repository: 'github.com/example/app', specRevision: 1, specDigest: 'a'.repeat(64) },
  nativeScope: { scopeKind: 'project-allocation', allocationMode: 'create-exclusive-v1', projectId: 'local-project', displayName: 'Local Project' } };
function fixture(options: { lostAck?: boolean; pending?: boolean; existing?: boolean; revoke?: boolean } = {}) {
  let saved: CloudInstallationRecord<LocalCloudScopePreparationIntent> | null = null;
  let project: Record<string, unknown> | null = options.existing ? { name: 'projects/123456789', projectId: 'local-project', state: 'ACTIVE', createTime: '2026-10-24T12:00:00Z' } : null;
  let authorized = true; let reads = 0; let operationVisible = true;
  const calls: Array<{ host: string; path: string; method: string }> = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const method = init.method ?? 'GET';
    calls.push({ host: url.host, path: url.pathname, method });
    expect(url.host).toBe('cloudresourcemanager.googleapis.com');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-local-user-token');
    if (url.pathname === '/v3/projects/local-project') {
      if (++reads === 3 && options.revoke) authorized = false;
      return project ? Response.json(project) : Response.json({}, { status: 403 });
    }
    if (url.pathname === '/v3/projects' && method === 'POST') {
      expect(saved!.attempts.at(-1)?.status).toBe('attempted');
      const body = JSON.parse(String(init.body));
      project = { name: 'projects/123456789', projectId: 'local-project', displayName: 'Local Project',
        parent: '', state: 'ACTIVE', createTime: '2026-10-24T12:00:00Z', labels: body.labels };
      if (options.lostAck) throw new Error('lost acknowledgment containing synthetic-local-user-token');
      return Response.json({ name: 'operations/pc.123' });
    }
    if (url.pathname === '/v3/operations/pc.123') return operationVisible ? Response.json(options.pending
      ? { name: 'operations/pc.123' } : { name: 'operations/pc.123', done: true,
        response: { '@type': 'type.googleapis.com/google.cloud.resourcemanager.v3.Project', ...project } }) : Response.json({}, { status: 404 });
    throw new Error(`Unexpected reconstructed transport ${url.pathname}`);
  };
  const driver = createGcpLocalProjectAllocationDriver({ fetch: request });
  const context: CloudInstallationContext<LocalCloudScopePreparationIntent> = { driver, authorize: async () => authorized,
    authentication: { kind: 'local-administrator', administrator: { getAccessToken: async () => 'synthetic-local-user-token' } },
    store: { read: async () => saved && structuredClone(saved), compareAndSwap: async (_id, revision, next) => {
      if ((saved?.revision ?? null) !== revision) return false; saved = structuredClone(next); return true;
    } } };
  const plan = (value: unknown = intent) => planCloudInstallationV1({ ...context, intent: value });
  const apply = () => applyCloudInstallationV1({ ...context, installationId: saved!.installationId, planDigest: saved!.plan.digest, confirmActions: ['gcp:project'] });
  const reconcile = () => reconcileCloudInstallationV1({ ...context, installationId: saved!.installationId, planDigest: saved!.plan.digest });
  return { context, plan, apply, reconcile, calls, saved: () => saved!, expire: () => { operationVisible = false; } };
}
describe('local empty-project allocation through shared lifecycle and native transport', () => {
  it('allocates without billing or host credentials and proves terminal native identity', async () => {
    const f = fixture(); const review = await f.plan();
    expect(review.plan.actions).toHaveLength(1);
    expect(review.plan.review.permissions.flatMap(item => item.actions)).toEqual(['resourcemanager.projects.create']);
    expect(review.plan.review.warnings.join(' ')).toContain('unknown');
    expect((await f.apply()).status).toBe('scope-ready');
    expect(cloudInstallationResolvedScopeV1(f.saved(), f.context.driver)).toMatchObject({ projectId: 'local-project', projectNumber: '123456789', projectParent: 'none', projectCreateTime: '2026-10-24T12:00:00Z' });
    f.expire(); expect((await f.reconcile()).status).toBe('scope-ready');
    expect(f.calls.filter(call => call.method !== 'GET')).toEqual([{ host: 'cloudresourcemanager.googleapis.com', path: '/v3/projects', method: 'POST' }]);
    expect(JSON.stringify(f.saved())).not.toContain('synthetic-local-user-token');
  });
  it.each([{ lostAck: true }, { pending: true }])('retains exact uncertain allocation without any second POST: %j', async options => {
    const f = fixture(options); await f.plan(); expect((await f.apply()).status).toBe('pending');
    f.expire(); expect((await f.reconcile()).status).toBe('pending'); expect((await f.apply()).status).toBe('pending');
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(f.saved())).not.toContain('synthetic-local-user-token');
  });
  it('rejects a known existing project and approval revoked while reading native state', async () => {
    const f = fixture({ existing: true }); await expect(f.plan()).rejects.toMatchObject({ code: 'ownership_mismatch' });
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    const g = fixture({ revoke: true }); await g.plan(); expect((await g.apply()).status).toBe('blocked');
    expect(g.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('rejects billing, resolved scope, or hosted-native intent as allocation authority', async () => {
    for (const nativeScope of [ { ...intent.nativeScope, billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' },
      { ...intent.nativeScope, scopeKind: 'new-project' }, { projectId: 'local-project', projectNumber: '123456789' } ]) {
      const f = fixture(); await expect(f.plan({ ...intent, nativeScope })).rejects.toMatchObject({ code: 'invalid_contract' }); expect(f.calls).toEqual([]);
    }
  });
});
