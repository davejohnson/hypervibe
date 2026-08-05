import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

function project(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: 'restore-drill',
    gitRemoteUrl: 'https://github.com/owner/restore-drill.git',
    github: {},
    environments: {
      production: {
        hosting: { provider: 'cloudrun' },
        services: { web: {} },
        database: {
          provider: 'cloudsql',
          resilience: {
            backups: { retainedBackups: 8, pitrRetentionDays: 7 },
            restoreDrill: {
              schedule: { cron: '30 4 * * 1', timezone: 'America/Vancouver' },
            },
          },
        },
      },
    },
    ...overrides,
  };
}

describe('database restore-drill schema', () => {
  it('defaults a safe isolated weekly verification contract', () => {
    const spec = projectSpecSchema.parse(project());
    expect(spec.environments.production.database?.resilience?.restoreDrill).toEqual({
      schedule: { cron: '30 4 * * 1', timezone: 'America/Vancouver' },
      credentialsSecret: 'HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS',
      verificationQuery: 'SELECT 1',
      restoreLagMinutes: 5,
      retainFailedInstanceDays: 3,
    });
  });

  it('requires backups, enabled GitHub desired state, and the canonical environment', () => {
    const missingBackups = project();
    delete (missingBackups.environments.production.database.resilience as Record<string, unknown>).backups;
    expect(projectSpecSchema.safeParse(missingBackups).success).toBe(false);

    expect(projectSpecSchema.safeParse(project({ github: undefined })).success).toBe(false);

    const nonCanonical = project({
      github: { canonicalEnvironment: 'staging' },
      environments: {
        ...project().environments,
        staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
      },
    });
    expect(projectSpecSchema.safeParse(nonCanonical).success).toBe(false);
  });

  it('rejects workflow interpolation, multiple SQL statements, and unsafe secret names', () => {
    const base = project();
    const drill = base.environments.production.database.resilience.restoreDrill as Record<string, unknown>;

    drill.verificationQuery = 'SELECT ${{ secrets.DATABASE_URL }}';
    expect(projectSpecSchema.safeParse(base).success).toBe(false);

    drill.verificationQuery = 'SELECT 1; DROP TABLE users';
    expect(projectSpecSchema.safeParse(base).success).toBe(false);

    drill.verificationQuery = 'SELECT 1';
    drill.credentialsSecret = 'unsafe-secret';
    expect(projectSpecSchema.safeParse(base).success).toBe(false);
  });
});
