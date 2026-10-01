import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { RdsAdapter } from '../../src/adapters/providers/aws/rds.adapter.js';
import { EcsExpressAdapter } from '../../src/adapters/providers/aws/ecs-express.adapter.js';
import { S3StorageAdapter } from '../../src/adapters/providers/aws/s3.adapter.js';
import { AzurePostgresAdapter } from '../../src/adapters/providers/azure/azure-postgres.adapter.js';
import { AzureContainerAppsAdapter } from '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
import { AzureBlobStorageAdapter } from '../../src/adapters/providers/azure/azure-blob.adapter.js';
import { DigitalOceanDatabaseAdapter } from '../../src/adapters/providers/digitalocean/digitalocean-database.adapter.js';
import { DigitalOceanAdapter } from '../../src/adapters/providers/digitalocean/digitalocean.adapter.js';
import { FlyDatabaseAdapter } from '../../src/adapters/providers/fly/fly-database.adapter.js';
import { FlyAdapter } from '../../src/adapters/providers/fly/fly.adapter.js';
import { CloudSqlAdapter } from '../../src/adapters/providers/gcp/cloudsql.adapter.js';
import { CloudRunAdapter } from '../../src/adapters/providers/gcp/cloudrun.adapter.js';
import { GcsStorageAdapter } from '../../src/adapters/providers/gcp/gcs.adapter.js';
import { NeonAdapter } from '../../src/adapters/providers/neon/neon.adapter.js';
import { SupabaseAdapter } from '../../src/adapters/providers/supabase/supabase.adapter.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../../src/adapters/providers/railway/railway-database.factory.js';
import { createRailwayStorageAdapter } from '../../src/adapters/providers/railway/railway-storage.factory.js';
import { VercelAdapter } from '../../src/adapters/providers/vercel/vercel.adapter.js';

type Resource = 'database' | 'volume' | 'storage';
interface EvidenceRow {
  resource: Resource;
  provider: string;
  implementation: 'implemented' | 'unsupported';
  reason: string;
  nativeCapability: string;
  limitations: string[];
  officialSources: string[];
}
const evidence = JSON.parse(readFileSync(new URL('./daily-backup-provider-matrix.json', import.meta.url), 'utf8')) as {
  schemaVersion: number;
  resources: EvidenceRow[];
};

const railway = new RailwayAdapter();
// Constructors and derived ports only. No credentials, clients or provider calls.
const adapters: Record<Resource, Map<string, object>> = {
  database: new Map<string, object>([
    ['railway', createRailwayDatabaseAdapter({ hostingAdapter: railway, envRepo: {} as never })],
    ['cloudsql', new CloudSqlAdapter()],
    ['rds', new RdsAdapter()],
    ['supabase', new SupabaseAdapter()],
    ['azure-postgres', new AzurePostgresAdapter()],
    ['neon', new NeonAdapter()],
    ['fly', new FlyDatabaseAdapter()],
    ['digitalocean', new DigitalOceanDatabaseAdapter()],
  ]),
  volume: new Map<string, object>([
    ['railway', railway], ['cloudrun', new CloudRunAdapter()],
    ['ecs', new EcsExpressAdapter()], ['azure-container-apps', new AzureContainerAppsAdapter()],
    ['fly', new FlyAdapter()], ['digitalocean', new DigitalOceanAdapter()], ['vercel', new VercelAdapter()],
  ]),
  storage: new Map<string, object>([
    ['railway', createRailwayStorageAdapter(railway)], ['s3', new S3StorageAdapter()],
    ['gcs', new GcsStorageAdapter()], ['azureblob', new AzureBlobStorageAdapter()],
  ]),
};

describe('named-provider daily backup implementation coverage', () => {
  it.each(['database', 'volume', 'storage'] as const)('reviews every named %s provider, including unsupported adapters', resource => {
    const rows = evidence.resources.filter(row => row.resource === resource);
    const names = providerRegistry.namesFor(resource === 'volume' ? 'hosting' : resource).sort();
    expect(rows.map(row => row.provider).sort()).toEqual(names);
    expect([...adapters[resource].keys()].sort()).toEqual(names);
  });

  it('keeps official-source evidence distinct from implementation and live support', () => {
    expect(evidence.schemaVersion).toBe(1);
    for (const row of evidence.resources) {
      expect(['implemented', 'unsupported']).toContain(row.implementation);
      expect(row.reason.length).toBeGreaterThan(20);
      expect(row.nativeCapability.length).toBeGreaterThan(20);
      expect(row.limitations.length).toBeGreaterThan(0);
      expect(row.officialSources.length).toBeGreaterThan(0);
      for (const source of row.officialSources) expect(new URL(source).protocol).toBe('https:');
    }
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
