import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudSqlAdapter } from '../cloudsql.adapter.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

describe('CloudSqlAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a missing logical database on an existing Cloud SQL instance', async () => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/instances/app-postgres/databases/app') && method === 'GET') {
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith('/instances/app-postgres/databases') && method === 'POST') {
        return Response.json({ name: 'db-create-op' });
      }
      if (url.endsWith('/operations/db-create-op') && method === 'GET') {
        return Response.json({ name: 'db-create-op', status: 'DONE' });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const component: Component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'app-postgres',
      bindings: {
        provider: 'cloudsql',
        database: 'app',
      },
      createdAt: now,
      updatedAt: now,
    };

    const receipt = await adapter.ensureDatabase(component);

    expect(receipt.success).toBe(true);
    expect(receipt.data).toMatchObject({
      instanceName: 'app-postgres',
      databaseName: 'app',
      created: true,
    });

    const createCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith('/instances/app-postgres/databases') && init?.method === 'POST'
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ name: 'app' });
  });

  it('treats an existing logical database as successful reuse', async () => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/instances/app-postgres/databases/app') && method === 'GET') {
        return Response.json({ name: 'app' });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const component: Component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'app-postgres',
      bindings: {
        provider: 'cloudsql',
        database: 'app',
      },
      createdAt: now,
      updatedAt: now,
    };

    const receipt = await adapter.ensureDatabase(component);

    expect(receipt.success).toBe(true);
    expect(receipt.data).toMatchObject({
      instanceName: 'app-postgres',
      databaseName: 'app',
      created: false,
    });
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('observes a provisioned Cloud SQL instance for an environment', async () => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        return Response.json({
          name: 'production-postgres',
          state: 'RUNNABLE',
          databaseVersion: 'POSTGRES_15',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };

    const observed = await adapter.observeDatabase(environment);

    expect(observed).toEqual({
      provider: 'cloudsql',
      engine: 'postgres',
      externalId: 'production-postgres',
      name: 'production-postgres',
      status: 'running',
    });
  });

  it('returns null from observeDatabase when no instance exists for the environment', async () => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        return new Response('not found', { status: 404 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };

    await expect(adapter.observeDatabase(environment)).resolves.toBeNull();
  });
});
