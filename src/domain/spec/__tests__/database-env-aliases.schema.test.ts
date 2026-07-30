import { describe, expect, it } from 'vitest';
import { environmentSpecSchema } from '../spec.schema.js';

describe('service databaseEnvAliases', () => {
  it('accepts a per-service legacy alias without storing a database value', () => {
    const environment = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: {
        web: {},
        'events-worker': {
          workloadKind: 'worker',
          databaseEnvAliases: {
            POSTGRES_DB_URL: 'DATABASE_URL',
          },
        },
      },
      database: { provider: 'railway', engine: 'postgres' },
    });

    expect(environment.services['events-worker'].databaseEnvAliases).toEqual({
      POSTGRES_DB_URL: 'DATABASE_URL',
    });
    expect(JSON.stringify(environment)).not.toContain('postgresql://');
  });

  it('rejects aliases without a database or with a conflicting ordinary env var', () => {
    const noDatabase = environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: {
        worker: {
          workloadKind: 'worker',
          databaseEnvAliases: { POSTGRES_DB_URL: 'DATABASE_URL' },
        },
      },
    });
    expect(noDatabase.success).toBe(false);

    const conflict = environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: {
        worker: {
          workloadKind: 'worker',
          databaseEnvAliases: { POSTGRES_DB_URL: 'DATABASE_URL' },
        },
      },
      database: { provider: 'railway' },
      envVars: { POSTGRES_DB_URL: 'postgresql://user:password@example.com/app' },
    });
    expect(conflict.success).toBe(false);
  });

  it('rejects aliases whose canonical source does not match the database engine', () => {
    expect(environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: {
        worker: {
          workloadKind: 'worker',
          databaseEnvAliases: { POSTGRES_DB_URL: 'MONGODB_URI' },
        },
      },
      database: { provider: 'railway', engine: 'postgres' },
    }).success).toBe(false);
  });

  it('does not allow an alias to replace a canonical managed database variable', () => {
    expect(environmentSpecSchema.safeParse({
      hosting: { provider: 'railway' },
      services: {
        worker: {
          workloadKind: 'worker',
          databaseEnvAliases: { DIRECT_URL: 'DATABASE_URL' },
        },
      },
      database: { provider: 'railway', engine: 'postgres' },
    }).success).toBe(false);
  });
});
