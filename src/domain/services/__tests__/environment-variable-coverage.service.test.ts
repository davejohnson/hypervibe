import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { environmentVariableCoverage, introducedEnvironmentVariableCoverageIssues } from '../environment-variable-coverage.service.js';

function spec(input: Record<string, unknown>) {
  return projectSpecSchema.parse({ version: 1, project: 'coverage-app', ...input });
}

const web = { web: { startCommand: 'npm start' } };

describe('environmentVariableCoverage', () => {
  it.each(['new input', 'changed config', 'additional service', 'new environment'])(
    'does not grandfather %s submitted alongside a rename', (change) => {
      const previous = spec({ environments: {
        production: { hosting: { provider: 'railway' }, services: web },
        staging: { hosting: { provider: 'railway' }, services: { preview: { startCommand: 'npm start' } }, envVars: { CONTACT_EMAIL: 'owner@example.test' } },
      } });
      const next = structuredClone(previous);
      next.environments.staging.services = { web: next.environments.staging.services.preview };
      if (change === 'new input') next.environments.staging.envVars.NEW_INPUT = 'new-value';
      if (change === 'changed config') next.environments.staging.services.web.startCommand = 'npm run other';
      if (change === 'additional service') next.environments.staging.services.extra = structuredClone(next.environments.staging.services.web);
      if (change === 'new environment') next.environments.review = structuredClone(next.environments.production);
      const issues = introducedEnvironmentVariableCoverageIssues(previous, next);
      expect(issues.length).toBeGreaterThan(0);
      if (change === 'new input') expect(issues.map(({ key }) => key)).toEqual(['NEW_INPUT']);
      if (change === 'new environment') expect(issues.map(({ environment }) => environment)).toEqual(['review']);
    }
  );

  it('requires new ordinary keys in every non-local environment with matching services', () => {
    const report = environmentVariableCoverage(spec({
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web, envVars: {} },
        production: {
          hosting: { provider: 'railway' }, services: web,
          envVars: { RECAPTCHA_SITE_KEY: 'production-site-id' },
        },
      },
    }));

    expect(report).toMatchObject({
      complete: false,
      issues: [{
        reason: 'missing_environment',
        key: 'RECAPTCHA_SITE_KEY',
        environment: 'staging',
        declaredIn: ['production'],
        requiredEnvironments: ['production', 'staging'],
      }],
    });
    expect(JSON.stringify(report)).not.toContain('production-site-id');
  });

  it('accepts separately chosen ordinary values and explicit exceptions', () => {
    const complete = environmentVariableCoverage(spec({
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web, envVars: { SITE_KEY: 'staging-id' } },
        production: { hosting: { provider: 'railway' }, services: web, envVars: { SITE_KEY: 'production-id' } },
      },
    }));
    const excepted = environmentVariableCoverage(spec({
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web, envVarExceptions: ['PRODUCTION_ONLY'] },
        production: { hosting: { provider: 'railway' }, services: web, envVars: { PRODUCTION_ONLY: 'enabled' } },
      },
    }));

    expect(complete).toEqual({ complete: true, issues: [] });
    expect(excepted).toEqual({ complete: true, issues: [] });
  });

  it('requires managed secret slots across matching release environments without values', () => {
    const report = environmentVariableCoverage(spec({
      secrets: {
        RECAPTCHA_SECRET_KEY: { principal: 'github:dave', environments: ['production'] },
      },
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web },
        production: { hosting: { provider: 'railway' }, services: web },
      },
    }));

    expect(report.issues).toEqual([
      expect.objectContaining({ key: 'RECAPTCHA_SECRET_KEY', environment: 'staging' }),
    ]);
  });

  it('rejects mixing managed secrets and ordinary configuration across environments', () => {
    const report = environmentVariableCoverage(spec({
      secrets: {
        API_KEY: { principal: 'github:dave', environments: ['production'] },
      },
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web, envVars: { API_KEY: 'not-a-secret-here' } },
        production: { hosting: { provider: 'railway' }, services: web },
      },
    }));

    expect(report.issues).toEqual([
      expect.objectContaining({ reason: 'mixed_secret_boundary', key: 'API_KEY' }),
    ]);
  });

  it('does not couple local or unrelated-service environments', () => {
    const report = environmentVariableCoverage(spec({
      environments: {
        local: { hosting: { provider: 'railway' }, services: web, envVars: {} },
        production: { hosting: { provider: 'railway' }, services: web, envVars: { WEB_ONLY: 'yes' } },
        jobs: {
          hosting: { provider: 'railway' },
          services: { worker: { workloadKind: 'worker', startCommand: 'npm run worker' } },
          envVars: {},
        },
      },
    }));

    expect(report).toEqual({ complete: true, issues: [] });
  });
});
