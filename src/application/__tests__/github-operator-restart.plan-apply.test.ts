import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Crc32c } from '@aws-sdk/checksums/crc';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { localHoldingApplicationFixture } from './local-holding-preparation.fixture.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { createGcpSecretContainerSetup } from '../../adapters/providers/gcp/gcp-secret-container.js';
import { OperatorCredentialCustody } from '../../domain/services/operator-credential-custody.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { closeOperatorAppCallbacks } from '../../adapters/browser/operator-app-callback.js';

import { applyOperatorApplications, inspectOperatorApplications } from '../../domain/services/operator-application.service.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { createGcpOperatorOutputClient } from '../../adapters/providers/gcp/gcp-operator-output.js';
const browserFetch = globalThis.fetch;
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const stableAttempts = (record: any) => record.attempts.map(({ updatedAt: _observedAt, ...attempt }: any) => attempt);
const registration = (action: any) => { const { operation: _operation, nativeActionId: _id, ...proof } = action.metadata; return proof; };
describe('explicit GitHub registration restart through PlanService and SQLite', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-github-plan-restart-'));
    vi.stubEnv('HYPERVIBE_DATA_DIR', directory); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(async () => {
    await closeOperatorAppCallbacks(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
  });
  // User-approved restart requirement + GitHub's one-hour manifest contract.
  // The real local callback stages synthetic codes; provider transport is
  // reconstructed, never an assertion of native absence or live compatibility.
  async function fixture(options: { lost?: boolean } = {}) {
    const f = await localHoldingApplicationFixture();
    for (let step = 0; step < 2; step++) {
      const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
      expect(await f.apply(planned.planRunId, planned.actions.filter(a => a.requiresConfirm).map(a => a.id)))
        .toMatchObject({ kind: 'executed', result: { success: true } });
    }
    let conversions = 0, manifest: any, app: any;
    const containers = new Map<string, Record<string, unknown>>();
    const delivered = new Map<string, string>();
    const request: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input)), method = init.method ?? 'GET';
      if (url.hostname === 'api.github.com') {
        if (url.pathname === '/users/operator-test' && method === 'GET') return Response.json({ id: 1234, login: 'operator-test', type: 'User' });
        if (method === 'POST' && url.pathname.startsWith('/app-manifests/')) {
          conversions++;
          if (options.lost) throw new Error('Synthetic lost one-time conversion acknowledgement');
          const slug = manifest.name.toLowerCase().replaceAll(' ', '-');
          app = { id: 5678, slug, name: manifest.name, client_id: 'Iv1.synthetic', owner: { id: 1234, login: 'operator-test', type: 'User' },
            external_url: manifest.url, html_url: `https://github.com/apps/${slug}`, created_at: new Date().toISOString(),
            permissions: { actions: 'read', administration: 'read', checks: 'read', contents: 'read', metadata: 'read' },
            events: ['check_run', 'check_suite', 'workflow_run'] };
          return Response.json({ ...app, pem, client_secret: 'private-fixture-client-value', webhook_secret: 'private-fixture-webhook-value' }, { status: 201 });
        }
        if (url.pathname === '/app') return Response.json(app);
        if (url.pathname === '/app/hook/config') return Response.json({ url: `${manifest.url}/api/v1/code-host-events`, content_type: 'json', insecure_ssl: '0' });
        throw new Error('Unexpected synthetic GitHub request');
      }
      if (url.hostname === 'secretmanager.googleapis.com') {
        const resource = url.pathname.replace(/^\/v1\//, '').split('/versions')[0].replace(/:addVersion$/, '');
        if (url.pathname.endsWith(':addVersion')) {
          expect(method).toBe('POST'); expect(delivered.has(resource)).toBe(false);
          delivered.set(resource, Buffer.from(JSON.parse(String(init.body)).payload.data, 'base64').toString());
          return Response.json({ name: `${resource}/versions/1`, state: 'ENABLED' });
        }
        if (method === 'POST' && url.pathname.endsWith('/secrets')) {
          const name = `projects/${f.native.scope.projectNumber}/secrets/${url.searchParams.get('secretId')}`;
          expect(containers.has(name)).toBe(false);
          const result = { name, createTime: '2026-10-27T00:00:00Z', ...JSON.parse(String(init.body)) };
          containers.set(name, result); return Response.json(result);
        }
        expect(method).toBe('GET');
        if (url.pathname.endsWith(':access')) {
          const value = delivered.get(resource)!, crc = new Crc32c(); crc.update(Buffer.from(value));
          return Response.json({ name: `${resource}/versions/1`, payload: { data: Buffer.from(value).toString('base64'),
            dataCrc32c: String(Buffer.from(await crc.digest()).readUInt32BE()) } });
        }
        if (url.pathname.endsWith('/versions/1')) return Response.json({ name: `${resource}/versions/1`, state: 'ENABLED' });
        if (url.pathname.endsWith('/versions')) return Response.json(delivered.has(resource) ? { versions: [{ name: `${resource}/versions/1` }] } : {});
        return containers.has(resource) ? Response.json(containers.get(resource)) : Response.json({}, { status: 404 });
      }
      return f.native.request(input, init);
    };
    vi.stubGlobal('fetch', request);
    vi.spyOn(providerRegistry.getOperatorOutputDelivery('cloudrun')!, 'create').mockImplementation(async binding =>
      createGcpOperatorOutputClient(binding, { token: async () => 'synthetic-token', request }));
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
    async function callback(handoff: string, code = 'synthetic-expired-code') {
      const response = await browserFetch(handoff); expect(response.status).toBe(200);
      const html = await response.text(), encoded = html.match(/name="manifest" value="([^"]+)"/)![1];
      manifest = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
      const state = html.match(/name="state" value="([^"]+)"/)![1], callback = new URL(manifest.redirect_url);
      callback.search = new URLSearchParams({ state, code }).toString();
      expect((await browserFetch(callback, { redirect: 'manual' })).status).toBe(303);
    }
    await callback(handoff);
    const validPlan = await f.plan(); if ('error' in validPlan) throw new Error(validPlan.error);
    const original = structuredClone(readRecord()), cipher = custody.read()!.cipher;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.parse(custody.read()!.state.browser!.expiresAt) + 1));
    const restartFrom = { installationId: record.installationId, planDigest: record.plan.digest };
    return { f, desired, original, custody, cipher, restartFrom, handoff, callback, validPlan, delivered,
      readRecord: () => f.ctx.repos.runs.findByProjectId(f.project.id).find(row => row.id === record.installationId)!.plan as any,
      conversions: () => conversions };
  }
  it('reviews a fresh successor while preserving the expired parent and revoking historical apply authority', async () => {
    const x = await fixture(), { f, desired, restartFrom } = x;
    desired.environments.staging.operatorApplications.github.restartFrom = restartFrom;
    f.store.replace(f.project, desired);
    const plan = await f.plan();
    expect(plan).toMatchObject({ scope: 'operator-applications' });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions).toHaveLength(5);
    expect(plan.actions[0]).toMatchObject({ type: 'create', requiresConfirm: true });
    const records = f.ctx.repos.runs.findByProjectId(f.project.id).filter(row => row.type === 'operator-applications:github').map(row => row.plan as any);
    const child = records.find(record => record.installationId !== restartFrom.installationId)!;
    expect(child.intent.predecessor).toEqual(restartFrom); expect(child.attempts).toEqual([]);
    expect(child.plan.review.resources[0].name).not.toBe(x.original.plan.review.resources[0].name);
    expect(child.plan.review.warnings.join(' ')).toMatch(/unknown.*cleanup|cleanup.*unknown/i);
    expect(x.custody.read()!.cipher).toBe(x.cipher); expect(x.conversions()).toBe(0);
    expect(stableAttempts(x.readRecord())).toEqual(stableAttempts(x.original));
    const result = await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id));
    expect(result).toMatchObject({ result: { success: false } }); // new owner browser step pending
    expect(x.conversions()).toBe(0);
    const status = await inspectOperatorApplications(f.project, 'staging', f.store.get(f.project)!.spec);
    expect(status?.registrations[0]).toMatchObject({ installationId: child.installationId,
      historicalRegistrations: [{ installationId: restartFrom.installationId, nativeState: 'unknown', cleanupVerified: false }] });
    expect(x.custody.read()!.cipher).toBe(x.cipher);
    delete desired.environments.staging.operatorApplications.github.restartFrom;
    f.store.replace(f.project, desired);
    vi.setSystemTime(new Date(Date.parse(x.custody.read()!.state.browser!.expiresAt) - 1000));
    expect((await browserFetch(x.handoff)).status).toBe(403);
    expect(x.conversions()).toBe(0);
  });
  it('offers only a nonsecret contextual selector and preserves recovery without an explicit restart', async () => {
    const x = await fixture(), { f } = x;
    const status = await inspectOperatorApplications(f.project, 'staging', f.store.get(f.project)!.spec);
    expect(status?.registrations[0]).toMatchObject({ reason: 'authorization_expired',
      restart: { restartFrom: x.restartFrom, requiresNewApproval: true, nativeState: 'unknown', cleanupVerified: false } });
    expect(JSON.stringify(status)).not.toContain('synthetic-expired-code');
    expect(x.custody.read()!.cipher).toBe(x.cipher); expect(x.conversions()).toBe(0);
  });
  it('retains unresolved predecessor cleanup after a fresh callback, one conversion and immutable delivery', async () => {
    const x = await fixture(), { f, desired, restartFrom } = x;
    desired.environments.staging.operatorApplications.github.restartFrom = restartFrom; f.store.replace(f.project, desired);
    const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
    await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id));
    let status = await inspectOperatorApplications(f.project, 'staging', f.store.get(f.project)!.spec);
    await x.callback((status!.registrations[0].browserHandoff as any).url, 'synthetic-new-code');
    const continuation = await f.plan(); if ('error' in continuation) throw new Error(continuation.error);
    expect(continuation.actions.map(action => action.type)).toEqual(['noop', 'create', 'create', 'create', 'create']);
    expect(await f.apply(continuation.planRunId, continuation.actions.filter(action => action.requiresConfirm).map(action => action.id)))
      .toMatchObject({ result: { success: true } });
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    status = await inspectOperatorApplications(f.project, 'staging', f.store.get(f.project)!.spec);
    expect(status?.registrations[0]).toMatchObject({ status: 'scope-ready', verified: true,
      historicalRegistrations: [{ ...restartFrom, nativeState: 'unknown', cleanupVerified: false }] });
    expect(x.conversions()).toBe(1); expect(x.delivered.size).toBe(3);
    expect(x.custody.read()!.cipher).toBe(x.cipher);
    expect(stableAttempts(x.readRecord())).toEqual(stableAttempts(x.original));
    expect(x.readRecord().completed).toEqual(x.original.completed);
    expect(JSON.stringify(status)).not.toMatch(/synthetic-new-code|private-fixture-client-value|private-fixture-webhook-value|BEGIN RSA PRIVATE KEY/);
  });
  it.each(['digest', 'owner', 'repository', 'destination', 'unexpired'] as const)('refuses restart with changed %s', async change => {
    const x = await fixture(), { f, desired } = x;
    const selected = desired.environments.staging.operatorApplications.github;
    selected.restartFrom = { ...x.restartFrom };
    if (change === 'digest') selected.restartFrom.planDigest = 'a'.repeat(64);
    if (change === 'owner') selected.nativeScope.ownerLogin = 'other-owner';
    if (change === 'repository') desired.gitRemoteUrl = 'https://github.com/other/operator';
    if (change === 'destination') desired.environments.staging.secretDestinations.GITHUB_APP_CLIENT_SECRET.destination.secretId = 'unreviewed-output';
    if (change === 'unexpired') vi.setSystemTime(new Date(Date.parse(x.custody.read()!.state.browser!.expiresAt) - 1000));
    f.store.replace(f.project, desired);
    const result = await f.plan(); expect(result).toHaveProperty('error');
    expect(result).not.toHaveProperty('planRunId'); expect(x.conversions()).toBe(0);
    expect(f.ctx.repos.runs.findByProjectId(f.project.id).filter(row => row.type === 'operator-applications:github')).toHaveLength(1);
    expect(x.custody.read()!.cipher).toBe(x.cipher);
  });
  it('never permits a fresh registration after an uncertain one-time conversion', async () => {
    const x = await fixture({ lost: true }), { f, desired } = x;
    vi.setSystemTime(new Date(Date.parse(x.custody.read()!.state.browser!.expiresAt) - 1000));
    await f.apply(x.validPlan.planRunId, x.validPlan.actions.filter(action => action.requiresConfirm).map(action => action.id));
    expect(x.conversions()).toBe(1); expect(x.custody.read()!.state.phase).toBe('conversion-started');
    vi.setSystemTime(new Date(Date.parse(x.custody.read()!.state.browser!.expiresAt) + 1));
    desired.environments.staging.operatorApplications.github.restartFrom = x.restartFrom; f.store.replace(f.project, desired);
    expect(await f.plan()).toHaveProperty('error');
    const status = await inspectOperatorApplications(f.project, 'staging', f.store.get(f.project)!.spec);
    expect(status?.registrations[0]).not.toHaveProperty('restart'); expect(x.conversions()).toBe(1);
    expect(f.ctx.repos.runs.findByProjectId(f.project.id).filter(row => row.type === 'operator-applications:github')).toHaveLength(1);
  });
  it('accepts only one concurrent successor and cannot reactivate its ancestor after a spec reversal', async () => {
    const x = await fixture(), { f, desired } = x;
    desired.environments.staging.operatorApplications.github.restartFrom = x.restartFrom; f.store.replace(f.project, desired);
    const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    desired.secrets.UNRELATED = { ownership: 'delegated', principal: 'email:operator@example.test', environments: ['staging'], required: false };
    f.store.replace(f.project, desired);
    const second = await f.plan(); if ('error' in second) throw new Error(second.error);
    expect(first.actions[0].metadata!.installationId).not.toBe(second.actions[0].metadata!.installationId);
    // Exercise the real action adapter concurrently; exact source revisions also
    // protect the ordinary saved-plan entrypoint independently of journal CAS.
    await Promise.all([first, second].map(plan => applyOperatorApplications({ project: f.project,
      environment: f.ctx.repos.environments.findById(f.environment.id)!, applicationRegistration: registration(plan.actions[0]),
      action: plan.actions[0], authorize: () => true })));
    const children = f.ctx.repos.runs.findByProjectId(f.project.id).filter(row => row.type === 'operator-applications:github'
      && row.id !== x.restartFrom.installationId).map(row => row.plan as any);
    expect(children.filter(record => record.attempts.length > 0)).toHaveLength(1);
    expect(children.flatMap(record => record.attempts)).toHaveLength(1);
    delete desired.environments.staging.operatorApplications.github.restartFrom; f.store.replace(f.project, desired);
    const old = x.validPlan.actions[1];
    await applyOperatorApplications({ project: f.project, environment: f.ctx.repos.environments.findById(f.environment.id)!,
      applicationRegistration: registration(old), action: old, authorize: () => true });
    expect(x.conversions()).toBe(0); expect(x.custody.read()!.cipher).toBe(x.cipher);
  });
  it('stops at the shared twenty-generation limit before making its history unreadable', async () => {
    const x = await fixture(), { f, desired } = x;
    let predecessor = x.restartFrom;
    for (let generation = 1; generation < 20; generation++) {
      desired.environments.staging.operatorApplications.github.restartFrom = predecessor; f.store.replace(f.project, desired);
      const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
      await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id));
      const child = f.ctx.repos.runs.findByProjectId(f.project.id).find(row => row.id === plan.actions[0].metadata!.installationId)!.plan as any;
      expect(child.attempts).toHaveLength(1);
      const custody = new OperatorCredentialCustody({ projectId: f.project.id, environmentId: f.environment.id,
        installationId: child.installationId, intentDigest: canonicalJsonSha256(child.intent), provider: 'github-app' });
      vi.setSystemTime(new Date(Date.parse(custody.read()!.state.browser!.expiresAt) + 1));
      predecessor = { installationId: child.installationId, planDigest: child.plan.digest };
    }
    desired.environments.staging.operatorApplications.github.restartFrom = predecessor; f.store.replace(f.project, desired);
    expect(await f.plan()).toHaveProperty('error');
    const status = await inspectOperatorApplications(f.project, 'staging', f.store.get(f.project)!.spec);
    expect(status?.registrations[0]).toMatchObject({ installationId: predecessor.installationId, reason: 'authorization_expired' });
    expect(status?.registrations[0]).not.toHaveProperty('restart');
    expect(f.ctx.repos.runs.findByProjectId(f.project.id, 1000).filter(row => row.type === 'operator-applications:github')).toHaveLength(20);
    expect(x.conversions()).toBe(0); expect(x.custody.read()!.cipher).toBe(x.cipher);
  }, 60000);
});
