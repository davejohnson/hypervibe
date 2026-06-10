import { describe, expect, it } from 'vitest';
import { isProtectedEnvironment } from '../../domain/services/policy.service.js';
import { resolveDesiredState } from '../../domain/services/spec.service.js';

describe('infra.tools contract', () => {
  it('detects protected environments case-insensitively', () => {
    const project = {
      policies: { protectedEnvironments: ['Production', 'staging'] } as Record<string, unknown>,
    };
    expect(isProtectedEnvironment(project, 'production')).toBe(true);
    expect(isProtectedEnvironment(project, 'STAGING')).toBe(true);
    expect(isProtectedEnvironment(project, 'dev')).toBe(false);
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
