import { describe, expect, it } from 'vitest';
import { databaseSpecSchema } from '../spec.schema.js';

describe('database provider schema', () => {
  it.each(['railway', 'cloudsql', 'supabase', 'rds'] as const)('accepts %s Postgres', (provider) => {
    expect(databaseSpecSchema.parse({ provider })).toEqual({ provider, engine: 'postgres' });
  });

  it('keeps unsupported database providers out of desired state', () => {
    expect(databaseSpecSchema.safeParse({ provider: 'aws-aurora' }).success).toBe(false);
  });
});
