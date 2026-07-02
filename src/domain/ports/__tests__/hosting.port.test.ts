import { describe, expect, it } from 'vitest';
import { parseHostingBindings } from '../hosting.port.js';

describe('parseHostingBindings', () => {
  it('parses a production-shaped bindings blob and keeps provider extras', () => {
    const bindings = parseHostingBindings({
      platformBindings: {
        provider: 'railway',
        projectId: 'proj-123',
        environmentId: 'env-456',
        ci: { workflows: { production: { path: '.github/workflows/deploy.yml' } } },
        services: {
          web: {
            serviceId: 'svc-1',
            url: 'https://web-production.up.railway.app',
            customDomains: ['app.example.com'],
            source: { repo: 'davejohnson/app', branch: 'main' },
            railwayRebind: { previousServiceId: 'svc-0' },
          },
          nightly: {
            serviceId: 'svc-2',
            workloadKind: 'cron',
            schedulerJobName: 'nightly-job',
          },
        },
      },
    });

    expect(bindings.provider).toBe('railway');
    expect(bindings.projectId).toBe('proj-123');
    expect(bindings.services?.web?.serviceId).toBe('svc-1');
    expect(bindings.services?.web?.source?.branch).toBe('main');
    expect(bindings.services?.nightly?.schedulerJobName).toBe('nightly-job');
    // Passthrough: unknown keys survive at both levels.
    expect((bindings as Record<string, unknown>).ci).toBeDefined();
    expect((bindings.services?.web as Record<string, unknown>).railwayRebind).toEqual({ previousServiceId: 'svc-0' });
  });

  it('never throws on malformed or missing bindings', () => {
    expect(parseHostingBindings(null)).toEqual({});
    expect(parseHostingBindings(undefined)).toEqual({});
    expect(parseHostingBindings({ platformBindings: {} })).toEqual({});
    // Wrong types return {} instead of throwing.
    expect(parseHostingBindings({ platformBindings: { provider: 42, services: 'nope' } as unknown as Record<string, unknown> })).toEqual({});
  });
});
