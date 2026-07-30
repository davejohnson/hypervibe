import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import {
  runMockCacheLifecycleContract,
} from '../../__tests__/cache-lifecycle.contract.js';
import { MemorystoreAdapter } from '../memorystore.adapter.js';

const PROJECT_ID = 'gcp-project';
const REGION = 'us-central1';
const INSTANCE_ID = 'invoice-perfect-production-redis';
const RESOURCE_NAME =
  `projects/${PROJECT_ID}/locations/${REGION}/instances/${INSTANCE_ID}`;
const SERVICE_ACCOUNT_SECRET = 'service-account-private-key-never-output';
const REDIS_AUTH = 'memorystore-auth-string-never-output';

function environment(): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function component(externalId = RESOURCE_NAME): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'redis',
    externalId,
    bindings: {
      provider: 'memorystore',
      instanceId: externalId,
      privateNetworkOnly: true,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function instance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: RESOURCE_NAME,
    displayName: 'Invoice Perfect Production Redis',
    state: 'READY',
    host: '10.10.0.3',
    port: 6379,
    tier: 'BASIC',
    memorySizeGb: 1,
    redisVersion: 'REDIS_7_2',
    authorizedNetwork: `projects/${PROJECT_ID}/global/networks/default`,
    connectMode: 'DIRECT_PEERING',
    authEnabled: true,
    transitEncryptionMode: 'DISABLED',
    ...overrides,
  };
}

async function connected(): Promise<MemorystoreAdapter> {
  const adapter = new MemorystoreAdapter();
  await adapter.connect({
    projectId: PROJECT_ID,
    region: REGION,
    credentials: JSON.stringify({
      type: 'service_account',
      project_id: PROJECT_ID,
      private_key: SERVICE_ACCOUNT_SECRET,
      client_email: `deploy@${PROJECT_ID}.iam.gserviceaccount.com`,
    }),
  });
  (adapter as unknown as {
    accessToken: string;
    tokenExpiresAt: number;
  }).accessToken = 'safe-access-token';
  (adapter as unknown as {
    accessToken: string;
    tokenExpiresAt: number;
  }).tokenExpiresAt = Date.now() + 60_000;
  return adapter;
}

runMockCacheLifecycleContract({
  displayName: 'Google Cloud Memorystore',
  externalIds: [
    `projects/${PROJECT_ID}/locations/${REGION}/instances/cache-1`,
    `projects/${PROJECT_ID}/locations/${REGION}/instances/cache-2`,
  ],
  resourceName: 'Invoice Perfect Production Redis',
  createAdapter: connected,
  makeEnvironment: environment,
  makeComponent: component,
  isListRequest: (url, init) =>
    url.pathname === `/v1/projects/${PROJECT_ID}/locations/${REGION}/instances`
    && (init?.method ?? 'GET') === 'GET',
  isItemRequest: (url, externalId, init) =>
    url.pathname === `/v1/${externalId}`
    && (init?.method ?? 'GET') === 'GET',
  listResponse: (resources) => ({
    instances: resources.map((resource) => ({
      name: resource.id,
      displayName: resource.name,
      state: 'READY',
    })),
  }),
});

describe('MemorystoreAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('creates private-IP Redis with AUTH and keeps the auth string out of receipts', async () => {
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_ATTEMPTS', '3');
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url.pathname, body });
      if (url.pathname.endsWith(`/locations/${REGION}/instances`) && method === 'GET') {
        return response({ instances: [] });
      }
      if (url.pathname.endsWith(`/locations/${REGION}/instances`) && method === 'POST') {
        expect(url.searchParams.get('instanceId')).toBe(INSTANCE_ID);
        return response({
          name: `projects/${PROJECT_ID}/locations/${REGION}/operations/create-1`,
        });
      }
      if (url.pathname.endsWith('/operations/create-1') && method === 'GET') {
        return response({ name: 'create-1', done: true });
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'GET') {
        return response(instance());
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}/authString` && method === 'GET') {
        return response({ authString: REDIS_AUTH });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe(RESOURCE_NAME);
    expect(result.connectionUrl).toBe(`redis://:${REDIS_AUTH}@10.10.0.3:6379`);
    expect(result.envVars).toEqual({ REDIS_URL: result.connectionUrl });
    const create = requests.find((request) =>
      request.method === 'POST' && request.path.endsWith('/instances')
    );
    expect(create?.body).toMatchObject({
      displayName: 'Invoice Perfect Production Redis',
      tier: 'BASIC',
      memorySizeGb: 1,
      redisVersion: 'REDIS_7_2',
      authorizedNetwork: `projects/${PROJECT_ID}/global/networks/default`,
      connectMode: 'DIRECT_PEERING',
      authEnabled: true,
      transitEncryptionMode: 'DISABLED',
    });
    expect(JSON.stringify(result.receipt)).not.toContain(REDIS_AUTH);
    expect(JSON.stringify(result.receipt)).not.toContain(SERVICE_ACCOUNT_SECRET);
    expect(JSON.stringify(result.receipt)).not.toContain('redis://');
  });

  it('preserves the deterministic resource id when create outcome is unknown', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/instances') && method === 'GET') {
        return response({ instances: [] });
      }
      if (url.pathname.endsWith('/instances') && method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'GET') {
        return response({ error: 'temporarily unavailable' }, 503);
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe(RESOURCE_NAME);
    expect(result.receipt.data).toMatchObject({
      instanceId: RESOURCE_NAME,
      mutationAttempted: true,
      resourceCreated: 'unknown',
    });
  });

  it('waits for terminal absence after deletion', async () => {
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_ATTEMPTS', '4');
    let deleted = false;
    let readsAfterDelete = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'GET') {
        if (!deleted) return response(instance());
        readsAfterDelete += 1;
        return readsAfterDelete === 1
          ? response(instance({ state: 'DELETING' }))
          : response({ error: 'not found' }, 404);
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'DELETE') {
        deleted = true;
        return response({
          name: `projects/${PROJECT_ID}/locations/${REGION}/operations/delete-1`,
        });
      }
      if (url.pathname.endsWith('/operations/delete-1') && method === 'GET') {
        return response({ done: true });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const receipt = await adapter.destroy(component());

    expect(receipt.success).toBe(true);
    expect(readsAfterDelete).toBe(2);
  });

  it('observes the durable full resource name before fallback display names', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/${RESOURCE_NAME}`) {
        return response(instance({ displayName: 'Renamed outside Hypervibe' }));
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const observed = await adapter.observeCache(environment(), component());

    expect(observed).toMatchObject({
      externalId: RESOURCE_NAME,
      name: 'Renamed outside Hypervibe',
      status: 'running',
    });
  });
});
