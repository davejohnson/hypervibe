import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { RenderCacheAdapter } from '../render-cache.adapter.js';

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

function makeComponent(externalId = 'red-render-1'): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'redis',
    externalId,
    bindings: { provider: 'render', instanceId: externalId },
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

async function connectedAdapter(): Promise<RenderCacheAdapter> {
  const adapter = new RenderCacheAdapter();
  await adapter.connect({
    apiKey: 'rnd_test-key',
    ownerId: 'tea-owner-1',
    region: 'oregon',
    keyValuePlan: 'starter',
    keyValuePersistenceMode: 'journal_snapshot',
    keyValueMaxmemoryPolicy: 'noeviction',
  });
  return adapter;
}

function mutationCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) =>
    !['GET', 'HEAD'].includes(
      (call[1] as RequestInit | undefined)?.method ?? 'GET'
    )
  );
}

describe('RenderCacheAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does not create when Key Value observation is unknown', async () => {
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

  it('blocks name matches instead of silently adopting one', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      {
        keyValue: {
          id: 'red-render-1',
          name: 'invoice-perfect-production-redis',
          status: 'available',
        },
        cursor: 'cursor-1',
      },
      {
        keyValue: {
          id: 'red-render-2',
          name: 'invoice-perfect-production-redis',
          status: 'available',
        },
        cursor: 'cursor-2',
      },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-redis',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('red-render-1');
    expect(result.receipt.error).toContain('red-render-2');
    expect(result.receipt.error).toContain('hv_import');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('creates persistent Key Value and keeps the connection secret out of receipts', async () => {
    vi.stubEnv('HYPERVIBE_RENDER_DATABASE_READY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_RENDER_DATABASE_READY_DELAY_MS', '0');
    const internal =
      'rediss://red-render:cache-secret@red-render.internal:6379';
    const external =
      'rediss://red-render:cache-secret@oregon-key-value.render.com:6379';
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/key-value' && method === 'GET') {
        return jsonResponse([]);
      }
      if (url.pathname === '/v1/key-value' && method === 'POST') {
        return jsonResponse({
          id: 'red-created',
          name: 'invoice-perfect-production-redis',
          status: 'creating',
          region: 'oregon',
          plan: 'starter',
        }, 201);
      }
      if (url.pathname === '/v1/key-value/red-created' && method === 'GET') {
        return jsonResponse({
          id: 'red-created',
          name: 'invoice-perfect-production-redis',
          status: 'available',
          region: 'oregon',
          plan: 'starter',
        });
      }
      if (
        url.pathname === '/v1/key-value/red-created/connection-info'
        && method === 'GET'
      ) {
        return jsonResponse({
          internalConnectionString: internal,
          externalConnectionString: external,
          cliCommand: 'valkey-cli with cache-secret',
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
    expect(result.component.externalId).toBe('red-created');
    expect(result.connectionUrl).toBe(internal);
    expect(result.envVars).toEqual({ REDIS_URL: internal });
    expect(result.component.bindings).toMatchObject({
      provider: 'render',
      instanceId: 'red-created',
      externalConnectionString: external,
    });
    expect(JSON.stringify(result.receipt)).not.toContain('cache-secret');

    const createCall = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === 'POST'
    ) as [string, RequestInit] | undefined;
    expect(JSON.parse(String(createCall![1].body))).toEqual({
      name: 'invoice-perfect-production-redis',
      ownerId: 'tea-owner-1',
      plan: 'starter',
      region: 'oregon',
      maxmemoryPolicy: 'noeviction',
      persistenceMode: 'journal_snapshot',
    });
  });

  it('treats provider-confirmed preflight absence as idempotent deletion', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'not found' }, 404)
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.destroy(makeComponent())).resolves.toMatchObject({
      success: true,
      message: expect.stringContaining('already absent'),
    });
    expect(mutationCalls(fetchMock)).toEqual([]);
  });
});
