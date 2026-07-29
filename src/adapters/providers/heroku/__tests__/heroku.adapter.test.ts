import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import { HerokuAdapter } from '../heroku.adapter.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_BINDING = `${APP_ID}:web:basic`;

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

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(status === 204 ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
  });
}

function account() {
  return {
    id: ACCOUNT_ID,
    email: 'owner@example.com',
    name: 'Owner',
  };
}

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    name: expectedServiceName(),
    stack: { id: 'stack-container', name: 'container' },
    region: { id: 'region-us', name: 'us' },
    web_url: 'https://hv-example.herokuapp.com/',
    released_at: null,
    ...overrides,
  };
}

async function connectedAdapter(
  overrides: Record<string, unknown> = {}
): Promise<HerokuAdapter> {
  const adapter = new HerokuAdapter();
  await adapter.connect({
    apiKey: 'heroku-test-token',
    region: 'us',
    dynoSize: 'basic',
    ...overrides,
  });
  return adapter;
}

function expectedPrefix(): string {
  const projectHash = createHash('sha256')
    .update('project-1')
    .digest('hex')
    .slice(0, 8);
  const environmentHash = createHash('sha256')
    .update('production')
    .digest('hex')
    .slice(0, 6);
  return `hv-${projectHash}-${environmentHash}-`;
}

function expectedServiceName(): string {
  const serviceHash = createHash('sha256')
    .update('web')
    .digest('hex')
    .slice(0, 8);
  return `${expectedPrefix()}${serviceHash}`;
}

function mutationCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) =>
    !['GET', 'HEAD'].includes(
      (call[1] as RequestInit | undefined)?.method ?? 'GET'
    )
  );
}

describe('HerokuAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('binds the verified account without trying to create an account or app', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(account()));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.ensureProject('invoice-perfect', makeEnvironment())
    ).resolves.toMatchObject({
      success: true,
      data: {
        projectId: ACCOUNT_ID,
        projectName: 'owner@example.com',
        created: false,
      },
    });
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('blocks a conflicting durable account binding without mutations', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(account()));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject(
      'invoice-perfect',
      makeEnvironment({
        provider: 'heroku',
        projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        services: {},
      })
    );

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('will not silently rebind');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('creates only an empty container app and returns a secret-safe pending binding', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/account' && method === 'GET') {
        return jsonResponse(account());
      }
      if (url.pathname === '/apps' && method === 'GET') {
        return jsonResponse([]);
      }
      if (url.pathname === '/apps' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        return jsonResponse(app({
          name: body.name,
          region: { name: body.region },
          stack: { name: body.stack },
        }), 201);
      }
      if (
        url.pathname === `/apps/${APP_ID}/config-vars`
        && method === 'PATCH'
      ) {
        return jsonResponse(JSON.parse(String(init?.body)));
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'heroku',
        projectId: ACCOUNT_ID,
        services: {},
      }),
      {
        HYPERVIBE_SOURCE_REPO_URL:
          'https://github.com/davejohnson/invoice-perfect.git',
        IMAGE_URI: 'ghcr.io/should-not-cross-the-boundary',
        NODE_ENV: 'production',
        SESSION_SECRET: 'session-secret-value',
      },
      { deferDeployment: true }
    );

    expect(result).toMatchObject({
      externalId: SERVICE_BINDING,
      url: 'https://hv-example.herokuapp.com/',
      status: 'configured',
      receipt: {
        success: true,
        data: {
          serviceId: SERVICE_BINDING,
          appId: APP_ID,
          serviceName: expectedServiceName(),
          resourceType: 'web',
          createdService: true,
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
    expect(JSON.parse(String(createCall![1].body))).toEqual({
      name: expectedServiceName(),
      region: 'us',
      stack: 'container',
    });
    const configCall = fetchMock.mock.calls.find((call) =>
      new URL(String(call[0])).pathname.endsWith('/config-vars')
    ) as [string, RequestInit] | undefined;
    expect(JSON.parse(String(configCall![1].body))).toEqual({
      NODE_ENV: 'production',
      SESSION_SECRET: 'session-secret-value',
      HYPERVIBE_START_COMMAND: 'npm start',
      HYPERVIBE_HEALTH_CHECK_PATH: '/health',
    });
    expect(fetchMock.mock.calls.some((call) =>
      new URL(String(call[0])).pathname.includes('/formation')
    )).toBe(false);
    expect(fetchMock.mock.calls.some((call) =>
      new URL(String(call[0])).pathname.includes('/releases')
    )).toBe(false);
  });

  it('reports the created app identity if config mutation fails after creation', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/account') return jsonResponse(account());
      if (url.pathname === '/apps' && method === 'GET') return jsonResponse([]);
      if (url.pathname === '/apps' && method === 'POST') {
        return jsonResponse(app(), 201);
      }
      if (url.pathname.endsWith('/config-vars')) {
        return jsonResponse({}, 500);
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'heroku',
        projectId: ACCOUNT_ID,
        services: {},
      }),
      {},
      { deferDeployment: true }
    );

    expect(result).toMatchObject({
      externalId: SERVICE_BINDING,
      status: 'failed',
      receipt: {
        success: false,
        data: {
          createdService: true,
          mutationAttempted: true,
        },
      },
    });
  });

  it('blocks an unbound deterministic-name match instead of adopting it', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/account') return jsonResponse(account());
      if (url.pathname === '/apps') return jsonResponse([app()]);
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'heroku',
        projectId: ACCOUNT_ID,
        services: {},
      }),
      {},
      { deferDeployment: true }
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('hv_import');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('does not replace a stale durable binding', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/account') return jsonResponse(account());
      if (url.pathname === `/apps/${APP_ID}`) return jsonResponse({}, 404);
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'heroku',
        projectId: ACCOUNT_ID,
        services: {
          web: { serviceId: SERVICE_BINDING },
        },
      }),
      {},
      { deferDeployment: true }
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('stale binding');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('blocks cron before any provider request or mutation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService({
        name: 'daily',
        buildConfig: {
          workloadKind: 'cron',
          startCommand: 'npm run daily',
          cronSchedule: '0 8 * * *',
        },
      }),
      makeEnvironment({
        provider: 'heroku',
        projectId: ACCOUNT_ID,
        services: {},
      }),
      {},
      { deferDeployment: true }
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('Scheduler');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a missing declarative start command before any provider request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService({
        buildConfig: {
          workloadKind: 'web',
          healthCheckPath: '/health',
          public: true,
        },
      }),
      makeEnvironment({
        provider: 'heroku',
        projectId: ACCOUNT_ID,
        services: {},
      }),
      {},
      { deferDeployment: true }
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('require startCommand');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves omitted config vars and excludes orchestration-only values', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === `/apps/${APP_ID}` && method === 'GET') {
        return jsonResponse(app());
      }
      if (url.pathname.endsWith('/config-vars') && method === 'PATCH') {
        return jsonResponse(JSON.parse(String(init?.body)));
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.setEnvVars(
      makeEnvironment({
        provider: 'heroku',
        projectId: ACCOUNT_ID,
        services: {
          web: { serviceId: SERVICE_BINDING },
        },
      }),
      makeService(),
      {
        NODE_ENV: 'production',
        HYPERVIBE_SOURCE_REPO_URL: 'https://github.com/example/repo',
      },
      { deferDeployment: true }
    );

    expect(receipt.success).toBe(true);
    const patchCall = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === 'PATCH'
    ) as [string, RequestInit] | undefined;
    expect(JSON.parse(String(patchCall![1].body))).toEqual({
      NODE_ENV: 'production',
      HYPERVIBE_START_COMMAND: 'npm start',
      HYPERVIBE_HEALTH_CHECK_PATH: '/health',
    });
  });

  it('deletes only explicitly retired user config vars', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === `/apps/${APP_ID}` && method === 'GET') {
        return jsonResponse(app());
      }
      if (url.pathname.endsWith('/config-vars') && method === 'PATCH') {
        return jsonResponse({});
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.deleteEnvVars!(
      makeEnvironment({
        provider: 'heroku',
        projectId: ACCOUNT_ID,
        services: {
          web: { serviceId: SERVICE_BINDING },
        },
      }),
      makeService(),
      ['OLD_VALUE', 'HYPERVIBE_DEPLOY_SHA']
    );

    expect(receipt).toMatchObject({
      success: true,
      data: { deletedKeys: ['OLD_VALUE'] },
    });
    const patchCall = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === 'PATCH'
    ) as [string, RequestInit] | undefined;
    expect(JSON.parse(String(patchCall![1].body))).toEqual({
      OLD_VALUE: null,
    });
  });

  it('observes durable app IDs, complete pagination, and secret-safe config hashes', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/account') return jsonResponse(account());
      if (url.pathname === '/apps') return jsonResponse([app()]);
      if (url.pathname === `/apps/${APP_ID}/config-vars`) {
        return jsonResponse({
          SESSION_SECRET: 'secret-value',
          HYPERVIBE_START_COMMAND: 'npm start',
          HYPERVIBE_HEALTH_CHECK_PATH: '/health',
          HYPERVIBE_DEPLOY_SHA: 'a'.repeat(40),
          HYPERVIBE_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
        });
      }
      if (url.pathname === `/apps/${APP_ID}/formation`) {
        return jsonResponse([{
          id: 'formation-1',
          type: 'web',
          quantity: 1,
          command: 'sh -lc npm start',
          dyno_size: { name: 'basic' },
        }]);
      }
      if (url.pathname === `/apps/${APP_ID}/releases`) {
        return jsonResponse([{
          id: 'release-1',
          version: 3,
          status: 'succeeded',
          current: true,
        }]);
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const observed = await adapter.observe(makeEnvironment({
      provider: 'heroku',
      projectId: ACCOUNT_ID,
      services: {
        web: { serviceId: SERVICE_BINDING },
      },
    }));

    expect(observed).toMatchObject({
      projectExists: true,
      projectId: ACCOUNT_ID,
      completeness: {
        services: 'complete',
        databases: 'unknown',
        caches: 'unknown',
      },
      services: [{
        name: 'web',
        externalId: SERVICE_BINDING,
        workloadKind: 'web',
        url: 'https://hv-example.herokuapp.com/',
        config: {
          startCommand: 'npm start',
          healthCheckPath: '/health',
          public: true,
        },
        envVarKeys: ['SESSION_SECRET'],
        envVarHashes: {
          SESSION_SECRET: hashEnvValue('secret-value'),
        },
        status: 'running',
      }],
    });
    expect(JSON.stringify(observed)).not.toContain('secret-value');
    expect(JSON.stringify(observed)).not.toContain('HYPERVIBE_IMAGE_ID');
  });

  it('represents a provider-confirmed empty app without claiming a deployment', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/account') return jsonResponse(account());
      if (url.pathname === '/apps') return jsonResponse([app()]);
      if (url.pathname.endsWith('/config-vars')) {
        return jsonResponse({ HYPERVIBE_START_COMMAND: 'npm start' });
      }
      if (url.pathname.endsWith('/formation')) return jsonResponse([]);
      if (url.pathname.endsWith('/releases')) return jsonResponse([]);
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const observed = await adapter.observe(makeEnvironment({
      provider: 'heroku',
      projectId: ACCOUNT_ID,
      services: {
        web: { serviceId: SERVICE_BINDING },
      },
    }));

    expect(observed.services[0]?.status).toBe('empty');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('blocks unbound environment app matches during observation', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/account') return jsonResponse(account());
      if (url.pathname === '/apps') return jsonResponse([app()]);
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.observe(makeEnvironment({
      provider: 'heroku',
      projectId: ACCOUNT_ID,
      services: {},
    }))).rejects.toThrow(/hv_import/);
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('propagates observation failures instead of planning from false absence', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/account') return jsonResponse(account());
      if (url.pathname === '/apps') return jsonResponse({}, 403);
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.observe(makeEnvironment({
      provider: 'heroku',
      projectId: ACCOUNT_ID,
      services: {},
    }))).rejects.toThrow('Heroku Platform API error: 403');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('deletes an app idempotently and verifies terminal absence', async () => {
    let appReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === `/apps/${APP_ID}` && method === 'GET') {
        appReads += 1;
        return appReads === 1
          ? jsonResponse(app())
          : jsonResponse({}, 404);
      }
      if (url.pathname === `/apps/${APP_ID}` && method === 'DELETE') {
        return jsonResponse(app());
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HYPERVIBE_HEROKU_APP_DELETE_DELAY_MS', '0');
    const adapter = await connectedAdapter();

    await expect(adapter.deleteService!(SERVICE_BINDING)).resolves.toEqual({
      success: true,
    });
    expect(fetchMock.mock.calls.filter((call) =>
      (call[1] as RequestInit | undefined)?.method === 'DELETE'
    )).toHaveLength(1);
  });

  it('treats an already absent app as successful deletion with no mutation', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 404));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.deleteService!(SERVICE_BINDING)).resolves.toEqual({
      success: true,
    });
    expect(mutationCalls(fetchMock)).toEqual([]);
  });
});
