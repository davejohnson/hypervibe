import { reviewedOperationProviders } from './operations-scope.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { RdsAdapter } from '../../src/adapters/providers/aws/rds.adapter.js';
import { S3StorageAdapter } from '../../src/adapters/providers/aws/s3.adapter.js';
import { AzurePostgresAdapter } from '../../src/adapters/providers/azure/azure-postgres.adapter.js';
import { AzureBlobStorageAdapter } from '../../src/adapters/providers/azure/azure-blob.adapter.js';
import { CloudSqlAdapter } from '../../src/adapters/providers/gcp/cloudsql.adapter.js';
import { GcsStorageAdapter } from '../../src/adapters/providers/gcp/gcs.adapter.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../../src/adapters/providers/railway/railway-database.factory.js';
import { createRailwayStorageAdapter } from '../../src/adapters/providers/railway/railway-storage.factory.js';

type Resource = 'database' | 'volume' | 'storage';
interface EvidenceRow {
  resource: Resource;
  provider: string;
  implementation: 'implemented' | 'unsupported';
}
const evidence = JSON.parse(readFileSync(new URL('./daily-backup-provider-matrix.json', import.meta.url), 'utf8')) as {
  resources: EvidenceRow[];
};

const railway = new RailwayAdapter();
// Constructors and derived ports only. No credentials, clients or provider calls.
const adapters: Record<Resource, Map<string, object>> = {
  database: new Map<string, object>([
    ['railway', createRailwayDatabaseAdapter({ hostingAdapter: railway, envRepo: {} as never })],
    ['cloudsql', new CloudSqlAdapter()],
    ['rds', new RdsAdapter()],
    ['azure-postgres', new AzurePostgresAdapter()],
  ]),
  volume: new Map<string, object>([
    ['railway', railway],
  ]),
  storage: new Map<string, object>([
    ['railway', createRailwayStorageAdapter(railway)], ['s3', new S3StorageAdapter()],
    ['gcs', new GcsStorageAdapter()], ['azureblob', new AzureBlobStorageAdapter()],
  ]),
};

describe('named-provider daily backup implementation coverage', () => {
  it.each(['database', 'volume', 'storage'] as const)('reviews every named %s provider, including unsupported adapters', resource => {
    const rows = evidence.resources.filter(row => row.resource === resource);
    const names = resource === 'volume' ? providerRegistry.namesFor('hosting').sort() : reviewedOperationProviders(resource);
    expect(rows.map(row => row.provider).sort()).toEqual(names);
    expect([...adapters[resource].keys()].sort()).toEqual(names);
  });

  it.each(evidence.resources)('$provider $resource advertises only the complete implemented daily policy port', row => {
    const supported = row.implementation === 'implemented';
    const metadata = providerRegistry.getMetadata(row.provider)!;
    // Unknown flags are unsupported. Native product backups alone confer no mutation authority.
    expect(metadata.lifecycle?.dailyBackups?.[row.resource] === true).toBe(supported);
    const adapter = adapters[row.resource].get(row.provider) as {
      dailyBackups?: { observe?: unknown; configureDaily?: unknown };
      serviceVolumes?: { dailyBackups?: { observe?: unknown; configureDaily?: unknown } };
    };
    const port = row.resource === 'volume' ? adapter.serviceVolumes?.dailyBackups : adapter.dailyBackups;
    expect(port !== undefined, `${row.provider} ${row.resource} runtime port`).toBe(supported);
    if (supported) {
      expect(typeof port?.observe).toBe('function');
      expect(typeof port?.configureDaily).toBe('function');
    }
  });
});
