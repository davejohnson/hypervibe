import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { CloudflareAdapter } from '../cloudflare/cloudflare.adapter.js';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { supportsLoadBalancer } from '../../../domain/ports/load-balancer.port.js';
import { supportsManagedQueues } from '../../../domain/ports/queue.port.js';
import { supportsStorageLifecycle, supportsStorageOperations } from '../../../domain/ports/storage.port.js';
import { supportsCacheLifecycle } from '../../../domain/ports/cache.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { S3StorageAdapter } from '../aws/s3.adapter.js';
import { AzureBlobStorageAdapter } from '../azure/azure-blob.adapter.js';
import { GcsStorageAdapter } from '../gcp/gcs.adapter.js';
import { createRailwayStorageAdapter } from '../railway/railway-storage.factory.js';
import { createRailwayCacheAdapter } from '../railway/railway-cache.factory.js';

describe('production infrastructure capability truth', () => {
  it('keeps Railway application queues while retiring handwritten Cloud Run queues', () => {
    expect(providerRegistry.namesFor('queue')).toEqual(['railway']);
    expect(providerRegistry.namesForMutation('queue')).toEqual(['railway']);
    expect(providerRegistry.getMetadata('railway')?.lifecycle?.queue).toEqual({ backend: 'postgres', resources: 'application-managed' });
    expect(supportsManagedQueues(new RailwayAdapter())).toBe(false);
    expect(supportsManagedQueues(new CloudRunAdapter())).toBe(false);
  });

  it('advertises load balancing only when the provider implements the full port', () => {
    expect(providerRegistry.namesFor('load-balancer')).toEqual(['cloudflare']);
    expect(providerRegistry.namesForMutation('load-balancer')).toEqual(['cloudflare']);
    expect(supportsLoadBalancer(new CloudflareAdapter())).toBe(true);
    expect(providerRegistry.getMetadata('cloudflare')?.lifecycle?.loadBalancer).toEqual({ topology: 'monitor-pool-balancer', minimumOrigins: 2 });
  });

  it('keeps cloud object operations separate from resource lifecycle admission', () => {
    const adapters = new Map<string, unknown>([
      ['s3', new S3StorageAdapter()], ['azureblob', new AzureBlobStorageAdapter()],
      ['gcs', new GcsStorageAdapter()], ['railway', createRailwayStorageAdapter(new RailwayAdapter())],
    ]);
    expect([...adapters.keys()].sort()).toEqual(providerRegistry.namesFor('storage').sort());
    expect(providerRegistry.namesForMutation('storage')).toEqual(['railway']);
    for (const [provider, adapter] of adapters) {
      expect(supportsStorageOperations(adapter), provider).toBe(true);
      expect(supportsStorageLifecycle(adapter), provider).toBe(provider === 'railway');
    }
  });

  it('preserves the complete Railway cache lifecycle and its hosting boundary', () => {
    expect(providerRegistry.namesFor('cache')).toEqual(['railway']);
    expect(providerRegistry.namesForMutation('cache')).toEqual(['railway']);
    expect(supportsCacheLifecycle(createRailwayCacheAdapter({ hostingAdapter: new RailwayAdapter(), envRepo: {} as never }))).toBe(true);
    expect(providerRegistry.getMetadata('railway')?.lifecycle?.cacheConnectivity?.compatibleHostingProviders).toEqual(['railway']);
    for (const provider of ['memorystore', 'elasticache', 'azure-managed-redis']) expect(providerRegistry.get(provider)).toBeUndefined();
  });
});
