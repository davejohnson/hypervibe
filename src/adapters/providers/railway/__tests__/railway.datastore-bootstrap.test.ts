import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import { serviceInstanceInventory } from './service-instance-inventory.fixture.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function makeEnv(bindings: Record<string, unknown>): Environment {
  return {
    id: 'env-1',
    projectId: 'proj-1',
    name: 'staging',
    platformBindings: bindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function serviceEnvironmentInstance(serviceId: string, environmentId: string) {
  return {
    serviceInstance: {
      id: `instance-${serviceId}-${environmentId}`,
      serviceId,
      environmentId,
      deletedAt: null,
    },
  };
}

function volumeInventory(
  environmentId: string,
  volumes: Array<{
    instanceId: string;
    volumeId: string;
    serviceId: string | null;
    mountPath: string;
    projectId?: string;
    deletedAt?: string | null;
    isPendingDeletion?: boolean;
  }> = [],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  }
) {
  return {
    environment: {
      id: environmentId,
      volumeInstances: {
        edges: volumes.map((volume) => ({
          node: {
            id: volume.instanceId,
            serviceId: volume.serviceId,
            environmentId,
            mountPath: volume.mountPath,
            deletedAt: volume.deletedAt ?? null,
            isPendingDeletion: volume.isPendingDeletion ?? false,
            volume: {
              id: volume.volumeId,
              projectId: volume.projectId ?? 'rail-proj-1',
            },
          },
        })),
        pageInfo,
      },
    },
  };
}

describe('RailwayAdapter Redis service bootstrap', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails the provision when the volume cannot be attached', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({
        project: { services: { edges: [] } },
      })
      .mockResolvedValueOnce({
        serviceCreate: { id: 'rail-svc-db-1', name: 'redis-db' },
      })
      .mockResolvedValueOnce(serviceEnvironmentInstance('rail-svc-db-1', 'rail-env-1'))
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      })
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      .mockRejectedValueOnce(new Error('volume quota exceeded'))
      .mockResolvedValueOnce(volumeInventory('rail-env-1'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('redis', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' }));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.message).toContain('failed to attach a volume');
    expect(result.component).toMatchObject({
      externalId: 'rail-svc-db-1',
      bindings: {
        provider: 'railway',
        providerScope: { projectId: 'rail-proj-1' },
        resourceKind: 'service',
        pluginName: 'redis-db',
        volumeTarget: {
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          serviceId: 'rail-svc-db-1',
          mountPath: '/bitnami/redis/data',
        },
      },
    });
    expect(request.mock.calls.filter(([query]) => String(query).includes('volumeCreate'))).toHaveLength(1);
  });

  it('recovers one exact volume after a lost create response without retrying the mutation', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: 'rail-svc-db-1', name: 'redis-db' } })
      .mockResolvedValueOnce(serviceEnvironmentInstance('rail-svc-db-1', 'rail-env-1'))
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      .mockRejectedValueOnce(new Error('connection closed after volume request'))
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'volume-instance-recovered',
        volumeId: 'volume-recovered',
        serviceId: 'rail-svc-db-1',
        mountPath: '/bitnami/redis/data',
      }]))
      .mockResolvedValueOnce({ serviceInstanceRedeploy: true });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(true);
    expect(result.component.bindings).toMatchObject({
      volumeId: 'volume-recovered',
      volumeTarget: {
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-1',
        serviceId: 'rail-svc-db-1',
        mountPath: '/bitnami/redis/data',
      },
    });
    expect(request.mock.calls.filter(([query]) => String(query).includes('volumeCreate'))).toHaveLength(1);
  });

  it('fails closed when a valid volume acknowledgement resolves to a different exact volume', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: 'rail-svc-db-1', name: 'redis-db' } })
      .mockResolvedValueOnce(serviceEnvironmentInstance('rail-svc-db-1', 'rail-env-1'))
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      .mockResolvedValueOnce({ volumeCreate: { id: 'acknowledged-volume' } })
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'different-volume-instance',
        volumeId: 'different-volume',
        serviceId: 'rail-svc-db-1',
        mountPath: '/bitnami/redis/data',
      }]));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('acknowledged-volume');
    expect(result.component.bindings).toMatchObject({
      volumeId: 'different-volume',
      volumeTarget: { serviceId: 'rail-svc-db-1', mountPath: '/bitnami/redis/data' },
    });
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceInstanceRedeploy'))).toBe(false);
  });

  it('fully paginates the volume inventory before creating exactly one volume', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: 'rail-svc-db-1', name: 'redis-db' } })
      .mockResolvedValueOnce(serviceEnvironmentInstance('rail-svc-db-1', 'rail-env-1'))
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'unrelated-instance',
        volumeId: 'unrelated-volume',
        serviceId: 'another-service',
        mountPath: '/data',
      }], { hasNextPage: true, endCursor: 'cursor-1' }))
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      .mockResolvedValueOnce({ volumeCreate: { id: 'new-volume' } })
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'new-volume-instance',
        volumeId: 'new-volume',
        serviceId: 'rail-svc-db-1',
        mountPath: '/bitnami/redis/data',
      }]))
      .mockResolvedValueOnce({ serviceInstanceRedeploy: true });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(true);
    const volumeReads = request.mock.calls.filter(([query]) => String(query).includes('EnvironmentVolumeInstances'));
    expect(volumeReads).toHaveLength(3);
    expect(volumeReads[0]?.[1]).toMatchObject({ after: null });
    expect(volumeReads[1]?.[1]).toMatchObject({ after: 'cursor-1' });
    expect(request.mock.calls.filter(([query]) => String(query).includes('volumeCreate'))).toHaveLength(1);
  });

  it('ignores a detached volume with Railway\'s nullable service id', async () => {
    const request = vi.fn().mockResolvedValueOnce(volumeInventory('rail-env-1', [{
      instanceId: 'detached-instance',
      volumeId: 'detached-volume',
      serviceId: null,
      mountPath: '/data',
    }]));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.resolveServiceVolume({
      projectId: 'rail-proj-1',
      environmentId: 'rail-env-1',
      serviceId: 'rail-svc-db-1',
      mountPath: '/bitnami/redis/data',
    })).resolves.toEqual({ success: true, state: 'absent' });
  });

  it('does not mistake a detached recorded volume for the expected attachment', async () => {
    const request = vi.fn().mockResolvedValueOnce(volumeInventory('rail-env-1', [{
      instanceId: 'detached-instance',
      volumeId: 'detached-volume',
      serviceId: null,
      mountPath: '/data',
    }]));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.resolveServiceVolume({
      projectId: 'rail-proj-1',
      environmentId: 'rail-env-1',
      serviceId: 'rail-svc-db-1',
      mountPath: '/bitnami/redis/data',
    }, 'detached-volume');

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('<detached>') });
  });

  it('still rejects a volume response that omits service ownership', async () => {
    const response = volumeInventory('rail-env-1', [{
      instanceId: 'partial-instance',
      volumeId: 'partial-volume',
      serviceId: null,
      mountPath: '/data',
    }]);
    delete (response.environment.volumeInstances.edges[0]!.node as { serviceId?: string | null }).serviceId;
    const request = vi.fn().mockResolvedValueOnce(response);
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.resolveServiceVolume({
      projectId: 'rail-proj-1',
      environmentId: 'rail-env-1',
      serviceId: 'rail-svc-db-1',
      mountPath: '/bitnami/redis/data',
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('partial volume identity') });
  });

  it('does not create a volume when the exact target is already ambiguous', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: 'rail-svc-db-1', name: 'redis-db' } })
      .mockResolvedValueOnce(serviceEnvironmentInstance('rail-svc-db-1', 'rail-env-1'))
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'volume-instance-a',
        volumeId: 'volume-a',
        serviceId: 'rail-svc-db-1',
        mountPath: '/bitnami/redis/data',
      }, {
        instanceId: 'volume-instance-b',
        volumeId: 'volume-b',
        serviceId: 'rail-svc-db-1',
        mountPath: '/bitnami/redis/data',
      }]));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('Multiple active Railway volumes');
    expect(request.mock.calls.filter(([query]) => String(query).includes('volumeCreate'))).toHaveLength(0);
  });

  it('retains a scoped unresolved marker when a transport failure cannot recover the service id', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockRejectedValueOnce(new Error('socket closed after request transmission'))
      .mockResolvedValueOnce({ project: { services: { edges: [] } } });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'railway',
        providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        unresolvedMutation: {
          resourceKind: 'cache',
          operation: 'create',
          resourceName: 'redis-db',
          providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        },
      },
    });
  });

  it('does not recover a same-name Redis service from a different Railway environment', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockRejectedValueOnce(new Error('socket closed after request transmission'))
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'redis-in-production', name: 'redis-db' } }],
          },
        },
      })
      .mockResolvedValueOnce(serviceInstanceInventory('rail-proj-1', 'redis-in-production', ['rail-env-production']));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'railway',
        providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        unresolvedMutation: {
          resourceKind: 'cache',
          resourceName: 'redis-db',
          providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        },
      },
    });
    expect(result.receipt.data).not.toHaveProperty('recoveredServiceId');
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('does not retain an unresolved marker for a definitive service-create HTTP 4xx', async () => {
    const definitiveError = Object.assign(new Error('invalid service input'), {
      response: { status: 400, errors: [] },
    });
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockRejectedValueOnce(definitiveError);

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.data).toMatchObject({ resourceCreated: false });
    expect(result.component.externalId).toBeNull();
    expect(result.component.bindings).toEqual({});
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('recovers an exact service identity from a malformed create id and stops before follow-up mutations', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: '', name: 'redis-db' } })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'rail-svc-db-recovered', name: 'redis-db' } }],
          },
        },
      })
      .mockResolvedValueOnce(serviceInstanceInventory('rail-proj-1', 'rail-svc-db-recovered', ['rail-env-1']))
      .mockResolvedValueOnce(serviceEnvironmentInstance('rail-svc-db-recovered', 'rail-env-1'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('stopped before');
    expect(result.component).toMatchObject({
      externalId: 'rail-svc-db-recovered',
      bindings: {
        pluginName: 'redis-db',
        resourceKind: 'service',
      },
    });
    expect(request).toHaveBeenCalledTimes(6);
    expect(request.mock.calls.some(([query]) => (
      String(query).includes('serviceInstanceRedeploy')
      || String(query).includes('variableCollectionUpsert')
      || String(query).includes('volumeCreate')
    ))).toBe(false);
  });

  it('retains a valid wrong-name service id but never mutates that service', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({
        serviceCreate: { id: 'rail-svc-unexpected', name: 'unrelated-service' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('unrelated-service');
    expect(result.component).toMatchObject({
      externalId: 'rail-svc-unexpected',
      bindings: { pluginName: 'unrelated-service', resourceKind: 'service' },
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('blocks an existing unbound Redis service without modifying it', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-1', name: 'staging' } }],
          },
        },
      })
      // resolveServiceIdForProject -> listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'rail-svc-db-existing', name: 'redis-db' } }],
          },
        },
      })
      .mockResolvedValueOnce(serviceInstanceInventory('rail-proj-1', 'rail-svc-db-existing', ['rail-env-1']))
      // Exact target instance verification
      .mockResolvedValueOnce(serviceEnvironmentInstance('rail-svc-db-existing', 'rail-env-1'))
      // fetchServiceVariables — bootstrap vars are present
      .mockResolvedValueOnce({
        variables: { REDIS_PASSWORD: 'already-set', REDIS_URL: 'redis://...' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('redis', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' }));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('hv_import');
    expect(result.receipt.data).toMatchObject({ adoptionCandidateServiceId: 'rail-svc-db-existing' });
    expect(result.component.externalId).toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.some(([query]) => String(query).includes('variableCollectionUpsert'))).toBe(false);
  });

  it('does not repair an unbound datastore from create authority', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-1', name: 'staging' } }],
          },
        },
      })
      // resolveServiceIdForProject -> listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'rail-svc-db-existing', name: 'redis-db' } }],
          },
        },
      })
      .mockResolvedValueOnce(serviceInstanceInventory('rail-proj-1', 'rail-svc-db-existing', ['rail-env-1']))
      // Exact target instance verification
      .mockResolvedValueOnce(serviceEnvironmentInstance('rail-svc-db-existing', 'rail-env-1'))
      // fetchServiceVariables — REDIS_PASSWORD missing (crashlooping container)
      .mockResolvedValueOnce({
        variables: {},
      })
      // variableCollectionUpsert (repair)
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      })
      // serviceInstanceRedeploy
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('redis', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' }));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('will not mutate or adopt');
    expect(result.component.externalId).toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.some(([query]) => (
      String(query).includes('variableCollectionUpsert')
      || String(query).includes('serviceInstanceRedeploy')
    ))).toBe(false);
  });

  it.each(['redis-db', 'redis-db-staging'])('requires explicit adoption for scoped datastore %s after local bindings are missing', async (name) => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [
              { node: { id: 'rail-svc-db-prod', name: 'redis-db' } },
              { node: { id: 'rail-svc-db-staging', name } },
            ],
          },
        },
      })
      .mockResolvedValueOnce(serviceInstanceInventory('rail-proj-1', 'rail-svc-db-prod', ['rail-env-production']))
      .mockResolvedValueOnce(serviceInstanceInventory('rail-proj-1', 'rail-svc-db-staging', ['rail-env-staging']))
      .mockResolvedValueOnce(serviceEnvironmentInstance('rail-svc-db-staging', 'rail-env-staging'))
      .mockResolvedValueOnce({
        variables: { REDIS_PASSWORD: 'already-set', REDIS_URL: 'redis://...' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('redis', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-staging' }));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.data).toMatchObject({ adoptionCandidateServiceId: 'rail-svc-db-staging' });
    expect(result.component.externalId).toBeNull();
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceCreate'))).toBe(false);
  });
});
