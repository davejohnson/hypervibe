import { describe, expect, it } from 'vitest';
import { resolveDesiredState } from '../infra.tools.js';

describe('infra.tools desired state resolution', () => {
  it('uses defaults when neither policy nor overrides provide values', () => {
    const desired = resolveDesiredState(undefined, {});
    expect(desired).toEqual({
      environmentName: 'staging',
      services: ['web'],
      serviceName: 'web',
      databaseProvider: 'supabase',
      setupEmail: true,
      domain: undefined,
      deploy: undefined,
      migrations: undefined,
    });
  });

  it('prefers explicit overrides over persisted policy state', () => {
    const desired = resolveDesiredState(
      {
        environmentName: 'production',
        services: ['api', 'worker'],
        serviceName: 'api',
        domain: 'example.com',
        databaseProvider: 'rds',
        setupEmail: false,
        deploy: { strategy: 'manual' },
      },
      {
        services: ['web', 'worker'],
        databaseProvider: 'cloudsql',
        deploy: { strategy: 'branch', branches: { staging: 'staging', production: 'main' } },
        migrations: { mode: 'releaseCommand', runInDeploy: true, command: 'npm run migrate' },
      }
    );

    expect(desired.environmentName).toBe('production');
    expect(desired.services).toEqual(['web', 'worker']);
    expect(desired.serviceName).toBe('web');
    expect(desired.databaseProvider).toBe('cloudsql');
    expect(desired.setupEmail).toBe(false);
    expect(desired.deploy?.strategy).toBe('branch');
    expect(desired.migrations?.mode).toBe('releaseCommand');
  });

  it('accepts railway as a desired database provider override', () => {
    const desired = resolveDesiredState(
      {
        databaseProvider: 'supabase',
      },
      {
        databaseProvider: 'railway',
      }
    );

    expect(desired.databaseProvider).toBe('railway');
  });

  it('falls back to legacy serviceName when services are not persisted', () => {
    const desired = resolveDesiredState(
      {
        serviceName: 'worker',
      },
      {}
    );

    expect(desired.services).toEqual(['worker']);
    expect(desired.serviceName).toBe('worker');
  });
});
