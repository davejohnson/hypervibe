import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { GcsStorageAdapter } from '../../src/adapters/providers/gcp/gcs.adapter.js';
import { S3StorageAdapter } from '../../src/adapters/providers/aws/s3.adapter.js';
import { AzureBlobStorageAdapter } from '../../src/adapters/providers/azure/azure-blob.adapter.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { createRailwayStorageAdapter } from '../../src/adapters/providers/railway/railway-storage.factory.js';
import { storageDeletionEvidenceSchema } from '../../src/domain/ports/storage.port.js';

// Named shared-port review; actual native GCS transport and SQLite restart
// behavior live in the linked tests. Constructors make no provider calls.
const roster = [
  { provider: 'gcs', recovery: true, adapter: new GcsStorageAdapter() },
  { provider: 's3', recovery: false, adapter: new S3StorageAdapter() },
  { provider: 'azureblob', recovery: false, adapter: new AzureBlobStorageAdapter() },
  { provider: 'railway', recovery: false, adapter: createRailwayStorageAdapter(new RailwayAdapter()) },
];
describe('storage deletion recovery provider boundary', () => {
  it('covers every registered storage adapter without implying retention parity', () => {
    expect(roster.map(row => row.provider).sort()).toEqual(providerRegistry.namesFor('storage').sort());
  });
  it.each(roster)('$provider opts in only when its native deletion recovery is implemented', row => {
    expect(row.adapter.capabilities.supportsDeletionRecovery === true).toBe(row.recovery);
    expect(row.adapter.capabilities.supportsConditionalObjectDeletionRetry === true).toBe(row.provider === 'gcs');
  });
  it('does not turn an ordinary provider success message into deletion or retention evidence', () => {
    expect(storageDeletionEvidenceSchema.safeParse({ success: true, message: 'deleted' }).success).toBe(false);
  });
});
