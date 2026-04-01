import { describe, expect, it } from 'vitest';
import { mergeProjectPolicies } from '../project.tools.js';

describe('project.tools policy contract', () => {
  it('merges only provided policy fields', () => {
    const merged = mergeProjectPolicies(
      {
        protectedEnvironments: ['production'],
        requireApprovalForProtectedEnvironments: true,
        existing: 'keep',
      },
      {
        requireApprovalForDestructive: true,
      }
    );

    expect(merged).toEqual({
      protectedEnvironments: ['production'],
      requireApprovalForProtectedEnvironments: true,
      requireApprovalForDestructive: true,
      existing: 'keep',
    });
  });

  it('overwrites desiredState when provided', () => {
    const desiredState = { environmentName: 'staging', serviceName: 'web' };
    const merged = mergeProjectPolicies({}, { desiredState });
    expect(merged.desiredState).toEqual(desiredState);
  });
});
