import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { applyStorageAction, parseStorageBindings, planStorage } from '../storage-plan.service.js';
import { gcsTeardownFixture, bucketPath } from '../../../adapters/providers/gcp/__tests__/gcs-teardown.fixture.js';
import { parseStorageCreateRecoveryMap } from '../../ports/storage.port.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'hv-storage-delete-evidence-'));
  SqliteAdapter.resetInstance(); initializeDatabase(join(directory, 'state.db')); });
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
const spec = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: {} });
const context = { projectId: 'cloud-project' };
const evidence = { provider: 'gcs', externalId: 'managed', instanceScope: context,
  observedAt: '2026-11-03T12:00:00.000Z', activeState: 'absent',
  nativeIdentity: { generation: '101', projectNumber: '123456789', timeCreated: '2026-10-31T12:00:00.000Z' },
  retention: { state: 'recoverable', resources: [
    { kind: 'bucket', name: 'managed', generation: '101', softDeleteTime: '2026-11-03T12:00:00.000Z', hardDeleteTime: '2026-11-10T12:00:00.000Z' },
  ] } };

function fixture(receipt = { success: true, message: 'Removed active bucket; recovery data retained', data: { storageDeletion: evidence } }) {
  const projects = new ProjectRepository(), environments = new EnvironmentRepository();
  const project = projects.create({ name: 'storage-delete', defaultPlatform: 'cloudrun' });
  const environment = environments.create({ projectId: project.id, name: 'test', platformBindings: {
    unrelated: { preserve: true }, storageProviders: { gcs: context },
    storage: { documents: { provider: 'gcs', externalId: 'managed', instanceScope: context, region: 'us-central1', services: [], envKeys: [] } },
  } });
  const adapter = { name: 'gcs', destroyBucket: vi.fn(async () => receipt) };
  vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true, adapter } as never);
  const action = planStorage({ environment, environmentSpec: spec, observed: null }).actions.find(item => item.type === 'destroy')!;
  return { project, environment, environments, adapter,
    apply: () => applyStorageAction({ project, envName: 'test', environmentSpec: spec, action }),
    read: () => environments.findById(environment.id)! };
}

describe('storage deletion receipt persistence and binding removal', () => {
  it.each([403, 'uncertain'] as const)('requires a fresh exact conditional retry after %s without changing the previous outcome', async outcome => {
    const f = fixture(), native = await gcsTeardownFixture({ environmentId: f.environment.id,
      ...(outcome === 'uncertain' ? { objectResponseLostBeforeCommit: true } : { objectRejectOnce: outcome }) });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    expect(await f.apply()).toMatchObject({ success: false });
    expect(f.read().platformBindings.storageCreateRecovery).toMatchObject({ documents: { snapshot: {
      phase: outcome === 'uncertain' ? 'uncertain' : 'rejected',
      ...(outcome === 'uncertain' ? {} : { rejectionStatus: outcome }), nextStep: 0,
    } } });
    SqliteAdapter.resetInstance(); initializeDatabase(join(directory, 'state.db'));
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: await native.createAdapter() });
    const observation = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    expect(observation.type).toBe('update');
    const start = native.calls.length;
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: observation })).toMatchObject({ success: false, status: 'pending' });
    expect(native.calls.slice(start).every(call => call.method === 'GET')).toBe(true);
    const retry = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    expect(retry).toMatchObject({ type: 'destroy', requiresConfirm: true, metadata: { operation: 'storageDeletionRetry' } });
    expect(retry.reason).toMatch(outcome === 'uncertain' ? /uncertain/i : /rejected/i);
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: retry })).toMatchObject({ success: false, status: 'pending' });
    expect(native.calls.filter(call => call.method === 'DELETE' && (call.url.searchParams.get('generation') === '20' || call.url.pathname === bucketPath))).toEqual([]);
    const continuation = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    expect(continuation).toMatchObject({ type: 'destroy', requiresConfirm: true, metadata: { operation: 'storageDeletionContinue' } });
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: continuation })).toMatchObject({ success: true });
    expect(f.read().platformBindings.storageDeletionReceipts).toMatchObject({ documents: [{ priorAttempts: [
      expect.objectContaining({ step: 0, outcome: outcome === 'uncertain' ? 'uncertain' : 'rejected',
        ...(outcome === 'uncertain' ? {} : { rejectionStatus: outcome }) }),
    ] }] });
    expect(native.calls.filter(call => call.method === 'DELETE' && call.url.searchParams.get('generation') === '10')).toHaveLength(2);
  });

  it('records a definite 412 rejection but cannot silently adopt the changed object metadata', async () => {
    const f = fixture(), native = await gcsTeardownFixture({ environmentId: f.environment.id, objectRejectOnce: 412 });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    expect(await f.apply()).toMatchObject({ success: false });
    expect(f.read().platformBindings.storageCreateRecovery).toMatchObject({ documents: { snapshot: { phase: 'rejected', rejectionStatus: 412, nextStep: 0 } } });
    const observation = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    const start = native.calls.length;
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: observation })).toMatchObject({ success: false });
    expect(native.calls.slice(start).every(call => call.method === 'GET')).toBe(true);
    expect(planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0].type).toBe('update');
  });

  it('blocks an explicitly planned retry when the exact child metadata changes after read-only observation', async () => {
    const f = fixture(), native = await gcsTeardownFixture({ environmentId: f.environment.id, objectResponseLostBeforeCommit: true });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    await f.apply();
    const observe = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: observe })).toMatchObject({ status: 'pending' });
    const retry = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    native.versions[0].metageneration = '7';
    const start = native.calls.length;
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: retry })).toMatchObject({ success: false });
    expect(native.calls.slice(start).filter(call => call.method === 'DELETE')).toEqual([]);
    expect(f.read().platformBindings.storageCreateRecovery).toMatchObject({ documents: { snapshot: { phase: 'uncertain', nextStep: 0 } } });
  });

  it('observes a late completion without retrying when the prior uncertain request commits after review', async () => {
    const f = fixture(), native = await gcsTeardownFixture({ environmentId: f.environment.id, objectResponseLostBeforeCommit: true });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    await f.apply();
    const observe = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: observe });
    const retry = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    native.retained.push({ ...native.versions.shift()!, softDeleteTime: '2026-11-03T12:00:00.000Z', hardDeleteTime: '2026-11-10T12:00:00.000Z' });
    const start = native.calls.length;
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: retry })).toMatchObject({ success: false, status: 'pending' });
    expect(native.calls.slice(start).every(call => call.method === 'GET')).toBe(true);
    expect(f.read().platformBindings.storageCreateRecovery).toMatchObject({ documents: { snapshot: { phase: 'ready', nextStep: 1 } } });
  });

  it.each(['lost-delete-response', 'completion-cas-failure'] as const)('recovers %s through the real caller after restart with reads only', async fault => {
    const f = fixture();
    const native = await gcsTeardownFixture({ environmentId: f.environment.id,
      ...(fault === 'lost-delete-response' ? { fault: 'bucket-delete-uncertain' } : {}) });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    const original = EnvironmentRepository.prototype.compareAndSwapPlatformBindings;
    const cas = vi.spyOn(EnvironmentRepository.prototype, 'compareAndSwapPlatformBindings').mockImplementation(function(this: EnvironmentRepository, id, expected, next) {
      if (fault === 'completion-cas-failure' && next.storageDeletionReceipts) return null;
      return original.call(this, id, expected, next);
    });
    expect(await f.apply()).toMatchObject({ success: false });
    const marker = f.read().platformBindings.storageCreateRecovery;
    expect(marker).toMatchObject({ documents: { operation: 'delete' } });
    expect(parseStorageCreateRecoveryMap(marker)).toBeNull(); // Old strict readers fail closed.
    expect(parseStorageBindings(f.read()).documents.externalId).toBe('managed');
    cas.mockRestore();
    SqliteAdapter.resetInstance(); initializeDatabase(join(directory, 'state.db'));
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: await native.createAdapter() });
    const action = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    const start = native.calls.length;
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action }))
      .toMatchObject({ success: true });
    expect(native.calls.slice(start).every(call => call.method === 'GET')).toBe(true);
    expect(native.calls.filter(call => call.method === 'DELETE' && call.url.pathname === bucketPath)).toHaveLength(1);
    expect(parseStorageBindings(f.read())).toEqual({});
    expect(f.read().platformBindings.storageCreateRecovery).toBeUndefined();
    expect(f.read().platformBindings.storageDeletionReceipts).toMatchObject({ documents: [expect.objectContaining({ activeState: 'absent' })] });
  });

  it('does not dispatch any deletion when its write-ahead identity cannot be saved', async () => {
    const f = fixture(), native = await gcsTeardownFixture({ environmentId: f.environment.id });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    vi.spyOn(EnvironmentRepository.prototype, 'compareAndSwapPlatformBindings').mockReturnValue(null);
    expect(await f.apply()).toMatchObject({ success: false });
    expect(native.calls.filter(call => call.method === 'DELETE')).toEqual([]);
    expect(parseStorageBindings(f.read()).documents.externalId).toBe('managed');
  });

  it.each(['lost-response', 'step-cas-failure'] as const)('recovers an uncertain child after %s by reads, then authorizes only unattempted steps in a fresh plan', async fault => {
    const f = fixture(), native = await gcsTeardownFixture({ environmentId: f.environment.id, objectDeleteUncertain: fault === 'lost-response' });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    const original = EnvironmentRepository.prototype.compareAndSwapPlatformBindings;
    const cas = vi.spyOn(EnvironmentRepository.prototype, 'compareAndSwapPlatformBindings').mockImplementation(function(this: EnvironmentRepository, id, expected, next) {
      const progress = (next.storageCreateRecovery as Record<string, { snapshot: { nextStep: number } }> | undefined)?.documents;
      if (fault === 'step-cas-failure' && progress?.snapshot.nextStep === 1) return null;
      return original.call(this, id, expected, next);
    });
    expect(await f.apply()).toMatchObject({ success: false });
    expect(f.read().platformBindings.storageCreateRecovery).toMatchObject({ documents: { operation: 'delete', snapshot: {
      phase: 'uncertain', nextStep: 0, steps: [expect.objectContaining({ kind: 'object', generation: '10' }),
        expect.objectContaining({ kind: 'object', generation: '20' }), expect.objectContaining({ kind: 'bucket' })],
    } } });
    cas.mockRestore();
    SqliteAdapter.resetInstance(); initializeDatabase(join(directory, 'state.db'));
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: await native.createAdapter() });
    const recovery = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    const start = native.calls.length;
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: recovery }))
      .toMatchObject({ success: false, status: 'pending' });
    expect(native.calls.slice(start).every(call => call.method === 'GET')).toBe(true);
    const continuation = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    expect(continuation).toMatchObject({ type: 'destroy', requiresConfirm: true });
    const beforeRejected = native.calls.length;
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: recovery }))
      .toMatchObject({ success: false, status: 'blocked' });
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec,
      action: { ...continuation, requiresConfirm: false } })).toMatchObject({ success: false, status: 'blocked' });
    expect(native.calls.length).toBe(beforeRejected);
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: continuation }))
      .toMatchObject({ success: true });
    expect(native.calls.filter(call => call.method === 'DELETE' && call.url.searchParams.get('generation') === '10')).toHaveLength(1);
    expect(native.calls.filter(call => call.method === 'DELETE' && call.url.searchParams.get('generation') === '20')).toHaveLength(1);
    expect(f.read().platformBindings.storageCreateRecovery).toBeUndefined();
    expect(parseStorageBindings(f.read())).toEqual({});
  });

  it.each(['binding', 'legacy-context'] as const)('blocks the first child when %s changes after initial progress persistence', async change => {
    const f = fixture();
    if (change === 'legacy-context') {
      const binding = { ...parseStorageBindings(f.read()).documents }; delete binding.instanceScope;
      f.environments.updatePlatformBindings(f.environment.id, { storage: { documents: binding } });
    }
    const native = await gcsTeardownFixture({ environmentId: f.environment.id });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    const original = EnvironmentRepository.prototype.compareAndSwapPlatformBindings;
    let changed = false;
    vi.spyOn(EnvironmentRepository.prototype, 'compareAndSwapPlatformBindings').mockImplementation(function(this: EnvironmentRepository, id, expected, next) {
      const result = original.call(this, id, expected, next);
      if (!changed && result && next.storageCreateRecovery) {
        changed = true;
        this.updatePlatformBindings(id, change === 'binding'
          ? { storage: { documents: { ...parseStorageBindings(f.read()).documents, externalId: 'replacement' } } }
          : { storageProviders: { gcs: { projectId: 'replacement-project' } } });
      }
      return result;
    });
    expect(await f.apply()).toMatchObject({ success: false });
    expect(native.calls.filter(call => call.method === 'DELETE')).toEqual([]);
    expect(f.read().platformBindings.storageCreateRecovery).toMatchObject({ documents: { snapshot: { phase: 'ready', nextStep: 0 } } });
  });

  it('retains the ordinary runtime-permission blocker on a fresh deletion continuation', async () => {
    const f = fixture(), native = await gcsTeardownFixture({ environmentId: f.environment.id, objectDeleteUncertain: true });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    expect(await f.apply()).toMatchObject({ success: false });
    const recovery = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action: recovery })).toMatchObject({ status: 'pending' });
    f.environments.updatePlatformBindings(f.environment.id, { storageRuntimeAccess: { documents: { web: {} } } });
    const action = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    const start = native.calls.length;
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action })).toMatchObject({ success: false, status: 'blocked' });
    expect(native.calls.slice(start).filter(call => call.method === 'DELETE')).toEqual([]);
    expect(parseStorageBindings(f.read()).documents.externalId).toBe('managed');
  });

  it('preserves a same-named native replacement during read-only recovery', async () => {
    const f = fixture(), native = await gcsTeardownFixture({ environmentId: f.environment.id, fault: 'bucket-delete-uncertain' });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    expect(await f.apply()).toMatchObject({ success: false });
    const marker = f.read().platformBindings.storageCreateRecovery;
    native.replaceActiveBucket();
    const start = native.calls.length;
    const action = planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions[0];
    expect(await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action })).toMatchObject({ success: false });
    expect(native.calls.slice(start).every(call => call.method === 'GET')).toBe(true);
    expect(f.read().platformBindings.storageCreateRecovery).toEqual(marker);
    expect(parseStorageBindings(f.read()).documents.externalId).toBe('managed');
  });

  it('does not clear a legacy binding when its effective provider context changed', async () => {
    const f = fixture(), current = f.read();
    const binding = { ...parseStorageBindings(current).documents }; delete binding.instanceScope;
    f.environments.updatePlatformBindings(current.id, { storage: { documents: binding } });
    f.adapter.destroyBucket.mockImplementation(async () => {
      f.environments.updatePlatformBindings(current.id, { storageProviders: { gcs: { projectId: 'replacement-project' } } });
      return { success: true, message: 'Old target removed', data: { storageDeletion: evidence } };
    });
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(parseStorageBindings(f.read()).documents.instanceScope).toEqual({ projectId: 'replacement-project' });
  });

  it('atomically preserves exact retention evidence before the caller can record an apply receipt', async () => {
    const f = fixture();
    expect(await f.apply()).toMatchObject({ success: true });
    // No outer executor runs here: this is the process-crash window immediately
    // after storage apply returns, before converge writes its separate run receipt.
    expect(f.read().platformBindings.storageDeletionReceipts).toEqual({ documents: [evidence] });
    expect(parseStorageBindings(f.read())).toEqual({});
    expect(f.read().platformBindings.unrelated).toEqual({ preserve: true });
    expect(planStorage({ environment: f.read(), environmentSpec: spec, observed: null }).actions).toEqual([]);
  });

  it('preserves a concurrently replaced binding and cannot clear it with old deletion evidence', async () => {
    const f = fixture();
    f.adapter.destroyBucket.mockImplementation(async () => {
      const current = f.read();
      f.environments.updatePlatformBindings(current.id, { storage: { documents: {
        ...parseStorageBindings(current).documents, externalId: 'replacement',
      } } });
      return { success: true, message: 'Old target removed', data: { storageDeletion: evidence } };
    });
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(parseStorageBindings(f.read()).documents.externalId).toBe('replacement');
  });

  it.each(['malformed', 'wrong-target', 'wrong-scope', 'unknown-state', 'secret-extra-field', 'nested-secret', 'private-value'] as const)(
    'does not drop the binding or persist unvalidated %s evidence', async change => {
      const invalid: Record<string, unknown> = structuredClone(evidence);
      if (change === 'malformed') delete invalid.retention;
      if (change === 'wrong-target') invalid.externalId = 'unrelated';
      if (change === 'wrong-scope') invalid.instanceScope = { projectId: 'foreign' };
      if (change === 'unknown-state') invalid.activeState = 'unknown';
      if (change === 'secret-extra-field') invalid.secretValue = 'must-not-persist';
      if (change === 'nested-secret') invalid.nativeIdentity = { credentials: 'must-not-persist' };
      if (change === 'private-value') invalid.nativeIdentity = { generation: 'postgresql://name:password@private/db' };
      const f = fixture({ success: true, message: 'Untrusted completion', data: { storageDeletion: invalid as typeof evidence } });
      expect(await f.apply()).toMatchObject({ success: false, status: 'blocked' });
      expect(parseStorageBindings(f.read()).documents.externalId).toBe('managed');
      expect(f.read().platformBindings.storageDeletionReceipts).toBeUndefined();
    });

  it('retains the binding when deletion failed or its retention observation is unknown', async () => {
    const f = fixture({ success: false, message: 'Retention read denied', data: { storageDeletion: evidence } });
    expect(await f.apply()).toMatchObject({ success: false });
    expect(parseStorageBindings(f.read()).documents.externalId).toBe('managed');
    expect(f.read().platformBindings.storageDeletionReceipts).toBeUndefined();
  });
});
