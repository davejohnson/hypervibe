import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

describe('RailwayAdapter service instance updates', () => {
  it('passes serviceId and environmentId as top-level mutation variables', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      serviceInstanceUpdate: true,
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.updateServiceInstanceConfig({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      startCommand: 'npm start',
      healthcheckPath: '/health',
      cronSchedule: '0 * * * *',
    });

    expect(receipt.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      input: {
        startCommand: 'npm start',
        healthcheckPath: '/health',
        cronSchedule: '0 * * * *',
      },
    });
  });

  it('connects a service to a GitHub repo and branch via serviceConnect', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      serviceConnect: {
        id: 'svc-web',
      },
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.connectServiceToRepo({
      serviceId: 'svc-web',
      repo: 'davejohnson/billforge',
      branch: 'main',
    });

    expect(receipt.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual({
      id: 'svc-web',
      input: {
        repo: 'davejohnson/billforge',
        branch: 'main',
      },
    });
  });

  it('applies runtime config before redeploying a service', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironmentIds
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-prod', name: 'production' } }],
          },
        },
      })
      // resolveServiceIdForProject -> listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [],
          },
        },
      })
      // serviceCreate
      .mockResolvedValueOnce({
        serviceCreate: {
          id: 'svc-web',
          name: 'web',
        },
      })
      // redeploy
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const updateServiceInstanceConfig = vi
      .spyOn(adapter, 'updateServiceInstanceConfig')
      .mockResolvedValue({ success: true, message: 'configured' });
    const setEnvVars = vi
      .spyOn(adapter, 'setEnvVars')
      .mockResolvedValue({ success: true, message: 'vars synced' });
    vi.spyOn(adapter, 'getPluginVariableReferences').mockResolvedValue({});

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'production',
      platformBindings: {
        projectId: 'rail-project-1',
        railwayProjectId: 'rail-project-1',
        services: {},
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'web',
      buildConfig: {
        builder: 'nixpacks',
        startCommand: 'npm start',
        healthCheckPath: '/health',
      },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, { DATABASE_URL: 'postgres://db' });

    expect(result.receipt.success).toBe(true);
    expect(updateServiceInstanceConfig).toHaveBeenCalledWith({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      startCommand: 'npm start',
      healthcheckPath: '/health',
      cronSchedule: undefined,
    });
    expect(setEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({
        platformBindings: expect.objectContaining({
          services: {
            web: { serviceId: 'svc-web' },
          },
        }),
      }),
      service,
      { DATABASE_URL: 'postgres://db' }
    );
  });
});
