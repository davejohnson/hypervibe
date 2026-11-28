import { expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { runtimeMonitoringCoverage } from '../runtime-monitoring-coverage.js';
import type { PlanAction } from '../plan.types.js';

it('reports the health signals that are unavailable for the selected resources only when enrolled', () => {
  const base = { hosting: { provider: 'azure' }, services: {} };
  const spec = projectSpecSchema.parse({ version: 1, project: 'shop', environments: {
    staging: { ...base, runtimeObservation: { branch: 'main' } }, other: base,
  } });
  const action = (id: string, type: PlanAction['type'] = 'noop'): PlanAction => ({ id, type, resource: { kind: 'service', name: id, provider: 'azure' }, verified: true, reason: '' });
  const actions = [action('shared:network'), action('shared:registry', 'create'), action('identity:runtime', 'destroy'), action('monitor:dashboard'), action('new-provider-resource')];
  expect(runtimeMonitoringCoverage(spec, 'staging', actions).join(' ')).toMatch(/registry.*network|network.*registry/);
  expect(runtimeMonitoringCoverage(spec, 'staging', actions).join(' ')).not.toMatch(/identities|dashboard/);
  expect(runtimeMonitoringCoverage(spec, 'staging', actions).join(' ')).toContain('new-provider-resource');
  expect(runtimeMonitoringCoverage(spec, 'other', actions)).toEqual([]);
});
