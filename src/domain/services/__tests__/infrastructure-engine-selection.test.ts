import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { engineEnvironmentProblems, engineSelectionProblem, isEngineManaged } from '../infrastructure-engine-selection.js';

function specFor(provider: 'cloudrun' | 'aws' | 'railway', engine?: 'opentofu') {
  return projectSpecSchema.parse({ version: 1, project: 'engine-selection', environments: {
    staging: { hosting: { provider, ...(engine ? { engine } : {}) }, services: { web: {} } },
  }, secrets: { API_KEY: { ownership: 'delegated', principal: 'app-owner', environments: ['staging'] } } });
}

describe('engine selection across the GCP cutover', () => {
  it('keeps explicit AWS OpenTofu while inferring OpenTofu for Cloud Run', () => {
    for (const spec of [specFor('aws', 'opentofu'), specFor('cloudrun'), specFor('cloudrun', 'opentofu')]) {
      const environment = spec.environments.staging;
      expect(isEngineManaged(environment)).toBe(true);
      expect(engineSelectionProblem(environment)).toBeUndefined();
      expect(engineEnvironmentProblems(spec, 'staging')).toEqual([]);
    }
  });

  it('leaves AWS without an engine flag and Railway on their existing paths', () => {
    expect(isEngineManaged(specFor('aws').environments.staging)).toBe(false);
    expect(isEngineManaged(specFor('railway').environments.staging)).toBe(false);
    expect(engineSelectionProblem(specFor('railway', 'opentofu').environments.staging)).toContain('not supported');
  });

  it('accepts outside keys without losing GCP capability guards', () => {
    const spec = specFor('cloudrun');
    expect(engineEnvironmentProblems(spec, 'staging')).toEqual([]);
    spec.environments.staging.database = { engine: 'mysql', provider: 'cloudsql' } as never;
    expect(engineEnvironmentProblems(spec, 'staging')).toContain('The OpenTofu engine manages Cloud SQL only with engine "postgres".');
  });
});
