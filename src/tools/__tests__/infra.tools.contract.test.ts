import { describe, expect, it } from 'vitest';
import { infraApprovalsRequiredForEnvironment, isProtectedEnvironment, resolveDesiredState } from '../infra.tools.js';

describe('infra.tools contract', () => {
  it('detects protected environments case-insensitively', () => {
    const project = {
      policies: { protectedEnvironments: ['Production', 'staging'] } as Record<string, unknown>,
    };
    expect(isProtectedEnvironment(project, 'production')).toBe(true);
    expect(isProtectedEnvironment(project, 'STAGING')).toBe(true);
    expect(isProtectedEnvironment(project, 'dev')).toBe(false);
  });

  it('requires approvals for protected environments by default', () => {
    const project = {
      policies: { protectedEnvironments: ['production'] } as Record<string, unknown>,
    };
    expect(infraApprovalsRequiredForEnvironment(project, 'production')).toBe(true);
    expect(infraApprovalsRequiredForEnvironment(project, 'staging')).toBe(false);
  });

  it('can disable protected-environment approvals explicitly', () => {
    const project = {
      policies: {
        protectedEnvironments: ['production'],
        requireApprovalForProtectedEnvironments: false,
      } as Record<string, unknown>,
    };
    expect(infraApprovalsRequiredForEnvironment(project, 'production')).toBe(false);
  });

  it('resolveDesiredState preserves deploy and migration policy defaults', () => {
    const desired = resolveDesiredState(
      {
        deploy: { strategy: 'branch', branches: { staging: 'staging', production: 'main' } },
        migrations: { mode: 'tool', runInDeploy: true, command: 'pnpm migrate' },
      },
      {}
    );
    expect(desired.deploy?.strategy).toBe('branch');
    expect(desired.deploy?.branches?.production).toBe('main');
    expect(desired.migrations?.mode).toBe('tool');
    expect(desired.migrations?.runInDeploy).toBe(true);
  });
});
