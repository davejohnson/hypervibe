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
  nativeCreate: string;
  durability: string;
  identity: string;
  completion: string;
  recovery: string;
  prerequisites: string;
  coverage: string;
  runtimeReferenceBinding: 'implemented' | 'unsupported';
  runtimeReferenceEvidence: string;
  freshInitializationRepair: {
    implementation: 'planned' | 'implemented' | 'unsupported';
    prerequisites: string;
    nativeOperation: string;
    completion: string;
    recovery: string;
    officialSources: string[];
  };
  officialSources: string[];
}
const evidence = JSON.parse(readFileSync(new URL('./database-provisioning-provider-matrix.json', import.meta.url), 'utf8')) as {
  schemaVersion: number; providers: EvidenceRow[];
};
const railway = createRailwayDatabaseAdapter({ hostingAdapter: new RailwayAdapter(), envRepo: {} as never });

describe('complete database provisioning persistence contract', () => {
  it('requires explicit persistence and recovery evidence for every admitted database lifecycle', () => {
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.providers.map(row => row.provider).sort()).toEqual(providerRegistry.namesForMutation('database').sort());
    for (const row of evidence.providers) {
      expect(providerRegistry.get(row.provider)?.databaseRuntime, row.provider).toBeDefined();
      expect(row.provisioningMode).toBe('database-template');
      expect(row.model).toBe('service-volume');
      for (const key of ['nativeCreate', 'durability', 'identity', 'completion', 'recovery', 'prerequisites', 'coverage', 'runtimeReferenceEvidence'] as const) {
        expect(row[key].length, `${row.provider}: ${key}`).toBeGreaterThan(20);
      }
      expect(row.officialSources.length, row.provider).toBeGreaterThanOrEqual(2);
      for (const source of row.officialSources) expect(new URL(source).protocol).toBe('https:');
    }
  });

  it('preserves Railway runtime-reference normalization admission', () => {
    expect(evidence.providers.filter(row => row.runtimeReferenceBinding === 'implemented').map(row => row.provider)).toEqual(['railway']);
    expect(typeof railway.observeRuntimeReferenceBinding).toBe('function');
  });

  it('preserves Railway fresh-initialization evidence and the actual private execution contract', () => {
    const review = evidence.providers.find(row => row.provider === 'railway')!.freshInitializationRepair;
    expect(review.implementation).toBe('implemented');
    for (const key of ['prerequisites', 'nativeOperation', 'completion', 'recovery'] as const) expect(review[key].length).toBeGreaterThan(20);
    expect(review.officialSources.length).toBeGreaterThanOrEqual(2);
    for (const source of review.officialSources) expect(new URL(source).protocol).toBe('https:');
    expect(typeof railway.freshInitialization?.inspect).toBe('function');
    expect(typeof railway.freshInitialization?.apply).toBe('function');
  });
});
