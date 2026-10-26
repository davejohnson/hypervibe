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
import { localCloudScopeRequired } from '../../domain/services/local-cloud-scope.service.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
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
        ? { name: 'operations/create-operator-project', done: true, response: { '@type': 'type.googleapis.com/google.cloud.resourcemanager.v3.Project', ...live } }
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
    expect(applied.hint).toMatch(/preparation stage is verified/);
    expect(applied.data).toMatchObject({ receipts: [expect.objectContaining({ message: expect.stringMatching(/empty project allocation/) })] });
    const next = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(next.hint).toMatch(/preparation stage is verified/);
    expect(next.hint).not.toContain('Everything is in sync');
    const status = await registry.execute('hv_status', { project: f.project.name, env: 'staging' });
    expect(status).toMatchObject({ ok: true, data: { scope: 'cloud-scope', allocationComplete: true, hostingReady: false } });
  });

  it.each(['ready', 'pending', 'forbidden'] as const)('distinguishes the immutable approval review from current %s observations in both command warning surfaces', async state => {
    // Product evidence: approval history is immutable, but a later native read
    // determines current readiness. A historical GET403 cannot remain a present
    // blocker after success, or conceal a newly denied read after success.
    const f = fixture({ denied: true, pending: state === 'pending' });
    const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
    const first = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(first.ok).toBe(true);
    const firstData = first.data as any;
    const savedPlan = f.ctx.repos.runs.findById(firstData.planId)!.plan as any;
    const installationId = savedPlan.cloudScope.installationId;
    const approval = structuredClone((f.ctx.repos.runs.findById(installationId)!.plan as any).plan);
    expect(firstData.cloudScopeReview.warnings).toEqual(approval.review.warnings);
    expect(firstData.cloudScopeReview.warnings.join(' ')).toMatch(/lookup is unknown|creation authority is unverified/);
    await registry.execute('hv_apply', { project: f.project.name, planId: firstData.planId, confirmActions: ['gcp:project'] });
    if (state === 'forbidden') {
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation((input, init) => String(input).endsWith(`/projects/${nativeId}`)
        ? Promise.resolve(Response.json({}, { status: 403 })) : original(input, init));
    }
    const next = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(next.ok).toBe(true);
    const data = next.data as any;
    const historical = approval.review.warnings.map((warning: string) => `Historical approval review: ${warning}`);
    expect(data.cloudScopeReview.warnings).toEqual(historical);
    expect(next.warnings).toEqual(expect.arrayContaining(historical));
    for (const warning of approval.review.warnings) expect(next.warnings).not.toContain(warning);
    expect((f.ctx.repos.runs.findById(installationId)!.plan as any).plan).toEqual(approval);
    const status = await registry.execute('hv_status', { project: f.project.name, env: 'staging' });
    expect(status).toMatchObject({ ok: true, data: { allocationComplete: state === 'ready', verified: state === 'ready', hostingReady: false } });
    if (state === 'ready') {
      expect(data.actions).toEqual([]);
      expect(next.warnings?.some(warning => warning.startsWith('The retained allocation reports '))).toBe(false);
    } else {
      expect(data.actions).toMatchObject([{ type: 'update', requiresConfirm: false }]);
      expect(next.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^The retained allocation reports /)]));
      expect(await f.apply(data.planId, [])).toMatchObject({ kind: 'executed', result: { success: false } });
    }
    expect(f.writes).toHaveLength(1);
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
  it.each(['rejected', 'ready', 'project-read-denied', 'project-lifetime-replaced'] as const)('reports the allocated project separately from billing preparation: %s', async scenario => {
    // Independent evidence: Plan Honesty requires stage-specific partial progress;
    // the observed live initial-assignment PUT returned HTTP 400 while a later
    // exact ProjectBillingInfo read reported no association. Its error body was
    // not retained, so this reconstruction deliberately supplies no native cause.
    // https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/updateBillingInfo
    // https://docs.cloud.google.com/billing/docs/reference/rest/v1/ProjectBillingInfo
    const f = fixture(); const allocated = await f.plan(); if ('error' in allocated) throw new Error(allocated.error);
    expect(await f.apply(allocated.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    const desired = structuredClone(f.desired) as any;
    desired.environments.staging.hosting.scopePreparation.continuation = { nativeScope: {
      scopeKind: 'operator-hosting-v1', billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC',
    } };
    f.store.replace(f.project, desired);
    const base = f.request.getMockImplementation()!;
    let billing = false; let billingWrites = 0; let invalidateProject = false;
    f.request.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); const method = init?.method ?? 'GET';
      if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: [
        'billing.accounts.get', 'billing.resourceAssociations.create', 'resourcemanager.projects.get',
        'resourcemanager.projects.createBillingAssignment', 'serviceusage.services.list', 'serviceusage.effectivepolicy.get',
      ] });
      if (url.host === 'cloudbilling.googleapis.com') {
        if (url.pathname === '/v1/billingAccounts/ABCDEF-123456-789ABC') return Response.json({ name: 'billingAccounts/ABCDEF-123456-789ABC', open: true });
        expect(url.pathname).toBe(`/v1/projects/${nativeId}/billingInfo`);
        if (method === 'PUT') {
          expect(JSON.parse(String(init?.body))).toEqual({ billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' });
          billingWrites++;
          if (scenario !== 'ready') return new Response(null, { status: 400 });
          billing = true;
        }
        return Response.json({ name: `projects/${nativeId}/billingInfo`, projectId: nativeId,
          billingAccountName: billing ? 'billingAccounts/ABCDEF-123456-789ABC' : '', billingEnabled: billing });
      }
      const response = await base(input, init);
      if (invalidateProject && url.pathname === `/v3/projects/${nativeId}`) {
        if (scenario === 'project-read-denied') return Response.json({}, { status: 403 });
        if (scenario === 'project-lifetime-replaced') return Response.json({ ...await response.json() as Record<string, unknown>, createTime: '2026-10-25T09:00:00Z' });
      }
      return response;
    });
    const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
    const planned = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(planned).toMatchObject({ ok: true, data: { actions: [{ id: 'gcp:billing:initial-assignment-v1' }] } });
    const applied = await registry.execute('hv_apply', { project: f.project.name, planId: (planned.data as any).planId,
      confirmActions: ['gcp:billing:initial-assignment-v1'] });
    expect(applied).toMatchObject({ ok: true, data: { applied: scenario === 'ready' } });
    if (scenario === 'ready') expect.soft(applied.hint).not.toMatch(/Billing, API enablement and hosting still require/);
    if (scenario !== 'ready') {
      const receipt = (applied.data as any).receipts[0];
      expect(receipt).toMatchObject({ status: 'blocked', data: { reason: 'provider_error' } });
      expect.soft(receipt.message).toMatch(/preparation action.*gcp:billing:initial-assignment-v1/);
      expect.soft(receipt.message).not.toMatch(/project allocation is unresolved/);
    }
    invalidateProject = true;
    const status = await registry.execute('hv_status', { project: f.project.name, env: 'staging' });
    const allocationComplete = !scenario.startsWith('project-');
    expect.soft(status).toMatchObject({ ok: true, data: { allocationComplete, verified: scenario === 'ready', hostingReady: false } });
    expect.soft(status.hint).toContain('gcp:billing:initial-assignment-v1');
    expect.soft(status.hint).not.toMatch(/Billing and hosting have not been configured|saved cloud project allocation still needs review/);
    if (scenario === 'rejected') {
      expect.soft((status.data as any).resources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'project', id: `projects/${number}` })]));
      const recovery = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
      expect(recovery.ok).toBe(true);
      expect.soft(recovery.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^The retained preparation stage reports /)]));
      expect.soft(recovery.warnings?.join(' ')).not.toMatch(/The retained allocation reports /);
      await registry.execute('hv_apply', { project: f.project.name, planId: (recovery.data as any).planId });
    }
    if (scenario === 'ready') {
      // Removing the next-stage selection does not erase verified billing.
      delete desired.environments.staging.hosting.scopePreparation.continuation;
      f.store.replace(f.project, desired);
      const complete = await registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
      expect(complete).toMatchObject({ ok: true, data: { actions: [] } });
      expect.soft(complete.hint).not.toMatch(/Billing, API enablement and hosting still require/);
    }
    expect(billingWrites).toBe(1); expect(f.writes).toHaveLength(1);
    expect(JSON.stringify({ applied, status })).not.toContain(token);
  });

  it.each(['normal', 'lost-api-ack', 'unknown-api-state', 'changed-billing-selection', 'conflicting-connection', 'github-ci-disconnect', 'github-ci-lost-ack', 'public-registry', 'public-grant-lost-ack', 'github-ci-public-registry'] as const)('continues reviewed stages with exact environment isolation and safe recovery: %s', async scenario => {
    const f = fixture(); const allocated = await f.plan(); if ('error' in allocated) throw new Error(allocated.error);
    expect(await f.apply(allocated.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    const desired = structuredClone(f.desired) as any;
    desired.environments.staging.hosting.scopePreparation.continuation = { nativeScope: { scopeKind: 'operator-hosting-v1', billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' } };
    f.store.replace(f.project, desired);
    const github = scenario.startsWith('github-ci');
    const publicImages = scenario.includes('public-');
    if (publicImages) { desired.environments.staging.hosting.scopePreparation.continuation.nativeScope.publicArtifactRepository = 'operator-public'; f.store.replace(f.project, desired); }
    if (github) {
      Object.assign(desired.environments.staging.hosting.scopePreparation.continuation.nativeScope, { githubRepository: 'acme/operator-host',
        githubRepositoryId: '123456789', githubRepositoryOwnerId: '987654321', githubBranch: 'main',
        githubWorkflow: '.github/workflows/deploy-cloudrun-staging.yml', githubBackupWorkflow: '.github/workflows/hypervibe-backup-staging.yml' });
      f.store.replace(f.project, desired);
    }
    const native = new Map<string, any>(), operations = new Map<string, any>(); let lostCiAck = false;
    const unrelated = { role: 'roles/viewer', members: ['user:unrelated@example.invalid'], condition: { title: 'retained', expression: 'true' } };
    const projectPolicy = { version: 3, etag: 'project-etag', bindings: [unrelated] } as any;
    const accountPolicy = { version: 3, etag: 'account-etag', bindings: [] } as any;
    const registryPolicy = { version: 3, etag: 'registry-etag', bindings: [unrelated] } as any;
    const publicPolicy = { version: 3, etag: 'public-etag', bindings: [unrelated] } as any;
    const registries = new Map<string, Record<string, unknown>>(); let lostPublicAck = false;
    const base = f.request.getMockImplementation()!; let billing = false; let apis = false; const writes: string[] = [];
    f.request.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); const method = init?.method ?? 'GET';
      if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: ['billing.accounts.get', 'billing.resourceAssociations.create',
        'resourcemanager.projects.get', 'resourcemanager.projects.createBillingAssignment', 'serviceusage.services.list',
        'serviceusage.effectivepolicy.get', 'serviceusage.services.get', 'serviceusage.services.enable',
        'artifactregistry.repositories.get', 'artifactregistry.repositories.create', 'artifactregistry.repositories.setIamPolicy', 'artifactregistry.repositories.getIamPolicy',
        'iam.workloadIdentityPools.create', 'iam.workloadIdentityPoolProviders.create', 'iam.serviceAccounts.create', 'iam.serviceAccounts.setIamPolicy',
        'iam.roles.create', 'resourcemanager.projects.setIamPolicy'] });
      if (url.pathname.endsWith(':getIamPolicy')) return Response.json(url.host === 'iam.googleapis.com' ? accountPolicy
        : url.host === 'artifactregistry.googleapis.com' ? (url.pathname.includes('/operator-public:') ? publicPolicy : registryPolicy) : projectPolicy);
      if (url.pathname.endsWith(':setIamPolicy')) {
        const target = url.host === 'iam.googleapis.com' ? accountPolicy : url.host === 'artifactregistry.googleapis.com' ? (url.pathname.includes('/operator-public:') ? publicPolicy : registryPolicy) : projectPolicy;
        const body = JSON.parse(String(init?.body)); expect(body.policy.etag).toBe(target.etag);
        Object.assign(target, body.policy, { etag: target.etag + '-next' }); writes.push(target === publicPolicy ? 'public-iam-policy' : 'iam-policy');
        if (target === publicPolicy && scenario === 'public-grant-lost-ack' && !lostPublicAck) { lostPublicAck = true; throw new Error('synthetic lost public policy acknowledgment'); }
        return Response.json(target);
      }
      if (url.host === 'iam.googleapis.com') {
        const name = url.pathname.replace('/v1/', '');
        if (method !== 'POST') return Response.json(operations.get(name) ?? native.get(name) ?? {}, { status: operations.has(name) || native.has(name) ? 200 : 404 });
        const body = JSON.parse(String(init?.body)); writes.push('ci-identity');
        if (name.endsWith('/workloadIdentityPools') || name.endsWith('/providers')) {
          const id = url.searchParams.get('workloadIdentityPoolId') ?? url.searchParams.get('workloadIdentityPoolProviderId');
          const resource = `${name}/${id}`, operation = `${resource}/operations/synthetic-operation`;
          native.set(resource, { ...body, name: resource, state: 'ACTIVE' }); operations.set(operation, { name: operation, done: true });
          if (!lostCiAck && scenario === 'github-ci-lost-ack' && name.endsWith('/workloadIdentityPools')) { lostCiAck = true; throw new Error(`lost WIF acknowledgment ${token}`); }
          return Response.json({ name: operation, done: false });
        }
        if (name.endsWith('/serviceAccounts')) {
          const email = `${body.accountId}@${nativeId}.iam.gserviceaccount.com`, resource = `${name}/${email}`;
          const account = { ...body.serviceAccount, name: resource, email, projectId: nativeId, uniqueId: '123456789012345678901', disabled: false };
          native.set(resource, account); return Response.json(account);
        }
        if (name.endsWith('/roles')) { const role = { ...body.role, name: `${name}/${body.roleId}` }; native.set(role.name, role); return Response.json(role); }
        throw new Error('Unexpected reconstructed CI identity mutation');
      }
      if (url.host === 'cloudbilling.googleapis.com') {
        if (url.pathname === '/v1/billingAccounts/ABCDEF-123456-789ABC') return Response.json({ name: 'billingAccounts/ABCDEF-123456-789ABC', open: true });
        if (method === 'PUT') { expect(JSON.parse(String(init?.body))).toEqual({ billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' }); billing = true; writes.push('billing'); }
        return Response.json({ name: `projects/${nativeId}/billingInfo`, projectId: nativeId, billingAccountName: billing ? 'billingAccounts/ABCDEF-123456-789ABC' : '', billingEnabled: billing });
      }
      if (url.host === 'serviceusage.googleapis.com') {
        if (method === 'POST') { expect(url.pathname).toBe(`/v1/projects/${number}/services:batchEnable`); apis = true; writes.push('apis'); if (scenario === 'lost-api-ack') throw new Error(`Lost acknowledgment ${token}`); return Response.json({ name: 'operations/acf.synthetic' }); }
        if (scenario === 'unknown-api-state') return Response.json({}, { status: 403 });
        return Response.json({ name: url.pathname.replace('/v1/', ''), state: apis ? 'ENABLED' : 'DISABLED' });
      }
      if (url.host === 'artifactregistry.googleapis.com') {
        if (method === 'POST') {
          const id = url.searchParams.get('repositoryId'); expect(['hypervibe', 'operator-public']).toContain(id);
          const name = `projects/${nativeId}/locations/us-central1/repositories/${id}`;
          const registry = { name, ...JSON.parse(String(init?.body)), createTime: id === 'hypervibe' ? '2026-10-25T08:30:00Z' : '2026-10-25T08:35:00Z' };
          registries.set(name, registry); writes.push('registry');
          const operation = `projects/${nativeId}/locations/us-central1/operations/registry-${id}`;
          operations.set(operation, { name: operation, done: true, response: { '@type': 'type.googleapis.com/google.devtools.artifactregistry.v1.Repository', ...registry } });
          return Response.json({ name: operation });
        }
        const name = url.pathname.replace('/v1/', '');
        if (url.pathname.includes('/operations/')) return Response.json(operations.get(name));
        return registries.has(name) ? Response.json(registries.get(name)) : Response.json({}, { status: 404 });
      }
      return base(input, init);
    });
    const billingPlan = await f.plan(); if ('error' in billingPlan) throw new Error(billingPlan.error);
    expect(billingPlan.actions.map(action => action.id)).toEqual(['gcp:billing:initial-assignment-v1']);
    expect(writes).toEqual([]);
    expect(await f.apply(billingPlan.planRunId, ['gcp:billing:initial-assignment-v1'])).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toEqual(['billing']);
    if (scenario === 'changed-billing-selection') {
      desired.environments.staging.hosting.scopePreparation.continuation.nativeScope.billingAccountName = 'billingAccounts/111111-222222-333333';
      f.store.replace(f.project, desired);
    }
    const apiPlan = await f.plan();
    if (['unknown-api-state', 'changed-billing-selection'].includes(scenario)) {
      expect('error' in apiPlan || apiPlan.blocked.length > 0).toBe(true); expect(writes).toEqual(['billing']); return;
    }
    if ('error' in apiPlan) throw new Error(apiPlan.error);
    expect(apiPlan.actions.map(action => action.id)).toEqual(['gcp:local-scope:services']);
    expect(await f.apply(apiPlan.planRunId, ['gcp:local-scope:services'])).toMatchObject({ kind: 'executed', result: { success: scenario !== 'lost-api-ack' } });
    const registryPlan = await f.plan(); if ('error' in registryPlan) throw new Error(registryPlan.error);
    expect(registryPlan.actions.map(action => action.id)).toEqual(['gcp:local-scope:artifact-registry']);
    expect(await f.apply(registryPlan.planRunId, ['gcp:local-scope:artifact-registry'])).toMatchObject({ kind: 'executed', result: { success: true } });
    if (publicImages) {
      const publicPlan = await f.plan(); if ('error' in publicPlan) throw new Error(publicPlan.error);
      expect(publicPlan.actions.map(action => action.id)).toEqual(['gcp:local-scope:public-artifact-registry', 'gcp:local-scope:public-artifact-reader']);
      const before = writes.length;
      expect(await f.apply(publicPlan.planRunId, [])).toMatchObject({ kind: 'executed', result: { success: false } });
      expect(writes).toHaveLength(before);
      for (let step = 0; step < 6; step++) {
        const planned = await f.plan(); if ('error' in planned) throw new Error(JSON.stringify(planned));
        if (planned.actions.some(action => action.id === 'cloud-scope:bind' || action.id.startsWith('gcp:github-ci:'))) break;
        await f.apply(planned.planRunId, planned.actions.filter(action => action.type !== 'noop' && action.requiresConfirm).map(action => action.id));
      }
      expect(writes.filter(write => write === 'registry')).toHaveLength(2);
      expect(writes.filter(write => write === 'public-iam-policy')).toHaveLength(1);
      expect(publicPolicy.bindings).toEqual([unrelated, { role: 'roles/artifactregistry.reader', members: ['allUsers'] }]);
      expect(registryPolicy.bindings).toEqual([unrelated]);
    }
    if (github) {
      for (let step = 0; step < 18; step++) {
        const planned = await f.plan(); if ('error' in planned) throw new Error(JSON.stringify({ planned, step, writes }));
        if (planned.actions.some(action => action.id === 'cloud-scope:bind')) break;
        const action = planned.actions.find(action => action.type !== 'noop');
        expect(action, JSON.stringify(planned)).toBeDefined();
        const before = writes.length, current = f.store.get(f.project)!;
        // Reconstruct the application context every time: all authoritative
        // ownership, attempts and partial completion come from durable SQLite.
        const confirmations = planned.actions.filter(action => action.type !== 'noop' && action.requiresConfirm).map(action => action.id);
        const result = await executePlanApply(createCommandContext(), { project: f.project, spec: current.spec, specRevision: current.revision,
          planId: planned.planRunId, confirmActions: step === 0 ? confirmations.slice(0, 1) : confirmations });
        if (step === 0) { expect(writes).toHaveLength(before); expect(result).toMatchObject({ kind: 'executed', result: { success: false } }); }
        else expect(writes.length - before).toBeLessThanOrEqual(confirmations.length);
      }
      expect(writes.filter(write => write === 'ci-identity')).toHaveLength(4);
      expect(writes.filter(write => write === 'iam-policy')).toHaveLength(3);
      expect(projectPolicy.bindings).toEqual(expect.arrayContaining([unrelated]));
      expect(projectPolicy.bindings.some((binding: any) => binding.role === 'roles/artifactregistry.writer')).toBe(false);
      expect(registryPolicy.bindings.some((binding: any) => binding.role === 'roles/artifactregistry.writer')).toBe(true);
    }
    const bind = await f.plan(); if ('error' in bind) throw new Error(bind.error);
    expect(bind.actions.map(action => action.id)).toEqual(['cloud-scope:bind']);
    expect(f.ctx.repos.connections.findByProviderAndScope('cloudrun', 'github.com/acme/operator-host#environment=staging')).toBeNull();
    if (scenario === 'conflicting-connection') {
      const existing = f.ctx.repos.connections.upsertVerifiedBatch([{ provider: 'cloudrun', scope: 'github.com/acme/operator-host#environment=staging',
        credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'unrelated-project', authMode: 'default' }) }])[0];
      expect(await f.apply(bind.planRunId, ['cloud-scope:bind'])).toMatchObject({ kind: 'executed', result: { success: false } });
      expect(f.ctx.repos.connections.findById(existing.id)).toEqual(existing);
      expect(f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')?.platformBindings).toEqual({ provider: 'cloudrun' }); return;
    }
    expect(await f.apply(bind.planRunId, ['cloud-scope:bind'])).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')?.platformBindings).toMatchObject({ provider: 'cloudrun', projectId: nativeId });
    expect(f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')?.platformBindings.providerScope).toMatchObject({
      projectId: nativeId, projectNumber: number, projectCreateTime: '2026-10-25T08:00:00.123456Z', projectParent: 'none',
      projectInstallationId: expect.stringMatching(/^[a-f0-9-]{36}$/), projectAttemptId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(f.ctx.repos.connections.findByProviderAndScope('cloudrun', 'github.com/acme/operator-host#environment=staging')?.status).toBe('verified');
    expect(f.ctx.repos.connections.findByProviderAndScope('cloudsql', 'github.com/acme/operator-host#environment=staging')?.status).toBe('verified');
    expect(f.writes).toHaveLength(1);
    if (publicImages) expect(f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')!.platformBindings.providerScope).toMatchObject({ artifactRepository: 'hypervibe', artifactRepositoryCreateTime: '2026-10-25T08:30:00Z', publicArtifactRepository: 'operator-public', publicArtifactRepositoryCreateTime: '2026-10-25T08:35:00Z' });
    if (github) {
      const bound = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')!;
      expect(JSON.parse(String(bound.platformBindings.gcpGithubWorkloadIdentity))).toMatchObject({ repository: 'acme/operator-host', serviceAccountUniqueId: '123456789012345678901' });
      const priorBindings = structuredClone(bound.platformBindings);
      const connections = ['cloudrun', 'cloudsql', 'gcs'].map(provider => f.ctx.repos.connections.findByProviderAndScope(provider, 'github.com/acme/operator-host#environment=staging'));
      const identities = structuredClone([...native]); const before = writes.length;
      desired.environments.staging.hosting.scopePreparation.continuation.nativeScope.githubAccess = 'disconnect';
      f.store.replace(f.project, desired);
      for (let step = 0; step < 8; step++) {
        const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
        const action = planned.actions.find(action => action.type !== 'noop');
        expect(action, JSON.stringify(planned)).toBeDefined();
        const current = f.store.get(f.project)!;
        const result = await executePlanApply(createCommandContext(), { project: f.project, spec: current.spec, specRevision: current.revision,
          planId: planned.planRunId, confirmActions: planned.actions.filter(action => action.type !== 'noop' && action.requiresConfirm).map(action => action.id) });
        if (action!.id === 'cloud-scope:bind') { expect(result).toMatchObject({ kind: 'executed', result: { success: true } }); break; }
      }
      const after = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')!;
      const { gcpGithubWorkloadIdentity: _removed, ...preserved } = priorBindings;
      expect(after.platformBindings).toEqual(preserved);
      expect(['cloudrun', 'cloudsql', 'gcs'].map(provider => f.ctx.repos.connections.findByProviderAndScope(provider, 'github.com/acme/operator-host#environment=staging'))).toEqual(connections);
      expect(writes).toHaveLength(before + 3); expect(accountPolicy.bindings).toEqual([]);
      expect(projectPolicy.bindings).toEqual([unrelated]); expect(registryPolicy.bindings).toEqual([unrelated]);
      expect([...native]).toEqual(identities);
      if (publicImages) expect(publicPolicy.bindings).toEqual([unrelated, { role: 'roles/artifactregistry.reader', members: ['allUsers'] }]); expect(JSON.stringify({ bind, after })).not.toMatch(/synthetic-local-allocation-token|synthetic-refresh/);
      return;
    }
    expect(writes).toEqual(['billing', 'apis', 'registry', ...(publicImages ? ['registry', 'public-iam-policy'] : [])]);
    const instantiate = vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue({} as any);
    expect(await adapterFactory.getProviderAdapter('cloudrun', f.project, undefined, 'staging')).toMatchObject({ success: true });
    expect(await adapterFactory.getProviderAdapter('cloudrun', f.project, undefined, 'production')).toMatchObject({ success: false });
    expect(await adapterFactory.getProviderAdapter('cloudrun', f.project)).toMatchObject({ success: false });
    expect(instantiate).toHaveBeenCalledTimes(1);
    expect(new PlanService().preflight(desired.environments.staging, 'production', desired, f.project).some(item => item.provider === 'cloudrun')).toBe(true);
    expect(JSON.stringify(bind)).not.toContain(token);
    desired.environments.staging.services.web.healthCheckPath = '/healthz'; f.store.replace(f.project, desired);
    expect(await localCloudScopeRequired(f.project, 'staging', f.store.get(f.project)!.spec)).toBe(false);
  }, 60_000);

});
