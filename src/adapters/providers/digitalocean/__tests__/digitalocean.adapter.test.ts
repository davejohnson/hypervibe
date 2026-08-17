import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import { DigitalOceanAdapter } from '../digitalocean.adapter.js';

function makeEnvironment(
  platformBindings: Record<string, unknown> = {},
  name = 'production'
): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name,
    platformBindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeService(overrides: Partial<Service> = {}): Service {
  return {
    id: 'service-1',
    projectId: 'project-1',
    name: 'web',
    buildConfig: {
      workloadKind: 'web',
      startCommand: 'npm start',
      healthCheckPath: '/health',
      public: true,
    },
    envVarSpec: {
      required: ['NODE_ENV'],
      optional: [],
      secrets: ['SESSION_SECRET'],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function connectedAdapter(
  overrides: Record<string, unknown> = {}
): Promise<DigitalOceanAdapter> {
  const adapter = new DigitalOceanAdapter();
  await adapter.connect({
    apiToken: 'dop_v1_test-token',
    region: 'sfo3',
    appRegion: 'sfo',
    appInstanceSize: 'apps-s-1vcpu-0.5gb',
    databaseSize: 'db-s-1vcpu-1gb',
    postgresVersion: '17',
    valkeyVersion: '8',
    ...overrides,
  });
  return adapter;
}

function expectedAppName(environment = makeEnvironment()): string {
  const projectHash = createHash('sha256')
    .update(environment.projectId)
    .digest('hex')
    .slice(0, 8);
  return `hv-${projectHash}-${environment.name}`;
}

function mutationCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined;
    return !['GET', 'HEAD'].includes(init?.method ?? 'GET');
  });
}

describe('DigitalOceanAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('forensically inventories a deterministic abandoned app without mutations', async () => {
    const environment = makeEnvironment();
    const app = {
      id: 'do-app-legacy',
      spec: {
        name: expectedAppName(environment),
        region: 'sfo',
        services: [{ name: 'web' }],
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/apps') return jsonResponse({ apps: [app], links: {} });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.inspectEnvironmentResources({
      resource: 'environment',
      limit: 25,
      project: { id: environment.projectId, name: 'app' },
      environment: { id: environment.id, projectId: environment.projectId, name: environment.name },
    })).resolves.toMatchObject({
      observation: 'present',
      resource: 'environment',
      project: { id: app.id, name: app.spec.name },
      managedByHypervibe: true,
      services: [{ id: 'do-app-legacy:services:web', name: 'web', managedByHypervibe: true }],
    });
    expect(mutationCalls(fetchMock)).toEqual([]);
  });


  it('verifies App Platform and Managed Database access with one bearer token', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/apps') {
        return jsonResponse({ apps: [], links: {} });
      }
      if (url.pathname === '/v2/databases') {
        return jsonResponse({ databases: [], links: {} });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.verify()).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [rawUrl, init] of fetchMock.mock.calls) {
      const url = new URL(String(rawUrl));
      expect(url.searchParams.get('page')).toBe('1');
      expect(url.searchParams.get('per_page')).toBe('1');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer dop_v1_test-token',
      });
    }
  });

  it('creates an empty app only after a complete paginated absence check', async () => {
    const environment = makeEnvironment();
    let page = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps' && method === 'GET') {
        page += 1;
        return page === 1
          ? jsonResponse({
              apps: [{
                id: 'unrelated-app',
                spec: { name: 'another-app', region: 'sfo' },
              }],
              links: {
                pages: {
                  next: 'https://api.digitalocean.com/v2/apps?page=2',
                },
              },
            })
          : jsonResponse({ apps: [], links: {} });
      }
      if (url.pathname === '/v2/apps' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          spec: { name: string; region: string };
        };
        return jsonResponse({
          app: {
            id: 'do-app-created',
            spec: body.spec,
          },
        }, 201);
      }
      if (url.pathname === '/v2/registries' && method === 'GET') {
        return jsonResponse({
          registries: [{ name: 'existing-registry', region: 'sfo3' }],
          links: {},
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject('invoice-perfect', environment);

    expect(receipt).toMatchObject({
      success: true,
      data: {
        projectId: 'do-app-created',
        projectName: expectedAppName(environment),
        registryName: 'existing-registry',
        created: true,
      },
    });
    expect(page).toBe(2);
    const createCall = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === 'POST'
    ) as [string, RequestInit] | undefined;
    expect(JSON.parse(String(createCall![1].body))).toEqual({
      spec: {
        name: expectedAppName(environment),
        region: 'sfo',
      },
    });
  });

  it('creates a free stable Starter registry when the team has none', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps/do-app-1' && method === 'GET') {
        return jsonResponse({ app: { id: 'do-app-1', spec: { name: 'hv-app' } } });
      }
      if (url.pathname === '/v2/registries' && method === 'GET') {
        return jsonResponse({ registries: [], links: {} });
      }
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'A1B2-C3D4' } });
      }
      if (url.pathname === '/v2/registries' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          name: 'hypervibe-a1b2c3d4',
          region: 'sfo3',
          subscription_tier_slug: 'starter',
        });
        return jsonResponse({
          registry: { name: body.name, region: body.region },
        }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject('invoice-perfect', makeEnvironment({
      provider: 'digitalocean',
      projectId: 'do-app-1',
      services: {},
    }));

    expect(receipt).toMatchObject({
      success: true,
      data: {
        projectId: 'do-app-1',
        registryName: 'hypervibe-a1b2c3d4',
        created: false,
      },
    });
  });

  it('does not create an app when list observation is unknown', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'temporarily unavailable' }, 503)
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject(
      'invoice-perfect',
      makeEnvironment()
    );

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('503');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('blocks an unbound name match instead of silently adopting it', async () => {
    const environment = makeEnvironment();
    const fetchMock = vi.fn(async () => jsonResponse({
      apps: [
        {
          id: 'do-app-1',
          spec: { name: expectedAppName(environment), region: 'sfo' },
        },
        {
          id: 'do-app-2',
          spec: { name: expectedAppName(environment), region: 'sfo' },
        },
      ],
      links: {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject('invoice-perfect', environment);

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('do-app-1');
    expect(receipt.error).toContain('do-app-2');
    expect(receipt.error).toContain('hv_import');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('uses a durable bound app ID and never replaces a confirmed missing app', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'not found' }, 404)
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject('invoice-perfect', makeEnvironment({
      provider: 'digitalocean',
      projectId: 'do-app-missing',
      services: {},
    }));

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('stale binding');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('adds an image-backed web component without exposing environment secrets', async () => {
    const app = {
      id: 'do-app-1',
      spec: {
        name: 'hv-app',
        region: 'sfo',
      },
    };
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps/do-app-1' && method === 'GET') {
        return jsonResponse({ app });
      }
      if (url.pathname === '/v2/apps/do-app-1' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { spec: unknown };
        return jsonResponse({
          app: {
            id: 'do-app-1',
            spec: body.spec,
            live_url: 'https://hv-app.ondigitalocean.app',
            in_progress_deployment: {
              id: 'deploy-1',
              phase: 'BUILDING',
            },
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();
    const environment = makeEnvironment({
      provider: 'digitalocean',
      projectId: 'do-app-1',
      services: {},
    });

    const result = await adapter.deploy(makeService(), environment, {
      IMAGE_URI_WEB:
        'registry.digitalocean.com/hypervibe/invoice-perfect@sha256:abcdef',
      NODE_ENV: 'production',
      SESSION_SECRET: 'session-secret-value',
      PORT: '8080',
    });

    expect(result).toMatchObject({
      externalId: 'do-app-1:services:web',
      url: 'https://hv-app.ondigitalocean.app',
      status: 'deploying',
      receipt: {
        success: true,
        data: {
          appId: 'do-app-1',
          componentName: 'web',
          resourceType: 'services',
          createdService: true,
        },
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain('session-secret-value');

    const putCall = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === 'PUT'
    ) as [string, RequestInit] | undefined;
    const body = JSON.parse(String(putCall![1].body));
    expect(body.spec.services).toEqual([expect.objectContaining({
      name: 'web',
      image: {
        registry_type: 'DOCR',
        registry: 'hypervibe',
        repository: 'invoice-perfect',
        digest: 'sha256:abcdef',
        deploy_on_push: { enabled: false },
      },
      run_command: 'npm start',
      http_port: 8080,
      instance_size_slug: 'apps-s-1vcpu-0.5gb',
      instance_count: 1,
      routes: [{ path: '/' }],
      health_check: {
        http_path: '/health',
      },
      envs: [
        {
          key: 'NODE_ENV',
          value: 'production',
          scope: 'RUN_TIME',
          type: 'GENERAL',
        },
        {
          key: 'PORT',
          value: '8080',
          scope: 'RUN_TIME',
          type: 'GENERAL',
        },
        {
          key: 'SESSION_SECRET',
          value: 'session-secret-value',
          scope: 'RUN_TIME',
          type: 'SECRET',
        },
      ],
    })]);
    expect(JSON.stringify(body)).not.toContain('IMAGE_URI_WEB');
  });

  it('does not create a first component without an exact image source', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      app: {
        id: 'do-app-1',
        spec: { name: 'hv-app', region: 'sfo' },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'digitalocean',
        projectId: 'do-app-1',
        services: {},
      }),
      { NODE_ENV: 'production' }
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('IMAGE_URI_WEB');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('blocks a deferred first component when the explicit project action has not created a registry', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/apps/do-app-1') {
        return jsonResponse({
          app: {
            id: 'do-app-1',
            spec: { name: 'hv-app', region: 'sfo' },
          },
        });
      }
      if (url.pathname === '/v2/registries') {
        return jsonResponse({ registries: [], links: {} });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'digitalocean',
        projectId: 'do-app-1',
        services: {},
      }),
      {
        HYPERVIBE_SOURCE_REPO_URL: 'https://github.com/acme/invoice-perfect.git',
        NODE_ENV: 'production',
      },
      { deferDeployment: true }
    );

    expect(result.status).toBe('failed');
    expect(result.receipt.error).toContain('explicit project action');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('prepares a first component for exact-SHA CI without claiming deployment', async () => {
    const app = {
      id: 'do-app-1',
      spec: { name: 'hv-app', region: 'sfo' },
    };
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps/do-app-1' && method === 'GET') {
        return jsonResponse({ app });
      }
      if (url.pathname === '/v2/registries' && method === 'GET') {
        return jsonResponse({
          registries: [{ name: 'hypervibe', region: 'nyc3' }],
          links: {},
        });
      }
      if (url.pathname === '/v2/apps/do-app-1' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { spec: unknown };
        return jsonResponse({
          app: {
            id: 'do-app-1',
            spec: body.spec,
            in_progress_deployment: {
              id: 'pending-deploy',
              phase: 'ERROR',
            },
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'digitalocean',
        projectId: 'do-app-1',
        services: {},
      }),
      {
        HYPERVIBE_SOURCE_REPO_URL: 'https://github.com/Acme/Invoice-Perfect.git',
        NODE_ENV: 'production',
      },
      { deferDeployment: true }
    );

    expect(result).toMatchObject({
      externalId: 'do-app-1:services:web',
      status: 'configured',
      receipt: {
        success: true,
        data: {
          appId: 'do-app-1',
          componentName: 'web',
          createdService: true,
          deploymentDeferred: true,
          pendingImage: true,
        },
      },
    });
    expect(result.receipt.message).toContain('exact-SHA CI');
    expect(result.receipt.data).not.toHaveProperty('imageUri');
    const putCall = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === 'PUT'
    ) as [string, RequestInit] | undefined;
    const body = JSON.parse(String(putCall![1].body));
    expect(body.spec.services[0].image).toEqual({
      registry_type: 'DOCR',
      registry: 'hypervibe',
      repository: 'acme/invoice-perfect',
      tag: 'hypervibe-pending',
      deploy_on_push: { enabled: false },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(
      'registry.digitalocean.com'
    );
  });

  it('treats an unauthorized registry observation as unknown and does not update the app', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps/do-app-1' && method === 'GET') {
        return jsonResponse({
          app: {
            id: 'do-app-1',
            spec: { name: 'hv-app', region: 'sfo' },
          },
        });
      }
      if (url.pathname === '/v2/registries') {
        return jsonResponse({ message: 'forbidden' }, 403);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'digitalocean',
        projectId: 'do-app-1',
        services: {},
      }),
      {
        HYPERVIBE_SOURCE_REPO_URL: 'https://github.com/acme/invoice-perfect.git',
      },
      { deferDeployment: true }
    );

    expect(result.status).toBe('failed');
    expect(result.receipt.error).toContain('403');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('preserves the exact component identity when an app update outcome is unknown', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps/do-app-1' && method === 'GET') {
        return jsonResponse({
          app: {
            id: 'do-app-1',
            spec: { name: 'hv-app', region: 'sfo' },
          },
        });
      }
      if (url.pathname === '/v2/apps/do-app-1' && method === 'PUT') {
        return jsonResponse({ message: 'upstream timeout' }, 503);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'digitalocean',
        projectId: 'do-app-1',
        services: {},
      }),
      {
        IMAGE_URI:
          'registry.digitalocean.com/hypervibe/acme/invoice-perfect:sha-1',
      }
    );

    expect(result).toMatchObject({
      externalId: 'do-app-1:services:web',
      status: 'failed',
      receipt: {
        success: false,
        data: {
          appId: 'do-app-1',
          createdService: true,
          mutationAttempted: true,
        },
      },
    });
    expect(result.receipt.error).toContain('503');
    expect(mutationCalls(fetchMock)).toHaveLength(1);
  });

  it('observes services by bound app ID with secret-safe environment state', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      app: {
        id: 'do-app-1',
        spec: {
          name: 'hv-app',
          services: [{
            name: 'web',
            image: {
              registry_type: 'DOCR',
              registry: 'hypervibe',
              repository: 'invoice-perfect',
              tag: 'sha-123',
            },
            envs: [
              {
                key: 'NODE_ENV',
                value: 'production',
                type: 'GENERAL',
              },
              {
                key: 'SESSION_SECRET',
                value: 'EV[encrypted-secret]',
                type: 'SECRET',
              },
            ],
            run_command: 'npm start',
          }],
          workers: [{
            name: 'worker',
            image: {
              registry_type: 'DOCR',
              registry: 'hypervibe',
              repository: 'invoice-perfect-worker',
              tag: 'sha-123',
            },
          }],
        },
        live_url: 'https://hv-app.ondigitalocean.app',
        active_deployment: { id: 'deploy-1', phase: 'ACTIVE' },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const observed = await adapter.observe(makeEnvironment({
      provider: 'digitalocean',
      projectId: 'do-app-1',
      services: {},
    }));

    expect(observed).toMatchObject({
      provider: 'digitalocean',
      projectExists: true,
      projectId: 'do-app-1',
      partial: false,
    });
    expect(observed.services).toEqual([
      expect.objectContaining({
        name: 'web',
        externalId: 'do-app-1:services:web',
        workloadKind: 'web',
        sourceState: 'disconnected',
        envVarKeys: ['NODE_ENV', 'SESSION_SECRET'],
        status: 'running',
      }),
      expect.objectContaining({
        name: 'worker',
        externalId: 'do-app-1:workers:worker',
        workloadKind: 'worker',
      }),
    ]);
    expect(observed.services[0]?.envVarHashes).toHaveProperty('NODE_ENV');
    expect(observed.services[0]?.envVarHashes).not.toHaveProperty('SESSION_SECRET');
    expect(JSON.stringify(observed)).not.toContain('encrypted-secret');
  });

  it('blocks unbound name matches during observation', async () => {
    const environment = makeEnvironment();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      apps: [{
        id: 'do-app-unbound',
        spec: { name: expectedAppName(environment), region: 'sfo' },
      }],
      links: {},
    })));
    const adapter = await connectedAdapter();

    await expect(adapter.observe(environment)).rejects.toThrow(/hv_import/);
  });

  it('attaches an exact app domain while preserving the complete observed spec', async () => {
    let appRead = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps/do-app-1' && method === 'GET') {
        appRead += 1;
        return jsonResponse({
          app: {
            id: 'do-app-1',
            spec: {
              name: 'hv-app',
              region: 'sfo',
              features: ['keep-this'],
              services: [{ name: 'web', routes: [{ path: '/' }] }],
              ...(appRead > 1
                ? { domains: [{ domain: 'do.domain-test.hypervibe.dev', type: 'ALIAS' }] }
                : {}),
            },
            default_ingress: 'hv-app-abc.ondigitalocean.app',
            ...(appRead > 1
              ? {
                  domains: [{
                    id: 'domain-1',
                    phase: 'CONFIGURING',
                    spec: {
                      domain: 'do.domain-test.hypervibe.dev',
                      type: 'ALIAS',
                      validations: [{
                        txt_name: '_acme-challenge.do.domain-test.hypervibe.dev',
                        txt_value: 'validation-token',
                      }],
                    },
                  }],
                }
              : {}),
          },
        });
      }
      if (url.pathname === '/v2/apps/do-app-1' && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        expect(body.spec.features).toEqual(['keep-this']);
        expect(body.spec.services).toEqual([{ name: 'web', routes: [{ path: '/' }] }]);
        expect(body.spec.domains).toEqual([{
          domain: 'do.domain-test.hypervibe.dev',
          type: 'ALIAS',
        }]);
        return jsonResponse({ app: { id: 'do-app-1', spec: body.spec } });
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.attachCustomDomain({
      projectId: 'do-app-1',
      serviceId: 'do-app-1:services:web',
      environmentId: 'env-1',
      domain: 'do.domain-test.hypervibe.dev',
    });

    expect(receipt).toMatchObject({
      success: true,
      data: {
        customDomainId: 'domain-1',
        created: true,
        providerVerified: false,
        certificateStatus: 'CONFIGURING',
        dnsRecords: [
          {
            name: 'do.domain-test.hypervibe.dev',
            type: 'CNAME',
            value: 'hv-app-abc.ondigitalocean.app',
            purpose: 'traffic',
          },
          {
            name: '_acme-challenge.do.domain-test.hypervibe.dev',
            type: 'TXT',
            value: 'validation-token',
            purpose: 'verification',
          },
        ],
      },
    });
    expect(mutationCalls(fetchMock)).toHaveLength(1);
  });

  it('detaches only the reviewed app domain and verifies terminal absence', async () => {
    let appRead = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps/do-app-1' && method === 'GET') {
        appRead += 1;
        const domains = appRead === 1
          ? [
              { domain: 'do.domain-test.hypervibe.dev', type: 'ALIAS' },
              { domain: 'keep.hypervibe.dev', type: 'PRIMARY' },
            ]
          : [{ domain: 'keep.hypervibe.dev', type: 'PRIMARY' }];
        return jsonResponse({
          app: {
            id: 'do-app-1',
            spec: {
              name: 'hv-app',
              features: ['keep-this'],
              services: [{ name: 'web' }],
              domains,
            },
            default_ingress: 'hv-app-abc.ondigitalocean.app',
            domains: domains.map((domain) => ({
              id: domain.domain.startsWith('do.') ? 'domain-1' : 'domain-keep',
              phase: 'ACTIVE',
              spec: domain,
            })),
          },
        });
      }
      if (url.pathname === '/v2/apps/do-app-1' && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        expect(body.spec.features).toEqual(['keep-this']);
        expect(body.spec.domains).toEqual([{
          domain: 'keep.hypervibe.dev',
          type: 'PRIMARY',
        }]);
        return jsonResponse({ app: { id: 'do-app-1', spec: body.spec } });
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.detachCustomDomain({
      projectId: 'do-app-1',
      serviceId: 'do-app-1:services:web',
      environmentId: 'env-1',
      domain: 'do.domain-test.hypervibe.dev',
      customDomainId: 'domain-1',
    });

    expect(receipt).toMatchObject({
      success: true,
      data: { customDomainId: 'domain-1', deleted: true },
    });
    expect(mutationCalls(fetchMock)).toHaveLength(1);
  });

  it('blocks DigitalOcean domain deletion when the reviewed id changed', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      app: {
        id: 'do-app-1',
        spec: {
          name: 'hv-app',
          services: [{ name: 'web' }],
          domains: [{ domain: 'do.domain-test.hypervibe.dev', type: 'ALIAS' }],
        },
        domains: [{
          id: 'different-domain-id',
          phase: 'ACTIVE',
          spec: { domain: 'do.domain-test.hypervibe.dev', type: 'ALIAS' },
        }],
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.detachCustomDomain({
      projectId: 'do-app-1',
      serviceId: 'do-app-1:services:web',
      environmentId: 'env-1',
      domain: 'do.domain-test.hypervibe.dev',
      customDomainId: 'domain-1',
    });

    expect(receipt).toMatchObject({ success: false });
    expect(receipt.error).toMatch(/does not match observed id/);
    expect(mutationCalls(fetchMock)).toHaveLength(0);
  });

  it('attributes app-level domains to the durable bound service during observation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      app: {
        id: 'do-app-1',
        spec: {
          name: 'hv-app',
          services: [{ name: 'web' }, { name: 'admin' }],
          domains: [{ domain: 'do.domain-test.hypervibe.dev', type: 'ALIAS' }],
        },
        default_ingress: 'https://hv-app-abc.ondigitalocean.app',
        domains: [{
          id: 'domain-1',
          phase: 'ACTIVE',
          spec: { domain: 'do.domain-test.hypervibe.dev', type: 'ALIAS' },
        }],
        active_deployment: { id: 'deploy-1', phase: 'ACTIVE' },
      },
    })));
    const adapter = await connectedAdapter();

    const observed = await adapter.observe(makeEnvironment({
      provider: 'digitalocean',
      projectId: 'do-app-1',
      services: {},
      domainDns: {
        name: 'do.domain-test.hypervibe.dev',
        serviceId: 'do-app-1:services:web',
      },
    }));

    expect(observed.services.find((service) => service.name === 'web')).toMatchObject({
      customDomains: ['do.domain-test.hypervibe.dev'],
      customDomainStatus: {
        'do.domain-test.hypervibe.dev': {
          providerVerified: true,
          certificateStatus: 'ACTIVE',
          dnsConfigured: true,
        },
      },
    });
    expect(observed.services.find((service) => service.name === 'admin')?.customDomains).toEqual([]);
  });

  it('removes one exact component and waits for provider-confirmed absence', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_COMPONENT_DELETE_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_COMPONENT_DELETE_ATTEMPTS', '3');
    let appRead = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps/do-app-1' && method === 'GET') {
        appRead += 1;
        return jsonResponse({
          app: {
            id: 'do-app-1',
            spec: {
              name: 'hv-app',
              region: 'sfo',
              ...(appRead < 2
                ? {
                    services: [{
                      name: 'web',
                      image: {
                        registry_type: 'DOCR',
                        registry: 'hypervibe',
                        repository: 'invoice-perfect',
                        tag: 'latest',
                      },
                    }],
                  }
                : {}),
              workers: [{
                name: 'worker',
                image: {
                  registry_type: 'DOCR',
                  registry: 'hypervibe',
                  repository: 'worker',
                  tag: 'latest',
                },
              }],
            },
          },
        });
      }
      if (url.pathname === '/v2/apps/do-app-1' && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        expect(body.spec.services).toBeUndefined();
        expect(body.spec.workers).toHaveLength(1);
        return jsonResponse({
          app: { id: 'do-app-1', spec: body.spec },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const deleted = await adapter.deleteService('do-app-1:services:web');

    expect(deleted).toEqual({
      success: true,
      message: 'Deleted DigitalOcean component web',
    });
    expect(appRead).toBe(2);
  });

  it('treats a provider-confirmed missing app as idempotent project deletion', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'not found' }, 404)
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.deleteProject('do-app-missing')).resolves.toEqual({
      success: true,
    });
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('does not mistake a failed project-deletion preflight for absence', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'forbidden' }, 403)
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deleteProject('do-app-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('waits until a deleted app is terminally absent', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_APP_DELETE_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_APP_DELETE_ATTEMPTS', '3');
    let appRead = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/apps/do-app-1' && method === 'GET') {
        appRead += 1;
        return appRead < 3
          ? jsonResponse({
              app: {
                id: 'do-app-1',
                spec: { name: 'hv-app', region: 'sfo' },
              },
            })
          : jsonResponse({ message: 'not found' }, 404);
      }
      if (url.pathname === '/v2/apps/do-app-1' && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.deleteProject('do-app-1')).resolves.toEqual({
      success: true,
    });
    expect(appRead).toBe(3);
  });
});
