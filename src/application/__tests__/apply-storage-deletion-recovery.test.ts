import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { gcsTeardownFixture } from '../../adapters/providers/gcp/__tests__/gcs-teardown.fixture.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { applyStorageAction, planStorage } from '../../domain/services/storage-plan.service.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import '../providers.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'hv-apply-storage-deletion-')); SqliteAdapter.resetInstance(); initializeDatabase(join(directory, 'state.db')); });
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

async function fixture(lostBeforeCommit = false) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'storage-retirement', defaultPlatform: 'cloudrun' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    unrelated: { preserved: true }, storageProviders: { gcs: { projectId: 'cloud-project' } },
    storage: { documents: { provider: 'gcs', externalId: 'managed', instanceScope: { projectId: 'cloud-project' }, region: 'us-central1', services: [], envKeys: [] } },
  } });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: {
    hosting: { provider: 'cloudrun' }, services: {}, backups: { mode: 'disabled', reason: 'Explicit storage cleanup test' }, email: { enabled: false },
  } } });
  const environmentSpec = spec.environments.production;
  const native = await gcsTeardownFixture({ environmentId: environment.id,
    ...(lostBeforeCommit ? { objectResponseLostBeforeCommit: true } : { objectDeleteUncertain: true }) });
  vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true, adapter: native.adapter });
  vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
  const read = () => ctx.repos.environments.findById(environment.id)!;
  const plan = () => planStorage({ environment: read(), environmentSpec, observed: null }).actions[0];
  expect(await applyStorageAction({ project, envName: 'production', environmentSpec, action: plan() })).toMatchObject({ success: false });
  const apply = async (action: PlanAction, confirm = false) => {
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
      kind: 'hv_plan', scope: 'full', environmentName: 'production', specRevision: 1, observedFingerprint: null, actions: [action],
    } });
    return executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id, confirmActions: confirm ? [action.id] : [] });
  };
  return { native, read, plan, apply };
}

describe('saved storage deletion recovery action authority', () => {
  it('dispatches read-only recovery, then requires exact confirmation for remaining generations', async () => {
    const f = await fixture();
    const start = f.native.calls.length;
    const recovery = f.plan();
    expect(recovery.metadata?.operation).toBe('storageDeletionRecover');
    const recovered = await f.apply(recovery);
    expect(recovered).toMatchObject({ kind: 'executed', result: { receipts: [expect.objectContaining({ status: 'pending' })] } });
    expect(f.native.calls.slice(start).length).toBeGreaterThan(0);
    expect(f.native.calls.slice(start).every(call => call.method === 'GET')).toBe(true);
    const continuation = f.plan();
    expect(continuation.metadata?.operation).toBe('storageDeletionContinue');
    expect(await f.apply(continuation)).toMatchObject({ kind: 'executed', result: { success: false } });
    const beforeConfirmed = f.native.calls.length;
    expect(await f.apply(continuation, true)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.native.calls.slice(beforeConfirmed).some(call => call.method === 'DELETE')).toBe(true);
    expect(f.read().platformBindings).toMatchObject({ unrelated: { preserved: true }, storageDeletionReceipts: { documents: [expect.objectContaining({ activeState: 'absent' })] } });
  });

  it('dispatches only the separately confirmed exact conditional retry after presence observation', async () => {
    const f = await fixture(true);
    await f.apply(f.plan());
    const retry = f.plan();
    expect(retry).toMatchObject({ id: 'storage:documents:deletion-retry', metadata: { operation: 'storageDeletionRetry' } });
    const start = f.native.calls.length;
    expect(await f.apply(retry)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.calls.slice(start).filter(call => call.method === 'DELETE')).toEqual([]);
    const beforeRetry = f.native.calls.length;
    expect(await f.apply(retry, true)).toMatchObject({ kind: 'executed', result: { receipts: [expect.objectContaining({ status: 'pending' })] } });
    const deletes = f.native.calls.slice(beforeRetry).filter(call => call.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url.searchParams.get('generation')).toBe('10');
    expect(f.read().platformBindings.storage).toHaveProperty('documents');
    const continuation = f.plan();
    expect(continuation.metadata?.operation).toBe('storageDeletionContinue');
    expect(await f.apply(continuation, true)).toMatchObject({ kind: 'executed', result: { success: true } });
  });

  it.each(['id', 'resource', 'hash', 'hash-type', 'operation', 'confirmation', 'extra-metadata'] as const)('refuses forged %s before any provider call', async field => {
    const f = await fixture();
    // Provider readback creates the real next-step marker without exercising the saved dispatch under test.
    const action = f.plan();
    const forged = structuredClone(action);
    if (field === 'id') forged.id = 'storage:other:deletion-recovery';
    if (field === 'resource') forged.resource.name = 'other';
    if (field === 'hash') forged.metadata!.recoverySha256 = 'not-a-hash';
    if (field === 'hash-type') forged.metadata!.recoverySha256 = [forged.metadata!.recoverySha256];
    if (field === 'operation') forged.metadata!.operation = 'storageDestroy';
    if (field === 'confirmation') forged.requiresConfirm = true;
    if (field === 'extra-metadata') forged.metadata!.serviceName = 'unrelated';
    const start = f.native.calls.length;
    expect(await f.apply(forged, true)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.calls.slice(start)).toEqual([]);
  });
});
