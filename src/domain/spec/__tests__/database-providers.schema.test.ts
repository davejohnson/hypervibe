import { describe, expect, it } from 'vitest';
import { databaseSpecSchema, environmentSpecSchema } from '../spec.schema.js';

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

  it('supports MongoDB as a database engine without treating Redis as a database', () => {
    expect(databaseSpecSchema.parse({
      provider: 'mongodb-atlas',
      engine: 'mongodb',
    })).toEqual({
      provider: 'mongodb-atlas',
      engine: 'mongodb',
    });
    expect(databaseSpecSchema.safeParse({
      provider: 'upstash',
      engine: 'redis',
    }).success).toBe(false);
  });

  it('rejects PostgreSQL migration and queue contracts for MongoDB', () => {
    expect(environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: {},
      database: { provider: 'mongodb-atlas', engine: 'mongodb' },
      migrations: { mode: 'tool', command: 'npm run migrate' },
    }).success).toBe(false);
    expect(environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: {},
      database: { provider: 'mongodb-atlas', engine: 'mongodb' },
      queues: { jobs: {} },
    }).success).toBe(false);
  });
});
