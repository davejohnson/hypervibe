import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { assertReadySecretContainers } from '../../domain/services/secret-container-setup.js';

const destination = { provider: 'gcp-secret-manager', projectId: 'synthetic-project', projectNumber: '123456789012', secretId: 'staging-api' };
const resource = 'projects/123456789012/secrets/staging-api';
describe('empty destination setup through persisted plan/apply and real GCP REST', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-container-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  async function fixture(options: { lost?: boolean; populated?: boolean; unowned?: boolean; pinned?: boolean; rejected?: boolean } = {}) {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'synthetic-app', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/app.git' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'cloudrun', projectId: 'synthetic-project' } });
    const store = new SpecStore();
    store.replace(project, { version: 1, project: project.name, secrets: { API_TOKEN: { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] } },
      environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} }, email: { enabled: false }, secretDestinations: { API_TOKEN: { destination, ...(options.pinned ? { version: '1' } : {}) } } } } });
    let live: any = options.unowned ? { name: resource, createTime: '2026-10-24T00:00:00Z' } : null;
    const writes: any[] = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === 'https://cloudresourcemanager.googleapis.com/v3/projects/123456789012') return Response.json({ name: 'projects/123456789012', projectId: 'synthetic-project', state: 'ACTIVE' });
      if (url === 'https://secretmanager.googleapis.com/v1/' + resource && method === 'GET') return live ? Response.json(live) : new Response('missing', { status: 404 });
      if (url.startsWith('https://secretmanager.googleapis.com/v1/' + resource + '/versions?')) return Response.json(options.populated ? { versions: [{ name: resource + '/versions/1' }] } : {});
      if (method === 'POST' && url === 'https://secretmanager.googleapis.com/v1/projects/123456789012/secrets?secretId=staging-api') {
        const binding: any = ctx.repos.environments.findByProjectAndName(project.id, 'staging')!.platformBindings.secretDestinationContainers;
        expect(binding.API_TOKEN.state).toBe('attempted');
        const body = JSON.parse(String(init?.body)); writes.push(body);
        expect(binding.API_TOKEN.attemptId).toBe(body.labels['hv-secret-attempt']);
        if (options.rejected) return new Response('synthetic upstream unavailable', { status: 503 });
        live = { name: resource, createTime: '2026-10-24T00:01:00.123456789Z', ...body };
        if (options.lost) throw new Error('Lost synthetic response');
        return Response.json(live);
      }
      throw new Error('Unexpected provider call');
    });
    vi.stubGlobal('fetch', request);
    const adapter = new CloudRunAdapter();
    await adapter.connect({ projectId: 'synthetic-project', credentials: JSON.stringify({ type: 'service_account', project_id: 'synthetic-project', client_email: 'deploy@synthetic-project.iam.gserviceaccount.com', private_key: 'synthetic' }) });
    Object.assign(adapter, { accessToken: 'synthetic', tokenExpiry: new Date(Date.now() + 60_000) });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    const deploy = vi.spyOn(adapter, 'deploy');
    const derive = vi.spyOn(getSecretStore(), 'deriveSecret');
    const plan = () => new PlanService().plan(project, 'staging', { scope: 'secret-destinations' } as any);
    async function apply(planId: string, confirm = true) {
      const current = store.get(project)!;
      return executePlanApply(ctx, { project, spec: current.spec, specRevision: current.revision, planId, confirmActions: confirm ? ['secret-destination:API_TOKEN'] : [] });
    }
    return { ctx, project, environment, store, plan, apply, writes, request, derive, deploy, getLive: () => live, setLive: (value: any) => { live = value; } };
  }
  it('plans container creation without values and requires its exact confirmation before POST', async () => {
    const f = await fixture(); const planned = await f.plan();
    expect(planned).toMatchObject({ scope: 'secret-destinations', inputRequired: [], actions: [expect.objectContaining({ id: 'secret-destination:API_TOKEN', type: 'create', requiresConfirm: true })] });
    if ('error' in planned) throw new Error(planned.error);
    expect(f.ctx.repos.runs.findById(planned.planRunId)!.plan).not.toHaveProperty('overrides');
    expect(await f.apply(planned.planRunId, false)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.writes).toEqual([]);
    const replanned = await f.plan(); if ('error' in replanned) throw new Error(replanned.error);
    expect(await f.apply(replanned.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toHaveLength(1); expect(f.derive).not.toHaveBeenCalled(); expect(f.deploy).not.toHaveBeenCalled();
    expect((f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.secretDestinationContainers as any).API_TOKEN).toMatchObject({ state: 'ready', resource, owner: { repository: 'github.com/acme/app', environment: 'staging', key: 'API_TOKEN' } });
    expect(await f.plan()).toMatchObject({ scope: 'secret-destinations', actions: [] });
  });
  it('recovers a lost create response by matching the durable attempt without another POST', async () => {
    const f = await fixture({ lost: true }); const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    expect(await f.apply(first.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    const second = await f.plan(); if ('error' in second) throw new Error(second.error);
    expect(second.actions[0]).toMatchObject({ type: 'update', metadata: { mode: 'reconcile' } });
    expect(await f.apply(second.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toHaveLength(1); expect(f.deploy).not.toHaveBeenCalled();
  });
  it('keeps unresolved attempted creation pending without automatically retrying even when currently absent', async () => {
    const f = await fixture({ rejected: true }); const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    expect(await f.apply(first.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    const second = await f.plan(); if ('error' in second) throw new Error(second.error);
    expect(second.actions[0]).toMatchObject({ type: 'update', metadata: { mode: 'reconcile' } });
    expect(await f.apply(second.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.writes).toHaveLength(1);
  });
  it.each(['deleted', 'recreated', 'relabeled'])('does not replace or trust a ready container whose lifetime changed: %s', async change => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    expect(await f.apply(planned.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    f.setLive(change === 'deleted' ? null : { ...f.getLive(), ...(change === 'recreated' ? { createTime: '2026-10-24T02:00:00Z' } : { labels: {} }) });
    expect(await f.plan()).toHaveProperty('error'); expect(f.writes).toHaveLength(1);
  });
  it('does not accept a saved zero-action setup plan after the ready container disappears', async () => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId);
    const readyPlan = await f.plan(); if ('error' in readyPlan) throw new Error(readyPlan.error);
    expect(readyPlan.actions).toEqual([]); f.setLive(null);
    expect(await f.apply(readyPlan.planRunId)).toMatchObject({ kind: 'blocked' }); expect(f.writes).toHaveLength(1);
  });
  it('admits writer preparation only for the current owned native container lifetime', async () => {
    const f = await fixture();
    const verify = () => assertReadySecretContainers({ project: f.project, spec: f.store.get(f.project)!.spec,
      environment: f.ctx.repos.environments.findById(f.environment.id)!, keys: ['API_TOKEN'] });
    await expect(verify()).rejects.toThrow(); expect(f.request).not.toHaveBeenCalled();
    const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId);
    expect(await verify()).toMatchObject({ API_TOKEN: { state: 'ready', resource } });
    f.setLive({ ...f.getLive(), createTime: '2026-10-24T02:00:00Z' });
    await expect(verify()).rejects.toThrow();
    expect(f.writes).toHaveLength(1);
  });
  it('rejects writer admission if retained ownership changes during native inspection', async () => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId);
    const transport = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const response = await transport(...args);
      if (String(args[0]) === 'https://secretmanager.googleapis.com/v1/' + resource)
        f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { secretDestinationContainers: {} });
      return response;
    });
    await expect(assertReadySecretContainers({ project: f.project, spec: f.store.get(f.project)!.spec,
      environment: f.ctx.repos.environments.findById(f.environment.id)!, keys: ['API_TOKEN'] })).rejects.toThrow();
    expect(f.writes).toHaveLength(1);
  });
  it.each(['destination', 'repository', 'environment', 'attempt'])('rejects altered reviewed %s before provider writes', async change => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    const run = f.ctx.repos.runs.findById(planned.planRunId)!;
    const document = structuredClone(run.plan) as any, metadata = document.actions[0].metadata;
    if (change === 'destination') metadata.destination.secretId = 'production-key';
    if (change === 'repository') metadata.owner.repository = 'github.com/other/app';
    if (change === 'environment') metadata.owner.environment = 'production';
    if (change === 'attempt') { metadata.mode = 'reconcile'; metadata.attemptId = '11111111-1111-4111-8111-111111111111'; document.actions[0].type = 'update'; }
    f.ctx.repos.runs.updatePlan(run.id, document); f.request.mockClear();
    expect(await f.apply(run.id)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.request).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });
  it.each(['hosting-scope', 'source'])('rechecks current %s after final provider inspection before claiming or creating', async change => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    const transport = f.request.getMockImplementation()!; let changed = false;
    f.request.mockImplementation(async (...args) => {
      const response = await transport(...args);
      if (!changed && String(args[0]) === 'https://secretmanager.googleapis.com/v1/' + resource) {
        changed = true;
        if (change === 'hosting-scope') f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { projectId: 'other-project' });
        else {
          const spec = structuredClone(f.store.get(f.project)!.spec);
          const slot = spec.secrets.API_TOKEN;
          if (slot.ownership !== 'delegated') throw new Error('Expected delegated fixture');
          slot.principal = 'email:new-owner@example.test';
          f.store.replace(f.project, spec);
        }
      }
      return response;
    });
    expect(await f.apply(planned.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(changed).toBe(true); expect(f.writes).toEqual([]);
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.secretDestinationContainers).toBeUndefined();
  });
  it.each([{ unowned: true }, { unowned: true, populated: true }])('does not adopt or replace existing targets: %j', async options => {
    const f = await fixture(options); expect(await f.plan()).toHaveProperty('error'); expect(f.writes).toEqual([]);
  });
  it('preserves pinned destinations without provider calls or creation', async () => {
    const f = await fixture({ pinned: true }); expect(await f.plan()).toMatchObject({ scope: 'secret-destinations', actions: [] });
    expect(f.request).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });
  it('rejects unrelated actions or value-bearing inputs from a saved prerequisite plan', () => {
    expect(planRunDocumentSchema.safeParse({ kind: 'hv_plan', scope: 'secret-destinations', environmentName: 'staging', specRevision: 1, observedFingerprint: null,
      actions: [{ id: 'service:web', type: 'create', verified: true, reason: 'unrelated', resource: { kind: 'service', name: 'web', provider: 'cloudrun' } }] }).success).toBe(false);
  });
  it('exposes the exact nonsecret destination in command review before confirmation', async () => {
    const f = await fixture(); const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
    const result = await registry.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'secret-destinations' });
    expect(result).toMatchObject({ ok: true, data: { scope: 'secret-destinations', actions: [expect.objectContaining({ destination, owner: { repository: 'github.com/acme/app', environment: 'staging', key: 'API_TOKEN' }, mode: 'create' })] } });
    expect(result.data).not.toHaveProperty('localEnv');
    expect(f.writes).toEqual([]); expect(f.derive).not.toHaveBeenCalled();
    const applied = await registry.execute('hv_apply', { project: f.project.name, planId: (result.data as any).planId, confirmActions: ['secret-destination:API_TOKEN'] });
    expect(applied).toMatchObject({ ok: true }); expect(f.writes).toHaveLength(1);
  });
  it('prepares a declared environment before any local hosting record or workload exists', async () => {
    const f = await fixture(); f.ctx.repos.environments.delete(f.environment.id);
    const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
    const result = await registry.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'secret-destinations' });
    expect(result).toMatchObject({ ok: true, data: { scope: 'secret-destinations', pendingActionCount: 1 } });
    expect(f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')).toBeTruthy();
    const applied = await registry.execute('hv_apply', { project: f.project.name, planId: (result.data as any).planId, confirmActions: ['secret-destination:API_TOKEN'] });
    expect(applied).toMatchObject({ ok: true }); expect(f.writes).toHaveLength(1); expect(f.deploy).not.toHaveBeenCalled();
  });
  it.each([{ envVars: {} }, { secretRefs: {} }, { includeEnvFile: false }, { envFile: '.env' }, { services: [] }])('rejects even empty unrelated inputs at the command boundary: %j', async inputs => {
    const f = await fixture(); const registry = new CommandRegistry(); registerCoreTools(registry, f.ctx);
    expect(await registry.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'secret-destinations', ...inputs })).toMatchObject({ ok: false });
    expect(f.request).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });
});
