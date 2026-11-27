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
    ['aws', 'rds'],
    ['azure', 'azure-postgres'],
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

  it.each(['cloudrun', 'aws', 'azure'])('accepts opt-in automated backups for the native %s database', (hosting) => {
    const database = (settings: Record<string, unknown>) => projectSpecSchema.parse(spec(hosting, settings)).environments.production.database;
    expect(database({ automatedBackups: true })?.automatedBackups).toBe(true);
    expect(database({})).not.toHaveProperty('automatedBackups');
    expect(projectSpecSchema.safeParse(spec(hosting, { automatedBackups: false })).success).toBe(false);
  });

  it.each([['railway', 'railway'], ['railway', 'cloudsql'], ['cloudrun', 'rds'], ['azure', 'railway']])(
    'refuses automated backup intent outside a managed cloud database (%s / %s)', (hosting, provider) => {
      expect(projectSpecSchema.safeParse(spec(hosting, { provider, automatedBackups: true })).success).toBe(false);
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
