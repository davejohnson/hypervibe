import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import '../providers.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { planPreparedHosting } from '../../domain/services/hosting-prepared.service.js';
import * as resilience from '../../domain/services/database-resilience-plan.service.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { applyPreparedHosting } from '../apply-prepared-hosting.js';
import * as releases from '../../domain/services/managed-release-observation.js';
import * as deploymentAccess from '../../adapters/cloud/deployment-access.client.js';
import type { PreparedHostingReleaseEvidence } from '../../domain/ports/hosting-prepared.port.js';

// Real saved spec/SQLite/planner/executor; synthetic provider capability only.
// Native create/UID/holding/config proof is separately required from each provider.
let directory: string;
const applicationImage = `operator/app@sha256:${'e'.repeat(64)}`;
const verifiedRelease = (): PreparedHostingReleaseEvidence => ({ schemaVersion: 1, repository: 'owner/app', workflow: '.github/workflows/deploy.yml', branch: 'main',
  sourceCommitSha: 'a'.repeat(40), workflowSourceCommitSha: 'b'.repeat(40), runId: 10, runAttempt: 1, artifactId: 20, workflowInputHash: 'a'.repeat(64),
  workflowContentHash: 'b'.repeat(64), programFingerprint: 'c'.repeat(64), deploymentContractFingerprint: 'd'.repeat(64), imageUri: applicationImage,
  targets: [{ workload: 'web', kind: 'service', resourceId: 'prepared-web', resourceUid: 'original-uid' }] });
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-prepared-hosting-')); vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SecretStore.resetInstance(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const nativeMetadata = providerRegistry.getMetadata.bind(providerRegistry);
  vi.spyOn(providerRegistry, 'getMetadata').mockImplementation(name => { const metadata = nativeMetadata(name);
    return name === 'cloudrun' && metadata?.lifecycle?.hosting ? { ...metadata, lifecycle: { ...metadata.lifecycle, hosting: { ...metadata.lifecycle.hosting, preparedResources: 'installer-receipt-v1' } } } : metadata; });
  const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'prepared-app', defaultPlatform: 'cloudrun' });
  new SpecStore().replace(project, { version: 1, project: project.name, environments: Object.fromEntries(['staging', 'production'].map(name => [name, {
    hosting: { provider: 'cloudrun', region: 'us-west2' }, services: { web: {} }, deploy: { strategy: 'manual' },
    backups: { mode: 'disabled', reason: 'Synthetic metadata-only contract.' },
  }])) });
  const image = `operator/holding@sha256:${'a'.repeat(64)}`;
  const state = { unknown: false, pending: ['web'], changed: false, configDigest: 'd'.repeat(64) };
  const proof = () => ({ state: 'verified' as const, bindings: { provider: 'cloudrun', projectId: 'customer-project', environmentId: 'us-west2',
    providerScope: { projectId: 'customer-project', region: 'us-west2', artifactRepository: 'prepared-repo', artifactRepositoryCreateTime: '2026-10-25T00:00:00Z' },
    services: { web: { serviceId: 'prepared-web', resourceUid: state.changed ? 'replaced-uid' : 'original-uid', resourceType: 'service' as const, workloadKind: 'web' as const, imageUri: state.pending.length ? image : applicationImage } } },
    preparation: { schemaVersion: 1 as const, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', planDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), pendingFirstRelease: [...state.pending], firstReleaseConfigurationDigests: Object.fromEntries(state.pending.map(name => [name, state.configDigest])) } });
  const inspect = vi.fn(async () => state.unknown ? { state: 'unknown' as const } : proof());
  const nativeWrite = vi.fn(async () => { throw new Error('Metadata binding must never mutate provider resources'); });
  const hosting = { name: 'cloudrun', capabilities: { supportsObserve: true }, preparedHosting: { inspect }, configureTarget: async () => {},
    deploy: nativeWrite, setEnvVars: nativeWrite, ensureProject: vi.fn(async () => ({ success: true, message: 'Verified existing installed project',
      data: { projectId: 'customer-project', environmentId: 'us-west2', providerBindings: { providerScope: { projectId: 'customer-project', region: 'us-west2' } } } })) };
  vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: hosting as any });
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: hosting as any });
  for (const method of ['preflight', 'providerPreflight', 'projectPreflight'] as const) vi.spyOn(PlanService.prototype, method).mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(async (_project, environment) => ({ warnings: [], observed: environment?.platformBindings.projectId ? {
    provider: 'cloudrun', observedAt: '2026-10-25T00:00:00Z', projectExists: true, projectId: 'customer-project', environmentId: 'us-west2',
    services: [], databases: [], storage: [], caches: [], warnings: [], partial: false,
    completeness: { project: 'complete', environment: 'complete', services: 'complete', databases: 'complete', storage: 'complete', caches: 'complete' },
  } : null }));
  const plan = async (options: Parameters<PlanService['plan']>[2] = {}) => { const result = await new PlanService().plan(project, 'staging', { includeEnvFile: false, ...options }); if ('error' in result) throw new Error(result.error); return result; };
  const apply = (planId: string, confirmActions: string[]) => { const spec = new SpecStore().get(project)!; return executePlanApply(ctx, { project, spec: spec.spec, specRevision: spec.revision, planId, confirmActions }); };
  const bound = () => ctx.repos.environments.findByProjectAndName(project.id, 'staging')!;
  const bootstrap = async () => { const planned = await plan(); expect(planned.scope).toBe('hosting-bindings');
    expect(await apply(planned.planRunId, planned.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } }); };
  return { ctx, project, state, proof, inspect, nativeWrite, hosting, plan, apply, bound, bootstrap };
}
describe('installer-prepared hosting metadata frontier', () => {
  it('discovers an unmarked installed receipt through the read-only adapter without requiring hosting mutation access', async () => {
    const f = fixture(); await f.bootstrap();
    expect(f.bound().platformBindings).not.toHaveProperty('preparedHosting');
    const mutationAdapter = vi.mocked(adapterFactory.getHostingAdapter).mockClear()
      .mockRejectedValue(new Error('Hosting mutation access is unavailable during metadata observation'));
    const planned = await f.plan();
    expect(planned.scope).toBe('hosting-prepared-bindings');
    expect(adapterFactory.getProviderAdapter).toHaveBeenCalledWith('cloudrun', f.project, undefined, 'staging');
    expect(mutationAdapter).not.toHaveBeenCalled();
    expect(f.inspect).toHaveBeenCalledOnce();
    expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it.each(['retained-marker', 'unavailable-hosted-grant'] as const)('keeps %s fail-closed when the read-only adapter cannot be resolved', async evidence => {
    const f = fixture(); await f.bootstrap();
    if (evidence === 'retained-marker') f.ctx.repos.environments.updatePlatformBindings(f.bound().id, {
      ...f.bound().platformBindings, preparedHosting: f.proof().preparation,
    });
    else vi.spyOn(deploymentAccess, 'selectedDeploymentAccess').mockImplementation(() => { throw new Error('Exact hosted grant is unreadable'); });
    vi.mocked(adapterFactory.getProviderAdapter).mockResolvedValue({ success: false, error: 'Read-only adapter unavailable' });
    await expect(f.plan()).rejects.toThrow('Installer-prepared hosting identity');
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('bootstraps first local environment then binds verified resources without deploying or claiming convergence', async () => {
    const f = fixture(); expect(f.bound()).toBeNull(); await f.bootstrap();
    const production = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'production', platformBindings: { provider: 'railway', projectId: 'unrelated' } });
    const planned = await f.plan(); expect(planned.scope).toBe('hosting-prepared-bindings'); expect(planned.actions).toHaveLength(1);
    expect(planned.actions[0].metadata?.operation).toBe('hostingPreparedBindings');
    expect(await f.apply(planned.planRunId, [])).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.bound().platformBindings.services ?? {}).toEqual({});
    expect(await f.apply(planned.planRunId, [planned.actions[0].id])).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.bound().platformBindings).toMatchObject({ services: f.proof().bindings.services, preparedHosting: f.proof().preparation });
    expect(f.bound().platformBindings).not.toHaveProperty('appliedSpecHash'); expect(f.nativeWrite).not.toHaveBeenCalled();
    expect(f.ctx.repos.environments.findById(production.id)?.platformBindings).toEqual(production.platformBindings);
  });
  it('blocks replacement and unknown native reads after review without recording bindings', async () => {
    const f = fixture(); await f.bootstrap(); const planned = await f.plan();
    f.state.changed = true;
    expect(await f.apply(planned.planRunId, planned.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.bound().platformBindings).not.toHaveProperty('preparedHosting');
    f.state.changed = false; f.state.unknown = true;
    await expect(f.plan()).rejects.toThrow(); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('retains exact local proof after export failure and retries only verification/export', async () => {
    const f = fixture(); await f.bootstrap(); const planned = await f.plan();
    const sync = vi.spyOn(f.ctx.repos.environments, 'syncRepoBindingsForId').mockImplementationOnce(() => { throw new Error('Synthetic lost export'); });
    expect(await f.apply(planned.planRunId, planned.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.bound().platformBindings.preparedHosting).toEqual(f.proof().preparation);
    expect(await f.apply(planned.planRunId, planned.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(sync).toHaveBeenCalledTimes(2); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('returns metadata noop without writes and requires a new explicit review for expected first-release configuration', async () => {
    const f = fixture(); await f.bootstrap(); let planned = await f.plan(); await f.apply(planned.planRunId, planned.actions.map(a => a.id));
    const update = vi.spyOn(f.ctx.repos.environments, 'updatePlatformBindings');
    const input = () => ({ environment: f.bound(), environmentSpec: new SpecStore().get(f.project)!.spec.environments.staging, hosting: f.hosting as any });
    expect(await planPreparedHosting(input())).toBeNull(); expect(update).not.toHaveBeenCalled();
    f.state.configDigest = 'e'.repeat(64); planned = await f.plan();
    expect(f.bound().platformBindings.preparedHosting).toMatchObject({ firstReleaseConfigurationDigests: { web: 'd'.repeat(64) } });
    expect(planned.scope).toBe('hosting-prepared-bindings'); await f.apply(planned.planRunId, planned.actions.map(a => a.id));
    expect(f.bound().platformBindings.preparedHosting).toMatchObject({ firstReleaseConfigurationDigests: { web: 'e'.repeat(64) } });
    expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('blocks a retained prepared receipt when its authenticated capability becomes unavailable', async () => {
    const f = fixture(); await f.bootstrap(); const planned = await f.plan(); await f.apply(planned.planRunId, planned.actions.map(a => a.id));
    delete (f.hosting as any).preparedHosting;
    await expect(f.plan()).rejects.toThrow(); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('records verified release progress only in a new metadata action and never restores holding authority', async () => {
    const f = fixture(); await f.bootstrap(); let planned = await f.plan(); await f.apply(planned.planRunId, planned.actions.map(a => a.id));
    f.state.pending = []; await expect(f.plan()).rejects.toThrow();
    expect(f.bound().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: ['web'] });
    vi.spyOn(releases, 'observeManagedReleaseEvidence').mockResolvedValue(verifiedRelease()); planned = await f.plan();
    expect(planned.actions[0].metadata).toMatchObject({ proof: { releaseEvidence: verifiedRelease() }, previousPreparation: { pendingFirstRelease: ['web'] } });
    expect(f.bound().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: ['web'] });
    await f.apply(planned.planRunId, planned.actions.map(a => a.id));
    expect(f.bound().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: [] });
    f.state.pending = ['web']; await expect(f.plan()).rejects.toThrow(); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('retains original release provenance and workflow inputs through lost metadata-export acknowledgment', async () => {
    const f = fixture(); await f.bootstrap(); let planned = await f.plan(); await f.apply(planned.planRunId, planned.actions.map(a => a.id));
    f.state.pending = [];
    const observe = vi.spyOn(releases, 'observeManagedReleaseEvidence').mockImplementation(async input => {
      expect(input.environment.platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: ['web'] }); return verifiedRelease();
    });
    planned = await f.plan();
    vi.spyOn(f.ctx.repos.environments, 'syncRepoBindingsForId').mockImplementationOnce(() => { throw new Error('Synthetic lost completion export'); });
    expect(await f.apply(planned.planRunId, planned.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.bound().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: [] });
    expect(await f.apply(planned.planRunId, planned.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ reviewed: verifiedRelease() }));
    expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('rejects changed release provenance after review without clearing the pending journal', async () => {
    const f = fixture(); await f.bootstrap(); let planned = await f.plan(); await f.apply(planned.planRunId, planned.actions.map(a => a.id)); f.state.pending = [];
    const observe = vi.spyOn(releases, 'observeManagedReleaseEvidence').mockResolvedValue(verifiedRelease()); planned = await f.plan();
    observe.mockResolvedValue({ ...verifiedRelease(), runId: 11 });
    expect(await f.apply(planned.planRunId, planned.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.bound().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: ['web'] }); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'spec', 'binding'] as const)('rejects %s changed while native verification is awaiting', async change => {
    const f = fixture(); await f.bootstrap(); const planned = await f.plan();
    f.inspect.mockImplementationOnce(async () => {
      if (change === 'cancel') {
        const run = f.ctx.repos.runs.findByProjectId(f.project.id).find(run => run.type === 'apply' && run.status === 'running')!;
        f.ctx.repos.runs.updateStatus(run.id, 'cancelled');
      } else if (change === 'spec') {
        const current = new SpecStore().get(f.project)!; current.spec.environments.staging.envVars = { CHANGED: 'review-required' };
        new SpecStore().replace(f.project, current.spec);
      } else f.ctx.repos.environments.updatePlatformBindings(f.bound().id, { ...f.bound().platformBindings, markerFromAnotherPlan: true });
      return f.proof();
    });
    expect(await f.apply(planned.planRunId, planned.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.bound().platformBindings).not.toHaveProperty('preparedHosting'); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('atomically preserves a competing binding write after final native observation and authorization', async () => {
    const f = fixture(); await f.bootstrap(); const planned = await f.plan(); let authorizations = 0;
    const result = await applyPreparedHosting({ ctx: f.ctx, project: f.project, environmentName: 'staging',
      environmentSpec: new SpecStore().get(f.project)!.spec.environments.staging, action: planned.actions[0],
      confirmedActionIds: new Set(planned.actions.map(action => action.id)), authorize: () => {
        if (++authorizations === 2) f.ctx.repos.environments.updatePlatformBindings(f.bound().id, { projectId: 'competing-project' });
        return true;
      } });
    expect(result.success).toBe(false); expect(f.bound().platformBindings.projectId).toBe('competing-project');
    expect(f.bound().platformBindings).not.toHaveProperty('preparedHosting'); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it.each(['serviceCreateRecovery', 'runtimeIdentities', 'storageRuntimeAccess', 'previousHosting'] as const)('does not bypass retained %s recovery', async key => {
    const f = fixture(); await f.bootstrap(); const planned = await f.plan();
    const recovery = key === 'serviceCreateRecovery' ? { web: { provider: 'cloudrun', operation: 'create', resourceName: 'prepared-web', providerScope: { projectId: 'customer-project', region: 'us-west2' }, state: 'unresolved' } } : key === 'previousHosting' ? { provider: 'old-host' } : { web: { pending: { attemptId: 'unresolved' } } };
    f.ctx.repos.environments.updatePlatformBindings(f.bound().id, { ...f.bound().platformBindings, [key]: recovery });
    expect(await f.apply(planned.planRunId, planned.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    await expect(f.plan()).rejects.toThrow(); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('preserves the earlier checkpoint frontier and rejects filtered/runtime-input metadata plans', async () => {
    const f = fixture(); await f.bootstrap();
    await expect(f.plan({ envVarOverrides: { PRIVATE_VALUE: 'must-not-persist' } })).rejects.toThrow();
    await expect(f.plan({ serviceFilter: ['web'] })).rejects.toThrow();
    const action = { id: 'database:checkpoint', type: 'create' as const, resource: { provider: 'cloud-sql', kind: 'database' as const, name: 'checkpoint' }, verified: true,
      reason: 'Requested safety checkpoint', requiresConfirm: true, billable: true, dataBearing: true,
      metadata: { operation: 'databaseCheckpointCreate', checkpointId: 'before-release' } };
    vi.spyOn(resilience, 'planDatabaseResilience').mockReturnValue({ actions: [action], warnings: [], unmanaged: [], serviceDependencies: [] });
    f.inspect.mockClear(); const planned = await f.plan(); expect(planned.scope).toBe('database-checkpoint'); expect(planned.actions).toEqual([action]);
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.nativeWrite).not.toHaveBeenCalled();
  });
  it('rejects broadened saved plans before the provider capability can run', async () => {
    const f = fixture(); await f.bootstrap(); const planned = await f.plan();
    const document = f.ctx.repos.runs.findById(planned.planRunId)!.plan;
    for (const change of [{ scope: 'full' }, { actions: [...planned.actions, { ...planned.actions[0], id: 'unrelated' }] }, { observedFingerprint: 'unreviewed' }, { overrides: { envVars: { VALUE: 'unreviewed' } } }])
      expect(planRunDocumentSchema.safeParse({ ...document, ...change }).success).toBe(false);
    expect(f.nativeWrite).not.toHaveBeenCalled();
  });
});
