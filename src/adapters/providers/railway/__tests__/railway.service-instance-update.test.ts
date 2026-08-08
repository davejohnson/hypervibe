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

  it('disconnects a provider-native repo source via serviceDisconnect', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      serviceDisconnect: {
        id: 'svc-web',
      },
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.disconnectDeploySource({
      serviceId: 'svc-web',
    });

    expect(receipt).toMatchObject({
      success: true,
      data: { serviceId: 'svc-web' },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toContain('serviceDisconnect(id: $id)');
    expect(request.mock.calls[0]?.[1]).toEqual({
      id: 'svc-web',
    });
  });

  it('attaches a custom domain and returns Railway-required DNS records', async () => {
    const request = vi.fn()
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
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
                      verified: false,
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
    expect(request.mock.calls[2]?.[1]).toEqual({
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
      providerVerified: false,
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

  it('refreshes an existing unverified custom domain without deleting it', async () => {
    const pendingDomain = {
      id: 'cd_pending',
      domain: 'usebillforge.com',
      status: {
        verified: false,
        certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUING',
        dnsRecords: [{
          fqdn: 'usebillforge.com',
          hostlabel: '@',
          recordType: 'CNAME',
          requiredValue: 'web-production.up.railway.app',
          currentValue: 'web-production.up.railway.app',
          status: 'DNS_RECORD_STATUS_PROPAGATED',
          zone: 'usebillforge.com',
        }],
        verificationDnsHost: '_railway-verify.usebillforge.com',
        verificationToken: 'railway-verify=verify-token',
      },
    };
    const domainObservation = {
      service: {
        serviceInstances: {
          edges: [{
            node: {
              environmentId: 'env-prod',
              domains: { customDomains: [pendingDomain] },
            },
          }],
        },
      },
    };
    const request = vi.fn()
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      // getCustomDomainStatus before refresh
      .mockResolvedValueOnce(domainObservation)
      // customDomainUpdate
      .mockResolvedValueOnce({ customDomainUpdate: true })
      // getCustomDomainStatus after refresh
      .mockResolvedValueOnce(domainObservation);

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.attachCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt).toMatchObject({
      success: true,
      message: expect.stringContaining('refreshed pending verification'),
      data: {
        domain: 'usebillforge.com',
        customDomainId: 'cd_pending',
        created: false,
        refreshed: true,
        providerVerified: false,
        certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUING',
      },
    });
    expect(String(request.mock.calls[2]?.[0])).toContain('customDomainUpdate');
    expect(request.mock.calls[2]?.[1]).toEqual({
      id: 'cd_pending',
      environmentId: 'env-prod',
    });
    expect(request.mock.calls.some((call) => String(call[0]).includes('customDomainDelete'))).toBe(false);
  });

  it('does not refresh an existing verified custom domain', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: {
                  customDomains: [{
                    id: 'cd_verified',
                    domain: 'usebillforge.com',
                    status: { verified: true, certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUED' },
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

    expect(receipt).toMatchObject({
      success: true,
      data: { created: false, providerVerified: true },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('deletes and recreates only the selected Railway custom domain', async () => {
    const existingDomain = {
      id: 'cd_old',
      domain: 'usebillforge.com',
      status: { verified: false },
    };
    const request = vi.fn()
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: { serviceInstances: { edges: [{ node: { environmentId: 'env-prod' } }] } },
      })
      // getCustomDomainStatus before delete
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: { customDomains: [existingDomain] },
              },
            }],
          },
        },
      })
      // customDomainDelete
      .mockResolvedValueOnce({ customDomainDelete: true })
      // customDomainCreate
      .mockResolvedValueOnce({
        customDomainCreate: { id: 'cd_new', domain: 'usebillforge.com' },
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
                    id: 'cd_new',
                    domain: 'usebillforge.com',
                    status: {
                      verified: false,
                      certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUING',
                      dnsRecords: [{
                        fqdn: 'usebillforge.com',
                        recordType: 'CNAME',
                        requiredValue: 'new-target.up.railway.app',
                        status: 'DNS_RECORD_STATUS_PENDING',
                      }],
                      verificationDnsHost: '_railway-verify.usebillforge.com',
                      verificationToken: 'railway-verify=new-token',
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
    const receipt = await adapter.recreateCustomDomain({
      projectId: 'rail-project-1',
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    });

    expect(receipt).toMatchObject({
      success: true,
      data: {
        domain: 'usebillforge.com',
        previousCustomDomainId: 'cd_old',
        customDomainId: 'cd_new',
        recreated: true,
        providerVerified: false,
        dnsRecords: [
          expect.objectContaining({ type: 'CNAME', value: 'new-target.up.railway.app' }),
          expect.objectContaining({ type: 'TXT', value: 'railway-verify=new-token' }),
        ],
      },
    });
    expect(String(request.mock.calls[2]?.[0])).toContain('customDomainDelete');
    expect(request.mock.calls[2]?.[1]).toEqual({ id: 'cd_old' });
    expect(String(request.mock.calls[3]?.[0])).toContain('customDomainCreate');
    expect(request.mock.calls[3]?.[1]).toEqual({
      input: {
        projectId: 'rail-project-1',
        serviceId: 'svc-web',
        environmentId: 'env-prod',
        domain: 'usebillforge.com',
      },
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
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
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
    expect(request.mock.calls[5]?.[1]).toEqual({
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
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
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
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('creates an environment-scoped service when the bound service only exists in another environment', async () => {
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
      // resolveServiceIdForEnvironment: bound/name-matched service only exists in production.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
      })
      // serviceCreate creates a staging-scoped replacement for this environment binding.
      .mockResolvedValueOnce({
        serviceCreate: {
          id: 'svc-web-staging',
          name: 'web-staging',
        },
      })
      // ensureServiceInstanceForEnvironment verifies the new service has a staging instance.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-staging' } }],
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
      name: 'staging',
      platformBindings: {
        projectId: 'rail-project-1',
        environmentId: 'env-staging',
        services: { web: { serviceId: 'svc-web' } },
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
      },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.receipt.success).toBe(true);
    expect(result.externalId).toBe('svc-web-staging');
    expect(result.receipt.data).toMatchObject({
      createdService: true,
      replacedServiceBinding: 'svc-web',
    });
    expect(String(request.mock.calls[3]?.[0])).toContain('serviceCreate');
    expect(request.mock.calls[3]?.[1]).toEqual({
      input: {
        projectId: 'rail-project-1',
        environmentId: 'env-staging',
        name: 'web-staging',
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
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
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

  it('configures a CI-managed service without redeploying its previous image', async () => {
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
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-prod' } }],
          },
        },
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
        environmentId: 'env-prod',
        services: { web: { serviceId: 'svc-web' } },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service: Service = {
      id: 'svc-local',
      projectId: 'proj-local',
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.deploy(
      service,
      environment,
      {},
      { deferDeployment: true }
    );

    expect(result.status).toBe('configured');
    expect(result.receipt).toMatchObject({
      success: true,
      data: { deploymentDeferred: true },
    });
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceInstanceRedeploy'))).toBe(false);
  });
});
