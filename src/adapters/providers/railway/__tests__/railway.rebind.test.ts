import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

function makeEnv(bindings: Record<string, unknown>): Environment {
  return {
    id: 'env-local',
    projectId: 'proj-local',
    name: 'staging',
    platformBindings: bindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeService(name: string): Service {
  return {
    id: `svc-${name}`,
    projectId: 'proj-local',
    name,
    buildConfig: {},
    envVarSpec: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RailwayAdapter stale binding recovery', () => {
  it('re-resolves stale service binding by name before variableCollectionUpsert', async () => {
    const request = vi.fn()
      // listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-new', name: 'staging' } }],
          },
        },
      })
      // listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-new', name: 'web' } }],
          },
        },
      })
      // resolveServiceIdForEnvironment verifies the candidate.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-new' } }],
          },
        },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-new' } }],
          },
        },
      })
      // variableCollectionUpsert
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const env = makeEnv({
      projectId: 'proj-railway',
      environmentId: 'env-stale',
      services: {
        web: { serviceId: 'svc-stale' },
      },
    });

    const receipt = await adapter.setEnvVars(env, makeService('web'), { DATABASE_URL: 'postgres://x' });

    expect(receipt.success).toBe(true);
    const upsertCall = request.mock.calls.find(([, vars]) => {
      const payload = vars as Record<string, unknown> | undefined;
      return Boolean(payload?.projectId && payload?.serviceId && payload?.environmentId && payload?.variables);
    });
    expect(upsertCall).toBeDefined();
    const upsertVars = upsertCall?.[1] as Record<string, unknown>;
    expect(upsertVars.serviceId).toBe('svc-new');
    expect(upsertVars.environmentId).toBe('env-new');
  });

  it('marks a bound project-level service as stale when it has no instance in the target environment', async () => {
    const request = vi.fn()
      // listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-staging', name: 'staging' } }],
          },
        },
      })
      // listProjectServices includes the bound service, but it is not usable in staging.
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-prod-web', name: 'web' } }],
          },
        },
      })
      // resolveServiceIdForEnvironment rejects the production-only service.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-production' } }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const env = makeEnv({
      projectId: 'proj-railway',
      environmentId: 'env-staging',
      services: {
        web: { serviceId: 'svc-prod-web' },
      },
    });

    const receipt = await adapter.setEnvVars(env, makeService('web'), { DATABASE_URL: 'postgres://x' });

    expect(receipt.success).toBe(false);
    expect(receipt.message).toContain('not found in Railway environment staging');
    expect(receipt.data).toMatchObject({
      staleBinding: true,
      ignoredBoundServiceId: 'svc-prod-web',
      environmentId: 'env-staging',
    });
    expect(request).toHaveBeenCalledTimes(3);
  });
});
