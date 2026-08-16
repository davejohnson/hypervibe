import { describe, expect, it } from 'vitest';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { supportsWorkloadMaintenance } from '../../../domain/ports/maintenance.port.js';
import { EcsExpressAdapter } from '../aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../azure/azure-container-apps.adapter.js';
import { DigitalOceanAdapter } from '../digitalocean/digitalocean.adapter.js';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { VercelAdapter } from '../vercel/vercel.adapter.js';

describe('hosting maintenance provider support', () => {
  it.each([
    ['railway', new RailwayAdapter()],
    ['cloudrun', new CloudRunAdapter()],
    ['azure-container-apps', new AzureContainerAppsAdapter()],
    ['digitalocean', new DigitalOceanAdapter()],
    ['vercel', new VercelAdapter()],
  ])('%s exposes the provider-neutral reversible workload contract', (provider, adapter) => {
    expect(adapter.capabilities.supportsMaintenance).toBe(true);
    expect(supportsWorkloadMaintenance(adapter)).toBe(true);
    expect(providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.maintenance).toBe('managed');
  });

  it.each([
    ['ecs', new EcsExpressAdapter()],
  ])('%s fails closed until reversible suspension is implemented', (provider, adapter) => {
    expect(adapter.capabilities.supportsMaintenance).not.toBe(true);
    expect(supportsWorkloadMaintenance(adapter)).toBe(false);
    expect(providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.maintenance).toBe('unsupported');
  });
});
