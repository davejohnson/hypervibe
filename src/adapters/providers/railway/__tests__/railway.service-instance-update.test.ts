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

  it('maps releaseCommand to Railway preDeployCommand as a single-element list', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      serviceInstanceUpdate: true,
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.updateServiceInstanceConfig({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      startCommand: 'npm start',
      releaseCommand: 'npx prisma migrate deploy',
    });

    expect(receipt.success).toBe(true);
    expect(request.mock.calls[0]?.[1]).toEqual({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      input: {
        startCommand: 'npm start',
        preDeployCommand: ['npx prisma migrate deploy'],
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

  it('attaches a custom domain and returns Railway-required DNS records', async () => {
    const request = vi.fn()
      // getCustomDomainStatus before create
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: {
                  customDomains: [],
                },
              },
            }],
          },
        },
      })
      // customDomainCreate
      .mockResolvedValueOnce({
        customDomainCreate: {
          id: 'cd_123',
          domain: 'usebillforge.com',
        },
      })
      // getCustomDomainStatus after create
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: {
                  customDomains: [{
                    id: 'cd_123',
                    domain: 'usebillforge.com',
                    status: {
                      dnsRecords: [{
                        fqdn: 'usebillforge.com',
                        hostlabel: '@',
                        recordType: 'CNAME',
                        requiredValue: 'web-production.up.railway.app',
                        status: 'DNS_RECORD_STATUS_PENDING',
                        zone: 'usebillforge.com',
                      }],
                      verificationDnsHost: '_railway.usebillforge.com',
                      verificationToken: 'verify-token',
                    },
                  }],
                },
              },
            }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.attachCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt.success).toBe(true);
    expect(request.mock.calls[1]?.[1]).toEqual({
      input: {
        projectId: 'rail-project-1',
        serviceId: 'svc-web',
        environmentId: 'env-prod',
        domain: 'usebillforge.com',
      },
    });
    expect(receipt.data).toMatchObject({
      domain: 'usebillforge.com',
      customDomainId: 'cd_123',
      created: true,
      dnsRecords: [
        {
          name: 'usebillforge.com',
          type: 'CNAME',
          value: 'web-production.up.railway.app',
        },
        {
          name: '_railway.usebillforge.com',
          type: 'TXT',
          value: 'verify-token',
        },
      ],
    });
  });

  it('does not call Railway customDomainCreate without a projectId binding', async () => {
    const request = vi.fn();
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.attachCustomDomain({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('requires the Railway projectId');
    expect(request).not.toHaveBeenCalled();
  });

  it('creates a Railway service domain for public services and returns the url', async () => {
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
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      // redeploy
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      })
      // ensureServiceDomain: query existing domains (none)
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: { serviceDomains: [] },
              },
            }],
          },
        },
      })
      // ensureServiceDomain: serviceDomainCreate
      .mockResolvedValueOnce({
        serviceDomainCreate: { domain: 'web-production.up.railway.app' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    vi.spyOn(adapter, 'getPluginVariableReferences').mockResolvedValue({});

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'production',
      platformBindings: {
        projectId: 'rail-project-1',
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
        public: true,
      },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.receipt.success).toBe(true);
    expect(result.url).toBe('https://web-production.up.railway.app');
    // serviceDomainCreate received the right input
    expect(request.mock.calls[4]?.[1]).toEqual({
      input: { serviceId: 'svc-web', environmentId: 'env-prod' },
    });
  });

  it('does not create a service domain for non-public services', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-prod', name: 'production' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-worker', name: 'worker' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    vi.spyOn(adapter, 'getPluginVariableReferences').mockResolvedValue({});

    const environment: Environment = {
      id: 'env-local',
      projectId: 'proj-local',
      name: 'production',
      platformBindings: {
        projectId: 'rail-project-1',
        services: {},
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'worker',
      buildConfig: {
        builder: 'nixpacks',
      },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.receipt.success).toBe(true);
    expect(result.url).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
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
