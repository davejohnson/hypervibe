import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../ci/providers.js';
import { executeManagedBackup } from '../managed-backup.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import type { ManagedBackupTarget } from '../../domain/services/managed-backup-target.service.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import * as retained from '../../domain/services/recovery-set-health.service.js';
import * as recoverySets from '../../domain/services/recovery-set.service.js';
import { recoveryFailure } from '../../domain/ports/recovery-diagnostics.port.js';

afterEach(() => vi.restoreAllMocks());

// Synthetic provider results exercise the real application boundary. These are
// diagnostics/privacy regressions, not evidence that provider execution works.
function fixture() {
  const source = { provider: 'railway', primaryExternalId: 'db-service', providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: {} };
  const identity: ManagedBackupTarget['destination']['identity'] = { provider: 'railway', externalId: 'archive', instanceScope: { projectId: 'p', environmentId: 'e' } };
  const target: ManagedBackupTarget = { version: 1, project: 'test', environment: 'staging',
    hosting: { provider: 'railway', providerScope: { projectId: 'p', environmentId: 'e' } },
    runnerImage: `example.invalid/helper@sha256:${'a'.repeat(64)}`, database: { componentId: 'db', source },
    destination: { name: 'archive', identity }, objects: [], fileReferenceQueries: [], retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 };
  const environment: Environment = { id: 'e', projectId: 'p', name: 'staging', createdAt: new Date(), updatedAt: new Date(),
    platformBindings: { recoveryDatabases: [{ componentId: 'db', provider: 'railway', engine: 'postgres', externalId: 'db-service' }] } };
  const archive = { destroy: vi.fn() };
  const storage = { name: 'railway', capabilities: { recoveryCredentialScope: 'bucket' },
    observe: vi.fn(async () => [{ ...identity, status: 'ready' }]), openObjectTransfer: vi.fn(async () => archive),
    getCredentials: vi.fn(async () => ({ bucket: 'archive', endpoint: 'https://example.invalid', accessKeyId: 'private-access', secretAccessKey: 'private-secret', region: 'auto', urlStyle: 'path' })) };
  const runJob = vi.fn(async () => ({ jobId: 'private-job-id', status: 'failed', mutationAttempted: true,
    receipt: { success: false, message: 'private-message', data: { cleanupVerified: true } }, output: 'private-output' }));
  vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue({ runJob });
  vi.spyOn(providerRegistry.get('railway')!.derivedAdapters!, 'storage').mockResolvedValue(storage);
  vi.spyOn(providerRegistry.get('railway')!.derivedAdapters!, 'database').mockResolvedValue({ name: 'railway', dailyBackups: {
    observe: async () => ({ state: 'known', source }),
  } });
  const record = vi.spyOn(retained, 'recordRecoveryExecution');
  const execute = () => executeManagedBackup({ target, environment, operation: 'backup', repository: 'owner/project', runId: '123', credentials: { RAILWAY_API_TOKEN: 'private-control-token' } });
  return { target, archive, storage, runJob, record, execute };
}

describe('managed backup diagnostic handoff', () => {
  it('preserves validated provider diagnosis and only finite task facts', async () => {
    const f = fixture();
    f.runJob.mockResolvedValue({ jobId: 'private-job-id', status: 'failed', mutationAttempted: false,
      diagnostic: { stage: 'task-preflight', category: 'authorization', httpStatus: 403 },
      receipt: { success: false, message: 'private-message', data: { cleanupVerified: true } }, output: 'private-output' } as never);
    const error = await f.execute().catch(error => error);
    expect(error).toMatchObject({ diagnostic: { stage: 'task-preflight', category: 'authorization', httpStatus: 403,
      task: { status: 'failed', mutationAttempted: false, cleanupVerified: true } } });
    expect(JSON.stringify(error)).not.toMatch(/private-/);
    expect(f.record).not.toHaveBeenCalled();
  });

  it('rejects arbitrary diagnostic text while retaining safe execution facts', async () => {
    const f = fixture();
    f.runJob.mockResolvedValue({ jobId: 'private-job-id', status: 'timeout', mutationAttempted: true,
      diagnostic: { stage: 'private-stage', category: 'provider', error: 'private-secret' },
      receipt: { success: false, message: 'private-message', data: { cleanupVerified: false } } } as never);
    const error = await f.execute().catch(error => error);
    expect(error).toMatchObject({ diagnostic: { stage: 'task-execution', category: 'timeout',
      task: { status: 'timeout', mutationAttempted: true, cleanupVerified: false } } });
    expect(JSON.stringify(error)).not.toMatch(/private-/);
    expect(f.record).not.toHaveBeenCalled();
  });

  it('does not call a completed worker a completed recovery set when recording fails', async () => {
    const f = fixture();
    f.runJob.mockResolvedValue({ jobId: 'job', status: 'completed', exitCode: 0, mutationAttempted: true,
      receipt: { success: true, message: 'completed', data: { cleanupVerified: true } } } as never);
    f.record.mockRejectedValue(new Error('private-archive-secret'));
    await expect(f.execute()).rejects.toMatchObject({ diagnostic: { stage: 'completion-record', category: 'unknown',
      task: { status: 'completed', exitCode: 0, mutationAttempted: true, cleanupVerified: true } } });
  });

  it('labels archive opening before any task is attempted', async () => {
    const f = fixture();
    f.storage.openObjectTransfer.mockRejectedValue(new Error('private-storage-secret'));
    await expect(f.execute()).rejects.toMatchObject({ diagnostic: { stage: 'archive-open', category: 'unknown',
      task: { mutationAttempted: false } } });
    expect(f.runJob).not.toHaveBeenCalled();
  });

  it('preserves the provider failure when controller client shutdown also fails', async () => {
    const f = fixture();
    f.runJob.mockResolvedValue({ jobId: 'private-job-id', status: 'failed', mutationAttempted: true,
      diagnostic: { stage: 'task-configure', category: 'authorization', httpStatus: 403 },
      receipt: { success: false, message: 'private-message', data: { cleanupVerified: true } } } as never);
    f.archive.destroy.mockImplementation(() => { throw new Error('private-shutdown-secret'); });
    const error = await f.execute().catch(error => error);
    expect(error).toMatchObject({ diagnostic: { stage: 'task-configure', category: 'authorization', httpStatus: 403,
      localCleanupFailed: true, task: { mutationAttempted: true, cleanupVerified: true } } });
    expect(JSON.stringify(error)).not.toMatch(/private-/);
  });

  it('attempts every client shutdown while preserving an object-only copy failure', async () => {
    const f = fixture(); delete f.target.database;
    const identity = { ...f.target.destination.identity, externalId: 'documents' };
    f.target.objects = [{ name: 'documents', identity }];
    f.storage.observe.mockResolvedValue([{ ...f.target.destination.identity, status: 'ready' }, { ...identity, status: 'ready' }]);
    const source = { destroy: vi.fn() };
    f.storage.openObjectTransfer.mockResolvedValueOnce(f.archive).mockResolvedValueOnce(source);
    f.archive.destroy.mockImplementation(() => { throw new Error('private-shutdown-secret'); });
    vi.spyOn(recoverySets, 'createRecoverySet').mockRejectedValue(recoveryFailure('object-copy', 'execution'));
    await expect(f.execute()).rejects.toMatchObject({ diagnostic: { stage: 'object-copy', category: 'execution', localCleanupFailed: true } });
    expect(f.archive.destroy).toHaveBeenCalledOnce(); expect(source.destroy).toHaveBeenCalledOnce();
  });

  it('retains completed-set counts when only controller client shutdown fails', async () => {
    const f = fixture();
    f.runJob.mockResolvedValue({ jobId: 'job', status: 'completed', exitCode: 0, mutationAttempted: true,
      receipt: { success: true, message: 'completed', data: { cleanupVerified: true } } } as never);
    f.record.mockResolvedValue({ applied: 1, skipped: 0 });
    vi.spyOn(retained, 'applyManagedRecoveryRetention').mockResolvedValue({ success: true } as never);
    vi.spyOn(retained, 'observeManagedRecoverySet').mockResolvedValue({ status: 'healthy', reasonCodes: [] } as never);
    f.archive.destroy.mockImplementation(() => { throw new Error('private-shutdown-secret'); });
    await expect(f.execute()).resolves.toMatchObject({ status: 'unknown', counts: { applied: 1, skipped: 0 },
      diagnostic: { stage: 'restore-cleanup', category: 'cleanup', localCleanupFailed: true } });
  });

  it('retains worker facts and completed-set counts when retention remains unknown', async () => {
    const f = fixture();
    f.runJob.mockResolvedValue({ jobId: 'job', status: 'completed', exitCode: 0, mutationAttempted: true,
      receipt: { success: true, message: 'completed', data: { cleanupVerified: true } } } as never);
    f.record.mockResolvedValue({ applied: 1, skipped: 0 });
    vi.spyOn(retained, 'applyManagedRecoveryRetention').mockResolvedValue({ success: false } as never);
    await expect(f.execute()).resolves.toMatchObject({ status: 'unknown', counts: { applied: 1, skipped: 0 },
      diagnostic: { stage: 'retention', category: 'unknown',
        task: { status: 'completed', exitCode: 0, mutationAttempted: true, cleanupVerified: true } } });
  });
});
