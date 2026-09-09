import { describe, expect, it } from 'vitest';
import {
  bindingIdentityFingerprint,
  providerIdentityScopeMatches,
} from '../binding-identity.js';

describe('bindingIdentityFingerprint', () => {
  it('is stable across key order and credential rotation', () => {
    const first = bindingIdentityFingerprint({
      provider: 'railway',
      volumeId: 'volume-1',
      providerScope: { projectId: 'project-1', environmentId: 'environment-1' },
      password: 'first-secret',
      connectionString: 'postgres://user:first-secret@example.invalid/app',
      pooledUrl: 'postgres://user:first-secret@pool.example.invalid/app',
    });
    const second = bindingIdentityFingerprint({
      pooledUrl: 'postgres://user:second-secret@pool.example.invalid/app',
      connectionString: 'postgres://user:second-secret@example.invalid/app',
      password: 'second-secret',
      providerScope: { environmentId: 'environment-1', projectId: 'project-1' },
      volumeId: 'volume-1',
      provider: 'railway',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['volumeId', { volumeId: 'volume-2' }],
    ['securityGroupId', { securityGroupId: 'sg-2' }],
    ['ownership flag', { securityGroupManagedByHypervibe: false }],
    ['resource kind', { resourceKind: 'volume-only' }],
  ])('changes when the destructive %s changes', (_label, patch) => {
    const base = {
      provider: 'rds',
      volumeId: 'volume-1',
      securityGroupId: 'sg-1',
      securityGroupManagedByHypervibe: true,
      resourceKind: 'postgres',
      providerScope: { accountId: '123456789012', region: 'us-west-2' },
    };

    expect(bindingIdentityFingerprint({ ...base, ...patch }))
      .not.toBe(bindingIdentityFingerprint(base));
  });
});

describe('providerIdentityScopeMatches', () => {
  it('completes a legacy flattened scope from the exact provider environment', () => {
    expect(providerIdentityScopeMatches({
      provider: 'railway',
      componentBindings: { provider: 'railway', projectId: 'project-1' },
      environmentBindings: {
        provider: 'railway',
        projectId: 'project-1',
        environmentId: 'environment-1',
      },
      liveScope: { projectId: 'project-1', environmentId: 'environment-1' },
    })).toBe(true);
  });

  it('does not replace malformed explicit scope with a matching fallback value', () => {
    expect(providerIdentityScopeMatches({
      provider: 'railway',
      componentBindings: {
        provider: 'railway',
        providerScope: { projectId: 'project-1', environmentId: null },
      },
      environmentBindings: {
        provider: 'railway',
        projectId: 'project-1',
        environmentId: 'environment-1',
      },
      liveScope: { projectId: 'project-1', environmentId: 'environment-1' },
    })).toBe(false);
  });

  it('does not use an environment bound to another provider', () => {
    expect(providerIdentityScopeMatches({
      provider: 'cloudsql',
      componentBindings: { provider: 'cloudsql', projectId: 'gcp-project' },
      environmentBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment',
      },
      liveScope: { projectId: 'gcp-project', region: 'us-west1' },
    })).toBe(false);
  });
});
