import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { localHoldingApplicationFixture } from './local-holding-preparation.fixture.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { recaptchaNativeFixture } from '../../adapters/providers/gcp/__tests__/gcp-operator-recaptcha.fixture.js';
import { verifiedLocalHoldingReceipt } from '../../domain/services/local-holding-preparation.service.js';
import { GcpLocalDefaultAuthentication } from '../../adapters/providers/gcp/gcp-local-default-authentication.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';

describe('isolated operator CAPTCHA desired state', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-recaptcha-operator-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  it('admits a separate CAPTCHA declaration while requiring the native holding origin', async () => {
    const f = await localHoldingApplicationFixture(), desired: any = structuredClone(f.desired);
    delete desired.environments.staging.hosting.preparation;
    desired.environments.staging.operatorApplications = { captcha: { provider: 'google-recaptcha', profile: 'hypercloud-connect-v1',
      originService: 'web', runtimeService: 'web', nativeScope: { projectId: 'owned-project', projectNumber: '123456789012' } } };
    f.store.replace(f.project, desired);
    expect(f.store.get(f.project)!.spec.environments.staging.operatorApplications).toEqual(desired.environments.staging.operatorApplications);
    expect(await new PlanService().plan(f.project, 'staging')).toMatchObject({ error: expect.stringMatching(/operator application.*origin/i) });
    expect(f.native.writes).toEqual([]);
  });
  it('uses actual SQLite planning, confirmation and retained origin through private native capture', async () => {
    const f = await localHoldingApplicationFixture();
    for (let step = 0; step < 2; step++) {
      const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
      expect(await f.apply(plan.planRunId, plan.actions.filter(a => a.requiresConfirm).map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    }
    const receipt = (await verifiedLocalHoldingReceipt(f.project, f.ctx.repos.environments.findById(f.environment.id)!))!;
    const native = recaptchaNativeFixture({ projectId: f.native.scope.projectId, hostname: new URL(receipt.origins.web).hostname, enabled: false });
    vi.spyOn(GcpLocalDefaultAuthentication.prototype, 'initialize').mockResolvedValue();
    vi.spyOn(GcpLocalDefaultAuthentication.prototype, 'token').mockResolvedValue('synthetic-transient-google-token');
    vi.stubGlobal('fetch', (input: any, init: any) => new Headers(init?.headers).get('authorization') === 'Bearer synthetic-transient-google-token'
      ? native.request(input, init) : f.native.request(input, init));
    const desired: any = structuredClone(f.desired);
    desired.environments.staging.operatorApplications = { captcha: { provider: 'google-recaptcha', profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web',
      nativeScope: { projectId: f.native.scope.projectId, projectNumber: f.native.scope.projectNumber } } };
    f.store.replace(f.project, desired);
    const ordinary = vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'Synthetic ordinary deployment unavailable' });
    const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    expect(first.scope).toBe('operator-applications'); expect(first.actions).toHaveLength(3); expect(native.writes).toEqual([]);
    expect(await f.commands.execute('hv_status', { project: f.project.name, env: 'staging' })).toMatchObject({ ok: true, data: { verified: false, hostingReady: false } });
    await f.apply(first.planRunId, []); expect(native.writes).toEqual([]);
    const reviewed = await f.plan(); if ('error' in reviewed) throw new Error(reviewed.error);
    const applied = await f.apply(reviewed.planRunId, reviewed.actions.filter(a => a.requiresConfirm).map(a => a.id));
    expect(applied).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(JSON.stringify(applied)).not.toMatch(/synthetic-private-captcha-secret|synthetic-transient-google-token/);
    expect(native.writes).toHaveLength(2); expect(ordinary).not.toHaveBeenCalled();
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    await f.plan(); expect(ordinary).toHaveBeenCalled(); expect(native.writes).toHaveLength(2);
    const rows = f.ctx.repos.runs.findByProjectId(f.project.id).filter(r => r.type === 'operator-applications:captcha');
    expect(rows).toHaveLength(1); expect(rows[0].plan).toMatchObject({ status: 'scope-ready' });
    expect(JSON.stringify(rows)).not.toContain('synthetic-private-captcha-secret');
  });
});
