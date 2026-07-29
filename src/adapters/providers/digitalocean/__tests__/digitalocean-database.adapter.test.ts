import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import {
  runMockDatabaseLifecycleContract,
} from '../../__tests__/database-lifecycle.contract.js';
import { DigitalOceanDatabaseAdapter } from '../digitalocean-database.adapter.js';

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

function makeComponent(externalId = 'do-postgres-1'): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'postgres',
    externalId,
    bindings: {
      provider: 'digitalocean',
      instanceId: externalId,
      database: 'app',
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

async function connectedAdapter(): Promise<DigitalOceanDatabaseAdapter> {
  const adapter = new DigitalOceanDatabaseAdapter();
  await adapter.connect({
    apiToken: 'dop_v1_test-token',
    region: 'sfo3',
    databaseSize: 'db-s-1vcpu-1gb',
    postgresVersion: '17',
    valkeyVersion: '8',
  });
  return adapter;
}

runMockDatabaseLifecycleContract({
  displayName: 'DigitalOcean',
  externalIds: ['do-postgres-1', 'do-postgres-2'],
  resourceName: 'invoice-perfect-production-postgres',
  createAdapter: connectedAdapter,
  makeEnvironment,
  makeComponent,
  isListRequest: (url, init) =>
    url.pathname === '/v2/databases' && (init?.method ?? 'GET') === 'GET',
  isItemRequest: (url, externalId, init) =>
    url.pathname === `/v2/databases/${externalId}`
    && (init?.method ?? 'GET') === 'GET',
  listResponse: (databases) => ({
    databases: databases.map((database) => ({
      ...database,
      engine: 'pg',
      status: 'online',
    })),
    links: {},
  }),
});

describe('DigitalOceanDatabaseAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('validates credentials instead of accepting an unchecked cast', async () => {
    const adapter = new DigitalOceanDatabaseAdapter();

    await expect(adapter.connect({ region: 'sfo3' })).rejects.toThrow(
      /personal access token/i
    );
  });

  it('verifies bearer credentials without exposing the token', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => jsonResponse({
      databases: [],
      links: {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.verify()).resolves.toEqual({ success: true });

    const [rawUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe('/v2/databases');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('per_page')).toBe('1');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer dop_v1_test-token',
    });
  });

  it('creates PostgreSQL only after complete absence and returns secret-safe receipts', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '4');
    const providerUri =
      'postgresql://doadmin:database-secret@private-db-do-user.db.ondigitalocean.com:25060/defaultdb?sslmode=require';
    let clusterRead = 0;
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
            id: 'do-created',
            name: 'invoice-perfect-production-postgres',
            engine: 'pg',
            status: 'creating',
            region: 'sfo3',
          },
        }, 201);
      }
      if (url.pathname === '/v2/databases/do-created' && method === 'GET') {
        clusterRead += 1;
        return jsonResponse({
          database: {
            id: 'do-created',
            name: 'invoice-perfect-production-postgres',
            engine: 'pg',
            status: clusterRead === 1 ? 'creating' : 'online',
            region: 'sfo3',
            connection: { uri: providerUri },
          },
        });
      }
      if (url.pathname === '/v2/databases/do-created/dbs' && method === 'GET') {
        return jsonResponse({ dbs: [{ name: 'defaultdb' }] });
      }
      if (url.pathname === '/v2/databases/do-created/dbs' && method === 'POST') {
        return jsonResponse({ db: { name: 'app' } }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-postgres',
      databaseName: 'app',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe('do-created');
    expect(result.connectionUrl).toBe(
      'postgresql://doadmin:database-secret@private-db-do-user.db.ondigitalocean.com:25060/app?sslmode=require'
    );
    expect(result.component.bindings).toMatchObject({
      provider: 'digitalocean',
      instanceId: 'do-created',
      engine: 'pg',
      database: 'app',
      region: 'sfo3',
    });
    expect(result.envVars).toMatchObject({
      DATABASE_URL: result.connectionUrl,
      DIRECT_URL: result.connectionUrl,
      DATABASE_SSL: 'true',
      PGHOST: 'private-db-do-user.db.ondigitalocean.com',
      PGPORT: '25060',
      PGUSER: 'doadmin',
      PGPASSWORD: 'database-secret',
      PGDATABASE: 'app',
    });
    expect(JSON.stringify(result.receipt)).not.toContain('database-secret');
    expect(clusterRead).toBe(2);

    const createCall = fetchMock.mock.calls.find((call) => {
      const [rawUrl, init] = call as [string, RequestInit];
      return new URL(rawUrl).pathname === '/v2/databases'
        && init.method === 'POST';
    }) as [string, RequestInit] | undefined;
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall![1].body))).toEqual({
      name: 'invoice-perfect-production-postgres',
      engine: 'pg',
      version: '17',
      region: 'sfo3',
      size: 'db-s-1vcpu-1gb',
      num_nodes: 1,
      tags: ['hypervibe'],
    });
  });

  it('preserves the created cluster identity when readiness cannot be proven', async () => {
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
            id: 'do-pending',
            name: 'production-postgres',
            engine: 'pg',
            status: 'creating',
            region: 'sfo3',
          },
        }, 201);
      }
      if (url.pathname === '/v2/databases/do-pending' && method === 'GET') {
        return jsonResponse({
          database: {
            id: 'do-pending',
            name: 'production-postgres',
            engine: 'pg',
            status: 'creating',
            region: 'sfo3',
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment());

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('do-pending');
    expect(result.component.bindings).toMatchObject({
      provider: 'digitalocean',
      instanceId: 'do-pending',
      engine: 'pg',
    });
    expect(result.receipt.data).toMatchObject({
      clusterId: 'do-pending',
      status: 'creating',
    });
    expect(result.connectionUrl).toBeUndefined();
  });

  it('observes a bound cluster by durable ID and propagates non-404 failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        database: {
          id: 'do-postgres-1',
          name: 'invoice-perfect-production-postgres',
          engine: 'pg',
          status: 'online',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ message: 'unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.observeDatabase(makeEnvironment(), makeComponent())
    ).resolves.toMatchObject({
      provider: 'digitalocean',
      engine: 'postgres',
      externalId: 'do-postgres-1',
      status: 'running',
    });
    await expect(
      adapter.observeDatabase(makeEnvironment(), makeComponent())
    ).rejects.toThrow(/503/);
  });

  it('follows every database-list page before proving name absence', async () => {
    let page = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/databases' && method === 'GET') {
        page += 1;
        return page === 1
          ? jsonResponse({
              databases: [{
                id: 'unrelated',
                name: 'another-cluster',
                engine: 'pg',
              }],
              links: {
                pages: {
                  next: 'https://api.digitalocean.com/v2/databases?page=2',
                },
              },
            })
          : jsonResponse({
              databases: [{
                id: 'existing-target',
                name: 'invoice-perfect-production-postgres',
                engine: 'pg',
              }],
              links: {},
            });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('existing-target');
    expect(page).toBe(2);
    expect(fetchMock.mock.calls.every((call) =>
      ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET'
    )).toBe(true);
  });

  it('rejects a durable ID that resolves to a different engine', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      database: {
        id: 'do-postgres-1',
        name: 'production-redis',
        engine: 'valkey',
        status: 'online',
      },
    })));
    const adapter = await connectedAdapter();

    await expect(
      adapter.observeDatabase(makeEnvironment(), makeComponent())
    ).rejects.toThrow(/not PostgreSQL/i);
  });

  it('waits until a deleted cluster is terminally absent', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_DELETE_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_DELETE_ATTEMPTS', '4');
    let clusterRead = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/databases/do-postgres-1' && method === 'GET') {
        clusterRead += 1;
        return clusterRead < 3
          ? jsonResponse({
              database: {
                id: 'do-postgres-1',
                name: 'invoice-perfect-production-postgres',
                engine: 'pg',
                status: clusterRead === 1 ? 'online' : 'deleting',
              },
            })
          : jsonResponse({ message: 'not found' }, 404);
      }
      if (
        url.pathname === '/v2/databases/do-postgres-1'
        && method === 'DELETE'
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.destroy(makeComponent());

    expect(receipt.success).toBe(true);
    expect(receipt.message).toContain('Deleted DigitalOcean PostgreSQL');
    expect(clusterRead).toBe(3);
  });
});
