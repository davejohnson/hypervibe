import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../src/adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../src/adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../src/adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../src/adapters/db/repositories/run.repository.js';
import { createAzureDisposableProbeSpec, planAzureDisposableProbe, applyAzureDisposableProbe,
  planAzureDisposableProbeCleanup } from './helpers/azure-disposable-probe-lifecycle.js';

// Reconstructed official ARM resource shapes. Transport state is synthetic; these
// tests prove action/attempt safety, never Azure support for conditional PUT.
const subscriptionId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const nativeProjectId = '44444444-4444-4444-8444-444444444444';
const authorizationOriginDigest = 'a'.repeat(64);
let directory: string; let projectId: string; let environmentId: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-azure-probe-test-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'journal.db')).migrate();
  projectId = new ProjectRepository().create({ name: 'disposable-native-probe' }).id;
  environmentId = new EnvironmentRepository().create({ projectId, name: 'ownership-proof' }).id;
});
afterEach(() => { SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
const spec = () => createAzureDisposableProbeSpec({ operationId, sourceProjectId: nativeProjectId,
  subscriptionId, tenantId, authorizationOriginDigest, location: 'canadacentral', environment: 'ownership-proof' });
function transport(options: { ignoreHeader?: boolean; loseFirstWrite?: boolean; loseIdentityWrite?: boolean;
  denyIdentityRead?: boolean; replaceIdentity?: boolean; revoke?: () => void } = {}) {
  const state = new Map<string, any>(); const writes: Array<{ id: string; method: string; headers: Headers }> = [];
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const id = new URL(String(url)).pathname; const method = init?.method ?? 'GET';
    if (method === 'GET') {
      options.revoke?.();
      if (options.denyIdentityRead && id.includes('/userAssignedIdentities/'))
        return Response.json({ error: { code: 'AuthorizationFailed' } }, { status: 403 });
      if (id.endsWith('/resources')) return Response.json({ value: [...state.values()].filter(item => item.id !== id.slice(0, -10)) });
      return state.has(id) ? Response.json({ ...state.get(id), providerEcho: 'DO-NOT-PERSIST' })
        : Response.json({ error: { code: 'ResourceNotFound' } }, { status: 404 });
    }
    const headers = new Headers(init?.headers); writes.push({ id, method, headers });
    if (method === 'DELETE') { state.delete(id); return new Response(null, { status: 204 }); }
    if (headers.get('if-none-match') === '*' && !options.ignoreHeader && state.has(id)) {
      if (options.replaceIdentity && id.includes('/userAssignedIdentities/'))
        state.get(id).properties.principalId = '77777777-7777-4777-8777-777777777777';
      return Response.json({ error: { code: 'PreconditionFailed', message: 'DO-NOT-PERSIST' } }, { status: 412 });
    }
    const body = JSON.parse(String(init?.body));
    const prior = state.get(id);
    const resource = { ...body, id, name: id.split('/').at(-1), type: id.includes('/userAssignedIdentities/')
      ? 'Microsoft.ManagedIdentity/userAssignedIdentities' : id.includes('/vaults/') ? 'Microsoft.KeyVault/vaults' : 'Microsoft.Resources/resourceGroups',
    properties: { ...body.properties, provisioningState: 'Succeeded', ...(id.includes('/userAssignedIdentities/') ? {
      clientId: '55555555-5555-4555-8555-555555555555', principalId: '66666666-6666-4666-8666-666666666666', tenantId,
    } : {}) }, systemData: { createdAt: prior?.systemData.createdAt ?? '2026-10-25T00:00:00Z' } };
    state.set(id, resource);
    if (options.loseFirstWrite && writes.length === 1 || options.loseIdentityWrite && !prior && id.includes('/userAssignedIdentities/'))
      throw new Error('DO-NOT-PERSIST token');
    return Response.json({ ...resource, providerEcho: 'DO-NOT-PERSIST' }, { status: prior ? 200 : 201 });
  }) as unknown as typeof fetch;
  return { request, state, writes };
}
async function planned() { return planAzureDisposableProbe({ projectId, environmentId, spec: spec() }); }
function access(t: ReturnType<typeof transport>, authorize = async () => true) {
  return { authorizationOriginDigest, fetch: t.request, getAccessToken: async () => 'synthetic-transient-token', authorize };
}
describe('disposable Azure probes through the real saved-plan executor', () => {
  it('persists exact synthetic targets and confirmation gates without any native call', async () => {
    const plan = await planned();
    expect(plan.actions).toHaveLength(9);
    expect(plan.actions.every(action => action.requiresConfirm && action.metadata?.authority === 'explicit-disposable-upsert')).toBe(true);
    const t = transport();
    const result = await applyAzureDisposableProbe({ ...access(t), planId: plan.id, planDigest: plan.digest, confirmActions: [] });
    expect(result.success).toBe(false); expect(t.request).not.toHaveBeenCalled();
  });
  it('records one durable attempt per exact action and proves 412 with unchanged native lifetime', async () => {
    const plan = await planned(); const t = transport();
    const result = await applyAzureDisposableProbe({ ...access(t), planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    expect(result.success).toBe(true); expect(t.writes).toHaveLength(9);
    expect(result.receipts.filter(receipt => receipt.data?.guard === 'verified')).toHaveLength(3);
    const journal = JSON.stringify(new RunRepository().findByEnvironmentId(environmentId));
    expect(journal).toContain('attempted'); expect(journal).not.toContain('DO-NOT-PERSIST');
    expect(journal).not.toContain('synthetic-transient-token');
  });
  it('does not mistake a successful same-body upsert for conditional rejection', async () => {
    const plan = await planned(); const t = transport({ ignoreHeader: true });
    const result = await applyAzureDisposableProbe({ ...access(t), planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    expect(result.success).toBe(true);
    expect(result.receipts.filter(receipt => receipt.data?.guard === 'not-supported')).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('"guard":"verified"');
  });
  it('rejects an exact GUID-shaped bearer echoed as a native lifetime before receipt persistence', async () => {
    const token = '55555555-5555-4555-8555-555555555555'; // also the reconstructed native clientId
    const plan = await planned(); const t = transport();
    const result = await applyAzureDisposableProbe({ ...access(t), getAccessToken: async () => token,
      planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    expect(result.success).toBe(false);
    expect(JSON.stringify(new RunRepository().findByEnvironmentId(environmentId))).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('never replays an unacknowledged create after a new invocation', async () => {
    const plan = await planned(); const t = transport({ loseFirstWrite: true });
    const input = { ...access(t), planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) };
    expect((await applyAzureDisposableProbe(input)).receipts[0]?.status).toBe('pending');
    expect((await applyAzureDisposableProbe(input)).receipts[0]?.status).toBe('pending');
    expect(t.writes).toHaveLength(1);
    expect(t.state.size).toBe(1); // native side effect happened; name/tag read cannot repair the missing acknowledgment
    await expect(planAzureDisposableProbeCleanup({ projectId, environmentId, preparationPlanId: plan.id })).rejects.toThrow('probe_ownership_unverified');
  });
  it('does not accept 412 when the native principal changed before readback', async () => {
    const plan = await planned(); const t = transport({ replaceIdentity: true });
    const result = await applyAzureDisposableProbe({ ...access(t), planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    expect(result.success).toBe(false);
    expect(result.receipts.find(receipt => receipt.actionId === 'probe:identity:conditional')?.status).toBe('pending');
    expect(t.writes.some(write => write.id.includes('/vaults/'))).toBe(false);
  });
  it('rejects a different plan digest before any native read or write', async () => {
    const plan = await planned(); const t = transport();
    await expect(applyAzureDisposableProbe({ ...access(t), planId: plan.id, planDigest: 'f'.repeat(64),
      confirmActions: plan.actions.map(a => a.id) })).rejects.toThrow('probe_plan_mismatch');
    expect(t.request).not.toHaveBeenCalled();
  });
  it('rejects a different private login-origin configuration before any native access', async () => {
    const plan = await planned(); const t = transport();
    const input = { ...access(t), planId: plan.id, planDigest: plan.digest,
      authorizationOriginDigest: 'f'.repeat(64), confirmActions: plan.actions.map(a => a.id) };
    await expect(applyAzureDisposableProbe(input)).rejects.toThrow('probe_origin_mismatch');
    expect(t.request).not.toHaveBeenCalled();
  });
  it('rechecks approval after native reads before dispatch', async () => {
    let approved = true; const t = transport({ revoke: () => { approved = false; } }); const plan = await planned();
    const result = await applyAzureDisposableProbe({ ...access(t, async () => approved), planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    expect(result.success).toBe(false); expect(t.writes).toHaveLength(0);
  });
  it('rechecks the saved apply lease after an asynchronous authorization callback', async () => {
    const plan = await planned(); const t = transport(); let checks = 0;
    const authorize = async () => {
      if (++checks === 3) {
        const running = new RunRepository().findByEnvironmentId(environmentId).find(run => run.type === 'apply' && run.status === 'running')!;
        new RunRepository().updateStatus(running.id, 'cancelled');
      }
      return true;
    };
    const result = await applyAzureDisposableProbe({ ...access(t, authorize), planId: plan.id,
      planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    expect(result.success).toBe(false); expect(t.writes).toHaveLength(0);
  });
  it('refuses a pre-existing lookalike before synthetic fixture preparation', async () => {
    const t = transport(); const plan = await planned();
    t.state.set(spec().resources.group.id, { id: spec().resources.group.id, location: 'canadacentral', tags: { unrelated: 'owner' } });
    const result = await applyAzureDisposableProbe({ ...access(t), planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    expect(result.success).toBe(false); expect(t.writes).toHaveLength(0);
  });
  it('requires separately reviewed exact cleanup and confirms terminal absence in dependency order', async () => {
    const t = transport(); const plan = await planned();
    await applyAzureDisposableProbe({ ...access(t), planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    const cleanup = await planAzureDisposableProbeCleanup({ projectId, environmentId, preparationPlanId: plan.id });
    expect(cleanup.actions.map(action => action.type)).toEqual(['destroy', 'destroy', 'destroy']);
    const result = await applyAzureDisposableProbe({ ...access(t), planId: cleanup.id, planDigest: cleanup.digest, confirmActions: cleanup.actions.map(a => a.id) });
    expect(result.success).toBe(true);
    expect(t.writes.filter(write => write.method === 'DELETE').map(write => write.id)).toEqual([
      spec().resources.vault.id, spec().resources.identity.id, spec().resources.group.id,
    ]);
    expect(t.state.size).toBe(0);
  });
  it('can clean the independently completed group after a later pre-write observation failure', async () => {
    const t = transport({ denyIdentityRead: true }); const plan = await planned();
    const prepared = await applyAzureDisposableProbe({ ...access(t), planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    expect(prepared.success).toBe(false); expect(t.state.size).toBe(1);
    const cleanup = await planAzureDisposableProbeCleanup({ projectId, environmentId, preparationPlanId: plan.id });
    expect(cleanup.actions.map(action => action.id)).toEqual(['probe:group:delete']);
    const result = await applyAzureDisposableProbe({ ...access(t), planId: cleanup.id, planDigest: cleanup.digest, confirmActions: cleanup.actions.map(a => a.id) });
    expect(result.success).toBe(true); expect(t.state.size).toBe(0);
  });
  it('blocks partial cleanup while a later identity write has an unknown outcome', async () => {
    const t = transport({ loseIdentityWrite: true }); const plan = await planned();
    const prepared = await applyAzureDisposableProbe({ ...access(t), planId: plan.id, planDigest: plan.digest, confirmActions: plan.actions.map(a => a.id) });
    expect(prepared.success).toBe(false); expect(t.state.size).toBe(2);
    await expect(planAzureDisposableProbeCleanup({ projectId, environmentId, preparationPlanId: plan.id })).rejects.toThrow('probe_ownership_unverified');
    expect(t.writes.some(write => write.method === 'DELETE')).toBe(false);
  });
});
