import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { engineEnvironmentProblems, isEngineManaged } from '../infrastructure-engine-selection.js';

function specFor(provider: 'cloudrun' | 'aws' | 'azure' | 'railway', engine?: 'opentofu') {
  return projectSpecSchema.parse({ version: 1, project: 'engine-selection', environments: {
    staging: { hosting: { provider, ...(engine ? { engine } : {}) }, services: { web: {} } },
  }, secrets: { API_KEY: { ownership: 'delegated', principal: 'app-owner', environments: ['staging'] } } });
}

// Contract: the engine is not a setting. Google Cloud, AWS and Azure always use
// OpenTofu; Railway never does (ARCHITECTURE.md, Provider Scope).
describe('engine selection', () => {
  it.each(['cloudrun', 'aws', 'azure'] as const)('always manages %s with the engine, with or without an older engine flag', (provider) => {
    for (const spec of [specFor(provider), specFor(provider, 'opentofu')]) {
      const environment = spec.environments.staging;
      expect(isEngineManaged(environment)).toBe(true);
      expect(environment.hosting).not.toHaveProperty('engine');
      expect(engineEnvironmentProblems(spec, 'staging')).toEqual([]);
    }
  });

  it('never manages Railway with the engine, and ignores an engine flag there too', () => {
    for (const spec of [specFor('railway'), specFor('railway', 'opentofu')]) {
      expect(isEngineManaged(spec.environments.staging)).toBe(false);
      expect(spec.environments.staging.hosting).toEqual({ provider: 'railway' });
    }
  });

  it.each(['cloudrun', 'aws', 'azure'] as const)('refuses capabilities no engine builds yet on %s', (provider) => {
    const spec = specFor(provider, 'opentofu');
    const environment = spec.environments.staging;
    environment.backups = { mode: 'daily' } as never;
    environment.email = { enabled: true } as never;
    environment.domainRegistration = { provider: 'cloudflare', register: true };
    environment.services.web!.volume = { mountPath: '/data' } as never;
    environment.database = { engine: 'postgres', provider: provider === 'cloudrun' ? 'cloudsql' : provider === 'aws' ? 'rds' : 'azure-postgres', resilience: {} } as never;
    const problems = engineEnvironmentProblems(spec, 'staging').join('\n');
    for (const field of ['backups', 'email', 'domainRegistration', 'filesystem volumes', 'database.resilience']) expect(problems).toContain(field);
  });

  it('keeps domainTarget available on AWS and Azure, where the engine recommends it', () => {
    for (const provider of ['aws', 'azure'] as const) {
      const spec = specFor(provider, 'opentofu');
      spec.environments.staging.domainTarget = { environment: 'production' } as never;
      expect(engineEnvironmentProblems(spec, 'staging')).toEqual([]);
    }
  });

  it('accepts outside keys without losing GCP capability guards', () => {
    const spec = specFor('cloudrun');
    expect(engineEnvironmentProblems(spec, 'staging')).toEqual([]);
    spec.environments.staging.database = { engine: 'mysql', provider: 'cloudsql' } as never;
    expect(engineEnvironmentProblems(spec, 'staging')).toContain('The OpenTofu engine manages Cloud SQL only with engine "postgres".');
  });
});
