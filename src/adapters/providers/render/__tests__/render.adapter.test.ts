import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import { RenderAdapter } from '../render.adapter.js';

function makeEnvironment(
  platformBindings: Record<string, unknown> = {}
): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
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
): Promise<RenderAdapter> {
  const adapter = new RenderAdapter();
  await adapter.connect({
    apiKey: 'rnd_test-key',
    ownerId: 'tea-owner-1',
    registryCredentialId: 'reg-credential-1',
    region: 'oregon',
    servicePlan: 'starter',
    ...overrides,
  });
  return adapter;
}

function expectedPrefix(): string {
  const hash = createHash('sha256')
    .update('project-1')
    .digest('hex')
    .slice(0, 8);
  return `hv-${hash}-production`;
}

function mutationCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) =>
    !['GET', 'HEAD'].includes(
      (call[1] as RequestInit | undefined)?.method ?? 'GET'
    )
  );
}

describe('RenderAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('binds the existing workspace without trying to create one', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: 'tea-owner-1',
      name: 'Invoice Perfect',
      email: 'owner@example.com',
      type: 'team',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.ensureProject('invoice-perfect', makeEnvironment())
    ).resolves.toMatchObject({
      success: true,
      data: {
        projectId: 'tea-owner-1',
        projectName: 'Invoice Perfect',
        created: false,
      },
    });
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('blocks a conflicting durable workspace binding', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject(
      'invoice-perfect',
      makeEnvironment({
        provider: 'render',
        projectId: 'tea-other',
        services: {},
      })
    );

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('will not silently rebind');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates an image-backed service for deferred CI and returns a secret-safe receipt', async () => {
    const providerName = `${expectedPrefix()}-web`;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/services' && method === 'GET') {
        return jsonResponse([]);
      }
      if (
        url.pathname === '/v1/registrycredentials/reg-credential-1'
        && method === 'GET'
      ) {
        return jsonResponse({
          id: 'reg-credential-1',
          name: 'Hypervibe GHCR',
          username: 'invoice-perfect',
          registry: 'GITHUB',
          updatedAt: new Date().toISOString(),
        });
      }
      if (url.pathname === '/v1/services' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        return jsonResponse({
          service: {
            id: 'srv-render-1',
            name: body.name,
            ownerId: body.ownerId,
            type: body.type,
            imagePath: body.image.imagePath,
            autoDeploy: body.autoDeploy,
            registryCredential: {
              id: body.image.registryCredentialId,
            },
            serviceDetails: {
              ...body.serviceDetails,
              url: 'https://invoice-perfect.onrender.com',
            },
          },
          deployId: 'dep-bootstrap-1',
        }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'render',
        projectId: 'tea-owner-1',
        services: {},
      }),
      {
        HYPERVIBE_SOURCE_REPO_URL:
          'https://github.com/davejohnson/invoice-perfect.git',
        NODE_ENV: 'production',
        SESSION_SECRET: 'session-secret-value',
      },
      { deferDeployment: true }
    );

    expect(result).toMatchObject({
      externalId: 'srv-render-1',
      url: 'https://invoice-perfect.onrender.com',
      status: 'configured',
      receipt: {
        success: true,
        data: {
          serviceId: 'srv-render-1',
          serviceName: providerName,
          resourceType: 'web_service',
          createdService: true,
          deployId: 'dep-bootstrap-1',
          deploymentDeferred: true,
          pendingImage: true,
        },
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(
      'session-secret-value'
    );

    const createCall = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === 'POST'
    ) as [string, RequestInit] | undefined;
    const body = JSON.parse(String(createCall![1].body));
    expect(body).toEqual({
      type: 'web_service',
      name: providerName,
      ownerId: 'tea-owner-1',
      autoDeploy: 'no',
      image: {
        ownerId: 'tea-owner-1',
        imagePath: 'docker.io/library/alpine:3.20',
      },
      envVars: [
        { key: 'NODE_ENV', value: 'production' },
        { key: 'SESSION_SECRET', value: 'session-secret-value' },
      ],
      serviceDetails: {
        runtime: 'image',
        plan: 'starter',
        region: 'oregon',
        envSpecificDetails: {
          dockerCommand: 'npm start',
        },
        healthCheckPath: '/health',
      },
    });
  });

  it('does not create a deferred service without an explicit existing registry credential', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter({
      registryCredentialId: undefined,
    });

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'render',
        projectId: 'tea-owner-1',
        services: {},
      }),
      {
        HYPERVIBE_SOURCE_REPO_URL:
          'https://github.com/davejohnson/invoice-perfect.git',
      },
      { deferDeployment: true }
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('registryCredentialId');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('preserves omitted env vars and excludes orchestration-only values', async () => {
    const providerName = `${expectedPrefix()}-web`;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/services/srv-render-1' && method === 'GET') {
        return jsonResponse({
          id: 'srv-render-1',
          name: providerName,
          ownerId: 'tea-owner-1',
          type: 'web_service',
          imagePath: 'ghcr.io/davejohnson/invoice-perfect:old-sha',
          registryCredential: { id: 'reg-credential-1' },
          serviceDetails: {},
        });
      }
      if (
        url.pathname === '/v1/registrycredentials/reg-credential-1'
        && method === 'GET'
      ) {
        return jsonResponse({
          id: 'reg-credential-1',
          name: 'GHCR',
          registry: 'GITHUB',
        });
      }
      if (
        url.pathname === '/v1/services/srv-render-1'
        && method === 'PATCH'
      ) {
        return jsonResponse({
          id: 'srv-render-1',
          name: providerName,
          ownerId: 'tea-owner-1',
          type: 'web_service',
          imagePath: 'ghcr.io/davejohnson/invoice-perfect:old-sha',
          serviceDetails: {},
        });
      }
      if (
        url.pathname === '/v1/services/srv-render-1/env-vars'
        && method === 'GET'
      ) {
        return jsonResponse([
          {
            envVar: { key: 'EXTERNAL_VALUE', value: 'preserve-me' },
            cursor: 'cursor-1',
          },
        ]);
      }
      if (
        url.pathname === '/v1/services/srv-render-1/env-vars'
        && method === 'PUT'
      ) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'render',
        projectId: 'tea-owner-1',
        services: {
          web: { serviceId: 'srv-render-1' },
        },
      }),
      {
        HYPERVIBE_SOURCE_REPO_URL:
          'https://github.com/davejohnson/invoice-perfect.git',
        NODE_ENV: 'production',
      },
      { deferDeployment: true }
    );

    expect(result.receipt.success).toBe(true);
    const putCall = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === 'PUT'
    ) as [string, RequestInit] | undefined;
    expect(JSON.parse(String(putCall![1].body))).toEqual([
      { key: 'EXTERNAL_VALUE', value: 'preserve-me' },
      { key: 'NODE_ENV', value: 'production' },
    ]);
  });

  it('observes bound services by durable ID and hashes env values', async () => {
    const providerName = `${expectedPrefix()}-web`;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/owners/tea-owner-1') {
        return jsonResponse({
          id: 'tea-owner-1',
          name: 'Invoice Perfect',
        });
      }
      if (url.pathname === '/v1/services') {
        return jsonResponse([
          {
            service: {
              id: 'srv-render-1',
              name: providerName,
              ownerId: 'tea-owner-1',
              type: 'web_service',
              autoDeploy: 'no',
              imagePath: 'ghcr.io/davejohnson/invoice-perfect:sha',
              serviceDetails: {
                url: 'https://invoice-perfect.onrender.com',
                healthCheckPath: '/health',
                envSpecificDetails: { dockerCommand: 'npm start' },
              },
            },
            cursor: 'cursor-service',
          },
        ]);
      }
      if (url.pathname === '/v1/services/srv-render-1/env-vars') {
        return jsonResponse([
          {
            envVar: { key: 'SESSION_SECRET', value: 'secret-value' },
            cursor: 'cursor-env',
          },
        ]);
      }
      if (url.pathname === '/v1/services/srv-render-1/deploys') {
        return jsonResponse([
          {
            deploy: { id: 'dep-1', status: 'live' },
            cursor: 'cursor-deploy',
          },
        ]);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const observed = await adapter.observe(makeEnvironment({
      provider: 'render',
      projectId: 'tea-owner-1',
      services: {
        web: { serviceId: 'srv-render-1' },
      },
    }));

    expect(observed).toMatchObject({
      projectExists: true,
      projectId: 'tea-owner-1',
      services: [{
        name: 'web',
        externalId: 'srv-render-1',
        workloadKind: 'web',
        sourceState: 'disconnected',
        status: 'running',
        envVarKeys: ['SESSION_SECRET'],
        envVarHashes: {
          SESSION_SECRET: hashEnvValue('secret-value'),
        },
      }],
    });
    expect(JSON.stringify(observed)).not.toContain('secret-value');
  });

  it('blocks unbound environment-name matches during observation', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/owners/tea-owner-1') {
        return jsonResponse({ id: 'tea-owner-1', name: 'Owner' });
      }
      if (url.pathname === '/v1/services') {
        return jsonResponse([
          {
            service: {
              id: 'srv-unbound',
              name: `${expectedPrefix()}-web`,
              ownerId: 'tea-owner-1',
              type: 'web_service',
            },
            cursor: 'cursor-1',
          },
        ]);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.observe(makeEnvironment({
      provider: 'render',
      projectId: 'tea-owner-1',
      services: {},
    }))).rejects.toThrow(/hv_import/);
    expect(mutationCalls(fetchMock)).toEqual([]);
  });
});
