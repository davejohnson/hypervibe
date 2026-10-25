import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';

// Reconstructed Google OAuth and Resource Manager v3 serialized responses.
// https://cloud.google.com/resource-manager/reference/rest/v3/projects/create
// A project create is a non-idempotent allocation returning an LRO. A 403 GET
// is unknown existence; only the completed, correlated native LRO establishes
// this versioned allocation's ownership. No billing or other resources follow.
const nativeId = 'operator-empty-project';
const number = '987654321012';
const token = 'synthetic-local-allocation-token';

describe('local empty cloud project through ordinary spec/plan/apply', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-local-scope-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    const adc = path.join(directory, 'adc.json');
    writeFileSync(adc, JSON.stringify({ type: 'authorized_user', client_id: 'synthetic-client',
      client_secret: 'synthetic-secret', refresh_token: 'synthetic-refresh' }), { mode: 0o600 });
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', adc);
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

  function fixture(options: { lostAck?: boolean; pending?: boolean; denied?: boolean; existing?: boolean; noEnvironment?: boolean } = {}) {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'operator-host', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator-host.git' });
    if (!options.noEnvironment) ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'cloudrun' } });
    const store = new SpecStore();
    const desired = { version: 1, project: project.name, environments: { staging: {
      hosting: { provider: 'cloudrun', scopePreparation: { schemaVersion: 1, authentication: 'local-default',
        nativeScope: { scopeKind: 'project-allocation', allocationMode: 'create-exclusive-v1', projectId: nativeId, displayName: 'Operator empty project' } } },
      services: { web: {} }, email: { enabled: false },
    } } };
    store.replace(project, desired);
    let live: Record<string, unknown> | null = options.existing ? { name: `projects/${number}`, projectId: nativeId,
      state: 'ACTIVE', createTime: '2026-10-24T00:00:00Z', labels: {} } : null;
    let completed = !options.pending;
    const writes: Array<{ url: string; body: unknown }> = [];
    const calls: string[] = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET'; calls.push(`${method} ${url}`);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      if (url === 'https://cloudresourcemanager.googleapis.com/v3/projects' && method === 'POST') {
        const body = JSON.parse(String(init?.body)); writes.push({ url, body });
        live = { name: `projects/${number}`, projectId: nativeId, displayName: 'Operator empty project', state: 'ACTIVE',
          createTime: '2026-10-25T08:00:00.123456Z', labels: body.labels };
        if (options.lostAck) throw new Error(`lost response ${token}`);
        return Response.json({ name: 'operations/create-operator-project', done: false });
      }
      if (url === 'https://cloudresourcemanager.googleapis.com/v3/operations/create-operator-project') return Response.json(completed
        ? { name: 'operations/create-operator-project', done: true, response: { '@type': 'type.googleapis.com/google.cloudresourcemanager.v3.Project', ...live } }
        : { name: 'operations/create-operator-project', done: false });
      if (url === `https://cloudresourcemanager.googleapis.com/v3/projects/${nativeId}` || url === `https://cloudresourcemanager.googleapis.com/v3/projects/${number}`)
        return live ? Response.json(live) : Response.json({}, { status: options.denied ? 403 : 404 });
      throw new Error('Unexpected synthetic allocation endpoint');
    });
    vi.stubGlobal('fetch', request);
    const adapters = vi.spyOn(adapterFactory, 'getProviderAdapter');
    const plan = () => new PlanService().plan(project, 'staging');
    const apply = async (planId: string, confirmActions: string[] = ['gcp:project']) => {
      const current = store.get(project)!;
      return executePlanApply(ctx, { project, spec: current.spec, specRevision: current.revision, planId, confirmActions });
    };
    return { ctx, project, store, desired, writes, calls, request, adapters, plan, apply,
      complete: () => { completed = true; }, replaceLive: (value: Record<string, unknown> | null) => { live = value; } };
  }

  it('allocates only the confirmed empty project without a connection or prior environment', async () => {
    const f = fixture({ noEnvironment: true, denied: true });
    const first = await f.plan();
    expect(first).toMatchObject({ scope: 'cloud-scope', actions: [{ id: 'gcp:project', type: 'create', requiresConfirm: true }] });
    if ('error' in first) throw new Error(first.error);
    expect(f.adapters).not.toHaveBeenCalled();
    expect(await f.apply(first.planRunId, [])).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.writes).toEqual([]);
    const second = await f.plan(); if ('error' in second) throw new Error(second.error);
    const applied = await f.apply(second.planRunId);
    expect(applied, JSON.stringify({ applied, calls: f.calls })).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toHaveLength(1);
    expect(f.calls.some(call => /billing|serviceusage|iam\.googleapis|run\.googleapis/.test(call))).toBe(false);
    expect(f.adapters).not.toHaveBeenCalled();
    expect(f.ctx.repos.connections.findByProvider('cloudrun')).toBeNull();
    const environment = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')!;
    expect(environment.platformBindings).toEqual({ provider: 'cloudrun' });
    expect(await f.plan()).toMatchObject({ scope: 'cloud-scope', actions: [] });
  });

  it('reconciles a retained native operation after restart without another project create', async () => {
    const f = fixture({ pending: true }); const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    expect(await f.apply(first.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    f.complete();
    const second = await f.plan(); if ('error' in second) throw new Error(second.error);
    expect(second).toMatchObject({ scope: 'cloud-scope' });
    const recovered = await f.apply(second.planRunId);
    expect(recovered, JSON.stringify({ recovered, calls: f.calls })).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toHaveLength(1);
  });

  it('retains a lost acknowledgment and vetoes a replacement target after desired source changes', async () => {
    const f = fixture({ lostAck: true }); const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    expect(await f.apply(first.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    const next = structuredClone(f.desired); next.environments.staging.hosting.scopePreparation.nativeScope.projectId = 'different-empty-project';
    f.store.replace(f.project, next); f.replaceLive(null);
    const recovery = await f.plan(); if ('error' in recovery) throw new Error(recovery.error);
    expect(recovery).toMatchObject({ scope: 'cloud-scope' });
    expect(await f.apply(recovery.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.writes).toHaveLength(1);
    expect(JSON.stringify(recovery)).not.toContain(token);
  });

  it('does not adopt a visible existing project', async () => {
    const f = fixture({ existing: true }); const planned = await f.plan();
    expect('error' in planned || planned.blocked.length > 0).toBe(true);
    expect(f.writes).toEqual([]); expect(f.adapters).not.toHaveBeenCalled();
  });

  it('revalidates source at the native write boundary', async () => {
    const f = fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith(`/projects/${nativeId}`)) {
        const changed = structuredClone(f.desired); changed.environments.staging.hosting.scopePreparation.nativeScope.displayName = 'Changed review';
        f.store.replace(f.project, changed);
      }
      return response;
    });
    expect(await f.apply(planned.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.writes).toEqual([]);
  });

  it('rejects a forged extra action before any native request', async () => {
    const f = fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    const run = f.ctx.repos.runs.findById(planned.planRunId)!; const document = structuredClone(run.plan) as any;
    document.actions.push({ ...document.actions[0], id: 'unreviewed', resource: { kind: 'service', name: 'web', provider: 'cloudrun' } });
    f.ctx.repos.runs.updatePlan(run.id, document); f.request.mockClear();
    expect(await f.apply(planned.planRunId)).toMatchObject({ kind: 'plan_not_found' });
    expect(f.request).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });

  it('uses the normal command envelope without exposing a local token', async () => {
    const f = fixture(); const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
    const result = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { scope: 'cloud-scope' } });
    expect(result.data).toMatchObject({ cloudScopeReview: { permissions: [expect.objectContaining({ actions: ['resourcemanager.projects.create'] })],
      costs: [expect.objectContaining({ resource: nativeId, pricingUrl: 'https://cloud.google.com/pricing' })] } });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-local-allocation-token|synthetic-refresh|synthetic-secret/);
    expect(result.data).not.toHaveProperty('localEnv');
    const applied = await registry.execute('hv_apply', { project: f.project.name, planId: (result.data as any).planId, confirmActions: ['gcp:project'] });
    expect(applied).toMatchObject({ ok: true, data: { applied: true } });
    expect(applied.hint).toMatch(/empty.*project/i);
    const next = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(next.hint).toMatch(/empty.*project/i);
    expect(next.hint).not.toContain('Everything is in sync');
    const status = await registry.execute('hv_status', { project: f.project.name, env: 'staging' });
    expect(status).toMatchObject({ ok: true, data: { scope: 'cloud-scope', allocationComplete: true, hostingReady: false } });
  });

  it.each(['azure-container-apps', 'unsupported-local-review'])('recovers the historical operation after current hosting changes to %s', async provider => {
    const f = fixture({ pending: true }); const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    await f.apply(first.planRunId);
    const changed = structuredClone(f.desired) as any; changed.environments.staging.hosting = { provider };
    f.store.replace(f.project, changed);
    const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
    const recovery = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(recovery, JSON.stringify(recovery)).toMatchObject({ ok: true, data: { scope: 'cloud-scope' } });
    f.complete();
    const applied = await registry.execute('hv_apply', { project: f.project.name, planId: (recovery.data as any).planId });
    expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true, data: { applied: true } });
    expect(f.writes).toHaveLength(1); expect(f.adapters).not.toHaveBeenCalled();
  });

  it('rechecks the running apply lease after an asynchronous native read before any write', async () => {
    const f = fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith(`/projects/${nativeId}`)) {
        const run = f.ctx.repos.runs.findByStatus('running').find(item => item.type === 'apply');
        if (run) f.ctx.repos.runs.updateStatus(run.id, 'cancelled');
      }
      return response;
    });
    expect(await f.apply(planned.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.writes).toEqual([]);
  });

  it('reports project-only status without treating it as a hosting connection', async () => {
    const f = fixture(); const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    await f.apply(first.planRunId);
    const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
    const status = await registry.execute('hv_status', { project: f.project.name, env: 'staging' });
    expect(status, JSON.stringify(status)).toMatchObject({ ok: true, data: { scope: 'cloud-scope', allocationComplete: true, hostingReady: false } });
    expect(f.adapters).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(1);
  });

  it('keeps a formerly complete allocation isolated when source removes it and native authority is lost', async () => {
    const f = fixture(); const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    await f.apply(first.planRunId);
    const changed = structuredClone(f.desired) as any; changed.environments.staging.hosting = { provider: 'unsupported-local-review' };
    f.store.replace(f.project, changed);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input, init) => String(input).endsWith(`/projects/${nativeId}`)
      ? Promise.resolve(Response.json({}, { status: 403 })) : original(input, init));
    const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
    const result = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { scope: 'cloud-scope' } });
    expect(result.data).not.toHaveProperty('localEnv');
    expect(f.adapters).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(1);
  });

  it('keeps native field validation provider-owned and rejects a billing field', async () => {
    const f = fixture(); const changed = structuredClone(f.desired) as any;
    changed.environments.staging.hosting.scopePreparation.nativeScope.billingAccountName = 'billingAccounts/111111-222222-333333';
    f.store.replace(f.project, changed);
    expect(await f.plan()).toHaveProperty('error'); expect(f.writes).toEqual([]);
    expect(projectSpecSchema.safeParse({ ...changed, environments: { staging: { ...changed.environments.staging,
      hosting: { provider: 'cloudrun', scopePreparation: { ...changed.environments.staging.hosting.scopePreparation, credentials: 'not-allowed' } } } } }).success).toBe(false);
  });

  it.each(['secrets', 'secret-destinations', 'database-credential-aliases', 'retained-cleanup'] as const)(
    'preserves an explicit %s scope instead of substituting cloud project creation', async scope => {
      const f = fixture({ noEnvironment: true }); const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
      const result = await registry.execute('hv_plan', { project: f.project.name, env: 'staging', scope });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      expect(result.error?.message).toContain('full');
      expect(f.request).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
      expect(f.ctx.repos.runs.findByProjectId(f.project.id)).toEqual([]);
      expect(f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')).toBeNull();
      const full = await registry.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'full' });
      expect(full).toMatchObject({ ok: true, data: { scope: 'cloud-scope', actions: [expect.objectContaining({ id: 'gcp:project' })] } });
    });
});
