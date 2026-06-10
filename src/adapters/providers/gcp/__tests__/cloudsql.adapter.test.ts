import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudSqlAdapter } from '../cloudsql.adapter.js';
import type { Component } from '../../../../domain/entities/component.entity.js';

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
});
