import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

function project(maintenance?: unknown) {
  return {
    version: 1,
    project: 'maintenance-schema',
    environments: {
      production: {
        hosting: { provider: 'railway' },
        domain: 'app.example.com',
        services: { web: { workloadKind: 'web' } },
        ...(maintenance === undefined ? {} : { maintenance }),
      },
    },
  };
}

describe('environment maintenance spec', () => {
  it('accepts the single whole-environment maintenance switch', () => {
    const parsed = projectSpecSchema.parse(project({ enabled: true }));
    expect(parsed.environments.production.maintenance).toEqual({ enabled: true });
  });

  it('defaults omitted maintenance to ordinary operation', () => {
    const parsed = projectSpecSchema.parse(project());
    expect(parsed.environments.production.maintenance).toBeUndefined();
  });

  it('rejects speculative or application-specific maintenance settings', () => {
    expect(projectSpecSchema.safeParse(project({ enabled: true, bypassToken: 'unsafe' })).success).toBe(false);
    expect(projectSpecSchema.safeParse(project({ enabled: true, readOnly: true })).success).toBe(false);
  });
});
