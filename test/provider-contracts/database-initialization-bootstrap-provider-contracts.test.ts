import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';

interface EvidenceRow {
  provider: string;
  identity: string;
  completionAndRecovery: string;
  prerequisites: string;
  limitations: string;
  officialSources: string[];
}
const evidence = JSON.parse(readFileSync(
  new URL('./database-initialization-bootstrap-provider-matrix.json', import.meta.url), 'utf8',
)) as {
  schemaVersion: number;
  evidenceBoundary: string;
  hosting: Array<EvidenceRow & { implementation: 'implemented' | 'unsupported'; databaseProviders: string[] }>;
  database: Array<EvidenceRow & { hostingProviders: string[] }>;
};

describe('fresh database bootstrap provider admission', () => {
  it.each(['hosting', 'database'] as const)('reviews every registered %s provider', resource => {
    const registered = providerRegistry.namesFor(resource)
      .filter(provider => resource !== 'database' || providerRegistry.supportsEngine(provider, 'database', 'postgres'));
    expect(evidence[resource].map(row => row.provider).sort()).toEqual(registered.sort());
    for (const row of evidence[resource]) {
      for (const field of ['identity', 'completionAndRecovery', 'prerequisites', 'limitations'] as const) {
        expect(row[field].length).toBeGreaterThan(20);
      }
      expect(row.officialSources.length).toBeGreaterThan(0);
      for (const source of row.officialSources) expect(new URL(source).protocol).toBe('https:');
    }
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.evidenceBoundary).toContain('no live');
  });

  it.each(evidence.hosting)('$provider admits only explicitly implemented database pairs', row => {
    const capability = providerRegistry.getMetadata(row.provider)?.lifecycle?.hosting?.databaseInitializationTasks;
    expect(Boolean(capability)).toBe(row.implementation === 'implemented');
    expect(new Set(row.databaseProviders).size).toBe(row.databaseProviders.length);
    for (const database of row.databaseProviders) {
      expect(evidence.database.map(entry => entry.provider)).toContain(database);
    }
    if (capability) expect(capability).toEqual({
      variableMode: 'references', execution: 'temporary-workload', status: 'ready-for-live',
      databaseProviders: row.databaseProviders,
    });
    for (const database of evidence.database) {
      expect(capability?.databaseProviders.includes(database.provider) ?? false)
        .toBe(database.hostingProviders.includes(row.provider));
    }
  });

  it('keeps the finite private executor separate from ordinary tasks and backup helpers', () => {
    const hosting = providerRegistry.getMetadata('railway')?.lifecycle?.hosting;
    expect(hosting?.environmentTasks).toBeDefined();
    expect(hosting?.recoveryTasks).toBeDefined();
    expect(hosting?.databaseInitializationTasks).toBeDefined();
    expect(evidence.hosting.filter(row => row.implementation === 'implemented')
      .map(row => [row.provider, row.databaseProviders])).toEqual([['railway', ['railway']]]);
  });
});
