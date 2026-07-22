import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';
import { canonicalizeLegacyGitHubSpec } from '../spec.store.js';

function baseSpec(github: Record<string, unknown>) {
  return {
    version: 1,
    project: 'example',
    github,
    environments: {
      production: { hosting: { provider: 'railway' }, services: { web: {} } },
    },
  };
}

describe('github desired state', () => {
  it('parses typed checks, AI automations, security, dependencies, and schedules', () => {
    const spec = projectSpecSchema.parse(baseSpec({
      canonicalEnvironment: 'production',
      actions: {
        tests: {
          kind: 'check',
          category: 'test',
          runtime: { kind: 'node' },
          commands: ['npm test'],
          triggers: { pullRequest: true, schedule: { cron: '17 3 * * *', timezone: 'America/Vancouver' } },
        },
        'fix-tests': { kind: 'autofix', sources: ['tests'] },
        review: { kind: 'pull-request-review' },
        audit: { kind: 'code-audit', schedule: { cron: '0 6 * * 1' } },
      },
      dependencies: {
        alerts: true,
        securityUpdates: true,
        versionUpdates: [{ ecosystem: 'npm', directory: '/', interval: 'weekly' }],
      },
      security: { codeScanning: true, secretScanning: true, pushProtection: true },
    }));

    expect(spec.github?.actions.tests).toMatchObject({
      kind: 'check',
      enabled: true,
      runtime: { kind: 'node', version: '22', installCommand: 'npm ci' },
    });
    expect(spec.github?.actions['fix-tests']).toMatchObject({
      kind: 'autofix',
      agent: { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' },
      draftPullRequest: true,
    });
  });

  it('requires five-field cron and a valid automation reference', () => {
    const result = projectSpecSchema.safeParse(baseSpec({
      actions: {
        tests: {
          kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm test'],
          triggers: { schedule: { cron: '0 3 * * * *' } },
        },
        fix: { kind: 'autofix', sources: ['missing'] },
      },
    }));
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages).toContain('schedule.cron must use five-field POSIX cron: minute hour day-of-month month day-of-week');
    expect(messages).toContain('autofix source "missing" is not a managed check or external workflow');
  });

  it('rejects broad or credential-shaped failure artifact paths', () => {
    const result = projectSpecSchema.safeParse(baseSpec({
      actions: {
        tests: {
          kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm test'],
          failureArtifacts: ['**/*', '.env.production'],
        },
      },
    }));
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      'failure artifact paths must be narrow relative result paths and cannot target credentials, .env, .git, or the whole workspace',
    ]));
  });

  it('keeps autofix pull requests and code-audit findings review-gated', () => {
    const result = projectSpecSchema.safeParse(baseSpec({
      actions: {
        tests: { kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm test'] },
        fix: { kind: 'autofix', sources: ['tests'], draftPullRequest: false },
        audit: { kind: 'code-audit', schedule: { cron: '0 4 * * *' }, findings: { createIssues: false } },
      },
    }));
    expect(result.success).toBe(false);
  });

  it('rejects ambiguous legacy and canonical collaboration state', () => {
    const result = projectSpecSchema.safeParse({
      ...baseSpec({}),
      collaboration: {},
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('cannot both be declared');
  });

  it('keeps basic project specs valid without GitHub or OpenAI', () => {
    expect(projectSpecSchema.parse({
      version: 1,
      project: 'local-only',
      environments: {
        development: { hosting: { provider: 'railway' }, services: {} },
      },
    }).github).toBeUndefined();
  });

  it('canonicalizes legacy collaboration on the next explicit spec update', () => {
    const canonical = projectSpecSchema.parse(canonicalizeLegacyGitHubSpec({
      version: 1,
      project: 'legacy',
      collaboration: { repository: 'owner/repo', pullRequests: { targetBranch: 'trunk' } },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    }));
    expect(canonical.collaboration).toBeUndefined();
    expect(canonical.github).toMatchObject({
      repository: 'owner/repo',
      collaboration: { pullRequests: { targetBranch: 'trunk' } },
    });
  });
});
