import type { PlanAction } from '../../domain/plan/plan.types.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { planQueues } from '../../domain/services/queue-plan.service.js';
import { CLOUD_PREPARE_PROFILES, QUEUE_PREPARE_ADDON } from '../../domain/services/cloud-prepare.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { observeRuntimeAccess, planRuntimeAccess } from '../../domain/services/runtime-access.service.js';
import type { IProviderAdapter } from '../../domain/ports/provider.port.js';
import type { IStorageAdapter } from '../../domain/ports/storage.port.js';
import type { StorageRuntimeAccessBinding, StorageRuntimeAccessTarget } from '../../domain/ports/storage-runtime-access.port.js';
import '../providers.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { getSecretStore, SecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';

// Real SQLite/spec/planner/application executor. Provider behavior is a synthetic
// capability model; the native wire suites separately validate its API contracts.
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-runtime-access-apply-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SecretStore.resetInstance(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function fixture(managedCi = false) {
  const nativeMetadata = providerRegistry.getMetadata.bind(providerRegistry);
  vi.spyOn(providerRegistry, 'getMetadata').mockImplementation(name => { const metadata = nativeMetadata(name); return name === 's3' && metadata ? { ...metadata, storageRuntimeAccess: { hostingProviders: ['ecs'] } } : name === 'ecs' && metadata?.lifecycle?.hosting ? { ...metadata, lifecycle: { ...metadata.lifecycle, hosting: { ...metadata.lifecycle.hosting, runtimeIdentityTiming: 'after-workload' as const } } } : metadata; });
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'runtime-access-app', defaultPlatform: 'ecs', ...(managedCi ? { gitRemoteUrl: 'https://github.com/example/runtime-access-app.git' } : {}) });
  if (managedCi) {
    const connection = ctx.repos.connections.create({ provider: 'github', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-contract-token' }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' } as never);
  }
  new SpecStore().replace(project, { version: 1, project: project.name, ...(managedCi ? { gitRemoteUrl: project.gitRemoteUrl, runtime: { kind: 'node', version: '22', installCommand: 'npm ci' } } : {}), environments: Object.fromEntries(['staging', 'production'].map(name => [name, {
    hosting: { provider: 'ecs', region: 'us-west-2' }, services: { web: {} }, deploy: managedCi ? { strategy: 'branch', trigger: 'ci', branch: 'main' } : { strategy: 'manual' }, backups: { mode: 'disabled', reason: 'Synthetic disposable lifecycle test.' },
    storage: { documents: { provider: 's3', type: 'bucket', region: 'us-west-2', injectInto: ['web'] } },
  }])) });
  const createEnvironment = (name: string) => ctx.repos.environments.create({ projectId: project.id, name, platformBindings: {
    provider: 'ecs', projectId: `cluster-${name}`, environmentId: `cluster-${name}`, services: { web: { serviceId: `service-${name}` } }, appliedSpecHash: 'previous-accepted-state',
    storage: { documents: { provider: 's3', externalId: `bucket-${name}`, instanceScope: { accountId: 'account', region: 'us-west-2' }, region: 'us-west-2', services: ['web'], envKeys: ['AWS_S3_BUCKET'] } },
  } });
  const grants = new Map<string, StorageRuntimeAccessBinding>(); const writes: string[] = [];
  const key = (target: StorageRuntimeAccessTarget) => `${target.environment.id}/${target.externalId}/${target.identity.principal}`;
  let loseGrant = false;
  const access = {
    hostingProviders: ['ecs'],
    observe: vi.fn(async (target: StorageRuntimeAccessTarget) => grants.has(key(target)) ? { state: 'present' as const, binding: grants.get(key(target))! } : { state: 'absent' as const }),
    grant: vi.fn(async (target: StorageRuntimeAccessTarget, attemptId: string) => {
      const persisted = ctx.repos.environments.findById(target.environment.id)!;
      expect((persisted.platformBindings.storageRuntimeAccess as any).documents.web.pending.attemptId).toBe(attemptId);
      const existing = grants.get(key(target));
      if (existing) { expect(existing.attemptId).toBe(attemptId); return { receipt: { success: true, message: 'Recovered' }, binding: existing }; }
      const binding = { id: `policy-${target.environment.id}`, attemptId, evidence: { environmentId: target.environment.id, principal: target.identity.principal } };
      grants.set(key(target), binding); writes.push(`grant:${target.environment.name}`);
      if (loseGrant) throw new Error('Lost serialized response');
      return { receipt: { success: true, message: 'Verified' }, binding };
    }),
    revoke: vi.fn(async (target: StorageRuntimeAccessTarget) => { grants.delete(key(target)); writes.push(`revoke:${target.environment.name}`); return { success: true, message: 'Absent' }; }),
  };
  const hosting = { name: 'ecs', configureTarget: vi.fn(), resolveRuntimeIdentity: vi.fn(async (environment: any) => ({ provider: 'aws', principal: `role-${environment.name}`, source: 'observed', scope: { accountId: 'account', roleId: `role-id-${environment.name}`, environmentId: environment.id } })) } as unknown as IProviderAdapter;
  const deploy = vi.fn(async (service: any, environment: any, variables: Record<string, string>, options: any) => {
    expect(options).toMatchObject({ deferDeployment: true, requireNewWorkload: true });
    expect(variables).not.toHaveProperty('AWS_ACCESS_KEY_ID'); expect(variables).not.toHaveProperty('AWS_S3_BUCKET');
    writes.push(`holding:${environment.name}`);
    return { serviceId: service.id, externalId: `service-${environment.name}`, status: 'configured', receipt: { success: true, message: 'Exact holding workload created', data: { serviceId: `service-${environment.name}`, created: true, deploymentDeferred: true } } };
  });
  const hostingLifecycle = { name: 'ecs', capabilities: { supportsDeferredDeploy: true, supportsCreateOnlyDeploy: true }, configureTarget: vi.fn(), deploy,
    ensureProject: vi.fn(async (_name: string, environment: any) => { writes.push(`project:${environment.name}`); return { success: true, message: 'Exact project created', data: { projectId: `cluster-${environment.name}`, environmentId: `cluster-${environment.name}`, created: true } }; }) };
  const storage = { name: 's3', runtimeAccess: access } as unknown as IStorageAdapter;
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: hosting });
  vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: hostingLifecycle as never });
  vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true, adapter: storage });
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(async (_project, environment, environmentSpec) => ({ warnings: [], observed: {
    provider: 'ecs', observedAt: '2026-10-24T00:00:00Z', projectExists: Boolean(environment?.platformBindings.projectId), ...(environment?.platformBindings.projectId ? { projectId: `cluster-${environment.name}`, environmentId: `cluster-${environment.name}` } : {}),
    services: (environment?.platformBindings.services as any)?.web ? [{ name: 'web', externalId: `service-${environment!.name}`, workloadKind: 'web', config: {}, envVarKeys: [], envVarHashes: {}, status: 'running', customDomains: [] }] : [], databases: [], storage: [], warnings: [], partial: false, completeness: { services: 'complete', databases: 'complete', storage: 'complete', storageByProvider: { s3: 'complete' } },
    runtimeAccess: await observeRuntimeAccess({ environment, environmentSpec, hosting, storageAdapters: { s3: storage } }),
  } }));
  const plan = async (name = 'staging') => { const result = await new PlanService().plan(project, name, { includeEnvFile: false }); if ('error' in result) throw new Error(result.error); return result; };
  const apply = (planId: string, confirmActions: string[] = []) => { const spec = new SpecStore().get(project)!; return executePlanApply(ctx, { project, spec: spec.spec, specRevision: spec.revision, planId, confirmActions }); };
  return { ctx, project, createEnvironment, plan, apply, hosting, storage, access, writes, deploy, set loseGrant(value: boolean) { loseGrant = value; } };
}

describe('runtime access through saved plans and SQLite', () => {
  it('persists an isolated exact grant action, recovers a lost response across reload, and leaves production untouched', async () => {
    const f = fixture(); const staging = f.createEnvironment('staging'); const production = f.createEnvironment('production');
    const untouched = structuredClone(production.platformBindings); const planned = await f.plan();
    expect(planned.scope).toBe('runtime-access'); expect(planned.actions).toHaveLength(1); expect(planned.actions[0].metadata?.operation).toBe('storageRuntimeGrant');
    const saved = f.ctx.repos.runs.findById(planned.planRunId)!; expect(saved.plan).not.toHaveProperty('overrides');
    f.loseGrant = true;
    expect(await f.apply(planned.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    const pending = (f.ctx.repos.environments.findById(staging.id)!.platformBindings.storageRuntimeAccess as any).documents.web.pending.attemptId;
    const recovery = await f.plan(); expect(recovery.actions[0].metadata?.operation).toBe('storageRuntimeRecover');
    f.loseGrant = false;
    expect(await f.apply(recovery.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.access.grant.mock.calls[1][1]).toBe(pending); expect(f.writes).toEqual(['grant:staging']);
    const bound = f.ctx.repos.environments.findById(staging.id)!;
    expect(bound.platformBindings.appliedSpecHash).toBe('previous-accepted-state');
    expect(planRuntimeAccess(await observeRuntimeAccess({ environment: bound, environmentSpec: new SpecStore().get(f.project)!.spec.environments.staging, hosting: f.hosting, storageAdapters: { s3: f.storage } }))).toEqual([]);
    expect(f.ctx.repos.environments.findById(production.id)!.platformBindings).toEqual(untouched);
  });

  it.each([false, true])('prepares only the first holding workload without a volume or early access (managed CI: %s)', async managedCi => {
    const f = fixture(managedCi);
    const observed = await observeRuntimeAccess({ environment: null, environmentSpec: new SpecStore().get(f.project)!.spec.environments.staging, hosting: f.hosting, storageAdapters: { s3: f.storage } });
    expect(planRuntimeAccess(observed)).toEqual([]); expect(f.access.observe).not.toHaveBeenCalled(); expect(f.hosting.resolveRuntimeIdentity).not.toHaveBeenCalled();
    expect(f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')).toBeNull(); expect(f.writes).toEqual([]);
    const planned = await f.plan();
    expect(planned.scope).toBe(managedCi ? 'managed-ci-bindings' : 'hosting-bindings');
    expect(planned.actions.every(action => ['project', 'environment', 'service'].includes(action.resource.kind))).toBe(true);
    expect(planned.actions.some(action => action.resource.kind === 'service')).toBe(true);
    expect(f.access.grant).not.toHaveBeenCalled();
    const applied = await f.apply(planned.planRunId, planned.actions.filter(action => action.requiresConfirm).map(action => action.id));
    expect(applied, JSON.stringify({ actions: planned.actions, applied })).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.deploy).toHaveBeenCalledOnce();
    expect(f.writes).toEqual(['project:staging', 'holding:staging']);
    expect(f.access.grant).not.toHaveBeenCalled(); expect(f.access.revoke).not.toHaveBeenCalled();
    expect(f.ctx.repos.environments.findByProjectAndName(f.project.id, 'staging')!.platformBindings).not.toHaveProperty('appliedSpecHash');
  });
});

async function queueFixture() {
  const ctx = createCommandContext(); const profile = CLOUD_PREPARE_PROFILES.cloudrun;
  const project = ctx.repos.projects.create({ name: 'queue-runtime-app', defaultPlatform: 'cloudrun', policies: { cloudPreparation: { cloudrun: {
    provider: 'cloudrun', version: profile.version, gcpProjectId: 'gcp-project', preparedAt: '2026-10-24T00:00:00Z',
    requiredApis: [...profile.requiredApis, ...QUEUE_PREPARE_ADDON.requiredApis],
    requiredRoles: [...profile.requiredRoles, 'projects/gcp-project/roles/hypervibeRuntimeIdentityV1', ...QUEUE_PREPARE_ADDON.requiredRoles],
  } } } });
  new SpecStore().replace(project, { version: 1, project: project.name, environments: Object.fromEntries(['staging', 'production'].map(name => [name, {
    hosting: { provider: 'cloudrun', region: 'us-central1' }, services: { web: {}, worker: { workloadKind: 'worker' } },
    deploy: { strategy: 'manual' }, queues: { 'email-jobs': { ackDeadlineSeconds: 120 } },
    backups: { mode: 'disabled', reason: 'Disposable transport contract fixture.' },
  }])) });
  const createEnvironment = (name: string) => ctx.repos.environments.create({ projectId: project.id, name,
    platformBindings: { provider: 'cloudrun', projectId: 'gcp-project', environmentId: name, appliedSpecHash: `accepted-${name}`,
      services: { web: { serviceId: `projects/gcp-project/locations/us-central1/services/web-${name}` } } } });
  const staging = createEnvironment('staging'); const production = createEnvironment('production');
  const adapter = new CloudRunAdapter(); await adapter.connect({ projectId: 'gcp-project', credentials: '{}' });
  Object.assign(adapter, { accessToken: 'synthetic-contract-token', tokenExpiry: new Date(Date.now() + 3_600_000) });
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
  const hosting = vi.spyOn(adapterFactory, 'getHostingAdapter').mockRejectedValue(new Error('Queue prerequisite may not change workloads'));
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
  // The shared read-only deployment preflight is outside this fixture; all queue
  // observations and writes still pass through the real native transport.
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
  const { topicId, subscriptionId } = adapter.queueResourceNames(staging, 'email-jobs');
  const topicName = `projects/gcp-project/topics/${topicId}`;
  const subscriptionName = `projects/gcp-project/subscriptions/${subscriptionId}`;
  // Reconstructed Pub/Sub v1 REST responses, using published Topic and Subscription
  // fields. Only transport is replaced; the real adapter serializes and verifies.
  // https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.topics/create
  // https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions/create
  const labels = { 'infraprint-environment': 'staging', 'infraprint-queue': 'email-jobs' };
  const resources = new Map<string, Record<string, unknown>>(); const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); expect(url.origin).toBe('https://pubsub.googleapis.com');
    const name = url.pathname.replace(/^\/v1\//, ''); const method = init?.method ?? 'GET';
    if (method === 'GET') return resources.has(name) ? Response.json(resources.get(name)) : new Response(null, { status: 404 });
    expect(method).toBe('PUT'); expect([topicName, subscriptionName]).toContain(name);
    const body = JSON.parse(String(init?.body)); expect(body.labels).toEqual(labels);
    const resource = name === topicName ? { name: topicName, labels } : { name: subscriptionName, topic: topicName, ackDeadlineSeconds: 120, labels };
    if (name === subscriptionName) expect(body).toMatchObject({ topic: topicName, ackDeadlineSeconds: 120 });
    expect(resources.has(name)).toBe(false); resources.set(name, resource); writes.push(`${method} ${name}`);
    return Response.json(resource);
  }));
  const stored = new SpecStore().get(project)!;
  const planned = await planQueues({ project, environmentSpec: stored.spec.environments.staging, environment: staging });
  expect(planned.actions).toHaveLength(1); const action = planned.actions[0];
  const document = (actions: PlanAction[]) => ({ kind: 'hv_plan', scope: 'runtime-access', environmentName: 'staging', specRevision: stored.revision, observedFingerprint: null, actions });
  const apply = async (actions: PlanAction[], confirmActions: string[] = []) => {
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: staging.id, type: 'plan', plan: document(actions) });
    return executePlanApply(ctx, { project, spec: stored.spec, specRevision: stored.revision, planId: run.id, confirmActions });
  };
  return { ctx, staging, production, action, document, apply, writes, topicName, subscriptionName, hosting };
}

describe('queue prerequisite through saved runtime-access plans and native transport', () => {
  it('requires exact approval, creates only the selected queue, and preserves application acceptance and production', async () => {
    const f = await queueFixture(); const untouched = structuredClone(f.production.platformBindings);
    expect(f.action).toMatchObject({ type: 'create', billable: true, requiresConfirm: true });
    expect(await f.apply([f.action], ['queue:wrong'])).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual([]);
    expect(await f.apply([f.action], [f.action.id])).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual([`PUT ${f.topicName}`, `PUT ${f.subscriptionName}`]);
    const bound = f.ctx.repos.environments.findById(f.staging.id)!;
    expect(bound.platformBindings).toMatchObject({ appliedSpecHash: 'accepted-staging', services: f.staging.platformBindings.services,
      queues: { 'email-jobs': { topicName: f.topicName, subscriptionName: f.subscriptionName, providerScope: { projectId: 'gcp-project' } } } });
    expect(f.ctx.repos.environments.findById(f.production.id)!.platformBindings).toEqual(untouched);
    expect(f.hosting).not.toHaveBeenCalled();
  });

  it.each(['billable', 'requiresConfirm'] as const)('rejects a persisted create stripped of %s before any native write', async field => {
    const f = await queueFixture(); const action = { ...f.action, billable: true, requiresConfirm: true }; delete action[field];
    expect(await f.apply([action], [action.id])).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual([]); expect(f.ctx.repos.environments.findById(f.staging.id)!.platformBindings).toEqual(f.staging.platformBindings);
  });

  it.each(['unwire', 'destroy', 'mixed'])('rejects a %s action in the persisted queue prerequisite envelope', async scenario => {
    const f = await queueFixture();
    const actions: PlanAction[] = scenario === 'mixed'
      ? [f.action, { id: 'identity:web', type: 'update', resource: { kind: 'service', provider: 'cloudrun', name: 'web' }, verified: true,
        reason: 'Unrelated identity mutation', metadata: { operation: 'runtimeIdentityApply' } }]
      : [{ ...f.action, type: scenario === 'destroy' ? 'destroy' : 'update', metadata: { ...f.action.metadata, operation: scenario === 'destroy' ? 'queueDestroy' : 'queueUnwire' } }];
    expect(planRunDocumentSchema.safeParse(f.document(actions)).success).toBe(false);
    expect(await f.apply(actions, actions.map(action => action.id))).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual([]); expect(f.hosting).not.toHaveBeenCalled();
  });
});
