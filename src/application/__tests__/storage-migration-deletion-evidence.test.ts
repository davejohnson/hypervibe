import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import type { IStorageAdapter } from '../../domain/ports/storage.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import * as maintenance from '../../domain/services/environment-maintenance.service.js';
import { createCommandContext } from '../context.js';
import { applyDataMigrationAction } from '../apply-data-migration.js';
import { gcsTeardownFixture, bucketPath } from '../../adapters/providers/gcp/__tests__/gcs-teardown.fixture.js';
import { applyStorageAction, planStorage } from '../../domain/services/storage-plan.service.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'hv-storage-migration-delete-'));
  SqliteAdapter.resetInstance(); initializeDatabase(join(directory, 'state.db')); });
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
const context = { projectId: 'cloud-project' };

function fixture(mode: 'previous' | 'failed-copy' | 'changed-source' | 'lingering', invalid = false) {
  const environments = new EnvironmentRepository();
  const project = new ProjectRepository().create({ name: 'migration-delete-evidence', defaultPlatform: 'cloudrun' });
  const binding = { provider: 'gcs', externalId: 'source', instanceScope: context, region: 'us-central1', services: [], envKeys: [] };
  const source = environments.create({ projectId: project.id, name: 'staging', platformBindings: { storage: { documents: binding } } });
  const target = environments.create({ projectId: project.id, name: 'production', platformBindings: {
    storageProviders: { gcs: context },
    storage: mode === 'previous' ? { documents: { ...binding, externalId: 'active-target',
      dataMigration: { id: 'copy-test', fromEnvironment: 'staging' },
      previousTarget: { ...binding, externalId: 'old-target' } } } : {},
    ...(mode === 'lingering' ? { dataMigrationCandidates: { storage: { documents: {
      migrationId: 'copy-test', provider: 'gcs', externalId: 'old-candidate', context, region: 'us-central1',
    } } } } : {}),
  } });
  const environmentSpec = { hosting: { provider: 'cloudrun' }, services: {}, maintenance: { enabled: true },
    storage: { documents: { provider: 'gcs', type: 'bucket', region: 'us-central1', injectInto: [] } } };
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    staging: environmentSpec, production: { ...environmentSpec, dataMigration: { id: 'copy-test', fromEnvironment: 'staging', include: { database: false, storage: ['documents'] } } },
  } });
  const maintenanceState = { state: 'active' as const };
  vi.spyOn(maintenance, 'observeEnvironmentMaintenance').mockResolvedValue(maintenanceState as never);
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { name: 'cloudrun' } } as never);
  const fingerprint = createHash('sha256').update(JSON.stringify(maintenanceState)).digest('hex');
  const action: PlanAction = { id: 'migration:documents', type: mode === 'previous' ? 'destroy' : 'update',
    resource: { kind: 'storage', provider: 'gcs', name: 'documents' }, reason: 'Reviewed migration cleanup', verified: true, requiresConfirm: true,
    metadata: { operation: mode === 'previous' ? 'dataMigrationStoragePreviousDestroy' : 'dataMigrationStorageCopy',
      migrationId: 'copy-test', sourceEnvironment: 'staging', targetEnvironment: 'production', sourceProvider: 'gcs', targetProvider: 'gcs',
      storageName: 'documents', sourceExternalId: 'source', sourceInstanceScope: context,
      previousExternalId: 'old-target', sourceMaintenanceFingerprint: fingerprint, targetMaintenanceFingerprint: fingerprint } };
  const receipts: Array<Record<string, unknown>> = [];
  let copied = false;
  const adapter = { name: 'gcs', capabilities: { kind: 'object', regions: [], privateOnly: true, supportsUsageObservation: true },
    runtimeEnvKeys: () => [],
    ensureContext: async () => ({ receipt: { success: true, message: 'Ready' }, context }),
    ensureBucket: async () => ({ receipt: { success: true, message: 'Created' }, context, externalId: 'new-candidate' }),
    openObjectTransfer: async (_env, _scope, externalId) => ({
      list: async () => externalId === 'source' || copied ? [{ key: 'one', size: 1 }] : [],
      get: async () => ({ body: new Blob(['x']), size: 1 }),
      put: async () => {
        if (mode === 'failed-copy') throw new Error('synthetic transfer failure');
        copied = true;
        if (mode === 'changed-source') environments.updatePlatformBindings(source.id, { storage: { documents: { ...binding, externalId: 'replacement-source' } } });
      }, destroy: () => undefined,
    }),
    destroyBucket: vi.fn(async (_env, _scope, externalId) => {
      const evidence = { provider: 'gcs', externalId: invalid ? 'unrelated' : externalId, instanceScope: context,
        observedAt: '2026-11-03T12:00:00.000Z', activeState: 'absent', nativeIdentity: { generation: '101', projectNumber: '123456789' },
        retention: { state: 'recoverable', resources: [{ kind: 'bucket', name: externalId, generation: '101',
          softDeleteTime: '2026-11-03T12:00:00.000Z', hardDeleteTime: '2026-11-10T12:00:00.000Z' }] } };
      receipts.push(evidence);
      return { success: true, message: 'Removed active bucket; recoverable retention remains', data: { storageDeletion: evidence } };
    }),
  } satisfies Partial<IStorageAdapter>;
  vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true, adapter } as never);
  return { receipts, adapter, target, environments, project, spec, action, read: () => environments.findById(target.id)!,
    apply: () => applyDataMigrationAction({ ctx: createCommandContext(), project, spec, targetEnvironmentName: 'production', action }) };
}

describe('storage migration cleanup retains native deletion evidence', () => {
  it.each([
    { mode: 'previous', child: false }, { mode: 'lingering', child: false },
    { mode: 'previous', child: true }, { mode: 'lingering', child: true },
  ] as const)('recovers uncertain native $mode cleanup (child=$child) through the migration caller', async ({ mode, child }) => {
    const f = fixture(mode);
    const current = f.read();
    if (mode === 'previous') {
      const storage = current.platformBindings.storage as Record<string, Record<string, unknown>>;
      storage.documents.previousTarget = { ...(storage.documents.previousTarget as Record<string, unknown>), externalId: 'managed' };
      f.environments.updatePlatformBindings(current.id, { storage });
      f.action.metadata!.previousExternalId = 'managed';
    } else {
      f.environments.updatePlatformBindings(current.id, { dataMigrationCandidates: { storage: { documents: {
        migrationId: 'copy-test', provider: 'gcs', externalId: 'managed', context, region: 'us-central1',
      } } } });
    }
    const native = await gcsTeardownFixture({ environmentId: current.id,
      ...(child ? { objectDeleteUncertain: true } : { fault: 'bucket-delete-uncertain' as const }) });
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: native.adapter });
    expect(await f.apply()).toMatchObject({ success: false });
    expect(f.read().platformBindings.storageCreateRecovery).toMatchObject({ documents: {
      operation: 'delete', target: mode === 'previous' ? 'previous' : 'candidate',
    } });
    SqliteAdapter.resetInstance(); initializeDatabase(join(directory, 'state.db'));
    vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: true, adapter: await native.createAdapter() });
    const start = native.calls.length;
    const result = await f.apply();
    expect(result).toMatchObject(mode === 'previous' && !child ? { success: true } : { success: false, status: 'pending' });
    expect(native.calls.slice(start).every(call => call.method === 'GET')).toBe(true);
    if (child) {
      // Replaying the migration action cannot dispatch the remaining program.
      const beforeReplay = native.calls.length;
      expect(await f.apply()).toMatchObject({ success: false, status: 'pending' });
      expect(native.calls.slice(beforeReplay).every(call => call.method === 'GET')).toBe(true);
      const environmentSpec = f.spec.environments.production;
      const action = planStorage({ environment: f.read(), environmentSpec, observed: null }).actions[0];
      expect(action).toMatchObject({ type: 'destroy', requiresConfirm: true });
      expect(await applyStorageAction({ project: f.project, envName: 'production', environmentSpec, action })).toMatchObject({ success: true });
      expect(native.calls.filter(call => call.method === 'DELETE' && call.url.searchParams.get('generation') === '10')).toHaveLength(1);
    }
    expect(native.calls.filter(call => call.method === 'DELETE' && call.url.pathname === bucketPath)).toHaveLength(1);
    expect(f.read().platformBindings.storageCreateRecovery).toBeUndefined();
    expect(f.read().platformBindings.storageDeletionReceipts).toMatchObject({ documents: [expect.objectContaining({ activeState: 'absent' })] });
  });

  it.each(['previous', 'failed-copy', 'changed-source', 'lingering'] as const)('keeps the %s cleanup receipt when clearing its old reference', async mode => {
    const f = fixture(mode);
    await f.apply();
    expect(f.adapter.destroyBucket).toHaveBeenCalled();
    expect(f.read().platformBindings.storageDeletionReceipts).toEqual({ documents: f.receipts });
    expect(JSON.stringify(f.read().platformBindings.storageDeletionReceipts)).toContain('recoverable');
  });

  it('does not discard a rollback reference after mismatched native completion', async () => {
    const f = fixture('previous', true);
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(f.read().platformBindings.storage).toMatchObject({ documents: { previousTarget: { externalId: 'old-target' } } });
    expect(f.read().platformBindings.storageDeletionReceipts).toBeUndefined();
  });
});
