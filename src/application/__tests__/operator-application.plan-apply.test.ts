import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { localHoldingApplicationFixture } from './local-holding-preparation.fixture.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { DefaultAzureCredential } from '@azure/identity';
import { entraNativeFixture } from '../../adapters/providers/entra/__tests__/entra-operator-application.fixture.js';
import { verifiedLocalHoldingReceipt } from '../../domain/services/local-holding-preparation.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { createGcpSecretContainerSetup } from '../../adapters/providers/gcp/gcp-secret-container.js';

describe('operator application desired-state admission', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-operator-application-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  it('retains an exact registration declaration and refuses to use a cached or absent origin', async () => {
    const f = await localHoldingApplicationFixture();
    const desired: any = structuredClone(f.desired);
    delete desired.environments.staging.hosting.preparation;
    desired.environments.staging.operatorApplications = { azure: { provider: 'microsoft-entra', originService: 'web', runtimeService: 'web',
      profile: 'hypercloud-connect-v1', nativeScope: { tenantId: '11111111-1111-4111-8111-111111111111' } } };
    f.store.replace(f.project, desired);
    expect((f.store.get(f.project)!.spec.environments.staging as any).operatorApplications).toEqual(desired.environments.staging.operatorApplications);
    expect(await new PlanService().plan(f.project, 'staging')).toMatchObject({ error: expect.stringMatching(/operator application.*origin/i) });
    expect(f.native.writes).toEqual([]);
  });
  it('prepares only selected operator output containers before opening registration or reading private inputs', async () => {
    const f = await localHoldingApplicationFixture();
    for (let step = 0; step < 2; step++) {
      const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
      await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id));
    }
    const desired: any = structuredClone(f.desired), key = 'CLOUD_CONNECT_GOOGLE_CLIENT_SECRET';
    desired.environments.staging.operatorApplications = { google: { provider: 'google-oauth', originService: 'web', runtimeService: 'web',
      profile: 'hypercloud-connect-v1', nativeScope: { projectId: f.native.scope.projectId }, outputs: { 'client-secret': key } } };
    const destination = { provider: 'gcp-secret-manager', projectId: f.native.scope.projectId, projectNumber: f.native.scope.projectNumber, secretId: 'operator-google-client' };
    desired.environments.staging.secretDestinations = { [key]: { destination }, UNRELATED: { destination: { ...destination, secretId: 'unrelated' } } };
    desired.secrets.UNRELATED = { ...desired.secrets[key] };
    f.store.replace(f.project, desired);
    const provider = vi.spyOn(providerRegistry, 'getOperatorApplication').mockReturnValue({ privateOutputRoles: ['client-secret'] } as any);
    const request: typeof fetch = async (input, init) => new URL(String(input)).hostname === 'secretmanager.googleapis.com'
      ? new Response(null, { status: 404 }) : f.native.request(input, init);
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { secretDestinationSetup:
      createGcpSecretContainerSetup({ projectId: f.native.scope.projectId, getAccessToken: async () => 'synthetic-token' }, { fetch: request }) } } as any);
    const before = f.native.writes.length, plan = await f.plan();
    expect(plan).toMatchObject({ scope: 'secret-destinations', actions: [{ id: `secret-destination:${key}`, requiresConfirm: true }] });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions).toHaveLength(1); expect(f.native.writes).toHaveLength(before); expect(provider).toHaveBeenCalled();
  });
  it.each([undefined, 'application', 'federation'] as const)('creates or recovers %s through actual SQLite plan/apply without replay', async lost => {
    const f = await localHoldingApplicationFixture();
    for (let step = 0; step < 2; step++) {
      const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
      expect(await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id)))
        .toMatchObject({ kind: 'executed', result: { success: true } });
    }
    const receipt = await verifiedLocalHoldingReceipt(f.project, f.ctx.repos.environments.findById(f.environment.id)!);
    const identity = receipt!.runtimeIdentities.find(item => item.workload === 'web')!.principal;
    if (identity.kind !== 'gcp-service-account') throw new Error('Unexpected fixture identity');
    const native = entraNativeFixture({ lost, origin: receipt!.origins.web, subject: identity.serviceAccountUniqueId });
    vi.spyOn(DefaultAzureCredential.prototype, 'getToken').mockImplementation(async scope => {
      expect(scope).toBe('https://graph.microsoft.com/.default');
      return { token: 'synthetic-transient-graph-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    });
    vi.stubGlobal('fetch', (input: any, init: any) => new URL(String(input)).hostname === 'graph.microsoft.com' ? native.request(input, init) : f.native.request(input, init));
    const desired: any = structuredClone(f.desired);
    desired.environments.staging.operatorApplications = { azure: { provider: 'microsoft-entra', originService: 'web', runtimeService: 'web',
      profile: 'hypercloud-connect-v1', nativeScope: { tenantId: native.tenantId } } };
    f.store.replace(f.project, desired);
    const ordinary = vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'Synthetic normal hosting unavailable' });
    const first = await f.plan(); expect(first).toMatchObject({ scope: 'operator-applications', actions: [{ requiresConfirm: true }, { requiresConfirm: true }] });
    if ('error' in first) throw new Error(first.error);
    const status = await f.commands.execute('hv_status', { project: f.project.name, env: 'staging' });
    expect(status).toMatchObject({ ok: true, data: { scope: 'operator-applications', verified: false, hostingReady: false } });
    expect(ordinary).not.toHaveBeenCalled(); expect(native.writes).toEqual([]);
    await f.apply(first.planRunId, []); expect(native.writes).toEqual([]);
    for (let step = 0; step < 5; step++) {
      const planned = await f.plan(); if ('error' in planned || planned.scope !== 'operator-applications') break;
      await f.apply(planned.planRunId, planned.actions.filter(action => action.requiresConfirm).map(action => action.id));
      SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    }
    expect(native.writes).toHaveLength(2);
    const rows = f.ctx.repos.runs.findByProjectId(f.project.id).filter(row => row.type === 'operator-applications:azure');
    expect(rows).toHaveLength(1); expect(rows[0].plan).toMatchObject({ status: 'scope-ready' });
    expect(JSON.stringify(rows)).not.toContain('synthetic-transient-graph-token');
    expect(ordinary).toHaveBeenCalled();
  });
});
