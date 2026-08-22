import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { DigitalOceanCacheAdapter } from '../digitalocean-cache.adapter.js';

function makeEnvironment(name = 'production'): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name,
    platformBindings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeComponent(externalId = 'do-valkey-1'): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'redis',
    externalId,
    bindings: {
      provider: 'digitalocean',
      instanceId: externalId,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function connectedAdapter(): Promise<DigitalOceanCacheAdapter> {
  const adapter = new DigitalOceanCacheAdapter();
  await adapter.connect({
    apiToken: 'dop_v1_test-token',
    region: 'sfo3',
    databaseSize: 'db-s-1vcpu-1gb',
    postgresVersion: '17',
    valkeyVersion: '8',
  });
  return adapter;
}

function mutationCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined;
    return !['GET', 'HEAD'].includes(init?.method ?? 'GET');
  });
}

describe('DigitalOceanCacheAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('creates Redis-compatible Valkey only after complete absence', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '2');
    const connectionUrl =
      'rediss://default:cache-secret@private-valkey-do-user.db.ondigitalocean.com:25061';
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases' && method === 'GET') {
        return jsonResponse({ databases: [], links: {} });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        return jsonResponse({
          database: {
            id: 'do-valkey-created',
            name: 'invoice-perfect-production-redis',
            engine: 'valkey',
            status: 'creating',
            region: 'sfo3',
          },
        }, 201);
      }
      if (
        url.pathname === '/v2/databases/do-valkey-created'
        && method === 'GET'
      ) {
        return jsonResponse({
          database: {
            id: 'do-valkey-created',
            name: 'invoice-perfect-production-redis',
            engine: 'valkey',
            status: 'online',
            region: 'sfo3',
            connection: { uri: connectionUrl },
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-redis',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe('do-valkey-created');
    expect(result.connectionUrl).toBe(connectionUrl);
    expect(result.envVars).toEqual({ REDIS_URL: connectionUrl });
    expect(result.component.bindings).toMatchObject({
      provider: 'digitalocean',
      instanceId: 'do-valkey-created',
      engine: 'valkey',
      region: 'sfo3',
    });
    expect(JSON.stringify(result.receipt)).not.toContain('cache-secret');

    const createCall = fetchMock.mock.calls.find((call) => {
      const [rawUrl, init] = call as [string, RequestInit];
      return new URL(rawUrl).pathname === '/v2/databases'
        && init.method === 'POST';
    }) as [string, RequestInit] | undefined;
    expect(JSON.parse(String(createCall![1].body))).toEqual({
      name: 'invoice-perfect-production-redis',
      engine: 'valkey',
      version: '8',
      region: 'sfo3',
      size: 'db-s-1vcpu-1gb',
      num_nodes: 1,
      tags: ['hypervibe'],
    });
  });

  it('does not create when existing-resource observation is unknown', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'temporarily unavailable' }, 503)
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-redis',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('503');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('blocks duplicate name matches instead of choosing or adopting one', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      databases: [
        {
          id: 'do-valkey-1',
          name: 'invoice-perfect-production-redis',
          engine: 'valkey',
        },
        {
          id: 'do-valkey-2',
          name: 'invoice-perfect-production-redis',
          engine: 'valkey',
        },
      ],
      links: {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-redis',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('do-valkey-1');
    expect(result.receipt.error).toContain('do-valkey-2');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('preserves the created Valkey identity when readiness cannot be proven', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '1');
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/databases' && method === 'GET') {
        return jsonResponse({ databases: [], links: {} });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        return jsonResponse({
          database: {
            id: 'do-valkey-pending',
            name: 'production-redis',
            engine: 'valkey',
            status: 'creating',
            region: 'sfo3',
          },
        }, 201);
      }
      if (
        url.pathname === '/v2/databases/do-valkey-pending'
        && method === 'GET'
      ) {
        return jsonResponse({
          database: {
            id: 'do-valkey-pending',
            name: 'production-redis',
            engine: 'valkey',
            status: 'creating',
            region: 'sfo3',
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment());

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('do-valkey-pending');
    expect(result.receipt.data).toMatchObject({
      clusterId: 'do-valkey-pending',
      engine: 'valkey',
      status: 'creating',
    });
  });

  it('observes a bound Valkey cluster by durable ID and propagates failures', async () => {
    let clusterReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      clusterReads += 1;
      return clusterReads === 1
        ? jsonResponse({
            database: {
              id: 'do-valkey-1',
              name: 'invoice-perfect-production-redis',
              engine: 'valkey',
              status: 'online',
            },
          })
        : jsonResponse({ message: 'forbidden' }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.observeCache(makeEnvironment(), makeComponent())
    ).resolves.toMatchObject({
      provider: 'digitalocean',
      engine: 'redis',
      externalId: 'do-valkey-1',
      providerScope: { accountUuid: 'do-account-uuid' },
      status: 'running',
    });
    await expect(
      adapter.observeCache(makeEnvironment(), makeComponent())
    ).rejects.toThrow(/403/);
  });

  it('rejects a durable ID that resolves to a different engine', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      database: {
        id: 'do-valkey-1',
        name: 'production-postgres',
        engine: 'pg',
        status: 'online',
      },
    })));
    const adapter = await connectedAdapter();

    await expect(
      adapter.observeCache(makeEnvironment(), makeComponent())
    ).rejects.toThrow(/not Redis-compatible Valkey/i);
  });

  it('treats provider-confirmed preflight absence as idempotent deletion', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'not found' }, 404)
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.destroy(makeComponent());

    expect(receipt.success).toBe(true);
    expect(receipt.message).toContain('already absent');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('does not mistake a failed deletion preflight for absence', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'forbidden' }, 403)
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.destroy(makeComponent());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('403');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });
});
