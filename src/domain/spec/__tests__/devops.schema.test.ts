import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';
import {
  devOpsScopeMatchesRemote,
  resolveDevOpsSelection,
} from '../devops-selection.js';

function base() {
  return {
    version: 1 as const,
    project: 'devops-app',
    gitRemoteUrl: 'git@gitlab.com:acme/apps/devops-app.git',
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: { web: { startCommand: 'npm start' } },
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
      },
    },
  };
}

describe('canonical devops desired state', () => {
  it('accepts open code-host and CI ids and preserves their independent selection', () => {
    const parsed = projectSpecSchema.parse({
      ...base(),
      devops: {
        code: { provider: 'gitlab', scope: 'https://gitlab.com/acme/apps/devops-app' },
        ci: { provider: 'gitlab-ci' },
        canonicalEnvironment: 'staging',
      },
    });
    expect(resolveDevOpsSelection(parsed)).toEqual({
      code: { provider: 'gitlab', scope: 'https://gitlab.com/acme/apps/devops-app' },
      ci: { provider: 'gitlab-ci' },
      canonicalEnvironment: 'staging',
      source: 'canonical',
    });
    expect(devOpsScopeMatchesRemote(parsed)).toBe(true);
  });

  it('rejects overlapping legacy and canonical authority', () => {
    const result = projectSpecSchema.safeParse({
      ...base(),
      devops: {
        code: { provider: 'gitlab', scope: 'https://gitlab.com/acme/apps/devops-app' },
        ci: { provider: 'gitlab-ci' },
      },
      github: { enabled: true },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      path: ['devops'],
      message: expect.stringContaining('cannot both be declared'),
    }));
  });

  it('requires an explicit primary CI provider for a canonical CI deploy', () => {
    const result = projectSpecSchema.safeParse({
      ...base(),
      devops: {
        code: { provider: 'gitlab', scope: 'https://gitlab.com/acme/apps/devops-app' },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      path: ['environments', 'staging', 'deploy', 'trigger'],
      message: expect.stringContaining('requires devops.ci.provider'),
    }));
  });

  it('keeps credentials and URL controls out of persisted repository scopes', () => {
    const result = projectSpecSchema.safeParse({
      ...base(),
      devops: {
        code: { provider: 'gitlab', scope: 'https://token@gitlab.com/acme/apps/devops-app?ref=main' },
        ci: { provider: 'gitlab-ci' },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      path: ['devops', 'code', 'scope'],
      message: expect.stringContaining('cannot contain credentials'),
    }));
  });

  it('matches path-only GitHub scopes without hard-coding them into the schema', () => {
    const parsed = projectSpecSchema.parse({
      ...base(),
      gitRemoteUrl: 'https://github.com/acme/devops-app.git',
      devops: {
        code: { provider: 'github', scope: 'acme/devops-app' },
        ci: { provider: 'github-actions' },
      },
    });
    expect(devOpsScopeMatchesRemote(parsed)).toBe(true);
  });
});
