import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { S3StorageAdapter } from '../../src/adapters/providers/aws/s3.adapter.js';
import { GcsStorageAdapter } from '../../src/adapters/providers/gcp/gcs.adapter.js';
import { AzureBlobStorageAdapter } from '../../src/adapters/providers/azure/azure-blob.adapter.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { createRailwayStorageAdapter } from '../../src/adapters/providers/railway/railway-storage.factory.js';
import { CloudRunAdapter } from '../../src/adapters/providers/gcp/cloudrun.adapter.js';
import { EcsExpressAdapter } from '../../src/adapters/providers/aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
import { FlyAdapter } from '../../src/adapters/providers/fly/fly.adapter.js';
import { DigitalOceanAdapter } from '../../src/adapters/providers/digitalocean/digitalocean.adapter.js';
import { VercelAdapter } from '../../src/adapters/providers/vercel/vercel.adapter.js';

// This roster enforces the reviewed scope in docs/storage-runtime-access-evidence.md.
// Constructors only; no credentials or live provider calls. Native contracts and
// serialized transport/lifecycle tests remain separate from live compatibility.
const matrix = [
  { provider: 's3', hosting: ['ecs'], adapter: new S3StorageAdapter(), identity: 'ECS task role', source: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html' },
  { provider: 'gcs', hosting: ['cloudrun'], adapter: new GcsStorageAdapter(), identity: 'per-service Google service account', source: 'https://cloud.google.com/storage/docs/json_api/v1/buckets/getIamPolicy' },
  { provider: 'azureblob', hosting: ['azure-container-apps'], adapter: new AzureBlobStorageAdapter(), identity: 'observed managed identity', source: 'https://learn.microsoft.com/en-us/azure/storage/blobs/assign-azure-role-data-access' },
  { provider: 'railway', hosting: [], adapter: createRailwayStorageAdapter(new RailwayAdapter()), identity: 'native bucket references; no native workload IAM grant capability', source: 'https://docs.railway.com/storage-buckets' },
];

describe('complete named storage workload-access contract', () => {
  it('reviews every registered storage provider including explicit non-IAM Railway behavior', () => {
    expect(matrix.map(row => row.provider).sort()).toEqual(providerRegistry.namesFor('storage').sort());
  });
  it.each(matrix)('$provider advertises only its implemented native grant lifecycle', row => {
    expect(new URL(row.source).protocol).toBe('https:'); expect(row.identity.length).toBeGreaterThan(10);
    const port = row.adapter.runtimeAccess;
    expect(providerRegistry.getMetadata(row.provider)?.storageRuntimeAccess?.hostingProviders ?? []).toEqual(row.hosting);
    expect(port?.hostingProviders ?? []).toEqual(row.hosting);
    if (row.hosting.length) {
      expect(typeof port?.observe).toBe('function'); expect(typeof port?.grant).toBe('function'); expect(typeof port?.revoke).toBe('function');
    } else expect(port).toBeUndefined();
  });
  it('pins every hosting queue backend affected by runtime identity preparation', () => {
    const hosts = [new RailwayAdapter(), new CloudRunAdapter(), new EcsExpressAdapter(), new AzureContainerAppsAdapter(),
      new FlyAdapter(), new DigitalOceanAdapter(), new VercelAdapter()];
    expect(hosts.map(adapter => adapter.name).sort()).toEqual(providerRegistry.namesFor('hosting').sort());
    expect(Object.fromEntries(hosts.map(adapter => [adapter.name, adapter.capabilities.queues?.backend ?? null]))).toEqual({
      railway: 'postgres', cloudrun: 'pubsub', ecs: null, 'azure-container-apps': null, fly: null, digitalocean: null, vercel: null,
    });
  });
});
