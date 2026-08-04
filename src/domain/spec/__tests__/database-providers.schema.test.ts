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

  it('accepts a provider-neutral resilience declaration', () => {
    expect(databaseSpecSchema.parse({
      provider: 'cloudsql',
      resilience: {
        availability: 'regional',
        backups: { retainedBackups: 8, pitrRetentionDays: 7 },
        replicas: { analytics: { region: 'us-west1', tier: 'db-custom-2-7680' } },
      },
    })).toMatchObject({
      provider: 'cloudsql',
      resilience: {
        availability: 'regional',
        backups: { retainedBackups: 8, pitrRetentionDays: 7 },
        replicas: { analytics: { region: 'us-west1', tier: 'db-custom-2-7680' } },
      },
    });
  });

  it('defaults an explicitly declared backup policy and rejects unsafe retention', () => {
    expect(databaseSpecSchema.parse({
      provider: 'cloudsql',
      resilience: { backups: {} },
    }).resilience?.backups).toEqual({ retainedBackups: 8, pitrRetentionDays: 7 });
    expect(databaseSpecSchema.safeParse({
      provider: 'cloudsql',
      resilience: { backups: { retainedBackups: 7, pitrRetentionDays: 7 } },
    }).success).toBe(false);
  });

  it('rejects replica names that cannot map to stable runtime keys', () => {
    expect(databaseSpecSchema.safeParse({
      provider: 'cloudsql',
      resilience: { replicas: { 'Analytics DB': {} } },
    }).success).toBe(false);
  });
});
