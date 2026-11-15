import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../../src/adapters/providers/railway/railway-database.factory.js';

interface EvidenceRow {
  provider: string;
  model: string;
  provisioningMode: string;
  runtimeReferenceBinding: 'implemented' | 'unsupported';
  freshInitializationRepair: {
    implementation: 'planned' | 'implemented' | 'unsupported';
  };
}
const evidence = JSON.parse(readFileSync(new URL('./database-provisioning-provider-matrix.json', import.meta.url), 'utf8')) as {
  providers: EvidenceRow[];
};
const railway = createRailwayDatabaseAdapter({ hostingAdapter: new RailwayAdapter(), envRepo: {} as never });

describe('complete database provisioning persistence contract', () => {
  it('covers every admitted database lifecycle with a runtime and the reviewed persistence model', () => {
    expect(evidence.providers.map(row => row.provider).sort()).toEqual(providerRegistry.namesForMutation('database').sort());
    for (const row of evidence.providers) {
      expect(providerRegistry.get(row.provider)?.databaseRuntime, row.provider).toBeDefined();
      expect(row.provisioningMode).toBe('database-template');
      expect(row.model).toBe('service-volume');
    }
  });

  it('preserves Railway runtime-reference normalization admission', () => {
    expect(evidence.providers.filter(row => row.runtimeReferenceBinding === 'implemented').map(row => row.provider)).toEqual(['railway']);
    expect(typeof railway.observeRuntimeReferenceBinding).toBe('function');
  });

  it('preserves Railway fresh-initialization evidence and the actual private execution contract', () => {
    const review = evidence.providers.find(row => row.provider === 'railway')!.freshInitializationRepair;
    expect(review.implementation).toBe('implemented');
    expect(typeof railway.freshInitialization?.inspect).toBe('function');
    expect(typeof railway.freshInitialization?.apply).toBe('function');
  });
});
