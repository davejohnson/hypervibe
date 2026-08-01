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
      changeScope: 'application',
      runtime: { kind: 'node', installCommand: 'npm ci' },
    });
    expect(spec.github?.actions['fix-tests']).toMatchObject({
      kind: 'autofix',
      agent: { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' },
      draftPullRequest: true,
    });
  });

  it('allows checks to opt into Hypervibe infrastructure changes', () => {
    const spec = projectSpecSchema.parse(baseSpec({
      actions: {
        infrastructure: {
          kind: 'check',
          category: 'lint',
          changeScope: 'all',
          runtime: { kind: 'node' },
          commands: ['npm run validate:infrastructure'],
          triggers: { pullRequest: true },
        },
      },
    }));

    expect(spec.github?.actions.infrastructure).toMatchObject({ changeScope: 'all' });
  });

  it('accepts concrete project runtimes and rejects ranges or image-tag injection', () => {
    const node = projectSpecSchema.parse({
      ...baseSpec({}),
      runtime: { kind: 'node', version: '22.17.1' },
    });
    const python = projectSpecSchema.parse({
      ...baseSpec({}),
      runtime: { kind: 'python', version: '3.13' },
    });

    expect(node.runtime).toEqual({ kind: 'node', version: '22.17.1' });
    expect(python.runtime).toEqual({ kind: 'python', version: '3.13' });
    for (const version of ['>=20', 'v22', '22-slim', '22\nRUN echo unsafe']) {
      expect(projectSpecSchema.safeParse({
        ...baseSpec({}),
        runtime: { kind: 'node', version },
      }).success).toBe(false);
    }
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

  it('requires declared evidence for external workflows used by autofix', () => {
    const result = projectSpecSchema.safeParse(baseSpec({
      actions: {
        fix: { kind: 'autofix', sources: ['deploy'] },
      },
      externalWorkflows: {
        deploy: { workflowName: 'Deploy staging' },
      },
    }));

    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages).toContain(
      'external workflow "deploy" must declare at least one failure artifact before autofix can consume it'
    );
  });

  it('keeps legacy external evidence readable while accepting a narrow artifact pattern', () => {
    const legacy = projectSpecSchema.parse(baseSpec({
      actions: { fix: { kind: 'autofix', sources: ['deploy'] } },
      externalWorkflows: {
        deploy: {
          workflowName: 'Deploy staging',
          failureArtifacts: ['hypervibe-deploy-failure.log'],
        },
      },
    }));
    expect(legacy.github?.externalWorkflows.deploy.failureArtifactPattern).toBeUndefined();

    const current = projectSpecSchema.parse(baseSpec({
      actions: { fix: { kind: 'autofix', sources: ['deploy'] } },
      externalWorkflows: {
        deploy: {
          workflowName: 'Deploy staging',
          failureArtifactPattern: 'deploy-staging-failure-*',
          failureArtifacts: ['hypervibe-deploy-failure.log'],
        },
      },
    }));
    expect(current.github?.externalWorkflows.deploy.failureArtifactPattern).toBe('deploy-staging-failure-*');
  });

  it('rejects broad or expression-shaped evidence artifact patterns', () => {
    const result = projectSpecSchema.safeParse(baseSpec({
      actions: { fix: { kind: 'autofix', sources: ['deploy'] } },
      externalWorkflows: {
        deploy: {
          workflowName: 'Deploy staging',
          failureArtifactPattern: '${{ github.run_id }}',
          failureArtifacts: ['hypervibe-deploy-failure.log'],
        },
      },
    }));

    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages).toContain(
      'failure artifact patterns must be a narrow artifact name or identifier-shaped prefix ending in *'
    );
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

  it('rejects opting out of owned pull-request templates', () => {
    const result = projectSpecSchema.safeParse(baseSpec({
      collaboration: {
        pullRequests: {
          requirePr: true,
          manageTemplate: false,
        },
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

  it('rejects legacy runtime autofix intent with migration guidance', () => {
    const legacy = baseSpec({});
    legacy.environments.production = {
      ...legacy.environments.production,
      autofix: { enabled: true, services: ['web'] },
    } as typeof legacy.environments.production;

    const result = projectSpecSchema.safeParse(legacy);
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages).toContain(
      'environments.*.autofix has been removed. Use hv_errors action="list" or action="summary" for live runtime errors; use github.actions.<id> kind="autofix" to repair failed GitHub workflow checks.'
    );
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
