import { describe, expect, it } from 'vitest';
import { databaseSpecSchema } from '../spec.schema.js';

describe('database provider schema', () => {
  it('accepts explicit reviewed database password replacement without changing legacy declarations', () => {
    expect(databaseSpecSchema.parse({ provider: 'supabase' })).not.toHaveProperty('credentialRotation');
    expect(databaseSpecSchema.parse({
      provider: 'supabase',
      credentialRotation: { generation: 1, consumers: 'environment-only', destinations: 'trusted' },
    }).credentialRotation).toEqual({ generation: 1, consumers: 'environment-only', destinations: 'trusted' });
  });

  it.each([
    {}, { generation: 0 }, { generation: -1 }, { generation: 1.5 }, { generation: '1' },
    { generation: 1 },
    { generation: 1, consumers: 'all', destinations: 'trusted' },
    { generation: 1, consumers: 'environment-only', destinations: 'unknown' },
    { generation: 1, consumers: 'environment-only', destinations: 'trusted', password: 'not-spec-data' },
  ])('rejects incomplete or unsafe database credential replacement intent: %j', (credentialRotation) => {
    expect(databaseSpecSchema.safeParse({ provider: 'supabase', credentialRotation }).success).toBe(false);
  });

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
