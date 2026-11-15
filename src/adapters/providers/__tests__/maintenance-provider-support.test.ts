import { describe, expect, it } from 'vitest';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { supportsWorkloadMaintenance } from '../../../domain/ports/maintenance.port.js';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';

describe('hosting maintenance provider support', () => {
  it.each([
    ['railway', new RailwayAdapter()],
  ])('%s exposes the provider-neutral reversible workload contract', (provider, adapter) => {
    expect(adapter.capabilities.supportsMaintenance).toBe(true);
    expect(supportsWorkloadMaintenance(adapter)).toBe(true);
    expect(providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.maintenance).toBe(provider === 'railway' ? 'managed' : undefined);
  });

  it('does not advertise Cloud Run maintenance while engine support is unavailable', () => {
    expect(new CloudRunAdapter().capabilities.supportsMaintenance).toBe(false);
    expect(providerRegistry.getMetadata('cloudrun')?.lifecycle?.hosting?.maintenance).toBeUndefined();
  });
});
