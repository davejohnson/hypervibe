import { describe, expect, it } from 'vitest';
import { approvalsRequired, requiresProductionConfirm } from '../deploy.tools.js';

describe('deploy.tools policy contract', () => {
  it('requires production confirm only for protected environments', () => {
    const project = { policies: { protectedEnvironments: ['production', 'staging'] } as Record<string, unknown> };
    expect(requiresProductionConfirm(project, 'production')).toBe(true);
    expect(requiresProductionConfirm(project, 'staging')).toBe(true);
    expect(requiresProductionConfirm(project, 'dev')).toBe(false);
  });

  it('requires approval by default for protected environments', () => {
    const project = { policies: { protectedEnvironments: ['production'] } as Record<string, unknown> };
    expect(approvalsRequired(project, 'production')).toBe(true);
  });

  it('can disable approval requirement explicitly', () => {
    const project = {
      policies: {
        protectedEnvironments: ['production'],
        requireApprovalForProtectedEnvironments: false,
      } as Record<string, unknown>,
    };
    expect(approvalsRequired(project, 'production')).toBe(false);
  });
});
