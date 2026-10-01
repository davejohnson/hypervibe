import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';

const evidence = JSON.parse(readFileSync(new URL('./managed-recovery-provider-matrix.json', import.meta.url), 'utf8')) as {
  schemaVersion: number; evidenceBoundary: string;
  hosting: Array<{ provider: string; implementation: string; nativeContract: string; limitations: string; officialSources: string[] }>;
  storage: Array<{ provider: string; implementation: string; nativeContract: string; limitations: string; officialSources: string[] }>;
  sdkPins: Array<{ package: string; version: string; integrity: string }>;
};

describe('managed recovery provider evidence boundaries', () => {
  it.each(['hosting', 'storage'] as const)('covers every named %s adapter without extending native capability claims', resource => {
    expect(evidence[resource].map(row => row.provider).sort()).toEqual(providerRegistry.namesFor(resource).sort());
    for (const row of evidence[resource]) {
      expect(row.nativeContract.length).toBeGreaterThan(20); expect(row.limitations.length).toBeGreaterThan(20);
      expect(row.officialSources.length).toBeGreaterThan(0);
      for (const source of row.officialSources) expect(new URL(source).protocol).toBe('https:');
    }
    expect(evidence.evidenceBoundary).toContain('no live');
  });
  it.each(evidence.hosting)('$provider advertises private helpers only when the executor is implemented', row => {
    const capability = providerRegistry.getMetadata(row.provider)?.lifecycle?.hosting?.recoveryTasks;
    expect(Boolean(capability)).toBe(row.implementation === 'implemented');
    if (capability) expect(capability).toMatchObject({ variableMode: 'references', execution: 'temporary-workload', status: 'ready-for-live' });
  });
  it('records the exact lockfile SDKs used for offline wire serialization without claiming pinned provider schemas', () => {
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    expect(evidence.schemaVersion).toBe(1);
    for (const pin of evidence.sdkPins) expect(lock.packages[`node_modules/${pin.package}`]).toMatchObject({ version: pin.version, integrity: pin.integrity });
  });
});
