import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { cloudEngineFor, cloudEngineForPlan, cloudEngines } from '../cloud-engines.js';

const spec = projectSpecSchema.parse({ version: 1, project: 'engines', environments: {
  gcp: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
  aws: { hosting: { provider: 'aws' }, services: { web: {} } },
  azure: { hosting: { provider: 'azure' }, services: { web: {} } },
  'aws-with-old-flag': { hosting: { provider: 'aws', engine: 'opentofu' }, services: { web: {} } },
  railway: { hosting: { provider: 'railway' }, services: { web: {} } },
} });

// Contract: generic code routes by engine, not provider-name branches (ARCHITECTURE.md, Provider Boundary).
describe('cloud engine registry', () => {
  it('selects one engine per engine-managed environment and none otherwise', () => {
    expect(['gcp', 'aws', 'azure', 'aws-with-old-flag', 'railway', 'missing'].map((name) => cloudEngineFor(spec, name)?.id))
      .toEqual(['gcp', 'aws', 'azure', 'aws', undefined, undefined]);
  });

  it('applies a saved plan with the engine that produced it, even after its environment left the spec', () => {
    expect(cloudEngineForPlan({ environmentName: 'removed', engine: { aws: { accountId: '1' } } }, spec).id).toBe('aws');
    expect(cloudEngineForPlan({ environmentName: 'removed', engine: { azure: {} } }, spec).id).toBe('azure');
    expect(cloudEngineForPlan({ environmentName: 'gcp', engine: { gcpProjectId: 'p' } }, spec).id).toBe('gcp');
    expect(cloudEngineForPlan({ environmentName: 'aws' }, spec).id).toBe('aws');
  });

  it('offers teardown only where an engine implements it', () => {
    expect(cloudEngines.filter((engine) => engine.planTeardown).map((engine) => engine.id)).toEqual(['gcp', 'aws', 'azure']);
    // Google Cloud deletes the project Hypervibe created; Azure removes what one-time setup created.
    expect(cloudEngines.filter((engine) => engine.removeProject).map((engine) => engine.id)).toEqual(['gcp', 'azure']);
  });
});
