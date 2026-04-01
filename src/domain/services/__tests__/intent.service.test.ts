import { describe, expect, it } from 'vitest';
import { buildDriftSignals } from '../intent.service.js';

describe('intent.service drift signals', () => {
  it('returns policy drift checks when desired state is empty', () => {
    const drift = buildDriftSignals(null, []);
    expect(drift).toHaveLength(2);
    const checks = new Map(drift.map((d) => [d.check, d.status]));
    expect(checks.get('policy.productionProtected')).toBe('warning');
    expect(checks.get('policy.protectedApprovals')).toBe('ok');
  });

  it('flags missing desired provider connections', () => {
    const drift = buildDriftSignals(
      {
        databaseProvider: 'supabase',
        domain: 'example.com',
        setupEmail: true,
      },
      []
    );

    expect(drift).toHaveLength(5);
    const checks = new Map(drift.map((d) => [d.check, d.status]));
    expect(checks.get('policy.productionProtected')).toBe('warning');
    expect(checks.get('policy.protectedApprovals')).toBe('ok');
    expect(checks.get('databaseProvider.connection')).toBe('warning');
    expect(checks.get('domain.dnsConnection')).toBe('warning');
    expect(checks.get('email.connection')).toBe('warning');
  });

  it('marks checks as ok when verified connections are present', () => {
    const drift = buildDriftSignals(
      {
        databaseProvider: 'supabase',
        domain: 'example.com',
        setupEmail: true,
      },
      [
        { provider: 'supabase', status: 'verified', scope: null },
        { provider: 'cloudflare', status: 'verified', scope: null },
        { provider: 'sendgrid', status: 'verified', scope: null },
      ],
      {
        protectedEnvironments: ['production'],
        requireApprovalForProtectedEnvironments: true,
      }
    );

    expect(drift).toHaveLength(5);
    expect(drift.every((d) => d.status === 'ok')).toBe(true);
  });

  it('flags deploy and migration safety drift in desired state', () => {
    const drift = buildDriftSignals(
      {
        deploy: {
          strategy: 'branch',
          branches: { staging: 'main', production: 'main' },
        },
        migrations: {
          runInDeploy: true,
        },
      },
      [],
      {
        protectedEnvironments: ['production'],
      }
    );

    const checks = new Map(drift.map((d) => [d.check, d.status]));
    expect(checks.get('policy.productionProtected')).toBe('ok');
    expect(checks.get('policy.protectedApprovals')).toBe('ok');
    expect(checks.get('deploy.branchesDistinct')).toBe('warning');
    expect(checks.get('migrations.deployMode')).toBe('warning');
  });
});
