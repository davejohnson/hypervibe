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

  it('stages variable updates without triggering a deployment when requested', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({ variableCollectionUpsert: true });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.setEnvVars(
      makeEnv({
        projectId: 'proj-railway',
        environmentId: 'env-staging',
        services: { web: { serviceId: 'svc-web' } },
      }),
      makeService('web'),
      { NEW_API_TOKEN: 'secret-value' },
      { deferDeployment: true }
    );

    expect(receipt.success).toBe(true);
    expect(receipt.data).toMatchObject({ deploymentDeferred: true });
    const upsertCall = request.mock.calls.at(-1)!;
    expect(String(upsertCall[0])).toContain('skipDeploys');
    expect(upsertCall[1]).toMatchObject({ skipDeploys: true });
  });

  it('deletes only explicitly named variables and never returns their values', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({ variableDelete: true })
      .mockResolvedValueOnce({ variableDelete: true });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    const receipt = await adapter.deleteEnvVars!(
      makeEnv({
        projectId: 'proj-railway',
        environmentId: 'env-staging',
        services: { web: { serviceId: 'svc-web' } },
      }),
      makeService('web'),
      ['OLD_API_TOKEN', 'LEGACY_FEATURE_FLAG', 'OLD_API_TOKEN']
    );

    expect(receipt).toMatchObject({
      success: true,
      data: {
        deletedKeys: ['LEGACY_FEATURE_FLAG', 'OLD_API_TOKEN'],
        variableCount: 2,
        redeployMayBeTriggered: true,
      },
    });
    const deleteCalls = request.mock.calls.filter(([query]) => String(query).includes('variableDelete'));
    expect(deleteCalls.map(([, variables]) => variables)).toEqual([
      {
        input: {
          projectId: 'proj-railway',
          serviceId: 'svc-web',
          environmentId: 'env-staging',
          name: 'LEGACY_FEATURE_FLAG',
        },
      },
      {
        input: {
          projectId: 'proj-railway',
          serviceId: 'svc-web',
          environmentId: 'env-staging',
          name: 'OLD_API_TOKEN',
        },
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain('secret-value');
  });
});
