import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: 'friend-app',
    secrets: {
      ANTHROPIC_API_KEY: {
        principal: 'github:alice',
        environments: ['production'],
      },
    },
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
      },
    },
    ...overrides,
  };
}

describe('delegated secret spec', () => {
  it('accepts a required preserve-only secret slot without a value', () => {
    const parsed = projectSpecSchema.parse(baseSpec());
    expect(parsed.secrets.ANTHROPIC_API_KEY).toEqual({
      ownership: 'delegated',
      principal: 'github:alice',
      environments: ['production'],
      required: true,
      driftPolicy: 'preserve',
    });
    expect(JSON.stringify(parsed)).not.toContain('sk-ant-');
  });

  it('rejects values that are also managed through ordinary envVars', () => {
    const result = projectSpecSchema.safeParse(baseSpec({
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          envVars: { ANTHROPIC_API_KEY: 'must-not-be-committed' },
        },
      },
    }));
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('cannot also be declared');
  });

  it('rejects unknown environments and explicit env-file selection', () => {
    const unknown = projectSpecSchema.safeParse(baseSpec({
      secrets: {
        ANTHROPIC_API_KEY: {
          principal: 'github:alice',
          environments: ['missing'],
        },
      },
    }));
    expect(unknown.success).toBe(false);
    expect(unknown.success ? '' : unknown.error.message).toContain('unknown environment');

    const included = projectSpecSchema.safeParse(baseSpec({
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          envFile: { include: ['ANTHROPIC_API_KEY'] },
        },
      },
    }));
    expect(included.success).toBe(false);
    expect(included.success ? '' : included.error.message).toContain('cannot be selected');
  });
});
