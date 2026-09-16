import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { railwayHttpFixture, projectId, stagingId, productionId } from '../../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { applyServiceVolumeAction, observeServiceVolumes, planServiceVolumes, retainedVolumeHostingBlock, wireServiceVolumeActions } from '../service-volume.service.js';
import { environmentSpecSchema, projectSpecSchema } from '../../spec/spec.schema.js';
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import { fingerprintObservedState, planRunDocumentSchema } from '../../plan/converge.executor.js';
import { resolvePlanActionAuthority } from '../../plan/action-authority.js';
import { validateProjectSpecProviders } from '../provider-spec-validation.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { ObservedState } from '../../ports/observe.port.js';
import type { PlanAction } from '../../plan/plan.types.js';
import type { IServiceVolumes } from '../../ports/service-volume.port.js';
import { PlanService } from '../../plan/plan.service.js';
import { adapterFactory } from '../adapter.factory.js';
import { SpecStore } from '../../spec/spec.store.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { createToolContext } from '../../../application/context.js';

const spec = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: { volume: { mountPath: '/data' } } }, deploy: { strategy: 'manual' } });
const repo = new EnvironmentRepository();
let environment: Environment;
beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(':memory:').migrate();
  const project = new ProjectRepository().create({ name: 'volume-lifecycle', defaultPlatform: 'railway' });
  environment = repo.create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'railway', projectId, environmentId: stagingId, services: { web: { serviceId: 'staging-web' } },
  } });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance();
});

async function setup(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const fixture = await railwayHttpFixture(options);
  fixture.addService('staging-web', 'web', stagingId);
  return fixture;
}
async function plan(volumes: IServiceVolumes, environmentSpec = spec) {
  environment = repo.findById(environment.id)!;
  const serviceVolumes = await observeServiceVolumes({ environment, environmentSpec, volumes });
  return planServiceVolumes({ environment, environmentSpec, observed: { serviceVolumes } as ObservedState }).actions;
}
async function apply(volumes: IServiceVolumes, action: PlanAction, save?: (value: Record<string, unknown>) => void) {
  return applyServiceVolumeAction({ environment: repo.findById(environment.id)!, environmentSpec: spec, action, volumes,
    confirmedActionIds: new Set([action.id]),
    save: save ?? ((serviceVolumes) => { repo.updatePlatformBindings(environment.id, { serviceVolumes }); }),
  });
}

describe('retained volume lifecycle: real SQLite and schema-executed Railway HTTP', () => {
  it('does not mistake Object prototype names for retained service bindings', async () => {
    const f = await setup();
    const environmentSpec = environmentSpecSchema.parse({ ...spec, services: { constructor: { volume: { mountPath: '/data' } } } });
    environment = repo.updatePlatformBindings(environment.id, { services: { constructor: { serviceId: 'staging-web' } } })!;
    const observations = await observeServiceVolumes({ environment, environmentSpec, volumes: f.adapter.serviceVolumes });
    expect(Object.keys(observations)).toEqual(['constructor']);
    expect(Object.values(observations)[0].observation).toEqual({ state: 'absent' });
  });
  it('creates one confirmed staging disk, persists its exact scope, and converges without further writes', async () => {
    const f = await setup();
    const production = f.addVolume('production-web', productionId, '/data');
    const before = structuredClone(production);
    const [action] = await plan(f.adapter.serviceVolumes);
    expect(action).toMatchObject({ id: 'volume:web', type: 'create', requiresConfirm: true, billable: true, dataBearing: true });
    expect(resolvePlanActionAuthority(action)?.capability).toBe('hosting.volume.mutate');
    expect(await apply(f.adapter.serviceVolumes, action)).toMatchObject({ success: true });
    expect(repo.findById(environment.id)!.platformBindings.serviceVolumes).toMatchObject({ web: {
      state: 'bound', externalId: expect.any(String), target: { projectId, environmentId: stagingId, serviceId: 'staging-web', mountPath: '/data' },
    } });
    expect((await plan(f.adapter.serviceVolumes))[0].type).toBe('noop');
    expect(f.mutations.map((m) => m.field)).toEqual(['volumeCreate']);
    expect(production).toEqual(before);
    expect(f.contractErrors).toEqual([]);
    const omitted = environmentSpecSchema.parse({ ...spec, services: { web: {} } });
    expect((await plan(f.adapter.serviceVolumes, omitted))[0]).toMatchObject({ type: 'noop', reason: expect.stringContaining('retained') });
    const destroy: PlanAction = { ...action, type: 'destroy', resource: { kind: 'service', name: 'web', provider: 'railway' } };
    expect(retainedVolumeHostingBlock(repo.findById(environment.id), omitted, destroy)).toContain('block');
    expect(f.mutations).toHaveLength(1);
  });

  it('persists intent before any provider write and does not create when local persistence fails', async () => {
    const f = await setup();
    const [action] = await plan(f.adapter.serviceVolumes);
    await expect(apply(f.adapter.serviceVolumes, action, () => { throw new Error('synthetic disk full'); })).rejects.toThrow('disk full');
    expect(f.mutations).toEqual([]);
  });

  it('retains lost-response intent and refuses both automatic retry and target-match adoption', async () => {
    const f = await setup({ dropVolumeCreateResponse: true });
    const [action] = await plan(f.adapter.serviceVolumes);
    expect(await apply(f.adapter.serviceVolumes, action)).toMatchObject({ success: false });
    expect(repo.findById(environment.id)!.platformBindings.serviceVolumes).toMatchObject({ web: { state: 'creating' } });
    expect((await plan(f.adapter.serviceVolumes))[0].metadata?.blockedReason).toBeDefined();
    expect(await apply(f.adapter.serviceVolumes, action)).toMatchObject({ success: false });
    expect(f.mutations.map((m) => m.field)).toEqual(['volumeCreate']);
  });

  it('recovers only the acknowledged ID with exact confirmation, without creating again', async () => {
    const f = await setup();
    const [action] = await plan(f.adapter.serviceVolumes);
    let reads = 0;
    const uncertain: IServiceVolumes = { create: (t) => f.adapter.serviceVolumes.create(t), observe: (t, id) => ++reads === 1
      ? f.adapter.serviceVolumes.observe(t, id) : Promise.resolve({ state: 'unknown', reason: 'synthetic read outage' }) };
    expect(await apply(uncertain, action)).toMatchObject({ success: false });
    expect(repo.findById(environment.id)!.platformBindings.serviceVolumes).toMatchObject({ web: { state: 'identified', externalId: expect.any(String) } });
    const [recovery] = await plan(f.adapter.serviceVolumes);
    expect(recovery.metadata?.operation).toBe('serviceVolumeFinalize');
    expect(await apply(f.adapter.serviceVolumes, { ...recovery, requiresConfirm: false })).toMatchObject({ success: false });
    expect(await apply(f.adapter.serviceVolumes, recovery)).toMatchObject({ success: true });
    expect((await plan(f.adapter.serviceVolumes))[0].type).toBe('noop');
    expect(f.mutations.map((m) => m.field)).toEqual(['volumeCreate']);
  });

  it('fails closed on omitted, corrupt, duplicate, missing and pending retained attachments', async () => {
    const f = await setup();
    const [action] = await plan(f.adapter.serviceVolumes);
    await apply(f.adapter.serviceVolumes, action);
    const state = repo.findById(environment.id)!.platformBindings.serviceVolumes as Record<string, unknown>;
    const omitted = environmentSpecSchema.parse({ ...spec, services: {} });
    expect((await plan(f.adapter.serviceVolumes, omitted))[0].type).toBe('noop'); // Removing the service still retains its volume; teardown is separately blocked.
    const volume = [...f.volumes.values()][0];
    volume.isPendingDeletion = true;
    expect((await plan(f.adapter.serviceVolumes))[0].metadata?.blockedReason).toBeDefined();
    f.volumes.clear();
    expect((await plan(f.adapter.serviceVolumes))[0].metadata?.blockedReason).toBeDefined();
    for (const malformed of [null, [], { web: { state: 'invalid' } }, { ...state, second: state.web }]) {
      repo.updatePlatformBindings(environment.id, { serviceVolumes: malformed });
      expect((await plan(f.adapter.serviceVolumes))[0].metadata?.blockedReason).toBeDefined();
    }
    expect(f.mutations.map((m) => m.field)).toEqual(['volumeCreate']);
  });

  it('rejects mount drift, unbound disks, forged targets and unacknowledged candidate IDs', async () => {
    const f = await setup();
    const [action] = await plan(f.adapter.serviceVolumes);
    expect(await apply(f.adapter.serviceVolumes, { ...action, metadata: { ...action.metadata, target: { ...(action.metadata?.target as object), environmentId: productionId } } })).toMatchObject({ success: false });
    expect(f.mutations).toEqual([]);
    const candidate: IServiceVolumes = { observe: (t, id) => f.adapter.serviceVolumes.observe(t, id), create: async () => ({ success: false, mutationAttempted: false, externalId: 'unowned' }) };
    expect(await apply(candidate, action)).toMatchObject({ success: false });
    expect(repo.findById(environment.id)!.platformBindings.serviceVolumes).toEqual({});
    f.addVolume('staging-web', stagingId, '/old');
    expect((await plan(f.adapter.serviceVolumes))[0].metadata?.blockedReason).toBeDefined();
  });

  it('includes mount intent in the deployment contract and live identity in stale-plan fingerprints', async () => {
    const input = { environments: { staging: spec } };
    const omitted = { environments: { staging: { ...spec, services: { web: {} } } } };
    expect(environmentDeploymentContractHash(input, 'staging')).not.toBe(environmentDeploymentContractHash(omitted, 'staging'));
    const observed: ObservedState = { provider: 'railway', observedAt: '', projectExists: true, services: [], databases: [], partial: false, warnings: [] };
    const before = fingerprintObservedState(observed);
    observed.serviceVolumes = await observeServiceVolumes({ environment, environmentSpec: spec });
    expect(fingerprintObservedState(observed)).not.toBe(before);
    const action: PlanAction = { id: 'service:web', type: 'update', resource: { kind: 'service', name: 'web', provider: 'railway' }, verified: true, reason: 'deploy' };
    wireServiceVolumeActions([action], [{ ...action, id: 'volume:web', resource: { kind: 'volume', name: 'web', provider: 'railway' } }]);
    expect(action.dependsOn).toEqual(['volume:web']);
  });

  it.each([['railway', 'worker'], ['railway', 'cron'], ['cloudrun', 'web']])('rejects unsupported %s/%s before provisioning', (provider, workloadKind) => {
    const parsed = projectSpecSchema.parse({ version: 1, project: 'volumes', environments: { staging: { hosting: { provider }, services: { web: { volume: { mountPath: '/data' }, workloadKind, startCommand: 'run', cronSchedule: '* * * * *' } } } } });
    expect(validateProjectSpecProviders(parsed).some((i) => i.field === 'services.volume' || i.field === 'hosting.provider')).toBe(true);
  });

  it('plans an identity-only stage for a new manual web service, not a cyclic volume-before-service deploy', async () => {
    const f = await railwayHttpFixture();
    repo.updatePlatformBindings(environment.id, { services: {} });
    const project = new ProjectRepository().findById(environment.projectId)!;
    new SpecStore().replace(project, { version: 1, project: project.name, environments: { staging: spec } });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: f.adapter });
    // The production factory exposes this same legacy adapter through IHostingAdapter.
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: f.adapter as never });
    const connections = new ConnectionRepository();
    const connection = connections.create({ provider: 'railway', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-test-token' }) });
    connections.updateStatus(connection.id, 'verified');
    const result = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
    expect(result).not.toHaveProperty('error');
    if ('error' in result) return;
    expect(result.scope).toBe('hosting-bindings');
    expect(result.actions.some((a) => a.resource.kind === 'volume')).toBe(false);
    expect(result.actions.some((a) => a.resource.kind === 'service' && a.type === 'create')).toBe(true);
    expect(planRunDocumentSchema.safeParse({ kind: 'hv_plan', scope: result.scope, environmentName: 'staging', specRevision: result.specRevision, observedFingerprint: null, actions: result.actions }).success).toBe(true);
    expect(f.mutations).toEqual([]);
    const current = new SpecStore().get(project)!;
    const outcome = await executePlanApply(createToolContext(), { project, spec: current.spec, specRevision: current.revision, planId: result.planRunId,
      confirmActions: result.actions.filter((a) => a.requiresConfirm).map((a) => a.id) });
    expect(outcome).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.mutations.some((m) => /deploy|volumeCreate/i.test(m.field))).toBe(false);
    expect(repo.findById(environment.id)!.platformBindings.services).toMatchObject({ web: { serviceId: expect.any(String) } });
    const next = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
    expect(next).not.toHaveProperty('error');
    if ('error' in next) return;
    expect(next.actions.find((a) => a.resource.kind === 'volume')).toMatchObject({ type: 'create', verified: true });
  });
});
