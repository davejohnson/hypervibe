import { describe, expect, it } from 'vitest';
import { awsLegacyNames, awsPrefix } from '../infrastructure-engine-aws.js';

const environment = (platformBindings: Record<string, unknown>) => ({ platformBindings }) as never;

describe('AWS environment names', () => {
  it('keeps environments apart when a long name is cut to fit', () => {
    // 25 characters of project name fill the whole 28-character prefix on their own.
    const production = awsPrefix('sequence-resource-planner', 'production');
    const preview = awsPrefix('sequence-resource-planner', 'preview');
    expect(production).not.toBe(preview);
    expect(awsPrefix('billing-service-app', 'production')).not.toBe(awsPrefix('billing-service-app', 'preview'));
    for (const name of [production, preview]) {
      expect(name.length).toBeLessThanOrEqual(28);
      expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
    // The same environment always gets the same name, and one that fits is left alone.
    expect(awsPrefix('sequence-resource-planner', 'production')).toBe(production);
    expect(awsPrefix('shop', 'pr-12')).toBe('hv-shop-pr-12');
  });

  it('keeps the plain cut name for an environment made before names were marked', () => {
    expect(awsPrefix('sequence-resource-planner', 'production', true)).toBe('hv-sequence-resource-planner');
    expect(awsPrefix('Shop_App', 'pr-12', true)).toBe('hv-shop-app-pr-12');
  });

  it('treats an environment as existing from any trace of it, and as new only when it has none', () => {
    expect(awsLegacyNames(environment({}), false)).toBe(false);
    expect(awsLegacyNames(environment({ aws: { kind: 'opentofu', imageUri: 'registry/app:1' } }), false)).toBe(true);
    // A first apply that failed before anything was saved still left resources: its state is the trace.
    expect(awsLegacyNames(environment({}), true)).toBe(true);
    // Workload identities are recorded after an apply, also a partial one.
    expect(awsLegacyNames(environment({ provider: 'aws', projectId: '123456789012', environmentId: 'us-east-1' }), false)).toBe(true);
    // Once recorded, the naming holds whatever else is saved or left behind.
    expect(awsLegacyNames(environment({ provider: 'aws', aws: { naming: 2, kind: 'opentofu', imageUri: 'registry/app:1' } }), true)).toBe(false);
    expect(awsLegacyNames(environment({ aws: { naming: 2, tornDownAt: '2026-11-19T00:00:00Z' } }), true)).toBe(false);
  });
});
