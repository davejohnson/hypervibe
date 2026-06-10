import { describe, expect, it } from 'vitest';
import { requiresProductionConfirm } from '../../domain/services/policy.service.js';

describe('deploy.tools policy contract', () => {
  it('requires production confirm only for protected environments', () => {
    const project = { policies: { protectedEnvironments: ['production', 'staging'] } as Record<string, unknown> };
    expect(requiresProductionConfirm(project, 'production')).toBe(true);
    expect(requiresProductionConfirm(project, 'staging')).toBe(true);
    expect(requiresProductionConfirm(project, 'dev')).toBe(false);
  });
});
