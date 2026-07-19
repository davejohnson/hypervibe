import { describe, expect, it } from 'vitest';
import { environmentSpecSchema, projectSpecSchema } from '../spec.schema.js';

function environment(overrides: Record<string, unknown> = {}) {
  return {
    hosting: { provider: 'railway' },
    services: { web: {} },
    ...overrides,
  };
}

describe('environment variable retirement spec', () => {
  it('defaults to preserving variables omitted from the desired spec', () => {
    const parsed = environmentSpecSchema.parse(environment());
    expect(parsed.removeEnvVars ?? []).toEqual([]);
  });

  it('accepts unique environment variable names as explicit tombstones', () => {
    const parsed = environmentSpecSchema.parse(environment({
      removeEnvVars: ['OLD_API_TOKEN', 'LEGACY_FEATURE_FLAG'],
    }));
    expect(parsed.removeEnvVars).toEqual(['OLD_API_TOKEN', 'LEGACY_FEATURE_FLAG']);
  });

  it('rejects duplicates and keys that are still supplied by envVars or envFile', () => {
    const duplicate = environmentSpecSchema.safeParse(environment({
      removeEnvVars: ['OLD_API_TOKEN', 'OLD_API_TOKEN'],
    }));
    expect(duplicate.success).toBe(false);
    expect(duplicate.success ? '' : duplicate.error.message).toContain('more than once');

    const ordinary = environmentSpecSchema.safeParse(environment({
      envVars: { OLD_API_TOKEN: 'still-used' },
      removeEnvVars: ['OLD_API_TOKEN'],
    }));
    expect(ordinary.success).toBe(false);
    expect(ordinary.success ? '' : ordinary.error.message).toContain('cannot also be declared');

    const envFile = environmentSpecSchema.safeParse(environment({
      envFile: { include: ['OLD_API_TOKEN'] },
      removeEnvVars: ['OLD_API_TOKEN'],
    }));
    expect(envFile.success).toBe(false);
    expect(envFile.success ? '' : envFile.error.message).toContain('cannot also be selected');
  });

  it('rejects a delegated secret that is retired in the same environment', () => {
    const result = projectSpecSchema.safeParse({
      version: 1,
      project: 'friend-app',
      secrets: {
        OLD_API_TOKEN: {
          principal: 'github:alice',
          environments: ['production'],
        },
      },
      environments: {
        production: environment({ removeEnvVars: ['OLD_API_TOKEN'] }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('cannot also be retired');
  });
});
