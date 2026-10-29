import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../ci/providers.js';
import { executeManagedBackup } from '../../../application/managed-backup.js';
import type { Environment } from '../../entities/environment.entity.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { createLocalRecoveryStore } from '../local-recovery-store.js';
import { createRecoverySet } from '../recovery-set.service.js';
import { recordRecoveryExecution } from '../recovery-set-health.service.js';
import { managedBackupTargetHash, type ManagedBackupTarget } from '../managed-backup-target.service.js';

import { backupOperationReceiptSchema } from '../backup-operation-receipt.js';

const image = `ghcr.io/example/backup@sha256:${'b'.repeat(64)}`;
const stores: Array<Awaited<ReturnType<typeof createLocalRecoveryStore>>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.cleanup();
});

// Real recovery-set, health and operation-receipt producers use owned local
// storage here. Only provider observation/transport is synthetic; this is receipt compatibility, not live cloud recovery evidence.
async function produceHealth(environmentName: 'staging' | 'production', state: 'healthy' | 'unhealthy' | 'unknown') {
  const archive = await createLocalRecoveryStore(); stores.push(archive);
  const source = await createLocalRecoveryStore(); stores.push(source);
  const identity = (externalId: string) => ({ provider: 'railway', externalId,
    instanceScope: { projectId: 'project', environmentId: environmentName } });
  const target: ManagedBackupTarget = { version: 1, project: 'receipt-contract', environment: environmentName,
    runnerImage: image, hosting: { provider: 'railway', providerScope: identity('archive').instanceScope },
    destination: { name: 'archive', identity: identity('archive') },
    objects: [{ name: 'documents', identity: identity('documents') }], fileReferenceQueries: [],
    retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 };
  if (state === 'healthy') {
    const bytes = Buffer.from('synthetic document bytes');
    await source.client.put('document.txt', { body: Readable.from([bytes]), size: bytes.length }, { ifAbsent: true });
    const setId = randomUUID();
    await createRecoverySet({ runId: setId, project: target.project, environment: environmentName,
      contractHash: managedBackupTargetHash(target), destination: target.destination.identity, archive: archive.client,
      objects: [{ ...target.objects[0], client: source.client }] });
    await recordRecoveryExecution({ target, archive: archive.client, setId, jobId: 'synthetic-local-cleanup' });
  }
  if (state === 'unknown') vi.spyOn(archive.client, 'list').mockRejectedValue(new Error('private-error-sentinel'));
  const storage = { name: 'railway', observe: async () => [{ ...target.destination.identity, status: 'ready' }],
    openObjectTransfer: async () => archive.client };
  vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue({});
  vi.spyOn(providerRegistry.get('railway')!.derivedAdapters!, 'storage').mockResolvedValue(storage);
  const now = new Date();
  const environment: Environment = { id: environmentName, projectId: 'project', name: environmentName,
    platformBindings: {}, createdAt: now, updatedAt: now };
  const receipt = await executeManagedBackup({ target, environment, operation: 'health', repository: 'owner/project',
    runId: '123', credentials: { RAILWAY_API_TOKEN: 'synthetic-control-token' } });
  expect(receipt.status).toBe(state);
  return { target, receipt };
}

// Release eligibility no longer consumes backup receipts. Recovery operations
// and their scheduled alerts still validate this independent receipt contract.
describe.each(['staging', 'production'] as const)('%s actual backup health receipt contract', environmentName => {
  it.each(['healthy', 'unhealthy', 'unknown'] as const)('retains the independently produced %s health status', async state => {
    const { receipt } = await produceHealth(environmentName, state);
    expect(backupOperationReceiptSchema.parse(receipt)).toMatchObject({ environment: environmentName, status: state });
  });

  it('retains support for the legacy healthy receipt format', async () => {
    const { receipt } = await produceHealth(environmentName, 'healthy');
    expect(backupOperationReceiptSchema.parse({ ...receipt, version: 1 })).toMatchObject({ version: 1, status: 'healthy' });
  });

  it.each(['failed', 'unknown-version', 'unknown-diagnostic', 'legacy-diagnostic', 'unknown-field', 'invalid-count', 'contradictory-healthy'])(
    'rejects %s as recovery evidence', async fault => {
      const { receipt } = await produceHealth(environmentName, 'healthy');
      let changed: unknown = receipt;
      if (fault === 'failed') changed = { ...receipt, status: 'failed' };
      if (fault === 'unknown-version') changed = { ...receipt, version: 99 };
      if (fault === 'unknown-diagnostic' || fault === 'legacy-diagnostic') changed = { ...receipt,
        version: fault === 'legacy-diagnostic' ? 1 : 2, diagnostic: { stage: 'private-error-sentinel', category: 'unknown' } };
      if (fault === 'unknown-field') changed = { ...receipt, version: 1, error: 'private-error-sentinel' };
      if (fault === 'invalid-count') changed = { ...receipt, version: 1, counts: { applied: -1, skipped: 0 } };
      if (fault === 'contradictory-healthy') changed = { ...receipt, reasonCodes: ['cleanup-unverified'] };
      expect(backupOperationReceiptSchema.safeParse(changed)).toEqual({ success: false });
    });
});
