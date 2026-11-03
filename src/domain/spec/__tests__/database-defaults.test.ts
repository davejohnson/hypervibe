import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { withDefaultDatabaseProviders } from '../database-defaults.js';
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
    const parsed = projectSpecSchema.parse(withDefaultDatabaseProviders(spec(hosting)));
    expect(parsed.environments.production.database?.provider).toBe(expected);
  });

  it('never replaces an explicit provider and leaves environments without a database alone', () => {
    const explicit = spec('cloudrun', { provider: 'railway' });
    expect(withDefaultDatabaseProviders(explicit)).toBe(explicit);
    const noDatabase = { version: 1, project: 'defaults', environments: { production: { hosting: { provider: 'railway' }, services: {} } } };
    expect(withDefaultDatabaseProviders(noDatabase)).toBe(noDatabase);
  });

  it('leaves an unknown host for schema validation to report', () => {
    expect(projectSpecSchema.safeParse(withDefaultDatabaseProviders(spec('unknown-host'))).success).toBe(false);
  });
});
