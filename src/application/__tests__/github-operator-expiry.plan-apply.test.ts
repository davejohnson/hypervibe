import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { localHoldingApplicationFixture } from './local-holding-preparation.fixture.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { createGcpSecretContainerSetup } from '../../adapters/providers/gcp/gcp-secret-container.js';
import { OperatorCredentialCustody } from '../../domain/services/operator-credential-custody.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { closeOperatorAppCallbacks } from '../../adapters/browser/operator-app-callback.js';

describe('GitHub manifest expiry through actual planning and SQLite', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-github-plan-expiry-'));
    vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(async () => {
    await closeOperatorAppCallbacks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
  });

  // GitHub requires the manifest flow to complete within one hour. Native
  // responses are reconstructed; real planner, executor, encrypted custody,
  // SQLite journal and clients run here without cloud requests. The issued form
  // and accepted callback pass through the real private loopback HTTP listener.
  it.each([false, true])('blocks a new capture plan after staged-code expiry, restart=%s', async restart => {
    const localFetch = fetch;
    const f = await localHoldingApplicationFixture();
    for (let step = 0; step < 2; step++) {
      const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
      expect(await f.apply(planned.planRunId, planned.actions.filter(a => a.requiresConfirm).map(a => a.id)))
        .toMatchObject({ kind: 'executed', result: { success: true } });
    }
    let conversions = 0;
    const containers = new Map<string, Record<string, unknown>>();
    const request: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input)), method = init.method ?? 'GET';
      if (url.hostname === '127.0.0.1') return localFetch(input, init);
      if (url.hostname === 'api.github.com') {
        if (url.pathname === '/users/operator-test' && method === 'GET') return Response.json({ id: 1234, login: 'operator-test', type: 'User' });
        if (method === 'POST') conversions++;
        throw new Error('Unexpected synthetic GitHub request');
      }
      if (url.hostname === 'secretmanager.googleapis.com') {
        const resource = url.pathname.replace(/^\/v1\//, '').split('/versions')[0];
        if (method === 'POST' && url.pathname.endsWith('/secrets')) {
          const name = `projects/${f.native.scope.projectNumber}/secrets/${url.searchParams.get('secretId')}`;
          expect(containers.has(name)).toBe(false);
          const result = { name, createTime: '2026-10-27T00:00:00Z', ...JSON.parse(String(init.body)) };
          containers.set(name, result); return Response.json(result);
        }
        expect(method).toBe('GET');
        if (url.pathname.endsWith('/versions')) return Response.json({});
        return containers.has(resource) ? Response.json(containers.get(resource)) : Response.json({}, { status: 404 });
      }
      return f.native.request(input, init);
    };
    vi.stubGlobal('fetch', request);
    const roles = { 'client-secret': 'GITHUB_APP_CLIENT_SECRET', 'private-key': 'GITHUB_APP_PRIVATE_KEY_BASE64', 'webhook-secret': 'GITHUB_APP_WEBHOOK_SECRET' };
    const desired: any = structuredClone(f.desired);
    desired.environments.staging.operatorApplications = { github: { provider: 'github-app', profile: 'hypercloud-connect-v1',
      originService: 'web', runtimeService: 'web', nativeScope: { ownerType: 'user', ownerLogin: 'operator-test' }, outputs: roles } };
    desired.environments.staging.secretDestinations = {};
    for (const [role, key] of Object.entries(roles)) {
      desired.secrets[key] = { ownership: 'delegated', principal: 'email:operator@example.test', environments: ['staging'], required: true };
      desired.environments.staging.secretDestinations[key] = { destination: { provider: 'gcp-secret-manager', projectId: f.native.scope.projectId,
        projectNumber: f.native.scope.projectNumber, secretId: `synthetic-${role}` } };
    }
    f.store.replace(f.project, desired);
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { secretDestinationSetup:
      createGcpSecretContainerSetup({ projectId: f.native.scope.projectId, getAccessToken: async () => 'synthetic-token' }, { fetch: request }) } } as any);
    const containerPlan = await f.plan(); if ('error' in containerPlan) throw new Error(containerPlan.error);
    expect(containerPlan.scope).toBe('secret-destinations');
    expect(await f.apply(containerPlan.planRunId, containerPlan.actions.map(a => a.id))).toMatchObject({ result: { success: true } });
    const initial = await f.plan(); if ('error' in initial) throw new Error(initial.error);
    expect(initial.scope).toBe('operator-applications');
    expect(await f.apply(initial.planRunId, initial.actions.map(a => a.id))).toMatchObject({ result: { success: false } });
    const readRecord = () => f.ctx.repos.runs.findByProjectId(f.project.id).find(row => row.type === 'operator-applications:github')!.plan as any;
    const record = readRecord();
    const custody = new OperatorCredentialCustody({ projectId: f.project.id, environmentId: f.environment.id,
      installationId: record.installationId, intentDigest: canonicalJsonSha256(record.intent), provider: 'github-app' });
    const handoff = record.attempts[0].externalUrl;
    expect(handoff).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/begin\//);
    const response = await fetch(handoff); expect(response.status).toBe(200);
    const html = await response.text(), encoded = html.match(/name="manifest" value="([^"]+)"/)![1];
    const manifest = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    const state = html.match(/name="state" value="([^"]+)"/)![1], callback = new URL(manifest.redirect_url);
    const code = 'synthetic-private-expired-manifest-code';
    callback.search = new URLSearchParams({ state, code }).toString();
    expect((await fetch(callback, { redirect: 'manual' })).status).toBe(303);
    expect(custody.read()!.state.phase).toBe('code-staged');
    const validPlan = await f.plan(); if ('error' in validPlan) throw new Error(validPlan.error);
    expect(validPlan.actions.map(a => a.type)).toEqual(['noop', 'create', 'create', 'create', 'create']);
    const before = structuredClone(readRecord()), staged = custody.read()!;
    const planCount = f.ctx.repos.runs.findByProjectId(f.project.id).filter(row => row.type === 'plan').length;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(staged.state.browser!.expiresAt) + 1);
    if (restart) { SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); }
    const expiredPlan = await f.plan();
    expect.soft(expiredPlan).toMatchObject({ error: expect.stringContaining('authorization_expired') });
    expect.soft(expiredPlan).not.toHaveProperty('planRunId');
    expect.soft(f.ctx.repos.runs.findByProjectId(f.project.id).filter(row => row.type === 'plan')).toHaveLength(planCount);
    const after = readRecord();
    expect(after).toMatchObject({ status: 'blocked', reason: 'authorization_expired', installationId: before.installationId });
    expect(after.intent).toEqual(before.intent); expect(after.plan).toEqual(before.plan);
    const stableAttempts = (value: typeof record) => value.attempts.map(({ updatedAt: _observedAt, ...attempt }: any) => attempt);
    expect(stableAttempts(after)).toEqual(stableAttempts(before)); expect(after.completed).toEqual(before.completed);
    expect(custody.read()!.cipher).toBe(staged.cipher); expect(conversions).toBe(0);
    expect(JSON.stringify([expiredPlan, after])).not.toContain(code);
  });
});
