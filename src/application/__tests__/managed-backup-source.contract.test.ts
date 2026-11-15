import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../ci/providers.js';
import { executeManagedBackup } from '../managed-backup.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { railwayHttpFixture, projectId, stagingId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import type { ManagedBackupTarget } from '../../domain/services/managed-backup-target.service.js';
import * as retained from '../../domain/services/recovery-set-health.service.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Real Railway source observation uses graphql-request and the pinned official
// GraphQL schema. Archive evidence and worker execution are mocked at their
// shared boundaries: this checks source admission, not live backup completion.
describe('recurring controller freshly verifies its native database source', () => {
  it.each([...['health', 'backup'].flatMap(operation => ['current', 'replaced', 'unknown'].map(state => ({ operation: operation as 'health' | 'backup', state }))),
    { operation: 'backup' as const, state: 'cleanup-unknown' }])(
    'checks $state source before $operation evidence or writes', async ({ operation, state }) => {
      vi.restoreAllMocks(); vi.unstubAllGlobals();
      const localState = vi.spyOn(SqliteAdapter, 'getInstance').mockImplementation(() => { throw new Error('Recurring controller must not open local SQLite.'); });
      const http = await railwayHttpFixture({ responseOverride: ({ query }) => state === 'unknown' && query.includes('DatabaseCheckpointTarget')
        ? Response.json({ errors: [{ message: 'synthetic denied' }] }, { status: 403 }) : undefined });
      http.addService('database-service', 'postgres', stagingId);
      const volume = http.addVolume('database-service', stagingId, '/var/lib/postgresql/data');
      http.environment.platformBindings.recoveryDatabases = [{ componentId: 'database-component', provider: 'railway', engine: 'postgres', resourceKind: 'service', externalId: 'database-service' }];
      const source = { provider: 'railway', primaryExternalId: 'database-service', providerScope: { projectId, environmentId: stagingId },
        resourceIdentity: { volumeId: volume.id, volumeInstanceId: String(volume.instance.id) } };
      const identity = { provider: 'railway', externalId: 'vault', instanceScope: { projectId, environmentId: stagingId } };
      const target: ManagedBackupTarget = { version: 1, project: 'test', environment: 'staging',
        hosting: { provider: 'railway', providerScope: { projectId, environmentId: stagingId } },
        runnerImage: `docker.io/example/recovery@sha256:${'a'.repeat(64)}`, database: { componentId: 'database-component', source },
        destination: { name: 'vault', identity }, objects: [], fileReferenceQueries: [], retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 };
      if (state === 'replaced') volume.instance.id = 'new-volume-instance-same-service';
      const archive = { destroy: vi.fn() };
      const storage = { name: 'railway', capabilities: { recoveryCredentialScope: 'bucket' },
        observe: vi.fn(async () => [{ ...identity, status: 'ready' }]), openObjectTransfer: async () => archive,
        getCredentials: vi.fn(async () => ({ bucket: 'vault', endpoint: 'https://example.invalid', accessKeyId: 'bucket-key', secretAccessKey: 'bucket-secret', region: 'auto', urlStyle: 'path' })) };
      vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue(http.adapter);
      vi.spyOn(providerRegistry.get('railway')!.derivedAdapters!, 'storage').mockResolvedValue(storage);
      const run = vi.spyOn(http.adapter, 'runJob').mockResolvedValue({ jobId: 'job', status: 'completed', exitCode: 0,
        receipt: { success: true, message: 'Completed', ...(state === 'cleanup-unknown' ? {} : { data: { cleanupVerified: true } }) } });
      const observe = vi.spyOn(retained, 'observeManagedRecoverySet').mockResolvedValue({ status: 'healthy', reasonCodes: [] } as never);
      const record = vi.spyOn(retained, 'recordRecoveryExecution').mockResolvedValue({ applied: 1, skipped: 0 });
      vi.spyOn(retained, 'applyManagedRecoveryRetention').mockResolvedValue({ success: true } as never);
      const promise = executeManagedBackup({ target, environment: http.environment, operation,
        repository: 'owner/project', runId: '123', credentials: { RAILWAY_API_TOKEN: 'controller-only-token' } });
      if (state === 'current') {
        expect(await promise).toMatchObject({ status: 'healthy' });
        expect(observe).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(operation === 'backup' ? 1 : 0);
      } else if (state === 'cleanup-unknown') {
        await expect(promise).rejects.toThrow(/cleanup is unverified/);
        expect(run).toHaveBeenCalledOnce();
        expect(observe).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
      } else {
        await expect(promise).rejects.toThrow(/database source/i);
        expect(observe).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
      }
      expect(http.requests.some(request => request.query.includes('DatabaseCheckpointTarget'))).toBe(true);
      expect(http.mutations).toEqual([]); expect(http.contractErrors).toEqual([]);
      expect(localState).not.toHaveBeenCalled();
  });
});
