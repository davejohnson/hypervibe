import { describe, expect, it, vi } from 'vitest';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import type { Component } from '../../../../domain/entities/component.entity.js';

describe('Railway database adapter cleanup', () => {
  it('deletes service-backed database volumes with the service', async () => {
    const deleteService = vi.fn(async () => ({ success: true }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const hostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {},
      verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => {
        throw new Error('not used');
      },
      deploy: async () => {
        throw new Error('not used');
      },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      getDeployStatus: async () => ({ status: 'deployed' }),
      deleteService,
      deleteVolume,
    };
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: hostingAdapter as unknown as Parameters<typeof createRailwayDatabaseAdapter>[0]['hostingAdapter'],
      envRepo: {} as never,
    });

    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      bindings: {
        provider: 'railway',
        resourceKind: 'service',
        volumeId: 'vol-1',
      },
      externalId: 'svc-db-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(deleteService).toHaveBeenCalledWith('svc-db-1');
    expect(deleteVolume).toHaveBeenCalledWith('vol-1');
  });

  it('preserves the volume when database service deletion is not confirmed', async () => {
    const deleteService = vi.fn(async () => ({
      success: false,
      error: 'service absence is unknown',
    }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const hostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: [],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: false,
      },
      deleteService,
      deleteVolume,
    };
    const envRepo = {
      findById: vi.fn(),
    };
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: hostingAdapter as never,
      envRepo: envRepo as never,
    });
    const component = {
      id: 'component-1',
      environmentId: 'environment-1',
      type: 'postgres',
      externalId: 'svc-db-1',
      bindings: {
        provider: 'railway',
        resourceKind: 'service',
        volumeId: 'vol-db-1',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.message).toContain('persistent volume was preserved');
    expect(deleteService).toHaveBeenCalledWith('svc-db-1');
    expect(deleteVolume).not.toHaveBeenCalled();
  });
});
