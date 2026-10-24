import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

const destination = (secretId: string) => ({ provider: 'gcp-secret-manager',
  projectId: 'synthetic-project', projectNumber: '123456789012', secretId });
const spec = () => ({ version: 1, project: 'synthetic-app', secrets: {
  FLOW_KEY: { ownership: 'delegated', principal: 'email:owner@example.test',
    environments: ['staging', 'production'] },
}, environments: Object.fromEntries(['staging', 'production'].map(env => [env, {
  hosting: { provider: 'cloudrun' }, services: { web: {} },
  secretDestinations: { FLOW_KEY: { destination: destination(`${env}-flow-key`) } },
}])) });

describe('reviewed secret destinations', () => {
  it('preserves separate destinations for all declared environments before and after delivery', () => {
    const input = spec();
    const before = projectSpecSchema.parse(input);
    expect(before.environments.staging.secretDestinations?.FLOW_KEY).toEqual({
      destination: destination('staging-flow-key'),
    });
    (input.environments.staging.secretDestinations.FLOW_KEY as Record<string, unknown>).version = '7';
    const delivered = projectSpecSchema.parse(input);
    expect(delivered.environments.staging.secretDestinations?.FLOW_KEY.version).toBe('7');
    expect(delivered.environments.production.secretDestinations?.FLOW_KEY.version).toBeUndefined();
  });

  it('rejects cross-environment destination reuse instead of sharing production values', () => {
    const input = spec();
    input.environments.production.secretDestinations = input.environments.staging.secretDestinations;
    expect(projectSpecSchema.safeParse(input).success).toBe(false);
  });

  it.each(['latest', '0', '../7'])('rejects mutable or invalid GCP version %s', version => {
    const input = spec();
    (input.environments.staging.secretDestinations.FLOW_KEY as Record<string, unknown>).version = version;
    expect(projectSpecSchema.safeParse(input).success).toBe(false);
  });

  it('rejects undeclared slots and plaintext input on destination records', () => {
    const input = spec();
    input.environments.staging.secretDestinations = { OTHER_KEY: {
      destination: destination('staging-other-key'), value: 'synthetic-do-not-persist',
    } } as never;
    expect(projectSpecSchema.safeParse(input).success).toBe(false);
  });
});
