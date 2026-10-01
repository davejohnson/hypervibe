import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

function spec() {
  return {
    version: 1, project: 'example', gitRemoteUrl: 'https://github.com/acme/example.git',
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
    environments: {
      production: {
        hosting: { provider: 'railway' }, services: { api: {}, web: {} },
        deploy: { strategy: 'branch', trigger: 'ci', autoDeploy: false },
        api: {
          service: 'api', versions: { v1: { path: '/v1', contract: 'api/v1.json' } },
          consumers: { web: { versions: ['v1'] }, ios: { versions: ['v1'] } },
          compatibility: { command: 'npm run api:compatibility' },
        },
      },
    },
  };
}

describe('declarative API release policy', () => {
  it('keeps supported versions indefinitely by default', () => {
    const result = projectSpecSchema.parse(spec());
    expect(result.environments.production.api?.versions.v1.status).toBe('supported');
    expect(result.environments.production.api?.compatibility.workingDirectory).toBe('.');
  });

  it('bounds the retained version ledger before generating artifacts', () => {
    const value = spec();
    value.environments.production.api.versions = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`v${i + 1}`, { path: `/v${i + 1}`, contract: `api/v${i + 1}.json` }])) as typeof value.environments.production.api.versions;
    expect(projectSpecSchema.safeParse(value).success).toBe(false);
  });
  it('accepts a second version alongside a deprecated first version', () => {
    const value = spec();
    Object.assign(value.environments.production.api.versions, {
      v1: { path: '/v1', contract: 'api/v1.json', status: 'deprecated' },
      v2: { path: '/v2', contract: 'api/v2.json' },
    });
    expect(projectSpecSchema.safeParse(value).success).toBe(true);
  });

  it.each(['../secret.json', '/tmp/secret.json', 'api/*.json', 'api/../../secret.json'])(
    'rejects unsafe contract path %s', (contract) => {
      const value = spec();
      value.environments.production.api.versions.v1.contract = contract;
      expect(projectSpecSchema.safeParse(value).success).toBe(false);
    },
  );

  it('rejects retirement without an explicit reason and revision, or with remaining consumers', () => {
    const value = spec();
    Object.assign(value.environments.production.api.versions.v1, { status: 'retired' });
    expect(projectSpecSchema.safeParse(value).success).toBe(false);
    Object.assign(value.environments.production.api.versions.v1, { retirement: { id: 'retire-v1', reason: 'Replacement available' } });
    expect(projectSpecSchema.safeParse(value).success).toBe(false);
    value.environments.production.api.consumers = {} as typeof value.environments.production.api.consumers;
    expect(projectSpecSchema.safeParse(value).success).toBe(true);
  });

  it('rejects unknown services, versions, native deploys, and unsupported CI authorities', () => {
    const unknownService = spec(); unknownService.environments.production.api.service = 'missing';
    expect(projectSpecSchema.safeParse(unknownService).success).toBe(false);
    const unknownVersion = spec(); unknownVersion.environments.production.api.consumers.ios.versions = ['v2'];
    expect(projectSpecSchema.safeParse(unknownVersion).success).toBe(false);
    const native = spec(); native.environments.production.deploy.trigger = 'native';
    expect(projectSpecSchema.safeParse(native).success).toBe(false);
    expect(projectSpecSchema.safeParse({ ...spec(), gitRemoteUrl: undefined,
      devops: { code: { provider: 'gitlab', scope: 'acme/example' }, ci: { provider: 'gitlab-ci' } },
    }).success).toBe(false);
  });
});
