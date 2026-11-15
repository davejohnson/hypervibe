import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { nativeDatabaseConnectivity } from '../../registry/database-connectivity.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { projectSpecSchema } from '../spec.schema.js';

function spec(hosting: string, database: Record<string, unknown> = {}) {
  return { version: 1, project: 'defaults', environments: { production: { hosting: { provider: hosting }, services: {}, database } } };
}

describe('host-native database default', () => {
  it.each([
    ['railway', 'railway'],
    ['cloudrun', 'cloudsql'],
    ['ecs', 'rds'],
    ['azure-container-apps', 'azure-postgres'],
  ])('uses the %s platform database when database.provider is omitted', (hosting, expected) => {
    const parsed = projectSpecSchema.parse(spec(hosting));
    expect(parsed.environments.production.database?.provider).toBe(expected);
  });

  it('never replaces an explicit provider and leaves environments without a database alone', () => {
    const explicit = spec('cloudrun', { provider: 'railway' });
    expect(projectSpecSchema.parse(explicit).environments.production.database?.provider).toBe('railway');
    const noDatabase = { version: 1, project: 'defaults', environments: { production: { hosting: { provider: 'railway' }, services: {} } } };
    expect(projectSpecSchema.parse(noDatabase).environments.production.database).toBeUndefined();
  });

  it('leaves an unknown host for schema validation to report', () => {
    expect(projectSpecSchema.safeParse(spec('unknown-host')).success).toBe(false);
  });

  it('shares the exact connectivity metadata used by registered native database adapters', () => {
    const registeredNativeProviders = providerRegistry.namesFor('database').filter(name =>
      providerRegistry.getMetadata(name)?.lifecycle?.databaseConnectivity
    );
    expect(registeredNativeProviders).toEqual(['railway']);
    for (const provider of registeredNativeProviders) {
      const connectivity = nativeDatabaseConnectivity[provider as keyof typeof nativeDatabaseConnectivity];
      expect(providerRegistry.getMetadata(provider)?.lifecycle?.databaseConnectivity).toEqual(connectivity);
    }
  });
});
