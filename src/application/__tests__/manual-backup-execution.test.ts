import { afterEach, describe, expect, it, vi } from 'vitest';
import '../providers.js';
import { executeLocalManagedBackup } from '../managed-backup.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import * as storage from '../../domain/services/managed-backup-target.service.js';
import * as evidence from '../../domain/services/recovery-set-health.service.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import type { Environment } from '../../domain/entities/environment.entity.js';

describe('current local authority at the actual managed backup execution boundary', () => {
  afterEach(() => vi.restoreAllMocks());
  function fixture() {
    const now = new Date(), environmentId = '11111111-1111-4111-8111-111111111111';
    const binding = { provider: 'cloudrun', evidence: { source: 'native-source' } };
    const environment: Environment = { id: environmentId, projectId: 'local-project', name: 'test',
      platformBindings: { provider: 'cloudrun', recoveryRuntime: binding }, createdAt: now, updatedAt: now };
    const source = { provider: 'cloudsql', primaryExternalId: 'native-sql', providerScope: { projectId: 'native-project' }, resourceIdentity: { instanceId: 'native-sql-lifetime' } };
    const target: storage.ManagedBackupTarget = { version: 1, project: 'manual-app', environment: 'test', environmentId,
      hosting: { provider: 'cloudrun', providerScope: { projectId: 'native-project' }, region: 'us-central1' },
      runnerImage: `registry/helper@sha256:${'a'.repeat(64)}`, database: { componentId: 'native-db-component', source },
      destination: { name: 'archive', identity: { provider: 'gcs', externalId: 'native-archive', instanceScope: { projectId: 'native-project' } } },
      objects: [], fileReferenceQueries: [], retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7,
      runtimeBindingHash: canonicalJsonSha256(binding), executionTarget: { environmentId, provider: 'cloudrun', region: 'us-central1',
        providerScope: { projectId: 'native-project' }, identity: { provider: 'gcp', principal: 'dedicated-backup@example.iam.gserviceaccount.com', scope: { projectId: 'native-project' }, source: 'observed' },
        configuration: { credentialHash: 'c'.repeat(64) }, worker: { provider: 'cloudrun', configuration: { nativeIdentity: 'dedicated-backup' } } },
    };
    const executionId = '22222222-2222-4222-8222-222222222222';
    const archive = { destroy: vi.fn() };
    const open = vi.spyOn(storage, 'openRecoveryStorage').mockResolvedValue(archive as never);
    const retention = vi.spyOn(evidence, 'applyManagedRecoveryRetention').mockRejectedValue(Error('Existing archives must not be deleted'));
    const completion = vi.spyOn(evidence, 'recordRecoveryExecution').mockImplementation(async input => { await input.beforeWrite?.(); return { applied: 1, skipped: 0 }; });
    vi.spyOn(evidence, 'observeRecoveryExecution').mockResolvedValue({ setId: executionId, completedAt: now.toISOString() });
    const runJob = vi.fn(async (..._args: unknown[]) => ({ jobId: 'exact-native-execution', status: 'completed', exitCode: 0, mutationAttempted: true,
      receipt: { success: true, message: 'Synthetic provider completion', data: { cleanupVerified: true } } }));
    const adapters: Record<string, any> = {
      cloudrun: { name: 'cloudrun', configureTarget: vi.fn(), runJob },
      cloudsql: { name: 'cloudsql', dailyBackups: { observe: vi.fn(async () => ({ state: 'known', source })) } },
      gcs: { name: 'gcs' },
    };
    const factory = vi.spyOn(providerRegistry, 'createAdapter').mockRejectedValue(Error('Automation credentials are forbidden'));
    const beforeCompletion = vi.fn();
    const input = { target, environment, executionId, databaseComponent: { id: 'native-db-component', environmentId, type: 'postgres',
      externalId: 'native-sql', bindings: { provider: 'cloudsql', providerScope: source.providerScope }, createdAt: now, updatedAt: now },
      adapter: vi.fn(async (provider: string) => adapters[provider]), lifecycle: { persist: vi.fn(async state => state) }, beforeCompletion };
    return { input, runJob, adapters, factory, retention, completion, open, beforeCompletion };
  }
  it('uses current connections with no CI binding, preserves immutable references and skips retention deletion', async () => {
    const f = fixture();
    const result = await executeLocalManagedBackup(f.input);
    expect(result).toMatchObject({ status: 'healthy', setId: f.input.executionId });
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.retention).not.toHaveBeenCalled();
    expect(f.beforeCompletion).toHaveBeenCalled();
    expect(f.adapters.cloudsql.dailyBackups.observe).toHaveBeenCalledOnce();
    const task: any = f.runJob.mock.calls[0][3];
    expect(task.managedRecoveryTask).toMatchObject({ executionId: f.input.executionId, executionTarget: f.input.target.executionTarget,
      selectedSecretValues: {}, variableReferences: [], lifecycle: f.input.lifecycle });
    expect(JSON.stringify(task)).not.toContain('ACTIONS_ID_TOKEN');
    expect(JSON.stringify(task)).not.toContain('private_key');
    expect(f.input.target.retainSets).toBe(7);
  });
  it('does not write completion when native cleanup is unknown', async () => {
    const f = fixture(); f.runJob.mockResolvedValueOnce({ jobId: 'uncertain-job', status: 'failed', exitCode: 1, mutationAttempted: true,
      receipt: { success: false, message: 'Unknown', data: { cleanupVerified: false } } });
    await expect(executeLocalManagedBackup(f.input)).rejects.toThrow();
    expect(f.completion).not.toHaveBeenCalled(); expect(f.retention).not.toHaveBeenCalled();
  });
  it('checks current authority again immediately before the completion marker write', async () => {
    const f = fixture(); f.beforeCompletion.mockImplementation(() => { throw Error('Current authority revoked'); });
    await expect(executeLocalManagedBackup(f.input)).rejects.toThrow();
    expect(f.beforeCompletion).toHaveBeenCalled(); expect(f.retention).not.toHaveBeenCalled();
  });
});
