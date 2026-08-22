import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { RailwayAdapter } from '../railway.adapter.js';

function makeEnvironment(environmentId = 'env-production'): Environment {
  return {
    id: 'local-production',
    projectId: 'local-project',
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'railway-project',
      environmentId,
      services: { web: { serviceId: 'service-web' } },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RailwayAdapter getDeployStatus', () => {
  it('reports why deployment observation is unavailable before connection', async () => {
    const result = await new RailwayAdapter().getDeployStatus(
      makeEnvironment(),
      'service-web'
    );

    expect(result).toEqual({
      status: 'unknown',
      reason: 'Railway deployment observation requires a verified connection.',
    });
  });

  it('selects the service instance matching the bound Railway environment', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('deployment not found'))
      .mockResolvedValueOnce({
        service: {
          id: 'service-web',
          serviceInstances: {
            edges: [
              {
                node: {
                  environmentId: 'env-staging',
                  latestDeployment: {
                    id: 'deploy-staging',
                    status: 'SUCCESS',
                    staticUrl: 'https://staging.example.com',
                  },
                },
              },
              {
                node: {
                  environmentId: 'env-production',
                  latestDeployment: {
                    id: 'deploy-production',
                    status: 'SUCCESS',
                    staticUrl: 'https://production.example.com',
                  },
                },
              },
            ],
          },
        },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.getDeployStatus(makeEnvironment(), 'service-web');

    expect(result).toEqual({
      status: 'deployed',
      url: 'https://production.example.com',
    });
    expect(String(request.mock.calls[1]?.[0])).toContain('environmentId');
  });

  it('preserves provider failures when neither Railway service query can be observed', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('deployment lookup denied'))
      .mockRejectedValueOnce(new Error('connection query permission denied'))
      .mockRejectedValueOnce(new Error('direct query permission denied'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.getDeployStatus(makeEnvironment(), 'service-web');

    expect(result).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('permission denied'),
    });
    expect(result.reason).toContain('service-web');
    expect(result.reason).toContain('env-production');
  });

  it('reports an unknown result when the service has no instance in the bound environment', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('deployment not found'))
      .mockResolvedValueOnce({
        service: {
          id: 'service-web',
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-staging',
                latestDeployment: { status: 'SUCCESS' },
              },
            }],
          },
        },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.getDeployStatus(makeEnvironment(), 'service-web');

    expect(result).toEqual({
      status: 'unknown',
      reason: 'Railway service service-web has no instance in bound environment env-production.',
    });
  });
});
