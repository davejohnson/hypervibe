import { reviewedOperationProviders } from './operations-scope.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { supportsManagedRecoveryDatabase } from '../../src/domain/services/managed-backup-target.service.js';

const evidence = JSON.parse(readFileSync(new URL('./managed-recovery-provider-matrix.json', import.meta.url), 'utf8')) as {
  hosting: Array<{ provider: string; implementation: string; databaseProviders: string[] }>;
  storage: Array<{ provider: string }>;
};

describe('managed recovery provider evidence boundaries', () => {
  it.each(['hosting', 'storage'] as const)('covers every named %s adapter', resource => {
    expect(evidence[resource].map(row => row.provider).sort()).toEqual(reviewedOperationProviders(resource));
  });

  it.each(evidence.hosting)('$provider advertises private helpers only when the executor is implemented', row => {
    const capability = providerRegistry.getMetadata(row.provider)?.lifecycle?.hosting?.recoveryTasks;
    expect(Boolean(capability)).toBe(row.implementation === 'implemented');
    if (capability) expect(capability).toMatchObject({ variableMode: 'references', execution: 'temporary-workload', status: 'ready-for-live' });
    expect(capability?.databaseProviders ?? []).toEqual(row.databaseProviders);
    for (const provider of row.databaseProviders) expect(providerRegistry.namesFor('database')).toContain(provider);
    // Every hosting/database pair is admitted only by its reviewed native path.
    // Presence of two independent adapters does not establish private routing.
    for (const database of providerRegistry.namesFor('database')) {
      expect(supportsManagedRecoveryDatabase(row.provider, database)).toBe(row.databaseProviders.includes(database));
    }
  });
});
