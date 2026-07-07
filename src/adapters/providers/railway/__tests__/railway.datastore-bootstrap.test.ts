import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
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

describe('RailwayAdapter datastore bootstrap vars', () => {
  it('sets bootstrap vars, attaches a volume, and redeploys after datastore creation', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-1', name: 'staging' } }],
          },
        },
      })
      // resolveServiceIdForProject -> listProjectServices (none exists yet)
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [],
          },
        },
      })
      // serviceCreate
      .mockResolvedValueOnce({
        serviceCreate: { id: 'rail-svc-db-1', name: 'postgres-db' },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      })
      // variableCollectionUpsert
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      })
      // volumeCreate
      .mockResolvedValueOnce({
        volumeCreate: { id: 'vol-1' },
      })
      // serviceInstanceRedeploy
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1' }));

    expect(result.receipt.success).toBe(true);
    expect(result.component.bindings).toMatchObject({ volumeId: 'vol-1' });
    const upsertVars = request.mock.calls[4]?.[1]?.variables as Record<string, string>;
    expect(upsertVars).toBeDefined();
    expect(typeof upsertVars.POSTGRES_PASSWORD).toBe('string');
    expect(upsertVars.POSTGRES_PASSWORD.length).toBeGreaterThan(0);
    expect(upsertVars.POSTGRES_USER).toBe('postgres');
    expect(upsertVars.POSTGRES_DB).toBe('postgres');
    // PGDATA must be a subdirectory of the mount (lost+found breaks initdb).
    expect(upsertVars.PGDATA).toBe('/var/lib/postgresql/data/pgdata');
    expect(typeof upsertVars.DATABASE_URL).toBe('string');

    // Volume attached at the postgres data dir.
    expect(request.mock.calls[5]?.[1]).toEqual({
      input: {
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-1',
        serviceId: 'rail-svc-db-1',
        mountPath: '/var/lib/postgresql/data',
      },
    });

    // Redeploy so the container boots with vars + volume (serviceCreate with
    // source.image already started a first deployment without them).
    expect(request.mock.calls[6]?.[1]).toEqual({
      serviceId: 'rail-svc-db-1',
      environmentId: 'rail-env-1',
    });
  });

  it('fails the provision when the volume cannot be attached', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({
        project: { services: { edges: [] } },
      })
      .mockResolvedValueOnce({
        serviceCreate: { id: 'rail-svc-db-1', name: 'postgres-db' },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      })
      .mockRejectedValueOnce(new Error('volume quota exceeded'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1' }));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.message).toContain('failed to attach a volume');
  });

  it('reuses an existing healthy postgres-db service without modifying it', async () => {
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
            edges: [{ node: { id: 'rail-svc-db-existing', name: 'postgres-db' } }],
          },
        },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      })
      // fetchServiceVariables — bootstrap vars are present
      .mockResolvedValueOnce({
        variables: { POSTGRES_PASSWORD: 'already-set', DATABASE_URL: 'postgres://...' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1' }));

    expect(result.receipt.success).toBe(true);
    expect(result.receipt.message).toContain('Using existing postgres datastore service');
    expect(result.receipt.message).not.toContain('repaired');
    expect(result.component.externalId).toBe('rail-svc-db-existing');
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('repairs a reused datastore service that is missing its bootstrap vars', async () => {
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
            edges: [{ node: { id: 'rail-svc-db-existing', name: 'postgres-db' } }],
          },
        },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      })
      // fetchServiceVariables — POSTGRES_PASSWORD missing (crashlooping container)
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

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1' }));

    expect(result.receipt.success).toBe(true);
    expect(result.receipt.message).toContain('repaired missing bootstrap variables');
    expect(result.receipt.data).toMatchObject({ repaired: true, reused: true });

    const repairVars = request.mock.calls[4]?.[1]?.variables as Record<string, string>;
    expect(typeof repairVars.POSTGRES_PASSWORD).toBe('string');
    expect(repairVars.POSTGRES_PASSWORD.length).toBeGreaterThan(0);

    expect(request.mock.calls[5]?.[1]).toEqual({
      serviceId: 'rail-svc-db-existing',
      environmentId: 'rail-env-1',
    });
  });

  it('creates an environment-scoped datastore when the matching service only exists elsewhere', async () => {
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
            edges: [{ node: { id: 'rail-svc-db-existing', name: 'postgres-db' } }],
          },
        },
      })
      // resolveServiceIdForEnvironment sees the matching service only in production.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-prod' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        serviceCreate: {
          id: 'rail-svc-db-staging',
          name: 'postgres-db-staging',
        },
      })
      // ensureServiceInstanceForEnvironment verifies the newly created service.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      })
      .mockResolvedValueOnce({
        volumeCreate: { id: 'vol-staging' },
      })
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1' }));

    expect(result.receipt.success).toBe(true);
    expect(result.receipt.message).toContain('Created postgres datastore');
    expect(result.component.externalId).toBe('rail-svc-db-staging');
    expect(result.component.bindings).toMatchObject({ volumeId: 'vol-staging' });
    expect(String(request.mock.calls[3]?.[0])).toContain('serviceCreate');
    expect(request.mock.calls[3]?.[1]).toEqual({
      input: {
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-staging',
        name: 'postgres-db-staging',
        source: {
          image: 'postgres:16',
        },
      },
    });
  });

  it('reuses an existing environment-scoped datastore after local bindings are missing', async () => {
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
              { node: { id: 'rail-svc-db-prod', name: 'postgres-db' } },
              { node: { id: 'rail-svc-db-staging', name: 'postgres-db-staging' } },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-prod' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        variables: { POSTGRES_PASSWORD: 'already-set', DATABASE_URL: 'postgres://...' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1' }));

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe('rail-svc-db-staging');
    expect(result.component.bindings).toMatchObject({
      resourceKind: 'service',
      pluginName: 'postgres-db-staging',
    });
    expect(String(request.mock.calls[4]?.[0])).not.toContain('serviceCreate');
  });
});
