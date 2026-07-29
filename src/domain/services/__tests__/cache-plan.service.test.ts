import { describe, expect, it } from 'vitest';
import type { Component } from '../../entities/component.entity.js';
import type { LocalSnapshot } from '../../plan/plan.types.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { planCache } from '../cache-plan.service.js';

function spec(cache: { provider: string } | null = { provider: 'railway' }) {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    services: { web: {} },
    ...(cache ? { cache } : {}),
  });
}

function component(provider = 'railway'): Component {
  return {
    id: 'component-1',
    environmentId: 'environment-1',
    type: 'redis',
    bindings: { provider, connectionUrl: 'redis://example.invalid' },
    externalId: 'redis-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function local(components: Component[] = []): LocalSnapshot {
  return {
    projectExists: true,
    environmentExists: true,
    services: [],
    components,
  };
}

function observed(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    services: [],
    databases: [],
    caches: [],
    partial: false,
    warnings: [],
    ...overrides,
  };
}

describe('Redis cache plan contract', () => {
  it('plans a billable create and makes service wiring depend on it', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed(),
      local: local(),
    });
    expect(result.actions).toContainEqual(expect.objectContaining({
      id: 'cache:railway',
      type: 'create',
      billable: true,
      resource: { kind: 'cache', name: 'redis', provider: 'railway' },
    }));
    expect(result.serviceDependency).toBe('cache:railway');
  });

  it('plans a verified noop for a bound live cache', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'redis-1',
          status: 'running',
        }],
      }),
      local: local([component()]),
    });
    expect(result.actions).toEqual([
      expect.objectContaining({ id: 'cache:railway', type: 'noop', verified: true }),
    ]);
  });

  it('blocks creates when cache observation is unknown', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({ completeness: { caches: 'unknown' }, partial: true }),
      local: local(),
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        type: 'update',
        verified: false,
        metadata: expect.objectContaining({ blockedReason: 'cache_observation_unknown' }),
      }),
    ]);
  });

  it('blocks duplicate live identities instead of choosing the first', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [
          { provider: 'railway', engine: 'redis', externalId: 'redis-1', status: 'running' },
          { provider: 'railway', engine: 'redis', externalId: 'redis-2', status: 'running' },
        ],
      }),
      local: local(),
    });
    expect(result.actions[0]).toEqual(expect.objectContaining({
      type: 'update',
      metadata: expect.objectContaining({
        blockedReason: 'ambiguous_cache_identity',
        externalIds: ['redis-1', 'redis-2'],
      }),
    }));
  });

  it('resolves a durable bound id before treating same-name caches as candidates', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [
          { provider: 'railway', engine: 'redis', externalId: 'redis-1', status: 'running' },
          { provider: 'railway', engine: 'redis', externalId: 'redis-2', status: 'running' },
        ],
      }),
      local: local([component()]),
    });
    expect(result.actions[0]).toEqual(expect.objectContaining({
      id: 'cache:railway',
      type: 'noop',
    }));
    expect(result.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'cache',
      detail: expect.stringContaining('redis-2'),
    }));
  });

  it('unwires REDIS_URL before a confirm-gated destroy', () => {
    const result = planCache({
      environmentSpec: spec(null),
      observed: observed({
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'redis-1',
          status: 'running',
        }],
      }),
      local: local([component()]),
    });
    expect(result.actions.map((action) => action.id)).toEqual([
      'cache:redis:unwire:web',
      'cache:railway:destroy',
    ]);
    expect(result.actions[1]).toEqual(expect.objectContaining({
      type: 'destroy',
      dataBearing: true,
      requiresConfirm: true,
      dependsOn: ['cache:redis:unwire:web'],
    }));
  });

  it('keeps provider-confirmed already-absent deletion retryable through apply', () => {
    const result = planCache({
      environmentSpec: spec(null),
      observed: observed({ caches: [] }),
      local: local([component()]),
    });
    expect(result.actions.at(-1)).toEqual(expect.objectContaining({
      id: 'cache:railway:destroy',
      type: 'destroy',
      verified: true,
      requiresConfirm: true,
    }));
  });
});
