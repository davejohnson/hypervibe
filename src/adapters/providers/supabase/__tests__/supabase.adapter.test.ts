import { describe, expect, it, vi, afterEach } from 'vitest';
import { SupabaseAdapter } from '../supabase.adapter.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function makeEnv(name = 'production'): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name,
    platformBindings: {},
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

describe('SupabaseAdapter.provision', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refuses to create a same-name project when one already exists', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/projects') && init?.method === 'GET') {
        return jsonResponse([
          { id: 'supabase-1', name: 'production-db', organization_id: 'org-1', region: 'us-east-1', status: 'ACTIVE_HEALTHY' },
        ]);
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('Supabase project "production-db" already exists');
    expect(result.receipt.error).toContain('supabase-1');
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/projects$/),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('refuses to create when existing-project lookup fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/projects') && init?.method === 'GET') {
        return jsonResponse({ message: 'forbidden' }, 403);
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('refused to create a new project');
    expect(result.receipt.error).toContain('Supabase API error: 403');
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/projects$/),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('creates a project only after proving no same-name project exists', async () => {
    vi.stubEnv('HYPERVIBE_SUPABASE_READY_ATTEMPTS', '0');
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/projects') && init?.method === 'GET') {
        return jsonResponse([]);
      }
      if (href.endsWith('/projects') && init?.method === 'POST') {
        return jsonResponse({
          id: 'supabase-new',
          name: 'production-db',
          organization_id: 'org-1',
          region: 'us-east-1',
          status: 'COMING_UP',
          database: {
            host: 'db.supabase-new.supabase.co',
            port: 5432,
            name: 'postgres',
            user: 'postgres',
            password: 'generated',
          },
        });
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe('supabase-new');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/projects$/),
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/projects$/),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('uses resourceName for provider identity instead of the logical database name', async () => {
    vi.stubEnv('HYPERVIBE_SUPABASE_READY_ATTEMPTS', '0');
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/projects') && init?.method === 'GET') return jsonResponse([]);
      if (href.endsWith('/projects') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string };
        return jsonResponse({
          id: 'supabase-scoped',
          name: body.name,
          organization_id: 'org-1',
          region: 'us-east-1',
          status: 'COMING_UP',
        });
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'), {
      databaseName: 'app',
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt.success).toBe(true);
    const create = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      name: 'invoice-perfect-production-postgres',
    });
  });

  it('observes a bound project by external id and propagates non-404 read failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'supabase-1',
        name: 'invoice-perfect-production-postgres',
        organization_id: 'org-1',
        region: 'us-east-1',
        status: 'ACTIVE_HEALTHY',
      }))
      .mockResolvedValueOnce(jsonResponse({ message: 'unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'supabase-1',
      bindings: { provider: 'supabase' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(adapter.observeDatabase(makeEnv(), component)).resolves.toMatchObject({
      externalId: 'supabase-1',
      status: 'active_healthy',
    });
    await expect(adapter.observeDatabase(makeEnv(), component)).rejects.toThrow(/503/);
  });

  it('waits for terminal absence after Supabase accepts deletion', async () => {
    vi.stubEnv('HYPERVIBE_SUPABASE_DELETE_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_SUPABASE_DELETE_DELAY_MS', '0');
    let projectRead = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      if (href.endsWith('/projects/supabase-1') && method === 'GET') {
        projectRead += 1;
        return projectRead < 3
          ? jsonResponse({
              id: 'supabase-1',
              name: 'invoice-perfect-production-postgres',
              organization_id: 'org-1',
              status: projectRead === 1 ? 'ACTIVE_HEALTHY' : 'GOING_DOWN',
            })
          : jsonResponse({ message: 'not found' }, 404);
      }
      if (href.endsWith('/projects/supabase-1') && method === 'DELETE') {
        return jsonResponse({});
      }
      throw new Error(`unexpected request: ${method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'supabase-1',
      bindings: { provider: 'supabase' },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Deleted Supabase project');
    expect(projectRead).toBe(3);
  });

  it('treats an already-absent Supabase project as idempotent success', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ message: 'not found' }, 404);
      throw new Error(`unexpected request: ${init?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'supabase-missing',
      bindings: { provider: 'supabase' },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already absent');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('treats a not-found race during Supabase deletion as idempotent success', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return jsonResponse({
          id: 'supabase-race',
          name: 'invoice-perfect-production-postgres',
          organization_id: 'org-1',
          status: 'GOING_DOWN',
        });
      }
      if (method === 'DELETE') return jsonResponse({ message: 'not found' }, 404);
      throw new Error(`unexpected request: ${method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'supabase-race',
      bindings: { provider: 'supabase' },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already absent');
  });

  it('does not mistake a failed Supabase deletion preflight for absence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'unavailable' }, 503)));
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'supabase-unknown',
      bindings: { provider: 'supabase' },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
  });
});
