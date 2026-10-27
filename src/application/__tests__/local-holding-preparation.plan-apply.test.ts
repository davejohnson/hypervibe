import { localHoldingApplicationFixture as fixture } from './local-holding-preparation.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { environmentConnectionScope } from '../../domain/services/project-scope.js';
import { readGcpLocalPreparedResources } from '../../adapters/providers/gcp/gcp-local-holding-preparation.js';
import { localHoldingWorkRequired, verifiedLocalHoldingReceipt } from '../../domain/services/local-holding-preparation.service.js';
import { planCloudInstallationV1 } from '../../domain/services/cloud-installation-runtime.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { createGcpSecretContainerSetup } from '../../adapters/providers/gcp/gcp-secret-container.js';
import { mergeRepoPlatformBindings } from '../../domain/spec/repo-bindings-file.js';

// User requirement: obtaining the exact HTTPS origin must not run application
// code or require its still-unregistered OAuth secrets. This exercises actual
// desired-state admission and planning, not a mocked planner response.
describe('local inert holding preparation', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-local-holding-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    vi.stubGlobal('fetch', async () => { throw new Error('Network is disabled for this serialized transport fixture'); });
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });
  it('admits a separately reviewed holding prerequisite without application secret inputs', async () => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'operator-host', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator.git' });
    const store = new SpecStore();
    store.replace(project, { version: 1, project: project.name, secrets: {
      CLOUD_CONNECT_GOOGLE_CLIENT_SECRET: { ownership: 'delegated', principal: 'email:operator@example.test', environments: ['staging'], required: true },
    }, environments: { staging: {
      hosting: { provider: 'cloudrun', preparation: { kind: 'holding-v1', image: `us-central1-docker.pkg.dev/owned-project/operator-public/holding@sha256:${'a'.repeat(64)}` } },
      services: { web: {} }, email: { enabled: false },
    } } });
    const planned = await new PlanService().plan(project, 'staging');
    // A missing reviewed local project is a holding prerequisite blocker, not
    // an invitation to supply app secrets or a normal application deployment.
    expect(planned).toMatchObject({ error: expect.stringMatching(/holding.*project|holding.*scope/i) });
  });

  it.each([undefined, { maxInstanceCount: 20 }])('creates and binds reviewed inert resources with native service scaling %j and all app secrets still absent', async serviceScaling => {
    const f = await fixture({ serviceScaling }); const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    expect(first.scope).toBe('hosting-preparation'); expect(first.actions).toHaveLength(6); expect(first.inputRequired).toEqual([]);
    expect(f.native.writes).toEqual([]);
    expect(await f.apply(first.planRunId, [])).toMatchObject({ kind: 'executed', result: { success: false } }); expect(f.native.writes).toEqual([]);
    const reviewed = await f.plan(); if ('error' in reviewed) throw new Error(reviewed.error);
    const applied = await f.apply(reviewed.planRunId, reviewed.actions.map(action => action.id));
    expect(applied, JSON.stringify(applied)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.native.writes.map(value => value.kind)).toEqual(['account', 'account', 'account', 'service', 'public', 'service']);
    const serviceWrites = f.native.writes.filter(value => value.kind === 'service');
    for (const { body } of serviceWrites) {
      expect(body.template.scaling).toEqual({ minInstanceCount: 0, maxInstanceCount: 1 });
      expect(body.template.containers[0].env).toBeUndefined(); expect(body.template.volumes).toBeUndefined();
      expect(body.template.containers[0].resources.cpuIdle).toBe(true);
      expect(body.template.containers[0].image).toBe(f.native.image);
    }
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.services).toBeUndefined();
    const binding = await f.plan(); if ('error' in binding) throw new Error(binding.error);
    expect(binding).toMatchObject({ scope: 'hosting-preparation', actions: [{ id: 'hosting-preparation:bind', requiresConfirm: true }] });
    const writes = f.native.writes.length;
    expect(await f.apply(binding.planRunId, ['hosting-preparation:bind'])).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.native.writes).toHaveLength(writes);
    const bound = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    expect(bound.preparedHosting).toMatchObject({ pendingFirstRelease: ['web', 'worker'] });
    expect(bound.localPreparedHosting).toMatchObject({ purpose: 'local-holding', origins: { web: expect.stringMatching(/^https:\/\/.*\.run\.app$/) } });
    expect(JSON.stringify(bound)).not.toMatch(/synthetic-local-holding-token|CLOUD_CONNECT_GOOGLE_CLIENT_SECRET/);
    const receipt = await verifiedLocalHoldingReceipt(f.project, f.ctx.repos.environments.findById(f.environment.id)!);
    expect(receipt).toBeDefined();
    expect(Object.keys((await readGcpLocalPreparedResources(receipt!, 'synthetic-local-holding-token', AbortSignal.timeout(1000), f.native.request)).workloads)).toEqual(['web', 'worker']);
    f.native.options.corrupt = true;
    await expect(readGcpLocalPreparedResources(receipt!, 'synthetic-local-holding-token', AbortSignal.timeout(1000), f.native.request)).rejects.toThrow();
    expect(f.native.writes).toHaveLength(writes);
  });

  it('revalidates the owned HTTPS origin and immutable runtime identity before operator registration', async () => {
    const f = await fixture();
    for (let step = 0; step < 2; step++) {
      const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
      expect(await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id)))
        .toMatchObject({ kind: 'executed', result: { success: true } });
    }
    const receipt = await verifiedLocalHoldingReceipt(f.project, f.ctx.repos.environments.findById(f.environment.id)!);
    const capability = providerRegistry.getHoldingPreparation('cloudrun')!;
    const verify = (capability as any).verifyOperatorOrigin;
    expect(verify, 'Cached origin metadata cannot establish current native identity or public access').toBeTypeOf('function');
    const writes = f.native.writes.length;
    const proof = await verify.call(capability, receipt, { service: 'web', runtimeService: 'web' });
    expect(proof).toEqual({ origin: receipt!.origins.web, runtimeIdentity: receipt!.runtimeIdentities.find(item => item.workload === 'web')!.principal });
    await expect(verify.call(capability, receipt, { service: 'worker', runtimeService: 'web' })).rejects.toThrow();
    f.native.options.corrupt = true;
    await expect(verify.call(capability, receipt, { service: 'web', runtimeService: 'web' })).rejects.toThrow();
    expect(f.native.writes).toHaveLength(writes);
  });

  it('preserves completed multi-service holding authority across repository export, restart and a later secret-destination plan', async () => {
    const f = await fixture({ serviceScaling: { maxInstanceCount: 20 } });
    for (let step = 0; step < 2; step++) {
      const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
      expect(await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id)))
        .toMatchObject({ kind: 'executed', result: { success: true } });
    }
    const original = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    const writes = f.native.writes.length, repository = path.join(directory, 'repository');
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://github.com/acme/operator']);
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'false');
    await runWithWorkspaceDirectories([repository], async () => {
      f.store.replace(f.project, f.desired);
      f.ctx.repos.environments.syncRepoBindingsForId(f.environment.id);
      const exported = JSON.parse(readFileSync(path.join(repository, '.hypervibe', 'bindings.json'), 'utf8'));
      expect(exported.environments.staging.platformBindings).not.toHaveProperty('localPreparedHosting');
      SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
      expect(await f.commands.execute('hv_spec', { project: f.project.name })).toMatchObject({ ok: true });
      expect.soft(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).toEqual(original);
      const declaration = { CLOUD_CONNECT_GOOGLE_CLIENT_SECRET: { destination: { provider: 'gcp-secret-manager', projectId: f.native.scope.projectId,
        projectNumber: f.native.scope.projectNumber, secretId: 'operator-google-client' } } };
      expect(await f.commands.execute('hv_spec', { project: f.project.name, spec: { environments: { staging: { secretDestinations: declaration } } } }))
        .toMatchObject({ ok: true });
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { secretDestinationSetup:
        createGcpSecretContainerSetup({ projectId: f.native.scope.projectId, getAccessToken: async () => 'synthetic-transient-token' }, { fetch: async (url, options) => {
          if (new URL(String(url)).hostname === 'secretmanager.googleapis.com') { expect(options?.method ?? 'GET').toBe('GET'); return Response.json({}, { status: 404 }); }
          return f.native.request(url, options);
        } }) } } as any);
      const narrow = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'secret-destinations' });
      expect(narrow, JSON.stringify(narrow)).toMatchObject({ ok: true, data: { scope: 'secret-destinations' } });
      // Full planning also passes the retained holding stage, then isolates the
      // declared operator's output prerequisite before reading private inputs.
      expect(await f.commands.execute('hv_spec', { project: f.project.name, spec: { environments: { staging: {
        operatorApplications: { google: { provider: 'google-oauth', originService: 'web', runtimeService: 'web',
          profile: 'hypercloud-connect-v1', nativeScope: { projectId: f.native.scope.projectId },
          outputs: { 'client-secret': 'CLOUD_CONNECT_GOOGLE_CLIENT_SECRET' } } },
      } } } })).toMatchObject({ ok: true });
      const full = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'full' });
      expect(full, JSON.stringify(full)).toMatchObject({ ok: true, data: { scope: 'secret-destinations' } });
      expect(await verifiedLocalHoldingReceipt(f.project, f.ctx.repos.environments.findById(f.environment.id)!)).toEqual(original.localPreparedHosting);
      expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).toEqual(original);
      expect(f.native.writes).toHaveLength(writes);
    });
  });

  it('recovers only journal-proven empty runtime declarations from the observed older sanitized receipt shape', async () => {
    const f = await fixture();
    for (let step = 0; step < 2; step++) {
      const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
      expect(await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id)))
        .toMatchObject({ kind: 'executed', result: { success: true } });
    }
    const original = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    // Sanitized native profile observation 2026-10-27: both web and worker lost
    // only empty runtimeSecrets; the immutable journal/digest remained complete.
    const legacy: any = structuredClone(original.localPreparedHosting);
    for (const workload of legacy.deployment.workloads) delete workload.runtimeSecrets;
    expect.soft(mergeRepoPlatformBindings(original, { localPreparedHosting: legacy }).localPreparedHosting).toEqual(original.localPreparedHosting);
    const changed = structuredClone(legacy); changed.preparedResources.workloads[0].lifetimeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect.soft(() => mergeRepoPlatformBindings(original, { localPreparedHosting: changed })).toThrow();
    expect.soft(() => mergeRepoPlatformBindings({}, { localPreparedHosting: legacy })).toThrow();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { localPreparedHosting: legacy });
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    const retained = f.ctx.repos.environments.findById(f.environment.id)!;
    expect(await verifiedLocalHoldingReceipt(f.project, retained)).toEqual(original.localPreparedHosting);
    expect(await localHoldingWorkRequired(f.project, 'staging', f.store.get(f.project)!.spec)).toBe(false);
    for (const variant of ['runtime-reference', 'native-id', 'digest', 'owner']) {
      const invalid: any = structuredClone(retained);
      if (variant === 'runtime-reference') invalid.platformBindings.localPreparedHosting.deployment.workloads[0].runtimeSecrets = [{ key: 'TOKEN' }];
      if (variant === 'native-id') invalid.platformBindings.localPreparedHosting.preparedResources.workloads[0].id += '-other';
      if (variant === 'digest') invalid.platformBindings.preparedHosting.receiptDigest = 'f'.repeat(64);
      if (variant === 'owner') invalid.platformBindings.localPreparedHosting.runtimeIdentities[0].owner = 'f'.repeat(64);
      await expect(verifiedLocalHoldingReceipt(f.project, invalid)).rejects.toThrow();
    }
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).toEqual(retained.platformBindings);
    expect(f.native.writes).toHaveLength(6);
  });

  it('cannot import a local holding receipt by creating a previously unrecorded environment', async () => {
    const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'operator', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator' });
    const repository = path.join(directory, 'unrecorded');
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', project.gitRemoteUrl!]);
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'false');
    await runWithWorkspaceDirectories([repository], async () => {
      new SpecStore().replace(project, { version: 1, project: project.name, environments: { staging: { hosting: { provider: 'cloudrun' }, email: { enabled: false } } } });
      writeFileSync(path.join(repository, '.hypervibe', 'bindings.json'), JSON.stringify({ version: 1, project: project.name, environments: {
        staging: { platformBindings: { localPreparedHosting: { purpose: 'local-holding' } } },
      } }));
      expect(() => ctx.resolveProjectOrThrow({ project: project.name })).toThrow(/local.*holding|holding.*local/i);
      expect(ctx.repos.environments.findByProjectAndName(project.id, 'staging')).toBeNull();
    });
  });

  it.each(['account', 'service', 'public'] as const)('reconciles a lost %s acknowledgment after SQLite restart without repeating the mutation', async lost => {
    const f = await fixture({ lost, serviceScaling: { maxInstanceCount: 20 } }); let plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
    for (let step = 0; step < 12; step++) {
      await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id));
      SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
      plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
      if (plan.actions[0]?.id === 'hosting-preparation:bind') break;
    }
    expect(plan.actions[0]?.id).toBe('hosting-preparation:bind');
    expect(f.native.writes.filter(write => write.kind === 'account')).toHaveLength(3);
    expect(f.native.writes.filter(write => write.kind === 'service')).toHaveLength(2);
    expect(f.native.writes.filter(write => write.kind === 'public')).toHaveLength(1);
  });

  it('keeps the normal command boundary free of application input preparation', async () => {
    const f = await fixture(); const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(result).toMatchObject({ ok: true, data: { scope: 'hosting-preparation', cloudScopeReview: { permissions: expect.any(Array), costs: expect.any(Array) } } });
    expect(result.data).not.toHaveProperty('localEnv'); expect(f.native.writes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('synthetic-local-holding-token');
    const plan = result.data as { planId: string; actions: Array<{ id: string }> };
    const applied = await f.commands.execute('hv_apply', { project: f.project.name, planId: plan.planId, confirmActions: plan.actions.map(action => action.id) });
    expect(applied).toMatchObject({ ok: true, data: { applied: true }, hint: expect.stringMatching(/inert.*release/i), next: ['hv_plan'] });
  });

  it('offers read-only recovery without another user approval after an uncertain holding create', async () => {
    const f = await fixture({ lost: 'service' });
    const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
    const result = await f.commands.execute('hv_apply', { project: f.project.name, planId: plan.planRunId,
      confirmActions: plan.actions.map(action => action.id) });
    expect(result).toMatchObject({ ok: true, data: { applied: false }, next: ['hv_plan'], agentInstruction: { action: 'continue' } });
    expect(result.agentInstruction?.message).toMatch(/read-only/);
    const writes = f.native.writes.length;
    const recovered = await f.plan(); if ('error' in recovered) throw new Error(recovered.error);
    expect(f.native.writes).toHaveLength(writes);
    expect(recovered.actions.find(action => action.id === 'gcp:holding:service:web')?.type).toBe('noop');
  });

  it('rechecks source after the final native absence read and before the write', async () => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    f.native.options.afterRead = () => { const changed = structuredClone(f.desired); changed.environments.staging.hosting.preparation.image = changed.environments.staging.hosting.preparation.image.replace(/d+$/, 'e'.repeat(64));
      f.store.replace(f.project, changed); f.native.options.afterRead = undefined; };
    const result = await f.apply(planned.planRunId, planned.actions.map(action => action.id));
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } }); expect(f.native.writes).toEqual([]);
  });

  it('retains attempted recovery after declaration removal and does not grant new old actions', async () => {
    const f = await fixture({ lost: 'account' }); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    // Hide the committed account after its write so this is a genuinely unknown
    // outcome until a later read, not a success mislabeled by the test.
    const original = f.native.request;
    let deny = false;
    vi.spyOn(providerRegistry.getHoldingPreparation('cloudrun')!, 'create').mockResolvedValue({ driver: (await import('../../adapters/providers/gcp/gcp-local-holding-preparation.js')).createGcpLocalHoldingDriver({ fetch: async (url, init) => {
      if (deny && String(url).includes('iam.googleapis.com')) return Response.json({}, { status: 403 });
      try { return await original(url, init); } catch (error) { deny = true; throw error; }
    } }), authentication: f.native.authentication });
    await f.apply(planned.planRunId, planned.actions.map(action => action.id)); expect(f.native.writes).toHaveLength(1);
    const changed: any = structuredClone(f.desired); delete changed.environments.staging.hosting.preparation; f.store.replace(f.project, changed);
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    const recovered = await f.plan(); if ('error' in recovered) throw new Error(recovered.error);
    expect(recovered).toMatchObject({ scope: 'hosting-preparation', actions: [{ id: 'gcp:holding:account:holding', requiresConfirm: false, billable: false }] });
    deny = false; await f.apply(recovered.planRunId, []);
    expect(f.native.writes).toHaveLength(1);
    const narrow = await new PlanService().plan(f.project, 'staging', { scope: 'secret-destinations' });
    expect(narrow).toMatchObject({ error: expect.stringMatching(/holding prerequisite/) });
  });

  it('requires a fresh explicit rejected-attempt retry and never treats an unknown response as retry authority', async () => {
    const f = await fixture({ reject: true }); let planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId, planned.actions.map(action => action.id)); expect(f.native.writes).toEqual([]);
    f.native.options.reject = false;
    planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    expect(planned.actions[0]).toMatchObject({ id: 'gcp:holding:account:holding', type: 'create', requiresConfirm: true, reason: expect.stringMatching(/Retry the rejected attempt/) });
    await f.apply(planned.planRunId, []); expect(f.native.writes).toEqual([]);
    planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId, planned.actions.filter(action => action.requiresConfirm).map(action => action.id));
    expect(f.native.writes).toHaveLength(1);
  });

  it('denies lost cloud authority after review without interpreting a 403 as absence', async () => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    f.native.options.denied = true;
    expect(await f.apply(planned.planRunId, planned.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.writes).toEqual([]);
  });

  it('does not adopt a foreign identity appearing after review', async () => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    const name = planned.actions[0].resource.name;
    const foreign = { name, email: name.split('/').at(-1), projectId: f.native.scope.projectId,
      uniqueId: '100000000000000000099', description: 'Owned by another operator' };
    f.native.accounts.set(name, foreign);
    expect(await f.apply(planned.planRunId, planned.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.writes).toEqual([]); expect(f.native.accounts.get(name)).toEqual(foreign);
  });

  it('requires the exact environment connection before invoking the local credential reader', async () => {
    const f = await fixture(); const create = vi.mocked(providerRegistry.getHoldingPreparation('cloudrun')!.create); create.mockClear();
    f.ctx.repos.connections.deleteByProviderAndScope('cloudrun', environmentConnectionScope('github.com/acme/operator', 'staging'));
    f.ctx.repos.connections.upsertVerifiedBatch([{ provider: 'cloudrun', scope: environmentConnectionScope('github.com/acme/operator', 'production'),
      credentialsEncrypted: getSecretStore().encryptObject({ authMode: 'default', projectId: f.native.scope.projectId, region: f.native.scope.region }) }]);
    const planned = await f.plan();
    expect(planned).toMatchObject({ error: expect.stringMatching(/holding/) }); expect(create).not.toHaveBeenCalled(); expect(f.native.writes).toEqual([]);
  });

  it('observes completed preparation without replay and rejects substituted bound service identities', async () => {
    const f = await fixture(); let planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId, planned.actions.map(action => action.id));
    const writes = f.native.writes.length;
    planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId, ['hosting-preparation:bind']);
    const environment = f.ctx.repos.environments.findById(f.environment.id)!;
    expect(await verifiedLocalHoldingReceipt(f.project, environment)).toBeDefined();
    const changed = structuredClone(environment); (changed.platformBindings.services as any).web.resourceUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await expect(verifiedLocalHoldingReceipt(f.project, changed)).rejects.toThrow();
    expect(f.native.writes).toHaveLength(writes);
  });

  it('does not create a nominally grant-free final identity with preexisting privileged project membership', async () => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    const runtime = planned.actions.find(action => action.id === 'gcp:holding:account:runtime-web')!;
    f.native.options.projectMembers = [`serviceAccount:${runtime.resource.name.split('/').at(-1)}`];
    expect(await f.apply(planned.planRunId, planned.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.writes).toEqual([]);
  });

  it('rejects hosted authentication for the local holding driver before provider or journal access', async () => {
    const f = await fixture(); const before = f.native.requests.length;
    const host = { verifyIdentity: vi.fn(), getIdToken: vi.fn(), getAccessToken: vi.fn() };
    const store = { read: vi.fn(async () => null), compareAndSwap: vi.fn(async () => true) };
    await expect(planCloudInstallationV1({ driver: f.native.driver, intent: f.native.intent,
      authentication: { host } as any, store, authorize: async () => true })).rejects.toMatchObject({ code: 'authorization_expired' });
    expect(store.compareAndSwap).not.toHaveBeenCalled(); expect(host.verifyIdentity).not.toHaveBeenCalled();
    expect(f.native.requests).toHaveLength(before); expect(f.native.writes).toEqual([]);
  });

  it('hands a completed exact binding with deployment inputs to ordinary native inspection without claiming readiness', async () => {
    const f = await fixture();
    for (let phase = 0; phase < 2; phase++) { const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
      expect(await f.apply(planned.planRunId, planned.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } }); }
    const writes = f.native.writes.length;
    const ordinary = vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'Synthetic ordinary native inspection unavailable' });
    const next = await new PlanService().plan(f.project, 'staging', { envVarOverrides: { SYNTHETIC_SETTING: 'test' }, secretRefs: {} });
    expect('error' in next ? next.error : next.scope).not.toMatch(/Holding preparation|hosting-preparation/);
    expect(ordinary).toHaveBeenCalled(); expect(next).toMatchObject({ error: expect.stringMatching(/Installer-prepared hosting identity or pending recovery is unverified/) });
    expect(f.native.writes).toHaveLength(writes);
    ordinary.mockClear();
    const changed = structuredClone(f.desired); changed.environments.staging.hosting.preparation.image = changed.environments.staging.hosting.preparation.image.replace(/d+$/, 'e'.repeat(64));
    f.store.replace(f.project, changed);
    expect(await new PlanService().plan(f.project, 'staging', { envVarOverrides: { SYNTHETIC_SETTING: 'test' }, secretRefs: {} })).toHaveProperty('error');
    expect(ordinary).not.toHaveBeenCalled(); expect(f.native.writes).toHaveLength(writes);
  });

  it('does not charge a different enabled billing account after the reviewed plan', async () => {
    const f = await fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    f.native.options.billingAccountName = 'billingAccounts/AAAAAA-BBBBBB-CCCCCC';
    expect(await f.apply(planned.planRunId, planned.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.writes).toEqual([]);
  });
});
