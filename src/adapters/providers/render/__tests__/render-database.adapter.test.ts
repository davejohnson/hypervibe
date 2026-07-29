import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { runMockDatabaseLifecycleContract } from '../../__tests__/database-lifecycle.contract.js';
import { RenderDatabaseAdapter } from '../render-database.adapter.js';

function makeEnvironment(): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeComponent(externalId = 'dpg-render-1'): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'postgres',
    externalId,
    bindings: {
      provider: 'render',
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

async function connectedAdapter(): Promise<RenderDatabaseAdapter> {
  const adapter = new RenderDatabaseAdapter();
  await adapter.connect({
    apiKey: 'rnd_test-key',
    ownerId: 'tea-owner-1',
    region: 'oregon',
    postgresPlan: 'basic_256mb',
    postgresVersion: '18',
  });
  return adapter;
}

runMockDatabaseLifecycleContract({
  displayName: 'Render',
  externalIds: ['dpg-render-1', 'dpg-render-2'],
  resourceName: 'invoice-perfect-production-postgres',
  createAdapter: connectedAdapter,
  makeEnvironment,
  makeComponent,
  isListRequest: (url, init) =>
    url.pathname === '/v1/postgres' && (init?.method ?? 'GET') === 'GET',
  isItemRequest: (url, externalId, init) =>
    url.pathname === `/v1/postgres/${externalId}`
    && (init?.method ?? 'GET') === 'GET',
  listResponse: (databases) => databases.map((postgres, index) => ({
    postgres: {
      ...postgres,
      owner: { id: 'tea-owner-1', name: 'Owner' },
      status: 'available',
    },
    cursor: `cursor-${index}`,
  })),
});

describe('RenderDatabaseAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('creates Postgres only after complete absence and keeps credentials out of receipts', async () => {
    vi.stubEnv('HYPERVIBE_RENDER_DATABASE_READY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_RENDER_DATABASE_READY_DELAY_MS', '0');
    const internal =
      'postgresql://app:database-secret@dpg-render.internal:5432/app';
    const external =
      'postgresql://app:database-secret@dpg-render.oregon-postgres.render.com:5432/app?sslmode=require';
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        return jsonResponse([]);
      }
      if (url.pathname === '/v1/postgres' && method === 'POST') {
        return jsonResponse({
          id: 'dpg-created',
          name: 'invoice-perfect-production-postgres',
          status: 'creating',
          region: 'oregon',
          plan: 'basic_256mb',
        }, 201);
      }
      if (url.pathname === '/v1/postgres/dpg-created' && method === 'GET') {
        return jsonResponse({
          id: 'dpg-created',
          name: 'invoice-perfect-production-postgres',
          status: 'available',
          region: 'oregon',
          plan: 'basic_256mb',
        });
      }
      if (
        url.pathname === '/v1/postgres/dpg-created/connection-info'
        && method === 'GET'
      ) {
        return jsonResponse({
          password: 'database-secret',
          internalConnectionString: internal,
          externalConnectionString: external,
          internalConnectionPoolString: `${internal}?pool=true`,
          psqlCommand: 'secret command',
        });
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
    expect(result.component.externalId).toBe('dpg-created');
    expect(result.connectionUrl).toBe(internal);
    expect(result.component.bindings).toMatchObject({
      provider: 'render',
      instanceId: 'dpg-created',
      connectionString: internal,
      externalConnectionString: external,
      host: 'dpg-render.internal',
      username: 'app',
      password: 'database-secret',
      database: 'app',
    });
    expect(result.envVars).toMatchObject({
      DATABASE_URL: internal,
      DIRECT_URL: internal,
    });
    expect(JSON.stringify(result.receipt)).not.toContain('database-secret');

    const createCall = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === 'POST'
    ) as [string, RequestInit] | undefined;
    expect(JSON.parse(String(createCall![1].body))).toEqual({
      name: 'invoice-perfect-production-postgres',
      ownerId: 'tea-owner-1',
      plan: 'basic_256mb',
      version: '18',
      region: 'oregon',
      databaseName: 'app',
      connectionPool: 'pgbouncer',
    });
  });

  it('follows every cursor page before deciding whether a name is absent', async () => {
    let page = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        page += 1;
        if (page === 1) {
          expect(url.searchParams.get('cursor')).toBeNull();
          return jsonResponse(Array.from({ length: 100 }, (_, index) => ({
            postgres: {
              id: `dpg-unrelated-${index}`,
              name: `unrelated-${index}`,
              status: 'available',
            },
            cursor: `cursor-${index}`,
          })));
        }
        expect(url.searchParams.get('cursor')).toBe('cursor-99');
        return jsonResponse([{
          postgres: {
            id: 'dpg-existing-target',
            name: 'invoice-perfect-production-postgres',
            status: 'available',
          },
          cursor: 'cursor-target',
        }]);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('dpg-existing-target');
    expect(page).toBe(2);
    expect(fetchMock.mock.calls.every((call) =>
      ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET'
    )).toBe(true);
  });

  it('preserves a newly created database identity when readiness is still pending', async () => {
    vi.stubEnv('HYPERVIBE_RENDER_DATABASE_READY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RENDER_DATABASE_READY_DELAY_MS', '0');
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        return jsonResponse([]);
      }
      if (url.pathname === '/v1/postgres' && method === 'POST') {
        return jsonResponse({
          id: 'dpg-pending',
          name: 'production-postgres',
          status: 'creating',
          region: 'oregon',
          plan: 'basic_256mb',
        }, 201);
      }
      if (url.pathname === '/v1/postgres/dpg-pending' && method === 'GET') {
        return jsonResponse({
          id: 'dpg-pending',
          name: 'production-postgres',
          status: 'creating',
          region: 'oregon',
          plan: 'basic_256mb',
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment());

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('dpg-pending');
    expect(result.component.bindings).toMatchObject({
      provider: 'render',
      instanceId: 'dpg-pending',
    });
    expect(result.receipt.data).toMatchObject({
      postgresId: 'dpg-pending',
      status: 'creating',
    });
  });

  it('returns the existing external endpoint through an operation-scoped lease without mutation', async () => {
    const adapter = await connectedAdapter();
    const component = makeComponent();
    component.bindings.externalConnectionString =
      'postgresql://app:secret@external.render.com:5432/app';

    await expect(
      adapter.acquireTemporaryDatabaseAccess(
        makeEnvironment(),
        component,
        5432
      )
    ).resolves.toEqual({
      connectionUrl:
        'postgresql://app:secret@external.render.com:5432/app',
      source: 'direct',
      temporary: false,
    });
  });

  it('waits for provider-confirmed terminal absence after delete', async () => {
    vi.stubEnv('HYPERVIBE_RENDER_DATABASE_DELETE_ATTEMPTS', '3');
    vi.stubEnv('HYPERVIBE_RENDER_DATABASE_DELETE_DELAY_MS', '0');
    let reads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres/dpg-render-1' && method === 'GET') {
        reads += 1;
        return reads < 3
          ? jsonResponse({
              id: 'dpg-render-1',
              name: 'database',
              status: reads === 1 ? 'available' : 'unavailable',
            })
          : jsonResponse({ message: 'not found' }, 404);
      }
      if (
        url.pathname === '/v1/postgres/dpg-render-1'
        && method === 'DELETE'
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.destroy(makeComponent())).resolves.toMatchObject({
      success: true,
      message: expect.stringContaining('Deleted Render Postgres'),
    });
    expect(reads).toBe(3);
  });
});
