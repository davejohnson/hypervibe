import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { ObservedState } from '../../domain/ports/observe.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import * as bootstrap from '../../domain/services/bootstrap.service.js';
import { parseRuntimeRolloutBindings, runtimeRolloutRequirements } from '../../domain/services/runtime-rollout.service.js';
import '../providers.js';

const destination = { provider: 'gcp-secret-manager', projectId: 'synthetic-project',
  projectNumber: '123456789012', secretId: 'staging-flow' };
const reference = { destination, version: '7' };
function observation(version?: string): ObservedState {
  return { provider: 'cloudrun', observedAt: new Date().toISOString(), projectExists: true,
    projectId: 'synthetic-project', partial: false, warnings: [], databases: [],
    services: [{ name: 'web', externalId: 'web-id', workloadKind: 'web', status: 'running', customDomains: [], config: {},
      envVarKeys: version ? ['FLOW_KEY'] : [], envVarHashes: {}, envVarSecretRefs: version ? { FLOW_KEY: {
        provider: 'gcp-secret-manager', resource: 'projects/123456789012/secrets/staging-flow', version } } : {} }] };
}
describe('native references at the persisted apply boundary', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-reference-apply-'));
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

  function fixture(current?: string, readback = '7') {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'synthetic-app', defaultPlatform: 'cloudrun' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'cloudrun', projectId: 'synthetic-project', services: { web: { serviceId: 'web-id' } },
    } });
    ctx.repos.services.create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      secrets: { FLOW_KEY: { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] } },
      environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} }, email: { enabled: false },
        secretDestinations: { FLOW_KEY: reference } } } });
    let state = observation(current);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(async () => ({ observed: state, warnings: [] }));
    const setEnvVars = vi.fn().mockImplementation(async () => {
      state = observation(readback); return { success: true, message: 'Provider accepted reference' };
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: {
      name: 'cloudrun', capabilities: { supportsObserve: true, supportsCreateOnlyDeploy: true, runtimeSecretReferenceProviders: ['gcp-secret-manager'] },
      setEnvVars,
    } as never });
    const action: PlanAction = { id: 'secret:FLOW_KEY', type: 'update', verified: true,
      reason: 'Install reviewed version', resource: { kind: 'secret', provider: 'cloudrun', name: 'FLOW_KEY' },
      ...(current && current !== '7' ? { requiresConfirm: true } : {}),
      metadata: { operation: 'secretReferenceSync', ownership: 'delegated', principal: 'email:owner@example.test',
        services: ['web'], reference } };
    const run = (actions = [action]) => ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', environmentName: 'staging', scope: 'full', specRevision: 1, observedFingerprint: null, actions } });
    return { ctx, project, spec, environment, action, setEnvVars, run };
  }
  it('writes only references and verifies metadata before recording success', async () => {
    const f = fixture(); const run = f.run();
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: run.id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.setEnvVars).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.environment.id }),
      expect.objectContaining({ name: 'web' }), {}, expect.objectContaining({ secretVersionRefs: { FLOW_KEY: reference } }));
    expect(f.ctx.repos.runs.findById(run.id)!.plan).not.toHaveProperty('overrides');
  });
  it.each([undefined, '7'])('does not let a prepared marker replace release proof for current reference %s', async current => {
    const f = fixture(current);
    f.action.metadata!.preparedReleaseBinding = true;
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { localPreparedHosting: { untrustedMarker: true } });
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1,
      planId: f.run().id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.setEnvVars).not.toHaveBeenCalled();
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.secretVersionBindings).toBeUndefined();
  });
  it('rejects a saved native reference action after the slot acquires credential authority', async () => {
    const f = fixture(); const run = f.run();
    f.spec.secrets.FLOW_KEY.credential = { role: 'external-api', label: 'External API', purpose: 'Web requests', kind: 'opaque',
      source: 'env:PRIVATE_INPUT', runtimeConsumers: [{ environment: 'staging', service: 'web', variable: 'FLOW_KEY' }] };
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: run.id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.setEnvVars).not.toHaveBeenCalled();
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.secretVersionBindings).toBeUndefined();
  });
  it.each(['destination', 'owner', 'services'] as const)('rejects changed %s before any provider mutation', async field => {
    const f = fixture();
    if (field === 'destination') f.action.metadata!.reference = { destination: { ...destination, secretId: 'production-flow' }, version: '7' };
    if (field === 'owner') f.action.metadata!.principal = 'email:other@example.test';
    if (field === 'services') f.action.metadata!.services = ['worker'];
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: f.run().id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.setEnvVars).not.toHaveBeenCalled();
  });
  it('blocks a service rollout before it could bypass reference replacement confirmation', async () => {
    const f = fixture('6');
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockResolvedValue({ success: true, summary: {} });
    const service: PlanAction = { id: 'service:web', type: 'update', verified: true, reason: 'New code',
      resource: { kind: 'service', name: 'web', provider: 'cloudrun' } };
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1,
      planId: f.run([service, f.action]).id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(deploy).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled();
  });
  it('does not accept a successful write response when readback has another version', async () => {
    const f = fixture(undefined, '8');
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: f.run().id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.setEnvVars).toHaveBeenCalledTimes(1);
  });
  it('blocks an omitted secret action when fresh matching references violate the immutable lifecycle', async () => {
    const f = fixture('7');
    f.spec.secrets.FLOW_KEY = { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1,
      environments: ['staging'], replacementPolicy: 'immutable', conflictsWith: ['OLD_KEY'] };
    const state = observation('7'); state.services[0].envVarKeys.push('OLD_KEY');
    vi.mocked(PlanService.prototype.observeEnvironment).mockResolvedValue({ observed: state, warnings: [] });
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockResolvedValue({ success: true, summary: {} });
    const service: PlanAction = { id: 'service:web', type: 'update', verified: true, reason: 'Deploy selected service',
      resource: { kind: 'service', name: 'web', provider: 'cloudrun' } };
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1,
      planId: f.run([service]).id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(deploy).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled();
  });
  it.each(['required', 'generated', 'optional'] as const)('rechecks an unpinned %s native slot before a persisted service-only deployment', async kind => {
    const f = fixture();
    delete f.spec.environments.staging.secretDestinations!.FLOW_KEY.version;
    if (kind === 'optional' && f.spec.secrets.FLOW_KEY.ownership === 'delegated') f.spec.secrets.FLOW_KEY.required = false;
    if (kind === 'generated') f.spec.secrets.FLOW_KEY = { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'] };
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockResolvedValue({ success: true, summary: {} });
    const service: PlanAction = { id: 'service:web', type: 'update', verified: true, reason: 'Deploy selected service', resource: { kind: 'service', name: 'web', provider: 'cloudrun' } };
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: f.run([service]).id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: kind === 'optional' } });
    expect(deploy).toHaveBeenCalledTimes(kind === 'optional' ? 1 : 0);
    expect(f.setEnvVars).not.toHaveBeenCalled();
  });
  it('records pending activation only for services that received an explicit provider rollout receipt', async () => {
    const f = fixture();
    f.spec.environments.staging.services.worker = { ...f.spec.environments.staging.services.web };
    f.action.metadata!.services = ['web', 'worker'];
    f.ctx.repos.services.create({ projectId: f.project.id, name: 'worker', buildConfig: {}, envVarSpec: {} });
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 'web-id' }, worker: { serviceId: 'worker-id' } } });
    const state = observation('7');
    state.services.push({ ...observation().services[0], name: 'worker', externalId: 'worker-id' });
    vi.mocked(PlanService.prototype.observeEnvironment).mockImplementation(async () => ({ observed: state, warnings: [] }));
    f.setEnvVars.mockImplementation(async () => {
      state.services[1] = { ...observation('7').services[0], name: 'worker', externalId: 'worker-id' };
      return { success: true, data: { runtimeRolloutRequired: true, rolloutBaseline: { state: 'present', deploymentId: 'worker-before' } } };
    });
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: f.run().id, confirmActions: [] });
    if (result.kind !== 'executed') throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(parseRuntimeRolloutBindings(f.ctx.repos.environments.findById(f.environment.id)!).map(binding => binding.service)).toEqual(['worker']);
  });
  it('reports a controlled failure when a forced all-noop rollout fails reference preflight', async () => {
    const f = fixture('6');
    f.action.type = 'noop';
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockResolvedValue({ success: true, summary: {} });
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1,
      planId: f.run().id, confirmActions: [], alwaysRunBootstrap: true });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(deploy).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled();
  });
  it.each([false, true])('retains explicit provider rollout evidence across matching retries (readback failure: %s)', async failedReadback => {
    const f = fixture();
    let state = observation();
    state.services[0].deployment = { id: 'deployment-before', status: 'SUCCESS' };
    vi.mocked(PlanService.prototype.observeEnvironment).mockImplementation(async () => ({ observed: state, warnings: [] }));
    f.setEnvVars.mockImplementation(async () => {
      state = observation(failedReadback ? '8' : '7');
      state.services[0].deployment = { id: 'deployment-before', status: 'SUCCESS' };
      return { success: true, message: 'Configuration stored; activation pending', data: {
        runtimeRolloutRequired: true, deploymentDeferred: true,
        rolloutBaseline: { state: 'present', deploymentId: 'deployment-before' },
      } };
    });
    const first = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: f.run().id, confirmActions: [] });
    expect(first).toMatchObject({ kind: 'executed', result: { success: !failedReadback } });
    if (first.kind !== 'executed') throw new Error('Expected an executed apply');
    expect(parseRuntimeRolloutBindings(f.ctx.repos.environments.findById(f.environment.id)!)).toEqual([
      expect.objectContaining({ service: 'web', applyRunId: first.result.applyRunId,
        baselineDeployment: { state: 'present', id: 'deployment-before' } }),
    ]);
    if (!failedReadback) expect(first.result.receipts.find(receipt => receipt.actionId === f.action.id)?.data).toMatchObject({
      runtimeRolloutRequired: true, rolloutBaselines: { web: { state: 'present', deploymentId: 'deployment-before' } },
      configurationVerified: true, runtimeAccessVerified: false,
    });
    state = observation('7');
    state.services[0].deployment = { id: 'deployment-before', status: 'SUCCESS' };
    const retry = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: f.run().id, confirmActions: [] });
    expect(retry).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.setEnvVars).toHaveBeenCalledTimes(1);
    const environment = f.ctx.repos.environments.findById(f.environment.id)!;
    expect(runtimeRolloutRequirements({ environment, provider: 'cloudrun', observed: state })).toHaveLength(1);
    state.services[0].deployment = { id: 'deployment-after', status: 'SUCCESS' };
    expect(runtimeRolloutRequirements({ environment, provider: 'cloudrun', observed: state })).toEqual([]);
  });
  it('installs initial references only through the reviewed creation-only service payload', async () => {
    const f = fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: {} });
    let current: ObservedState = { ...observation(), services: [], completeness: { services: 'complete' } };
    vi.mocked(PlanService.prototype.observeEnvironment).mockImplementation(async () => ({ observed: current, warnings: [] }));
    f.action.metadata!.creationOnlyServices = ['web'];
    const create: PlanAction = { id: 'service:web', type: 'create', verified: true, reason: 'Create reviewed service', resource: { kind: 'service', name: 'web', provider: 'cloudrun' } };
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockImplementation(async () => {
      f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 'web-id' } } });
      current = { ...observation('7'), completeness: { services: 'complete' } };
      return { success: true, summary: {} };
    });
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1,
      planId: f.run([create, f.action]).id, confirmActions: ['service:web'] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ provisionOnly: true, requireNewWorkload: true, secretVersionRefs: { FLOW_KEY: reference } }));
    expect(f.setEnvVars).not.toHaveBeenCalled();
  });
  it('does not turn an initial reference action into unreviewed service creation', async () => {
    const f = fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: {} });
    vi.mocked(PlanService.prototype.observeEnvironment).mockResolvedValue({ observed: { ...observation(), services: [], completeness: { services: 'complete' } }, warnings: [] });
    f.action.metadata!.creationOnlyServices = ['web'];
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockResolvedValue({ success: true, summary: {} });
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: f.run().id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(deploy).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled();
  });
  it('rechecks immutable conflicting keys after a successful write before accepting a lifecycle receipt', async () => {
    const f = fixture();
    f.spec.secrets.FLOW_KEY = { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'], replacementPolicy: 'immutable', conflictsWith: ['OLD_KEY'] };
    f.action.metadata = { ...f.action.metadata, ownership: 'hypervibe', principal: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, replacementPolicy: 'immutable', conflictsWith: ['OLD_KEY'] };
    let state = observation();
    vi.mocked(PlanService.prototype.observeEnvironment).mockImplementation(async () => ({ observed: state, warnings: [] }));
    f.setEnvVars.mockImplementation(async () => { state = observation('7'); state.services[0].envVarKeys.push('OLD_KEY'); return { success: true }; });
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: f.run().id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.setEnvVars).toHaveBeenCalledTimes(1);
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).not.toHaveProperty('secretVersionBindings');
  });
});
