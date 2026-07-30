import { describe, expect, it } from 'vitest';
import { databaseSpecSchema } from '../spec.schema.js';

describe('database provider schema', () => {
  it.each([
    'railway',
    'cloudsql',
    'supabase',
    'rds',
    'digitalocean',
    'acme-postgres',
  ] as const)('accepts stable provider id %s for Postgres', (provider) => {
    expect(databaseSpecSchema.parse({ provider })).toEqual({ provider, engine: 'postgres' });
  });

  it('keeps malformed provider ids out of desired state', () => {
    expect(databaseSpecSchema.safeParse({ provider: 'AWS RDS' }).success).toBe(false);
    expect(databaseSpecSchema.safeParse({ provider: '../adapter' }).success).toBe(false);
  });

  it('keeps non-Postgres engines out of database desired state', () => {
    for (const engine of ['mongodb', 'mysql', 'redis']) {
      expect(databaseSpecSchema.safeParse({
        provider: 'external-database',
        engine,
      }).success).toBe(false);
    }
  });
});
