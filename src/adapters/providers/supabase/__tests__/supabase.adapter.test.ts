import { describe, expect, it, vi, afterEach } from 'vitest';
import { SupabaseAdapter } from '../supabase.adapter.js';
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
});
