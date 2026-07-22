import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { deepMergeSpec } from '../../domain/spec/spec.store.js';
import { deprecatedCiSetupPatch } from '../hv-ci.tools.js';

const current = projectSpecSchema.parse({
  version: 1,
  project: 'example',
  environments: {
    staging: { hosting: { provider: 'railway' }, services: {} },
    production: { hosting: { provider: 'railway' }, services: {} },
  },
});

describe('deprecated hv_ci_setup desired-state bridge', () => {
  it('maps a workflow template to a typed check instead of calling GitHub', () => {
    const patch = deprecatedCiSetupPatch('workflow', { template: 'node-test' }, current);
    const next = projectSpecSchema.parse(deepMergeSpec(current, patch));
    expect(next.github?.actions['node-test']).toMatchObject({
      kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm test'],
    });
  });

  it('maps AI review without storing a legacy raw API key', () => {
    const patch = deprecatedCiSetupPatch('ai-review', { apiKey: 'must-not-survive' }, current);
    expect(JSON.stringify(patch)).not.toContain('must-not-survive');
    const next = projectSpecSchema.parse(deepMergeSpec(current, patch));
    expect(next.github?.actions['pr-review']).toMatchObject({ kind: 'pull-request-review' });
  });

  it('maps deploy setup to environment desired state', () => {
    const patch = deprecatedCiSetupPatch('deploy-branch', { provider: 'railway' }, current);
    const next = projectSpecSchema.parse(deepMergeSpec(current, patch));
    expect(next.environments.staging.deploy).toMatchObject({ strategy: 'branch', trigger: 'ci', branch: 'main' });
    expect(next.environments.production.deploy).toMatchObject({ strategy: 'branch', trigger: 'ci', branch: 'main' });
  });
});
