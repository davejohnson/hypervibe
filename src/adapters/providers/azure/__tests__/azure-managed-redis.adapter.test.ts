import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { AzureManagedRedisAdapter } from '../azure-managed-redis.adapter.js';

const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const RESOURCE_GROUP = 'hypervibe-test';
const CLUSTER_NAME = 'invoice-perfect-production-redis';
const CLUSTER_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`
  + `/providers/Microsoft.Cache/redisEnterprise/${CLUSTER_NAME}`;
const CLIENT_SECRET = 'azure-client-secret-never-output';
const PRIMARY_KEY = 'redis-primary-key-never-output';

const credentials = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: SUBSCRIPTION_ID,
  clientId: '33333333-3333-4333-8333-333333333333',
  clientSecret: CLIENT_SECRET,
  resourceGroup: RESOURCE_GROUP,
  location: 'canadacentral',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function accepted(): Response {
  return new Response(null, { status: 202 });
}

function cluster(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: CLUSTER_ID,
    name: CLUSTER_NAME,
    location: 'canadacentral',
    sku: { name: 'Balanced_B0' },
    properties: {
      provisioningState: 'Succeeded',
      resourceState: 'Running',
      hostName: `${CLUSTER_NAME}.canadacentral.redis.azure.net`,
      minimumTlsVersion: '1.2',
    },
    ...overrides,
  };
}

function database(): Record<string, unknown> {
  return {
    id: `${CLUSTER_ID}/databases/default`,
    name: `${CLUSTER_NAME}/default`,
    properties: {
      provisioningState: 'Succeeded',
      resourceState: 'Running',
      clientProtocol: 'Encrypted',
      port: 10000,
      redisVersion: '7.4',
    },
  };
}

function environment(): Environment {
  return {
    id: 'env-local',
    projectId: 'project-local',
    name: 'production',
    platformBindings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function installAzureFetch(
  handler: (
    url: URL,
    method: string,
    body: unknown
  ) => Response | Promise<Response>
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') {
      return jsonResponse({ access_token: 'safe-access-token' });
    }
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body)
      : undefined;
    return handler(url, init?.method ?? 'GET', body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function connected(): Promise<AzureManagedRedisAdapter> {
  const adapter = new AzureManagedRedisAdapter();
  await adapter.connect(credentials);
  return adapter;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('AzureManagedRedisAdapter', () => {
  it('inventories bounded caches with their full Azure scope', async () => {
    installAzureFetch((url, method) => {
      expect(method).toBe('GET');
      expect(url.pathname).toContain('/providers/Microsoft.Cache/redisEnterprise');
      return jsonResponse({ value: [cluster()] });
    });
    const adapter = await connected();

    await expect(adapter.inspectCacheResources({ resource: 'cache', limit: 1 }))
      .resolves.toMatchObject({
        observation: 'present',
        resource: 'cache',
        caches: [{
          id: CLUSTER_ID,
          name: CLUSTER_NAME,
          providerScope: {
            subscriptionId: SUBSCRIPTION_ID,
            resourceGroup: RESOURCE_GROUP,
          },
        }],
        partial: false,
      });
  });

  it('creates an encrypted Redis database and keeps access keys out of receipts', async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      body: any;
    }> = [];
    installAzureFetch((url, method, body) => {
      requests.push({ method, pathname: url.pathname, body });
      if (method === 'GET' && url.pathname.endsWith('/redisEnterprise')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return accepted();
      }
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster());
      }
      if (method === 'PUT' && url.pathname.endsWith('/databases/default')) {
        return accepted();
      }
      if (method === 'GET' && url.pathname.endsWith('/databases/default')) {
        return jsonResponse(database());
      }
      if (method === 'POST' && url.pathname.endsWith('/databases/default/listKeys')) {
        return jsonResponse({
          primaryKey: PRIMARY_KEY,
          secondaryKey: 'secondary-secret',
        });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe(CLUSTER_ID);
    expect(result.connectionUrl).toBe(
      `rediss://:${PRIMARY_KEY}@${CLUSTER_NAME}.canadacentral.redis.azure.net:10000`
    );
    const createDatabase = requests.find((request) =>
      request.method === 'PUT'
      && request.pathname.endsWith('/databases/default')
    );
    expect(createDatabase?.body).toMatchObject({
      properties: {
        clientProtocol: 'Encrypted',
        clusteringPolicy: 'NoCluster',
        accessKeysAuthentication: 'Enabled',
        port: 10000,
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(PRIMARY_KEY);
    expect(JSON.stringify(result.receipt)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(result.receipt)).not.toContain('rediss://');
  });

  it('blocks duplicate-name adoption without a mutation', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/redisEnterprise')) {
        return jsonResponse({ value: [cluster()] });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: CLUSTER_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('will not choose or silently adopt');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'))
      .toBe(false);
  });

  it('preserves cluster identity after an unknown create result', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/redisEnterprise')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: CLUSTER_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe(CLUSTER_ID);
    expect(result.receipt.data).toMatchObject({
      clusterId: CLUSTER_ID,
      mutationAttempted: true,
    });
  });

  it('uses durable ids first and preserves permission errors as unknown', async () => {
    let listCalled = false;
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster());
      }
      if (url.pathname.endsWith('/redisEnterprise')) listCalled = true;
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    const component = {
      id: 'component',
      environmentId: 'env-local',
      type: 'redis' as const,
      bindings: { provider: 'azure-managed-redis' },
      externalId: CLUSTER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(adapter.observeCache(
      environment(),
      component
    )).resolves.toMatchObject({
      externalId: CLUSTER_ID,
      status: 'running',
    });
    expect(listCalled).toBe(false);

    installAzureFetch(() => jsonResponse({ error: 'forbidden' }, 403));
    const unknown = await connected();
    await expect(unknown.observeCache(
      environment(),
      component
    )).rejects.toMatchObject({ status: 403 });
  });

  it('makes deletion idempotent and verifies terminal absence', async () => {
    let getCount = 0;
    let deleted = false;
    installAzureFetch((url, method) => {
      if (url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        if (method === 'DELETE') {
          deleted = true;
          return accepted();
        }
        getCount += 1;
        return deleted
          ? jsonResponse({ error: 'gone' }, 404)
          : jsonResponse(cluster());
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    const component = {
      id: 'component',
      environmentId: 'env-local',
      type: 'redis' as const,
      bindings: {
        provider: 'azure-managed-redis',
        instanceId: CLUSTER_ID,
      },
      externalId: CLUSTER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(adapter.destroy(component)).resolves.toMatchObject({
      success: true,
    });
    expect(getCount).toBe(2);

    installAzureFetch(() => jsonResponse({ error: 'gone' }, 404));
    const absent = await connected();
    await expect(absent.destroy(component)).resolves.toMatchObject({
      success: true,
      message: expect.stringContaining('already absent'),
    });

    let observed = false;
    installAzureFetch((_url, method) => {
      if (method === 'GET' && !observed) {
        observed = true;
        return jsonResponse(cluster());
      }
      return jsonResponse({ error: 'gone' }, 404);
    });
    const raced = await connected();
    await expect(raced.destroy(component)).resolves.toMatchObject({
      success: true,
    });
  });
});
