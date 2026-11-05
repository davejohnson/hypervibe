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

  it('accepts explicit routing to an existing separate web environment while the source stays paused', () => {
    const input = project({ enabled: true, mode: 'application', page: 'off' });
    Object.assign(input.environments.production, { domainTarget: { environment: 'next', service: 'web' } });
    Object.assign(input.environments, { next: { hosting: { provider: 'cloudrun' }, services: { web: {} } } });
    expect(projectSpecSchema.safeParse(input).success).toBe(true);
  });

  it('rejects releasing the page without a separate declared web target or while restoring the source', () => {
    expect(projectSpecSchema.safeParse(project({ enabled: true, mode: 'application', page: 'off' })).success).toBe(false);
    const input = project({ enabled: false, mode: 'application', page: 'off' });
    Object.assign(input.environments.production, { domainTarget: { environment: 'next', service: 'web' } });
    Object.assign(input.environments, { next: { hosting: { provider: 'cloudrun' }, services: { web: {} } } });
    expect(projectSpecSchema.safeParse(input).success).toBe(false);
  });

  it.each(['app.example.com', 'App.Example.Com', 'app.example.com.'])('rejects shared domain ownership for the target spelling %s', domain => {
    const input = project({ enabled: true, mode: 'application', page: 'off' });
    Object.assign(input.environments.production, { domainTarget: { environment: 'next', service: 'web' } });
    Object.assign(input.environments, { next: { hosting: { provider: 'cloudrun' }, domain, services: { web: {} } } });
    expect(projectSpecSchema.safeParse(input).success).toBe(false);
  });
});
