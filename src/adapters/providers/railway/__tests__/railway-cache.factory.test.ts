import { describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { createRailwayCacheAdapter } from '../railway-cache.factory.js';

function environment(platformBindings: Record<string, unknown> = { projectId: 'rail-project-1' }): Environment {
  return {
    id: 'environment-1',
    projectId: 'project-1',
    name: 'staging',
    platformBindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Railway cache adapter', () => {
  it('requires an existing reviewed project binding', async () => {
    const ensureComponent = vi.fn();
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { ensureComponent } as never,
      envRepo: { findById: vi.fn() } as never,
    });

    const result = await adapter.provision('redis', environment({}));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.data).toMatchObject({ phase: 'requireProjectBinding' });
    expect(ensureComponent).not.toHaveBeenCalled();
  });

  it('provisions Redis and exposes only the provider reference URL', async () => {
    const ensureComponent = vi.fn(async () => ({
      component: {
        id: '',
        environmentId: 'environment-1',
        type: 'redis',
        bindings: { pluginName: 'redis-db', resourceKind: 'service' },
        externalId: 'redis-service-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      receipt: { success: true, message: 'created' },
    }));
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { ensureComponent } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });

    const result = await adapter.provision('redis', environment());

    expect(result.receipt.success).toBe(true);
    expect(result.connectionUrl).toBe('${{redis-db.REDIS_URL}}');
    expect(result.envVars).toEqual({ REDIS_URL: '${{redis-db.REDIS_URL}}' });
    expect(result.component.bindings).toMatchObject({
      provider: 'railway',
      projectId: 'rail-project-1',
    });
  });

  it('preserves a volume when service deletion is not provider-confirmed', async () => {
    const deleteService = vi.fn(async () => ({
      success: false,
      error: 'service absence is unknown',
    }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { deleteService, deleteVolume } as never,
      envRepo: {} as never,
    });
    const component: Component = {
      id: 'component-1',
      environmentId: 'environment-1',
      type: 'redis',
      externalId: 'redis-service-1',
      bindings: { provider: 'railway', volumeId: 'redis-volume-1' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.message).toContain('persistent volume was preserved');
    expect(deleteVolume).not.toHaveBeenCalled();
  });
});
