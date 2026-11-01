import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { localHoldingApplicationFixture } from './local-holding-preparation.fixture.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { planPreparedHosting } from '../../domain/services/hosting-prepared.service.js';
import { applyPreparedHosting } from '../apply-prepared-hosting.js';
import { preparedSecretReleaseError } from '../apply-secret-references.js';
import { createPreparedDirectReleaseControl, completePreparedDirectRelease, reviewPreparedDirectReleaseActions } from '../../domain/services/prepared-direct-release.service.js';
import type { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import type { LocalPreparedHostingReceiptV1 } from '../../domain/ports/local-holding-preparation.port.js';
import { executeBootstrap } from '../../domain/services/bootstrap.service.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { deriveHypervibeSecretValues } from '../../domain/services/hypervibe-secret-value.js';
import type { Service } from '../../domain/entities/service.entity.js';
import { createHash } from 'node:crypto';

// Real local ADC loader + actual SQLite publication/holding journals + native
// provider clients. Only OAuth/Google transport is synthetic; no hosted grant
// or CI release receipt is constructed. Run v2 Service identity/configuration
// follows the same official contracts as cloudrun-prepared-release.contract.
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'hv-local-first-release-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(join(directory, 'state.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
async function fixture(changeHolding?: (native: Record<string, any>) => void, fullRuntime: boolean | 'secrets' = false, applicationMetadata = false, migration = false, nativeReference = false) {
  const f = await localHoldingApplicationFixture();
  for (let phase = 0; phase < 2; phase++) {
    const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
    expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  }
  const load = () => f.ctx.repos.environments.findById(f.environment.id)!;
  const receipt = load().platformBindings.localPreparedHosting as LocalPreparedHostingReceiptV1;
  const candidate = `us-central1-docker.pkg.dev/operator-project/hypervibe/application-candidate@sha256:${'f'.repeat(64)}`;
  const reference = { destination: { provider: 'gcp-secret-manager' as const, projectId: 'operator-project', projectNumber: '123456789012', secretId: 'native-token' }, version: '7' };
  f.store.replace(f.project, { ...f.desired, secrets: fullRuntime ? {
    GENERATED_TOKEN: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'] },
    DELEGATED_TOKEN: { ownership: 'delegated', principal: 'email:operator@example.test', environments: ['staging'], required: true },
  } : nativeReference ? { NATIVE_TOKEN: { ownership: 'delegated', principal: 'email:operator@example.test', environments: ['staging'], required: true } } : {}, environments: { staging: { ...f.desired.environments.staging,
    ...(nativeReference ? { secretDestinations: { NATIVE_TOKEN: reference } } : {}),
    ...(fullRuntime === true ? { database: { provider: 'rds', engine: 'postgres' } } : {}),
    envVars: { SETTING: 'reviewed-value', IMAGE_URI: candidate }, deploy: { strategy: 'manual' },
    ...(migration ? { migrations: { mode: 'releaseCommand', runInDeploy: true, command: 'npm run db:migrate:production' } } : {}) } } });
  if (fullRuntime === true) {
    f.ctx.repos.components.create({ environmentId: f.environment.id, type: 'postgres', bindings: { provider: 'rds', connectionUrl: 'postgresql://app:synthetic-db-secret@db.internal:5432/app' } });
    f.ctx.repos.components.create({ environmentId: f.environment.id, type: 'redis', bindings: { connectionUrl: 'redis://cache.internal:6379' } });
  }
  const managedSecretValues: Record<string, string> | undefined = fullRuntime ? { ...deriveHypervibeSecretValues(f.store.get(f.project)!.spec, 'staging'), DELEGATED_TOKEN: 'synthetic-delegated-token' } : undefined;
  const expectedRuntime = { SETTING: 'reviewed-value', ...managedSecretValues, ...(fullRuntime === true ? {
    DATABASE_URL: 'postgresql://app:synthetic-db-secret@db.internal:5432/app', DIRECT_URL: 'postgresql://app:synthetic-db-secret@db.internal:5432/app',
    DATABASE_PORT: '5432', DB_PORT: '5432', PGPORT: '5432', REDIS_URL: 'redis://cache.internal:6379' } : {}) };
  const expectedEnv = [...Object.entries(expectedRuntime).map(([name, value]) => ({ name, value })),
    ...(nativeReference ? [{ name: 'NATIVE_TOKEN', valueSource: { secretKeyRef: { secret: 'projects/123456789012/secrets/native-token', version: '7' } } }] : [])].sort((a, b) => a.name.localeCompare(b.name));
  const adc = join(directory, 'synthetic-adc.json'); writeFileSync(adc, JSON.stringify({ type: 'authorized_user', client_id: 'synthetic-client', client_secret: 'synthetic-client-secret', refresh_token: 'synthetic-refresh' }), { mode: 0o600 });
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', adc);
  const state = { repeatJobPatches: 0, repeatEnvPatches: 0, nextImage: undefined as string | undefined, loseCreateAcknowledgment: false, loseAcknowledgment: false, actAs: true, patches: 0, patchRequests: 0, generatedDisappears: false, finalObservations: 0, transportErrors: [] as string[] };
  const web = receipt.preparedResources.workloads.find(item => item.workload === 'web')!;
  const final = receipt.runtimeIdentities.find(item => item.workload === 'web')!.principal;
  if (final.kind !== 'gcp-service-account') throw new Error('Expected independently prepared native account');
  const migrationCommand = 'npm run db:migrate:production', migrationHash = createHash('sha256').update(migrationCommand).digest('hex');
  const jobResource = `${web.id.replace('/services/', '/jobs/')}-migration`;
  const task = { containers: [{ image: candidate, command: ['/bin/sh'], args: ['-lc', migrationCommand],
    env: expectedEnv, resources: { limits: { cpu: '1', memory: '512Mi' } } }],
    serviceAccount: final.serviceAccountEmail, maxRetries: 0, timeout: '3600s' };
  const job = { name: jobResource, uid: 'migration-job-uid', etag: 'migration-etag', generation: '1', observedGeneration: '1',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' }, template: { template: task } };
  const execution = { name: `${jobResource}/executions/first-schema`, uid: 'migration-execution-uid', job: jobResource,
    template: task, taskCount: 1, succeededCount: 1, completionTime: '2026-10-31T12:00:00Z',
    conditions: [{ type: 'Completed', state: 'CONDITION_SUCCEEDED' }] };
  let secondExecution: typeof execution | undefined;
  const taskState = { creates: 0, runs: 0 };
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-local-holding-token', token_type: 'Bearer', expires_in: 3600 });
    if (url.pathname.endsWith('/domainmappings')) return Response.json({ items: [] });
    if (nativeReference && url.hostname === 'secretmanager.googleapis.com') {
      expect(init.method ?? 'GET').toBe('GET');
      const name = 'projects/123456789012/secrets/native-token';
      if (url.pathname === `/v1/${name}`) return Response.json({ name, createTime: '2026-10-25T02:00:00Z' });
      if (url.pathname === `/v1/${name}/versions/7`) return Response.json({ name: `${name}/versions/7`, state: 'ENABLED' });
      if (url.pathname === `/v1/${name}:getIamPolicy`) return Response.json({ etag: 'synthetic-reader-policy', bindings: [{ role: 'roles/secretmanager.secretAccessor',
        members: receipt.runtimeIdentities.map(item => `serviceAccount:${(item.principal as any).serviceAccountEmail}`) }] });
      throw new Error('Unexpected native secret read');
    }
    if (url.hostname === 'run.googleapis.com' && url.pathname.endsWith('/services') && (!init.method || init.method === 'GET')) {
      if (state.patches === 2 && ++state.finalObservations === (nativeReference ? 1 : 3) && state.generatedDisappears) {
        for (const service of f.native.services.values()) service.template.containers[0].env = service.template.containers[0].env.filter((item: any) => !['GENERATED_TOKEN', 'NATIVE_TOKEN'].includes(item.name));
      }
      return Response.json({ services: [...f.native.services.values()] });
    }
    if (migration && url.hostname === 'run.googleapis.com') {
      if (secondExecution && url.pathname === `/v2/${secondExecution.name}`) return Response.json(secondExecution);
      if (state.nextImage && url.pathname === `/v2/${jobResource}` && init.method === 'PATCH') {
        const submitted = JSON.parse(String(init.body)).template.template;
        const nextTask = { ...task, containers: [{ ...task.containers[0], image: state.nextImage }], maxRetries: 1 };
        expect(submitted).toEqual(nextTask);
        state.repeatJobPatches++;
        Object.assign(job, { etag: 'second-migration-etag', generation: '2', observedGeneration: '2', template: { template: nextTask } });
        return Response.json({ name: 'projects/operator-project/locations/us-central1/operations/update-migration', done: true, response: job });
      }
      if (state.nextImage && url.pathname === `/v2/${jobResource}:run` && init.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({});
        taskState.runs++;
        secondExecution = { ...execution, name: `${jobResource}/executions/second-schema`, uid: 'second-migration-execution-uid', template: structuredClone(job.template.template) };
        return Response.json({ name: 'projects/operator-project/locations/us-central1/operations/second-migration', done: true, response: secondExecution });
      }
      if (url.pathname === `/v2/${jobResource}/executions`) return Response.json({ executions: taskState.runs ? [execution] : [] });
      if (url.pathname === `/v2/${execution.name}`) return Response.json(execution);
      if (url.pathname === `/v2/${jobResource}` && (!init.method || init.method === 'GET'))
        return taskState.creates ? Response.json(job) : Response.json({}, { status: 404 });
      if (url.pathname.endsWith('/jobs') && init.method === 'POST') {
        taskState.creates++;
        expect(JSON.parse(String(init.body)).template.template).toEqual(task);
        if (state.loseCreateAcknowledgment) throw new Error('Synthetic lost create acknowledgment');
        return Response.json({ name: 'projects/operator-project/locations/us-central1/operations/create-migration', done: true, response: job });
      }
      if (url.pathname === `/v2/${jobResource}:run` && init.method === 'POST') {
        taskState.runs++; expect(JSON.parse(String(init.body))).toEqual({ etag: job.etag });
        return Response.json({ name: 'projects/operator-project/locations/us-central1/operations/run-migration', done: true, response: execution });
      }
    }
    if (url.hostname === 'run.googleapis.com' && url.pathname.endsWith('/jobs') && (!init.method || init.method === 'GET')) return Response.json({ jobs: taskState.creates ? [job] : [] });
    if (url.hostname === 'iam.googleapis.com' && url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: state.actAs ? ['iam.serviceAccounts.actAs'] : [] });
    const target = receipt.preparedResources.workloads.find(item => url.pathname === `/v2/${item.id}`);
    if (url.hostname === 'run.googleapis.com' && target && init.method === 'PATCH') {
      if (state.nextImage) {
        const body = JSON.parse(String(init.body)), before = f.native.services.get(target.id)!;
        if (url.searchParams.get('updateMask') === 'template.containers') {
          expect(body.template.containers[0].image).toBe(before.template.containers[0].image);
          expect(body.template.containers[0].env.slice().sort((a: any, b: any) => a.name.localeCompare(b.name))).toEqual(expectedEnv);
          expect(body.template).not.toHaveProperty('serviceAccount');
          state.repeatEnvPatches++;
          f.native.services.set(target.id, { ...before, etag: 'second-runtime-etag', generation: '3', observedGeneration: '3',
            latestCreatedRevision: `${target.id}/revisions/runtime-00003`, latestReadyRevision: `${target.id}/revisions/runtime-00003` });
          return Response.json({ name: 'projects/operator-project/locations/us-central1/operations/second-runtime', done: true,
            response: { name: target.id, uid: target.lifetimeId } });
        }
        if (migration && target.workload === 'web') { expect(taskState).toEqual({ creates: 1, runs: 2 }); expect(state.repeatJobPatches).toBe(1); }
        expect(body.template.serviceAccount).toBe(before.template.serviceAccount);
        expect(body.template.containers[0].image).toBe(state.nextImage);
        expect(body.template.containers[0].env.slice().sort((a: any, b: any) => a.name.localeCompare(b.name))).toEqual(expectedEnv);
        // Independent next Service observation; never echo submitted payloads.
        f.native.services.set(target.id, { ...before, etag: 'second-application-etag', generation: '4', observedGeneration: '4',
          latestCreatedRevision: `${target.id}/revisions/application-00004`, latestReadyRevision: `${target.id}/revisions/application-00004`,
          template: { ...before.template, containers: [{ ...before.template.containers[0], image: state.nextImage }] } });
        state.patchRequests++; state.patches++;
        return Response.json({ name: 'projects/operator-project/locations/us-central1/operations/second-application', done: true,
          response: { name: target.id, uid: target.lifetimeId } });
      }
      if (migration) expect(taskState).toEqual({ creates: 1, runs: 1 });
      state.patchRequests++;
      expect((load().platformBindings.preparedDirectReleaseAttempts as any)[target.workload].status).toMatch(/^(attempted|uncertain)$/); state.patches++;
      const before = f.native.services.get(target.id)!;
      const principal = receipt.runtimeIdentities.find(item => item.workload === target.workload)!.principal;
      if (principal.kind !== 'gcp-service-account') throw new Error('Expected runtime identity');
      const worker = target.workload === 'worker';
      // Independent final Service JSON, not a response echo of the PATCH body.
      f.native.services.set(target.id, { ...before, generation: '2', observedGeneration: '2', etag: 'application-etag',
        ...(migration && !worker ? { annotations: { 'hypervibe.dev/release-command-sha256-v1': migrationHash } } : {}),
        latestCreatedRevision: `${target.id}/revisions/application-00002`, latestReadyRevision: `${target.id}/revisions/application-00002`,
        ingress: worker ? 'INGRESS_TRAFFIC_INTERNAL_ONLY' : 'INGRESS_TRAFFIC_ALL', invokerIamDisabled: false,
        ...(worker ? { scaling: { scalingMode: 'AUTOMATIC', minInstanceCount: 1, maxInstanceCount: 1 } } : {}),
        template: { serviceAccount: principal.serviceAccountEmail, executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
          scaling: { minInstanceCount: worker ? 1 : 0, maxInstanceCount: 100 }, timeout: '300s', maxInstanceRequestConcurrency: 80,
          containers: [{ image: candidate, ports: [{ containerPort: 8080 }], env: structuredClone(expectedEnv),
            resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: !worker, startupCpuBoost: false },
            startupProbe: { tcpSocket: { port: 8080 }, periodSeconds: 240, timeoutSeconds: 240, failureThreshold: 1 } }] } });
      if (state.loseAcknowledgment) { state.loseAcknowledgment = false; throw new Error('Synthetic lost application acknowledgment'); }
      return Response.json({ name: 'projects/operator-project/locations/us-central1/operations/application', done: true, response: { name: target.id, uid: target.lifetimeId } });
    }
    return f.native.request(input, init);
  };
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => { try { return await request(...args); }
    catch (error) { state.transportErrors.push(String(error)); throw error; } });
  changeHolding?.(f.native.services.get(web.id)!);
  const resolved = await adapterFactory.getHostingAdapter(f.project, 'staging');
  expect(resolved.success, resolved.error).toBe(true);
  const adapter = resolved.adapter as unknown as CloudRunAdapter;
  const spec = f.store.get(f.project)!.spec, environmentSpec = spec.environments.staging;
  expect(await adapter.preparedHosting!.inspect({ environment: load(), environmentSpec })).toMatchObject({ state: 'verified' });
  const metadata = await planPreparedHosting({ environment: load(), environmentSpec, hosting: adapter, project: f.project, spec, managedSecretValues });
  expect(metadata).not.toBeNull();
  if (!applicationMetadata) expect(await applyPreparedHosting({ ctx: f.ctx, project: f.project, environmentName: 'staging', environmentSpec, spec, managedSecretValues, action: metadata!,
    confirmedActionIds: new Set([metadata!.id]), authorize: () => true })).toMatchObject({ success: true });
  const now = new Date();
  const service: Service = { id: 'local-web', projectId: f.project.id, name: 'web', buildConfig: { public: true,
    ...(migration ? { releaseCommand: migrationCommand } : {}) }, envVarSpec: {}, createdAt: now, updatedAt: now };
  const control = createPreparedDirectReleaseControl({ planRunId: 'reviewed-local-plan', confirmed: true, expectedImage: candidate,
    action: reviewPreparedDirectReleaseActions([{ id: 'service:web', type: 'update', verified: true, requiresConfirm: true, resource: { kind: 'service', provider: 'cloudrun', name: 'web' }, reason: 'Reviewed local first release',
      ...(migration ? { diff: [{ field: 'releaseCommand', to: migrationCommand }] } : {}) }], load(), { web: candidate })[0]!,
    load, save: (before, next) => !!f.ctx.repos.environments.compareAndSwapPlatformBindings(before.id, before.platformBindings, next), authorize: () => true });
  return { ...f, load, receipt, adapter, service, control, state, candidate, environmentSpec, expectedRuntime, managedSecretValues, metadata, taskState, execution, job, reference };
}
describe('local journal-backed prepared application release', () => {
  it.each([false, true])('updates a completed native installation through plan/apply without legacy preparation; migration=%s', async migration => {
    // Redacted live counterexample, 2026-11-01: both first releases completed,
    // native identities/readers stayed ready, but the second image apply asked
    // for broad legacy preparation because pendingFirstRelease was empty.
    const f = await fixture(undefined, false, true, migration, true);
    for (let phase = 0; phase < 7 && f.state.patches < 2; phase++) {
      const first = await new PlanService().plan(f.project, 'staging');
      if ('error' in first) throw new Error(first.error);
      expect(first.blocked).toEqual([]);
      expect(await f.apply(first.planRunId, first.actions.filter(a => a.type !== 'noop').map(a => a.id)))
        .toMatchObject({ kind: 'executed', result: { success: true } });
    }
    expect(f.state.patches).toBe(2);
    expect(f.load().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: [] });
    expect(f.ctx.repos.projects.findById(f.project.id)!.policies).not.toHaveProperty('cloudPreparation');
    const spec = f.store.get(f.project)!.spec, nextImage = f.candidate.replace(/f{64}$/, 'b'.repeat(64));
    f.store.replace(f.project, { ...spec, environments: { staging: { ...spec.environments.staging,
      envVars: { ...spec.environments.staging.envVars, IMAGE_URI: nextImage } } } });
    const plan = await new PlanService().plan(f.project, 'staging', { serviceFilter: ['web', 'worker'], includeEnvFile: false });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.blocked).toEqual([]);
    expect(plan.actions.filter(a => a.type !== 'noop').map(a => a.id)).toEqual(['service:web', 'service:worker']);
    f.state.nextImage = nextImage;
    const result = await f.apply(plan.planRunId, ['service:web', 'service:worker']);
    expect(result, JSON.stringify({ result, transportErrors: f.state.transportErrors })).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.state.patches).toBe(4);
    if (migration) { expect(f.taskState).toEqual({ creates: 1, runs: 2 }); expect(f.state.repeatJobPatches).toBe(1); }
    expect(f.ctx.repos.projects.findById(f.project.id)!.policies).not.toHaveProperty('cloudPreparation');
  });

  it.each(['unknown', 'missing-binding', 'missing-uid', 'changed-uid', 'receipt', 'scope', 'uncertain'] as const)('blocks completed preparation with %s before runtime writes', async fault => {
    const f = await fixture();
    const release = await f.adapter.deploy(f.service, f.load(), f.environmentSpec.envVars, { preparedRelease: f.control });
    expect(release.receipt.success).toBe(true);
    const before = f.load();
    const bound = completePreparedDirectRelease(before, release.receipt.data!.preparedRelease);
    f.ctx.repos.environments.compareAndSwapPlatformBindings(before.id, before.platformBindings, bound);
    const changed = structuredClone(f.load().platformBindings) as any;
    if (fault === 'missing-binding') delete changed.services.web;
    if (fault === 'missing-uid') delete changed.services.web.resourceUid;
    if (fault === 'changed-uid') changed.services.web.resourceUid = 'replacement-uid';
    if (fault === 'receipt') changed.preparedHosting.receiptDigest = '9'.repeat(64);
    if (fault === 'scope') changed.projectId = 'another-project';
    if (fault === 'uncertain') changed.preparedDirectReleaseAttempts.web.status = 'uncertain';
    f.ctx.repos.environments.compareAndSwapPlatformBindings(f.environment.id, f.load().platformBindings, changed);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: f.adapter as never });
    if (fault === 'unknown') vi.spyOn(f.adapter.preparedHosting!, 'inspect').mockResolvedValue({ state: 'unknown' });
    const result = await executeBootstrap({ projectName: f.project.name, environmentName: 'staging', services: ['web'], envVars: f.environmentSpec.envVars });
    expect(result).toMatchObject({ success: false, summary: { blocked: true, error: expect.stringContaining('re-run hv_plan') } });
    expect(JSON.stringify(result)).not.toContain('action=\"prepare\"');
    expect(f.state.patches).toBe(1); expect(f.state.repeatEnvPatches).toBe(0);
  });
  it('updates a completed selected workload while preserving a pending sibling', async () => {
    const f = await fixture();
    const release = await f.adapter.deploy(f.service, f.load(), f.environmentSpec.envVars, { preparedRelease: f.control });
    expect(release.receipt.success).toBe(true);
    const before = f.load(), bound = completePreparedDirectRelease(before, release.receipt.data!.preparedRelease);
    f.ctx.repos.environments.compareAndSwapPlatformBindings(before.id, before.platformBindings, bound);
    const marker = structuredClone(f.load().platformBindings.preparedHosting);
    const pending = f.receipt.preparedResources.workloads.find(item => item.workload === 'worker')!;
    const pendingNative = structuredClone(f.native.services.get(pending.id));
    f.state.nextImage = f.candidate.replace(/f{64}$/, 'b'.repeat(64));
    const result = await executeBootstrap({ projectName: f.project.name, environmentName: 'staging', services: ['web'],
      envVars: { ...f.environmentSpec.envVars, IMAGE_URI: f.state.nextImage } });
    expect(result, JSON.stringify({ result, transportErrors: f.state.transportErrors })).toMatchObject({ success: true });
    expect(f.load().platformBindings.preparedHosting).toEqual(marker);
    expect(f.native.services.get(pending.id)).toEqual(pendingNative);
    expect(f.state.patches).toBe(2);
    const mixed = await executeBootstrap({ projectName: f.project.name, environmentName: 'staging', services: ['web', 'worker'], envVars: f.environmentSpec.envVars });
    expect(mixed).toMatchObject({ success: false, summary: { blocked: true } });
    expect(f.state.patches).toBe(2);
  });
  it.each(['uid', 'etag', 'execution', 'execution-reference', 'missing', 'runtime-account'] as const)('rejects %s drift after reviewing migration job adoption', async drift => {
    const f = await fixture(undefined, false, false, true);
    f.state.loseCreateAcknowledgment = true;
    await f.adapter.deploy(f.service, f.load(), { ...f.expectedRuntime, IMAGE_URI: f.candidate }, { preparedRelease: f.control });
    const plan = await new PlanService().plan(f.project, 'staging');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.scope).toBe('hosting-prepared-bindings');
    const before = f.load().platformBindings;
    if (drift === 'uid') f.job.uid = 'replacement-uid';
    if (drift === 'etag') f.job.etag = 'changed-etag';
    if (drift === 'execution') f.taskState.runs = 1;
    if (drift === 'execution-reference') Object.assign(f.job, { latestCreatedExecution: { name: f.execution.name } });
    if (drift === 'missing') f.taskState.creates = 0;
    if (drift === 'runtime-account') f.job.template.template.serviceAccount = 'unreviewed@operator-project.iam.gserviceaccount.com';
    const counts = { ...f.taskState };
    expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.load().platformBindings).toEqual(before); expect(f.taskState).toEqual(counts); expect(f.state.patches).toBe(0);
  });
  it.each([false, true])('requires explicit exact-identity adoption before a new reviewed release with native reference=%s', async nativeReference => {
    const f = await fixture(undefined, false, false, true, nativeReference);
    // Recorded native zero-execution shape on the disposable GCP Job, 2026-11-01.
    Object.assign(f.job, { latestCreatedExecution: {} });
    f.state.loseCreateAcknowledgment = true;
    expect((await f.adapter.deploy(f.service, f.load(), { ...f.expectedRuntime, IMAGE_URI: f.candidate }, { preparedRelease: f.control, ...(nativeReference ? { secretVersionRefs: { NATIVE_TOKEN: f.reference } } : {}) })).receipt.success).toBe(false);
    expect(f.taskState).toEqual({ creates: 1, runs: 0 });
    const before = f.load().platformBindings;
    const plan = await new PlanService().plan(f.project, 'staging');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.scope).toBe('hosting-prepared-bindings');
    expect(plan.blocked).toEqual([]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].reason).toContain('Adopt');
    expect((await f.apply(plan.planRunId, []))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.load().platformBindings).toEqual(before);
    expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.taskState).toEqual({ creates: 1, runs: 0 }); expect(f.state.patches).toBe(0);
    expect((f.load().platformBindings.preparedDirectReleaseAttempts as any).web.releaseTask).toMatchObject({ phase: 'job-ready', adopted: true, jobUid: f.job.uid, jobEtag: f.job.etag });
    let completedPlan: Exclude<Awaited<ReturnType<PlanService['plan']>>, { error: string }> | undefined;
    for (let phase = 0; phase < 5; phase++) {
      const next = await new PlanService().plan(f.project, 'staging');
      if ('error' in next) throw new Error(next.error);
      expect(next.blocked).toEqual([]);
      const applied = await f.apply(next.planRunId, next.actions.filter(a => a.requiresConfirm).map(a => a.id));
      expect(applied, JSON.stringify(applied)).toMatchObject({ kind: 'executed', result: { success: true } });
      if (f.state.patches === 2) { completedPlan = next; break; }
    }
    expect(f.state.patches).toBe(2); expect(f.taskState).toEqual({ creates: 1, runs: 1 });
    if (nativeReference) {
      expect(f.load().platformBindings.secretVersionBindings).toMatchObject({ NATIVE_TOKEN: { reference: { version: '7' } } });
      expect(completedPlan).toBeDefined();
      for (const drift of ['missing-continuation', 'different-attempt', 'configuration', 'resource-lifetime'] as const) {
        const actions = structuredClone(completedPlan!.actions);
        const web = actions.find(action => action.id === 'service:web')!;
        if (drift === 'missing-continuation') delete web.metadata!.preparedReleaseContinuation;
        if (drift === 'different-attempt') web.metadata!.preparedReleaseContinuation = 'another-attempt';
        const review = web.metadata!.preparedReleaseReview as Record<string, unknown>;
        if (drift === 'configuration') review.configurationDigest = 'e'.repeat(64);
        if (drift === 'resource-lifetime') review.resourceUid = 'replacement-service-uid';
        expect(await preparedSecretReleaseError({ ctx: f.ctx, project: f.project, environment: f.load(),
          environmentSpec: f.environmentSpec, services: ['web', 'worker'], actions, planId: completedPlan!.planRunId }))
          .toMatch(/exact completed first-release/);
      }
      expect(f.state.patchRequests).toBe(2); expect(f.taskState).toEqual({ creates: 1, runs: 1 });
    }
  });
  it.each([false, true])('deploys and accepts an immutable native reference through its actual first-release plan with drift=%s', async drift => {
    // Observed live on 2026-11-01: the planner added preparedReleaseBinding,
    // then the strict apply schema rejected that same metadata before rollout.
    const f = await fixture(undefined, false, true, true, true);
    f.state.generatedDisappears = drift;
    for (let phase = 0; phase < 7; phase++) {
      const plan = await new PlanService().plan(f.project, 'staging');
      if ('error' in plan) throw new Error(plan.error);
      expect(plan.blocked).toEqual([]);
      const applied = await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id));
      if (drift && f.state.patches === 2 && 'result' in applied && !applied.result.success) {
        expect(f.state.patchRequests).toBe(2);
        expect(f.load().platformBindings.secretVersionBindings).toBeUndefined();
        return;
      }
      expect(applied, JSON.stringify({ applied, transportErrors: f.state.transportErrors })).toMatchObject({ kind: 'executed', result: { success: true } });
      if (f.state.patches === 2) break;
    }
    expect(f.state.patchRequests).toBe(2);
    expect(drift).toBe(false);
    expect(f.taskState).toEqual({ creates: 1, runs: 1 });
    expect(f.load().platformBindings.secretVersionBindings).toMatchObject({ NATIVE_TOKEN: { reference: { version: '7' } } });
    expect((f.load().platformBindings.secretVersionBindings as any).NATIVE_TOKEN).not.toHaveProperty('preparedReleaseBinding');
  });
  it.each([false, true])('runs first-release migrations through the saved plan and verifies recovery with lost rollout=%s', async lost => {
    const f = await fixture(undefined, false, true, true);
    f.state.loseAcknowledgment = lost;
    let recovered = false;
    for (let phase = 0; phase < 7; phase++) {
      const plan = await new PlanService().plan(f.project, 'staging');
      if ('error' in plan) throw new Error(plan.error);
      expect(plan.blocked).toEqual([]);
      const web = plan.actions.find(action => action.id === 'service:web' && action.type !== 'noop');
      if (web) expect(plan.actions.find(action => action.id === 'service:worker')?.dependsOn).toContain('service:web');
      const applied = await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id));
      if (lost && !recovered && 'result' in applied && !applied.result.success && f.state.patches === 1) { recovered = true; continue; }
      expect(applied).toMatchObject({ kind: 'executed', result: { success: true } });
      if (f.state.patches === 2) break;
    }
    expect(f.state.patches).toBe(2); expect(f.taskState).toEqual({ creates: 1, runs: 1 });
    expect(f.load().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: [] });
    f.execution.uid = 'replaced-execution';
    expect(await f.adapter.preparedHosting!.inspect({ environment: f.load(), environmentSpec: f.environmentSpec })).toEqual({ state: 'unknown' });
  });
  it.each([{ secrets: false, lost: false, race: false }, { secrets: true, lost: false, race: false }, { secrets: true, lost: true, race: false }, { secrets: true, lost: false, race: true }])('executes the saved application plan through bootstrap and orchestration %j', async ({ secrets, lost, race }) => {
    const f = await fixture(undefined, secrets ? 'secrets' : false, true);
    vi.stubEnv('HV_TEST_DELEGATED_VALUE', 'synthetic-delegated-token');
    f.state.loseAcknowledgment = lost; f.state.generatedDisappears = race; let uncertain = false; let recoveryWithoutInputs = false;
    for (let phase = 0; phase < 6; phase++) {
      const readonlyRecovery = uncertain && !recoveryWithoutInputs;
      const plan = await new PlanService().plan(f.project, 'staging', secrets && !readonlyRecovery ? { secretRefs: { DELEGATED_TOKEN: 'env:HV_TEST_DELEGATED_VALUE' } } : undefined);
      expect(plan).not.toHaveProperty('error');
      if (readonlyRecovery) { expect(plan).toHaveProperty('scope', 'hosting-prepared-bindings'); recoveryWithoutInputs = true; }
      if ('error' in plan) throw new Error(plan.error);
      expect(plan.blocked).toEqual([]);
      for (const value of Object.values(f.managedSecretValues ?? {})) expect(JSON.stringify(plan)).not.toContain(value);
      if (!secrets && plan.actions.some(action => action.id === 'service:web' && action.type !== 'noop')) {
        expect(await f.apply(plan.planRunId, [])).toMatchObject({ kind: 'executed', result: { success: false } });
        expect(f.state.patches).toBe(0);
      }
      if (secrets) vi.stubEnv('HV_TEST_DELEGATED_VALUE', 'changed-after-plan');
      const applied = await f.apply(plan.planRunId, plan.actions.filter(a => a.requiresConfirm).map(a => a.id));
      if (secrets) vi.stubEnv('HV_TEST_DELEGATED_VALUE', 'synthetic-delegated-token');
      if (race && f.state.patches === 2 && 'result' in applied && !applied.result.success) {
        expect(f.state.finalObservations).toBeGreaterThanOrEqual(3);
        expect(f.state.patchRequests).toBe(2);
        return;
      }
      if (lost && !uncertain && 'result' in applied && !applied.result.success && f.state.patches === 1) uncertain = true;
      else expect(applied, JSON.stringify({ plan, applied, runs: f.ctx.repos.runs.findByProjectId(f.project.id).filter(run => run.type === 'deploy') })).toMatchObject({ kind: 'executed', result: { success: true } });
      if (f.state.patches === 2 && 'result' in applied && applied.result.success) break;
    }
    expect(f.state.patches).toBe(2);
    expect(f.load().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: [] });
  });
  it('reviews the resolved generated, delegated and component inputs used by the first application revision', async () => {
    const f = await fixture(undefined, true);
    const result = await f.adapter.deploy(f.service, f.load(), { ...f.expectedRuntime, IMAGE_URI: f.candidate }, { preparedRelease: f.control });
    expect(result.receipt.success, result.receipt.error).toBe(true);
    expect(f.state.patches).toBe(1);
    for (const value of Object.values(f.managedSecretValues!)) expect(JSON.stringify(f.metadata)).not.toContain(value);
    expect(deriveHypervibeSecretValues(f.store.get(f.project)!.spec, 'staging')).toMatchObject({ GENERATED_TOKEN: f.managedSecretValues!.GENERATED_TOKEN });
  });
  it('rejects a later holding revision before proposing local prepared metadata', async () => {
    await expect(fixture(native => { native.generation = '2'; native.observedGeneration = '2';
      native.latestCreatedRevision = `${native.name}/revisions/holding-replaced`; native.latestReadyRevision = native.latestCreatedRevision;
    })).rejects.toThrow();
  });
  it('requires durable release authority and never infers a hosted connection from local binding bytes', async () => {
    const f = await fixture();
    const result = await f.adapter.deploy(f.service, f.load(), f.environmentSpec.envVars);
    expect(result.receipt.success).toBe(false); expect(f.state.patches).toBe(0);
    expect((f.adapter as any).deploymentConnection).toBeNull();
  });
  it.each([false, true])('releases with native local authority and safely recovers lost acknowledgment=%s', async lost => {
    const f = await fixture(); f.state.loseAcknowledgment = lost;
    let result = await f.adapter.deploy(f.service, f.load(), f.environmentSpec.envVars, { preparedRelease: f.control });
    if (lost) {
      expect(result.receipt.success).toBe(false);
      result = await f.adapter.deploy(f.service, f.load(), f.environmentSpec.envVars, { preparedRelease: f.control });
    }
    expect(result.receipt).toMatchObject({ success: true, data: { preparedRelease: { kind: 'native-direct' } } });
    expect(f.state.patches).toBe(1);
    const before = f.load(), next = completePreparedDirectRelease(before, result.receipt.data!.preparedRelease);
    expect(f.ctx.repos.environments.compareAndSwapPlatformBindings(before.id, before.platformBindings, next)).toBeTruthy();
    expect(f.load().platformBindings.localPreparedHosting).toEqual(f.receipt);
    expect(f.load().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: ['worker'] });
  });
  it('blocks a revoked local actAs permission before any application PATCH', async () => {
    const f = await fixture(); f.state.actAs = false;
    expect((await f.adapter.deploy(f.service, f.load(), f.environmentSpec.envVars, { preparedRelease: f.control })).receipt.success).toBe(false);
    expect(f.state.patches).toBe(0); expect(f.load().platformBindings.preparedDirectReleaseAttempts).toBeUndefined();
  });
});
