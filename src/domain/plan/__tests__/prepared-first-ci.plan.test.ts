import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../../application/context.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import * as managedCi from '../../services/managed-ci.service.js';
import * as releases from '../../services/managed-release-observation.js';
import { SpecStore } from '../../spec/spec.store.js';
import { PlanService } from '../plan.service.js';
import { planRunDocumentSchema } from '../converge.executor.js';
import type { PlanAction } from '../plan.types.js';

// Reconstruct the November 5 walkthrough at the normalized provider boundary:
// list services/jobs returned 403, while exact prepared service/lifetime reads
// succeeded. GitHub's reviewed workflow existed but its environment did not.
// The real planner and SQLite must preserve unknown runtime state and expose
// only CI setup. Native provider proof is covered by prepared-hosting contracts.
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-prepared-first-ci-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network access'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'prepared-ci-app', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/owner/app.git' });
  new SpecStore().replace(project, { version: 1, project: project.name,
    devops: { code: { provider: 'github', scope: 'owner/app', repository: { management: 'external', state: 'present' } },
      ci: { provider: 'github-actions' } },
    secrets: { API_TOKEN: { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] } },
    environments: { staging: { hosting: { provider: 'cloudrun', region: 'us-central1' }, services: { web: { public: false } },
      email: { enabled: false }, envVars: { APPLICATION_SETTING: 'first-release' },
      secretDestinations: { API_TOKEN: { destination: { provider: 'gcp-secret-manager', projectId: 'customer-project', projectNumber: '123456789012', secretId: 'api-token' }, version: '1' } },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: false } } } });
  const bindings = { provider: 'cloudrun', projectId: 'customer-project', environmentId: 'us-central1',
    providerScope: { projectId: 'customer-project', region: 'us-central1' },
    services: { web: { serviceId: 'prepared-web', resourceUid: 'original-uid', resourceType: 'service' as const,
      workloadKind: 'web' as const, imageUri: `operator/holding@sha256:${'a'.repeat(64)}` } } };
  const preparation = { schemaVersion: 1 as const, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', planDigest: 'b'.repeat(64),
    receiptDigest: 'c'.repeat(64), pendingFirstRelease: ['web'], firstReleaseConfigurationDigests: { web: 'd'.repeat(64) } };
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { ...bindings, preparedHosting: preparation } });
  const inspect = vi.fn(async () => ({ state: 'verified' as const, bindings, preparation }));
  const mutation = vi.fn(async () => { throw new Error('No hosting mutation is authorized'); });
  const hosting = { name: 'cloudrun', capabilities: { supportsObserve: true }, preparedHosting: { inspect },
    observe: async () => ({ provider: 'cloudrun', observedAt: new Date().toISOString(), projectExists: true,
      projectId: bindings.projectId, environmentId: bindings.environmentId, services: [], databases: [], warnings: ['Service inventory permission denied'],
      partial: true, completeness: { project: 'complete', environment: 'complete', services: 'unknown', databases: 'complete' } }),
    deploy: mutation, setEnvVars: mutation };
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: hosting as never });
  vi.spyOn(releases, 'observeManagedReleaseEvidence').mockResolvedValue(undefined);
  for (const name of ['preflight', 'providerPreflight', 'projectPreflight'] as const) vi.spyOn(PlanService.prototype, name).mockReturnValue([]);
  const ciAction: PlanAction = { id: 'ci:github-actions:staging:deploy-branch', type: 'update', verified: true,
    resource: { kind: 'ci', provider: 'github', name: 'deploy-branch:staging' }, reason: 'Record the published workflow input contract and prepare its environment',
    metadata: { operation: 'githubActionsDeployBranch', repository: 'owner/app', provider: 'cloudrun',
      workflow: { path: '.github/workflows/deploy-cloudrun-staging.yml', branch: 'main', autoDeployOnPush: false, requiredSecrets: [] } } };
  const ci = vi.spyOn(managedCi, 'planManagedCiDeploy').mockResolvedValue({ actions: [ciAction], warnings: [] });
  const appliedMarker = vi.spyOn(managedCi, 'planManagedCiAppliedSpecHash').mockResolvedValue({ actions: [], warnings: [] });
  return { ctx, project, environment, preparation, inspect, mutation, ciAction, ci, appliedMarker,
    plan: () => new PlanService().plan(project, 'staging', { includeEnvFile: false }) };
}

describe('prepared holding first CI prerequisite', () => {
  it('saves only accepted-workflow CI setup while runtime references remain unknown', async () => {
    const f = fixture(); const result = await f.plan();
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('managed-ci-credentials');
    expect(result.actions).toEqual([f.ciAction]); expect(result.inputRequired).toEqual([]);
    expect(result.observed).toMatchObject({ partial: true, completeness: { services: 'unknown' } });
    const document = f.ctx.repos.runs.findById(result.planRunId)!.plan;
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    for (const key of ['overrides', 'sourceCommitSha', 'integrationFingerprints', 'inputRequired']) expect(document).not.toHaveProperty(key);
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).toMatchObject({ preparedHosting: f.preparation });
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).not.toHaveProperty('secretVersionBindings');
    expect(f.appliedMarker).not.toHaveBeenCalled(); expect(f.mutation).not.toHaveBeenCalled();
  });
  it('keeps unknown runtime references blocked after the CI prerequisite converges', async () => {
    const f = fixture(); f.ci.mockResolvedValue({ actions: [{ ...f.ciAction, type: 'noop' }], warnings: [] });
    expect(await f.plan()).toMatchObject({ error: expect.stringContaining('Cannot verify current runtime secret reference') });
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it('executes only CI synchronization without releasing the holding workload or accepting its references', async () => {
    const f = fixture(); const planned = await f.plan();
    if ('error' in planned) throw new Error(planned.error);
    const applyCi = vi.spyOn(managedCi, 'applyManagedCiAction').mockResolvedValue({ success: true, message: 'CI setup verified' });
    const stored = new SpecStore().get(f.project)!;
    expect(await executePlanApply(f.ctx, { project: f.project, spec: stored.spec, specRevision: stored.revision,
      planId: planned.planRunId, confirmActions: [], alwaysRunBootstrap: true })).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(applyCi).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: f.ciAction, authority: 'secret-sync', appliedSpecHash: false }));
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).toEqual(f.environment.platformBindings);
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it.each(['external-dependency', 'unverified-ci'] as const)('does not bypass %s for CI synchronization', async state => {
    const f = fixture(); f.ci.mockResolvedValue({ actions: [{ ...f.ciAction,
      ...(state === 'external-dependency' ? { dependsOn: ['database:postgres'] } : { verified: false }) }], warnings: [] });
    expect(await f.plan()).toMatchObject({ error: expect.stringContaining('Cannot verify current runtime secret reference') });
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'replaced'] as const)('does not use a %s prepared identity to bypass secret verification', async state => {
    const f = fixture();
    if (state === 'unknown') f.inspect.mockResolvedValue({ state: 'unknown' } as never);
    else { const proof = await f.inspect(); f.inspect.mockResolvedValue({ ...proof, bindings: { ...proof.bindings,
      services: { web: { ...proof.bindings.services.web, resourceUid: 'replacement-uid' } } } }); }
    expect(await f.plan()).toMatchObject({ error: expect.stringContaining('Installer-prepared hosting identity') });
    expect(f.ci).not.toHaveBeenCalled(); expect(f.mutation).not.toHaveBeenCalled();
  });
  it('preserves ordinary unknown bound workloads without a prepared capability', async () => {
    const f = fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { preparedHosting: undefined });
    vi.mocked(adapterFactory.getProviderAdapter).mockResolvedValue({ success: true, adapter: { name: 'cloudrun', capabilities: { supportsObserve: true },
      observe: async () => ({ provider: 'cloudrun', projectExists: true, services: [], databases: [], partial: true, warnings: [], observedAt: new Date().toISOString() }) } as never });
    expect(await f.plan()).toMatchObject({ error: expect.stringContaining('Cannot verify current runtime secret reference') });
    expect(f.mutation).not.toHaveBeenCalled();
  });
});
