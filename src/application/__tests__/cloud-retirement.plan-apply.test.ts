import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { DEPLOYMENT_ACCESS_PROVIDER, deploymentGrantScope, saveDeploymentState } from '../../adapters/cloud/deployment-access.client.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';

// User contract: explicit hosted GCP retirement uses the existing exact device
// grant and browser owner approval. An app remaining in desired state must never
// recreate it during cleanup. This command/SQLite/HTTP boundary uses serialized
// hosted outcomes; native GCP compatibility is covered separately.
let directory: string;
const baseUrl = 'https://cloud.example.test', repository = 'github.com/acme/cleanup';
const token = `hvc_${randomUUID()}_${'x'.repeat(43)}`;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-retirement-public-'));
  execFileSync('git', ['init', '-q', directory]);
  execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', 'https://github.com/acme/cleanup.git']);
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
function fixture(mode: 'disconnect' | 'delete-owned' = 'delete-owned') {
  const ctx = createCommandContext(), commands = new CommandRegistry(); registerCoreTools(commands, ctx);
  const project = ctx.repos.projects.create({ name: 'cleanup', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/cleanup.git' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'cloudrun', projectId: 'native-original', services: { web: { serviceId: 'native-service' } }, unrelatedAudit: { keep: true } } });
  const declaration = { id: randomUUID(), mode, connectionIds: Array.from({ length: mode === 'disconnect' ? 1 : 2 }, () => randomUUID()).sort(), baseUrl };
  const desired: any = { version: 1, project: project.name, environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} }, cloudRetirement: declaration } } };
  saveDeploymentState({ connections: ctx.repos.connections, secretStore: ctx.secretStore }, DEPLOYMENT_ACCESS_PROVIDER,
    deploymentGrantScope(baseUrl, repository, 'staging'), { version: 1, baseUrl, repository, env: 'staging', sourceBranch: 'old-branch', status: 'verified',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), token, project: { id: 'hosted-project', name: 'cleanup' }, environment: { id: 'hosted-env', key: 'staging', name: 'Staging' } }, null, null);
  let remote: any = { id: declaration.id, environment: 'staging', mode, connectionIds: declaration.connectionIds,
    status: 'review-required', reviewUrl: `${baseUrl}/apps/hosted-project/cloud-retirements/${declaration.id}` };
  let lost = false;
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(url).toMatch(/^https:\/\/cloud\.example\.test\/api\/v1\/projects\/hosted-project\/cloud-retirements/);
    if (url.endsWith('/continuations')) { if (lost) throw Error(`lost ${token}`); remote = { ...remote, status: mode === 'disconnect' ? 'disconnected' : 'retired', completedActionIds: ['gcp:cleanup', 'gcp:verify-retired'], remainingActionIds: [], retained: mode === 'disconnect' ? ['app', 'secret-reader'] : ['history'] }; }
    return Response.json(remote);
  });
  vi.stubGlobal('fetch', network);
  const adapters = vi.spyOn(adapterFactory, 'getProviderAdapter');
  const execute = (name: string, input: any = {}) => runWithWorkspaceDirectories([directory], () => commands.execute(name, { project: project.name, ...(['hv_plan', 'hv_status'].includes(name) ? { env: 'staging' } : {}), ...input })) as Promise<any>;
  const setSpec = () => execute('hv_spec', { spec: desired, replace: true });
  const plan = (input: any = {}) => execute('hv_plan', input);
  const apply = (planned: any, confirm = true) => execute('hv_apply', { planId: planned.data.planId, confirmActions: confirm ? planned.data.actions.map((action: any) => action.id) : [] });
  return { ctx, project, environment, declaration, desired, calls, network, adapters, execute, setSpec, plan, apply,
    ready: () => { remote = { ...remote, status: 'ready', planDigest: 'a'.repeat(64), completedActionIds: [], remainingActionIds: ['gcp:cleanup', 'gcp:verify-retired'] }; },
    setRemote: (patch: any) => { remote = { ...remote, ...patch }; }, lose: () => { lost = true; } };
}
it('saves explicit cleanup and plans only its browser review despite remaining app declarations', async () => {
  const f = fixture(); const saved = await f.setSpec(); expect(saved.ok, JSON.stringify(saved)).toBe(true);
  const planned = await f.plan(); expect(planned.ok, JSON.stringify(planned)).toBe(true);
  expect(planned.data.scope).toBe('cloud-retirement'); expect(planned.data.actions).toEqual([]);
  expect(planned.data.cloudRetirement).toMatchObject({ status: 'review-required', reviewUrl: expect.stringContaining('/cloud-retirements/') });
  expect(f.calls).toHaveLength(1); expect(f.calls[0].body).toEqual({ id: f.declaration.id, environment: 'staging', mode: 'delete-owned', connectionIds: f.declaration.connectionIds });
  expect(f.adapters).not.toHaveBeenCalled(); expect(JSON.stringify(planned)).not.toContain(token);
});
it.each(['disconnect', 'delete-owned'] as const)('requires exact confirmation and preserves audit bindings after %s', async mode => {
  const f = fixture(mode); expect((await f.setSpec()).ok).toBe(true); f.ready();
  const planned = await f.plan({ scope: 'cloud-retirement' }); expect(planned.ok, JSON.stringify(planned)).toBe(true);
  expect(planned.data.actions).toHaveLength(1); expect(planned.data.actions[0]).toMatchObject({ type: 'destroy', requiresConfirm: true });
  await f.apply(planned, false); expect(f.calls.filter(call => call.url.endsWith('/continuations'))).toHaveLength(0);
  const applied = await f.apply(planned); expect(applied.ok, JSON.stringify(applied)).toBe(true); expect(applied.data.applied).toBe(true);
  expect(f.calls.filter(call => call.url.endsWith('/continuations'))).toHaveLength(1);
  expect(f.calls.at(-1)?.body).toEqual({ planDigest: 'a'.repeat(64) });
  const status = await f.execute('hv_status'); expect(status.ok, JSON.stringify(status)).toBe(true);
  expect(status.data.cloudRetirement.status).toBe(mode === 'disconnect' ? 'disconnected' : 'retired');
  expect(f.ctx.repos.environments.findById(f.environment.id)?.platformBindings).toEqual(f.environment.platformBindings);
  const again = await f.plan(); expect(again.ok).toBe(true); expect(again.data.actions).toEqual([]); expect(again.data.scope).toBe('cloud-retirement');
  expect(f.adapters).not.toHaveBeenCalled(); expect(JSON.stringify([planned, applied, status])).not.toContain(token);
});
it.each([{ envVars: {} }, { envVars: { PRIVATE: 'never-send' } }, { services: [] }, { envFile: '.env' }, { secretRefs: {} }, { includeEnvFile: true }, { credential: 'owner' }])('rejects deployment inputs before any hosted request', async input => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true);
  const planned = await f.plan(input); expect(planned.ok).toBe(false); expect(f.calls).toEqual([]); expect(f.adapters).not.toHaveBeenCalled();
});
it('requires a fresh status read after an uncertain continuation and keeps the same remote plan', async () => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready();
  const planned = await f.plan(); f.lose();
  const outcome = await f.apply(planned);
  expect(JSON.stringify(outcome)).toContain('pending'); expect(JSON.stringify(outcome)).not.toContain(token);
  const before = f.calls.length, status = await f.execute('hv_status');
  expect(status.ok).toBe(true); expect(f.calls.slice(before).map(call => call.method)).toEqual(['GET']);
  f.setRemote({ status: 'pending' });
  const recovery = await f.plan(); expect(recovery.ok, JSON.stringify(recovery)).toBe(true);
  expect(recovery.data.cloudRetirement.status).toBe('pending'); expect(recovery.data.actions[0]).toMatchObject({ type: 'update', requiresConfirm: true });
  const currentCalls = f.calls.length;
  await f.apply(recovery, false); expect(f.calls).toHaveLength(currentCalls);
  await f.apply(recovery);
  expect(f.calls.slice(currentCalls).map(call => [call.method, call.url.endsWith('/continuations')])).toEqual([['GET', false], ['POST', true]]);
  expect(f.calls.at(-1)?.body).toEqual({ planDigest: 'a'.repeat(64) });
});
it.each(['digest', 'target', 'declaration', 'grant'] as const)('blocks changed %s before cleanup effects', async change => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready();
  const planned = await f.plan(); expect(planned.ok, JSON.stringify(planned)).toBe(true);
  if (change === 'digest') f.setRemote({ planDigest: 'b'.repeat(64) });
  if (change === 'target') f.setRemote({ connectionIds: [randomUUID(), randomUUID()] });
  if (change === 'declaration') { f.desired.environments.staging.cloudRetirement.connectionIds = [randomUUID(), randomUUID()]; expect((await f.setSpec()).ok).toBe(true); }
  if (change === 'grant') {
    const row = f.ctx.repos.connections.findByProviderAndScope(DEPLOYMENT_ACCESS_PROVIDER, deploymentGrantScope(baseUrl, repository, 'staging'))!;
    const grant = f.ctx.secretStore.decryptObject(row.credentialsEncrypted) as any;
    saveDeploymentState({ connections: f.ctx.repos.connections, secretStore: f.ctx.secretStore }, DEPLOYMENT_ACCESS_PROVIDER,
      row.scope!, { ...grant, sourceBranch: 'replacement-approval' }, row.credentialsEncrypted, row.status);
  }
  const applied = await f.apply(planned); expect(JSON.stringify(applied)).toMatch(/blocked|stale|changed|reject/i);
  expect(f.calls.filter(call => call.url.endsWith('/continuations'))).toEqual([]); expect(f.adapters).not.toHaveBeenCalled();
});
it('rejects a concurrent local journal change after status and before continuation', async () => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready(); const planned = await f.plan();
  const transport = f.network.getMockImplementation()!;
  f.network.mockImplementationOnce(async (input, init) => {
    const result = await transport(input, init);
    const row = f.ctx.repos.connections.findAllByProvider('hypervibe-cloud-retirement')[0];
    f.ctx.repos.connections.updateStatus(row.id, 'failed'); return result;
  });
  const applied = await f.apply(planned); expect(JSON.stringify(applied)).toContain('blocked');
  expect(f.calls.filter(call => call.url.endsWith('/continuations'))).toEqual([]);
});
it.each([
  { reviewUrl: 'https://foreign.example/steal' }, { reviewUrl: `${baseUrl}/apps/wrong/cloud-retirements/target` },
  { reason: token }, { retained: [token] }, { accessToken: token }, { status: 'retired', remainingActionIds: ['gcp:pending'] },
])('keeps malformed or secret-bearing hosted responses out of output and saved plans', async patch => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready(); f.setRemote(patch);
  const planned = await f.plan(); expect(planned.ok).toBe(false);
  expect(JSON.stringify(planned)).not.toContain(token); expect(f.ctx.repos.runs.findByProjectId(f.project.id)).toEqual([]);
  expect(f.calls.filter(call => call.url.endsWith('/continuations'))).toEqual([]);
});
it('status reports an unknown result without turning it into completed cleanup or setup', async () => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready(); await f.plan();
  f.network.mockRejectedValueOnce(new Error(token));
  const status = await f.execute('hv_status'); expect(status.ok).toBe(true);
  expect(status.data).toMatchObject({ inSync: false, verified: false, cloudRetirement: { status: 'unknown' } });
  expect(f.adapters).not.toHaveBeenCalled(); expect(JSON.stringify(status)).not.toContain(token);
});
it.each(['retired', 'uncertain'] as const)('prevents implicit recreation when a %s delete-owned declaration is removed', async state => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready();
  const planned = await f.plan(); if (state === 'uncertain') f.lose(); await f.apply(planned);
  delete f.desired.environments.staging.cloudRetirement; expect((await f.setSpec()).ok).toBe(true);
  const again = await f.plan(); expect(again.ok).toBe(false); expect(again.error.message).toMatch(/cleanup|retirement|reconnect/i);
  expect(f.adapters).not.toHaveBeenCalled();
  const status = await f.execute('hv_status'); expect(status.data).toMatchObject({ scope: 'cloud-retirement', inSync: false });
  if (state === 'retired') expect(status.data.cloudRetirement.status).toBe('retired');
});
it('allows ordinary app planning after removing a completed disconnect declaration', async () => {
  const f = fixture('disconnect'); expect((await f.setSpec()).ok).toBe(true); f.ready(); await f.apply(await f.plan());
  delete f.desired.environments.staging.cloudRetirement; expect((await f.setSpec()).ok).toBe(true);
  const planned = await f.plan();
  expect(planned.data?.scope).not.toBe('cloud-retirement');
  expect(planned.error?.message ?? '').not.toMatch(/retirement|cleanup.*declaration|reconnect/i);
  expect(f.adapters).toHaveBeenCalled();
  expect(f.ctx.repos.environments.findById(f.environment.id)?.platformBindings).toEqual(f.environment.platformBindings);
});
it.each([{ env: 'production' }, { repository: 'github.com/foreign/app' }, { baseUrl: 'https://foreign.example' }, { expiresAt: '2020-01-01T00:00:00.000Z' }])('requires the exact current scoped device grant without local credential fallback', async patch => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true);
  const row = f.ctx.repos.connections.findByProviderAndScope(DEPLOYMENT_ACCESS_PROVIDER, deploymentGrantScope(baseUrl, repository, 'staging'))!;
  const grant = f.ctx.secretStore.decryptObject(row.credentialsEncrypted) as any;
  saveDeploymentState({ connections: f.ctx.repos.connections, secretStore: f.ctx.secretStore }, DEPLOYMENT_ACCESS_PROVIDER,
    row.scope!, { ...grant, ...patch }, row.credentialsEncrypted, row.status);
  const planned = await f.plan(); expect(planned.ok).toBe(false); expect(f.calls).toEqual([]); expect(f.adapters).not.toHaveBeenCalled();
});
it.each(['confirmation', 'action', 'inputs'] as const)('rejects persisted %s tampering before any continuation', async variant => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready(); const planned = await f.plan();
  const row = f.ctx.repos.runs.findById(planned.data.planId)!; const document = structuredClone(row.plan) as any;
  if (variant === 'confirmation') document.actions[0].requiresConfirm = false;
  if (variant === 'action') document.actions.push({ id: 'service:web', type: 'create', resource: { kind: 'service', name: 'web', provider: 'cloudrun' }, verified: true, reason: 'Unreviewed app creation' });
  if (variant === 'inputs') document.overrides = { envVarKeys: ['PRIVATE'] };
  f.ctx.repos.runs.updatePlan(row.id, document);
  const before = f.calls.length; const applied = await f.apply(planned);
  expect(applied.ok).toBe(false); expect(f.calls).toHaveLength(before); expect(f.adapters).not.toHaveBeenCalled();
});
it('matches the original connection selection independent of caller order', async () => {
  const f = fixture(); const sorted = [...f.declaration.connectionIds].sort();
  f.desired.environments.staging.cloudRetirement = { ...f.declaration, connectionIds: [...sorted].reverse() };
  expect((await f.setSpec()).ok).toBe(true); f.ready();
  const planned = await f.plan(); expect(planned.ok, JSON.stringify(planned)).toBe(true);
  expect(f.calls[0].body.connectionIds).toEqual(sorted);
  expect((await f.apply(planned)).data.applied).toBe(true);
});
it('allows a continuation body beyond the short observation deadline', async () => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready(); const planned = await f.plan();
  const transport = f.network.getMockImplementation()!;
  f.network.mockImplementation(async (input, init) => {
    const response = await transport(input, init);
    if (!String(input).endsWith('/continuations')) return response;
    const body = await response.text();
    let timer: ReturnType<typeof setTimeout>;
    return new Response(new ReadableStream({ start(controller) {
      timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(body)); controller.close(); }, 45_000);
    }, cancel() { clearTimeout(timer); } }), { headers: { 'content-type': 'application/json' } });
  });
  vi.useFakeTimers(); const applying = f.apply(planned);
  await vi.advanceTimersByTimeAsync(45_001);
  const applied = await applying; expect(applied.ok, JSON.stringify(applied)).toBe(true); expect(applied.data.applied).toBe(true);
  expect(JSON.stringify(applied)).toContain('retired');
  expect(f.calls.filter(call => call.url.endsWith('/continuations'))).toHaveLength(1);
});
it.each(['missing', 'overlap', 'empty', 'duplicate'] as const)('rejects %s remote action evidence before saving an executable plan', async variant => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready();
  const patch = variant === 'missing' ? { completedActionIds: undefined, remainingActionIds: undefined }
    : variant === 'overlap' ? { completedActionIds: ['gcp:cleanup'], remainingActionIds: ['gcp:cleanup'] }
    : variant === 'empty' ? { completedActionIds: [], remainingActionIds: [] }
    : { completedActionIds: [], remainingActionIds: ['gcp:cleanup', 'gcp:cleanup'] };
  f.setRemote(patch); const planned = await f.plan(); expect(planned.ok).toBe(false);
  expect(f.calls.filter(call => call.url.endsWith('/continuations'))).toEqual([]);
});
it.each(['fresh-status', 'continuation'] as const)('never treats dropped actions in %s as terminal cleanup', async stage => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true); f.ready(); const planned = await f.plan();
  if (stage === 'fresh-status') f.setRemote({ status: 'retired', completedActionIds: ['gcp:cleanup'], remainingActionIds: [] });
  else {
    const transport = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, init) => {
      const response = await transport(input, init); if (!String(input).endsWith('/continuations')) return response;
      return Response.json({ ...await response.json() as Record<string, unknown>, completedActionIds: ['gcp:cleanup'] });
    });
  }
  const applied = await f.apply(planned);
  expect(applied.data.applied).toBe(false); expect(JSON.stringify(applied)).toMatch(/blocked|pending/);
  expect(f.calls.filter(call => call.url.endsWith('/continuations'))).toHaveLength(stage === 'fresh-status' ? 0 : 1);
});
it('recovers a lost initial proposal response with GET and no duplicate proposal', async () => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true);
  const transport = f.network.getMockImplementation()!;
  f.network.mockImplementationOnce(async (input, init) => {
    await transport(input, init); throw Error(`Lost initial response ${token}`);
  });
  expect((await f.plan()).ok).toBe(false);
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  const recovered = await f.plan(); expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
  expect(f.calls.map(call => call.method)).toEqual(['POST', 'GET']);
  expect(f.calls[0].body.id).toBe(f.declaration.id);
  expect(recovered.data.cloudRetirement).toMatchObject({ id: f.declaration.id, status: 'review-required' });
  expect(JSON.stringify(recovered)).not.toContain(token); expect(f.adapters).not.toHaveBeenCalled();
});
it.each([401, 403, 500, 'transport', 'malformed'] as const)('does not recreate an initial proposal when GET returns %s', async outcome => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true);
  const wire: string[] = [];
  f.network.mockImplementation(async (_input, init) => {
    wire.push(init?.method ?? 'GET');
    if (init?.method === 'POST' || outcome === 'transport') throw Error(`Unknown response ${token}`);
    return typeof outcome === 'number' ? Response.json({ error: token }, { status: outcome }) : Response.json({ status: 'absent', id: 'foreign' });
  });
  expect((await f.plan()).ok).toBe(false);
  const recovery = await f.plan(); expect(recovery.ok).toBe(false);
  expect(wire).toEqual(['POST', 'GET']); expect(JSON.stringify(recovery)).not.toContain(token);
  expect(f.adapters).not.toHaveBeenCalled();
});
it('recovers an undelivered initial proposal with the same idempotent metadata request after an inconclusive 404', async () => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true);
  const transport = f.network.getMockImplementation()!;
  const wire: Array<{ method: string; url: string; body: unknown }> = [];
  f.network.mockImplementation(async (input, init) => {
    wire.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (wire.length === 1) throw Error(`Request never arrived ${token}`);
    if (wire.length === 2) return Response.json({ error: 'Not found' }, { status: 404 });
    return transport(input, init);
  });
  expect((await f.plan()).ok).toBe(false);
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  const recovered = await f.plan(); expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
  expect(wire.map(call => call.method)).toEqual(['POST', 'GET', 'POST']);
  expect(wire[2]).toEqual(wire[0]);
  expect(wire[2].body).toEqual({ id: f.declaration.id, environment: 'staging', mode: 'delete-owned', connectionIds: f.declaration.connectionIds });
  expect(recovered.data.cloudRetirement.status).toBe('review-required');
  expect(wire.every(call => !call.url.endsWith('/continuations'))).toBe(true);
  expect(f.adapters).not.toHaveBeenCalled(); expect(JSON.stringify(recovered)).not.toContain(token);
});
it('keeps an unauthorized metadata replay blocked when the scoped GET conceals access with 404', async () => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true);
  const methods: string[] = [];
  f.network.mockImplementation(async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    if (methods.length === 1) throw Error('Initial proposal outcome unknown');
    return Response.json({ error: token }, { status: init?.method === 'GET' ? 404 : 403 });
  });
  expect((await f.plan()).ok).toBe(false);
  const recovered = await f.plan(); expect(recovered.ok).toBe(false);
  expect(methods).toEqual(['POST', 'GET', 'POST']);
  expect(f.ctx.repos.runs.findByProjectId(f.project.id)).toEqual([]);
  expect(JSON.stringify(recovered)).not.toContain(token); expect(f.adapters).not.toHaveBeenCalled();
});
it.each(['review-required', 'ready', 'pending'] as const)('never recreates an observed %s proposal after 404', async state => {
  const f = fixture(); expect((await f.setSpec()).ok).toBe(true);
  if (state !== 'review-required') { f.ready(); f.setRemote({ status: state }); }
  expect((await f.plan()).ok).toBe(true);
  f.network.mockImplementationOnce(async () => Response.json({ error: 'Not found' }, { status: 404 }));
  const before = f.network.mock.calls.length;
  expect((await f.plan()).ok).toBe(false);
  expect(f.network.mock.calls.slice(before).map(([, init]) => init?.method)).toEqual(['GET']);
  expect(f.adapters).not.toHaveBeenCalled();
});
