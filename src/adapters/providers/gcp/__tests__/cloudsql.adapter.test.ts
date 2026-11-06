import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { CloudSqlAdapter } from '../cloudsql.adapter.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

describe('CloudSqlAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function connectedAdapter(): Promise<CloudSqlAdapter> {
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
    return adapter;
  }

  it('verifies successfully when the SQL Admin API probe succeeds', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/instances?maxResults=1' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ items: [] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(result.email).toBe('deploy@gcp-project.iam.gserviceaccount.com');
  });

  it('fails verification with an actionable error when the SQL Admin API probe is denied', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/instances?maxResults=1' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          error: {
            code: 403,
            message: 'The caller does not have permission',
            status: 'PERMISSION_DENIED',
          },
        }, { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('roles/cloudsql.viewer');
    expect(result.error).toContain('roles/cloudsql.client');
    expect(result.error).toContain('roles/cloudsql.admin');
    expect(result.error).toContain('sqladmin.googleapis.com');
    expect(result.error).toContain('serviceAccount:deploy@gcp-project.iam.gserviceaccount.com');
  });

  it('fails verification with status and body on non-403 SQL Admin API errors', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/instances?maxResults=1' && (init?.method ?? 'GET') === 'GET') {
        return new Response('backend unavailable', { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
    expect(result.error).toContain('backend unavailable');
  });

  it('lists differently named Cloud SQL instances with scoped provider identities', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/instances?maxResults=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          items: [{
            name: 'customer-facing-primary',
            state: 'RUNNABLE',
            databaseVersion: 'POSTGRES_15',
            region: 'northamerica-northeast1',
            connectionName: 'gcp-project:northamerica-northeast1:customer-facing-primary',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectDatabaseResources({ resource: 'database', limit: 25 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'database',
      project: { id: 'gcp-project' },
      databases: [{
        id: 'customer-facing-primary',
        engine: 'postgres',
        status: 'running',
        providerScope: { projectId: 'gcp-project', region: 'northamerica-northeast1' },
      }],
      truncated: false,
      partial: false,
    });
  });

  it('uses exact Cloud SQL identity lookup and preserves non-not-found errors', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/instances/legacy-db')) {
        return new Response('permission denied', { status: 403 });
      }
      throw new Error(`Unexpected fetch: GET ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.inspectDatabaseResources({ resource: 'database', id: 'legacy-db', limit: 1 }))
      .rejects.toThrow('403 permission denied');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an exact Cloud SQL lookup that returns a different instance identity', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      name: 'different-instance',
      state: 'RUNNABLE',
      databaseVersion: 'POSTGRES_15',
      region: 'us-central1',
    })));

    await expect(adapter.inspectDatabaseResources({
      resource: 'database',
      id: 'expected-instance',
      limit: 1,
    })).rejects.toThrow('exact lookup for expected-instance returned different-instance');
  });

  it('inventories project-level retained backups with exact scoped identities', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/backups?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          backups: [{
            name: 'projects/gcp-project/backups/backup-123',
            sourceInstance: 'projects/gcp-project/instances/legacy-db',
            type: 'FINAL',
            state: 'SUCCESSFUL',
            instanceDeletionTime: '2026-08-17T12:00:00Z',
            maxChargeableBytes: '4294967296',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectBackupResources({ resource: 'backup', limit: 25 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'backup',
      backups: [{
        id: 'projects/gcp-project/backups/backup-123',
        name: 'backup-123',
        type: 'FINAL',
        providerScope: { projectId: 'gcp-project' },
        cleanupSupported: true,
      }],
      truncated: false,
      partial: false,
    });
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

      if (url.endsWith('/instances/postgres-4a1633ab7b') && method === 'GET') {
        return Response.json({
          name: 'postgres-4a1633ab7b',
          state: 'RUNNABLE',
          databaseVersion: 'POSTGRES_15',
          region: 'us-central1',
          replicaNames: ['postgres-4a1633ab7b-rr-analytics'],
          settings: {
            availabilityType: 'REGIONAL',
            backupConfiguration: {
              enabled: true,
              pointInTimeRecoveryEnabled: true,
              transactionLogRetentionDays: 7,
              backupRetentionSettings: { retentionUnit: 'COUNT', retainedBackups: 8 },
            },
          },
        });
      }
      if (url.endsWith('/instances/postgres-4a1633ab7b-rr-analytics') && method === 'GET') {
        return Response.json({
          name: 'postgres-4a1633ab7b-rr-analytics',
          state: 'RUNNABLE',
          databaseVersion: 'POSTGRES_15',
          region: 'us-west1',
          connectionName: 'gcp-project:us-west1:postgres-4a1633ab7b-rr-analytics',
          masterInstanceName: 'postgres-4a1633ab7b',
          settings: {
            tier: 'db-custom-2-7680',
            userLabels: { 'hypervibe-replica': 'analytics' },
          },
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
      externalId: 'postgres-4a1633ab7b',
      providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      name: 'postgres-4a1633ab7b',
      status: 'running',
      resilience: {
        availability: 'regional',
        backupPolicy: {
          enabled: true,
          pitrEnabled: true,
          retainedBackups: 8,
          pitrRetentionDays: 7,
        },
        replicas: [{
          name: 'analytics',
          externalId: 'postgres-4a1633ab7b-rr-analytics',
          status: 'running',
          region: 'us-west1',
          tier: 'db-custom-2-7680',
          connectionName: 'gcp-project:us-west1:postgres-4a1633ab7b-rr-analytics',
        }],
      },
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

      if (url.endsWith('/instances/postgres-4a1633ab7b') && method === 'GET') {
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

  it('propagates Cloud SQL observation errors instead of treating them as absence', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('backend unavailable', { status: 503 })
    ));
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(adapter.observeDatabase(environment)).rejects.toThrow(/503.*backend unavailable/);
  });

  it('opens and releases a local authenticated connector for one database operation', async () => {
    const adapter = await connectedAdapter();
    const startLocalProxy = vi.spyOn(Connector.prototype, 'startLocalProxy').mockResolvedValue();
    const close = vi.spyOn(Connector.prototype, 'close').mockImplementation(() => {});
    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {},
      createdAt: now,
      updatedAt: now,
    };
    const component: Component = {
      id: 'component-1',
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        connectionName: 'gcp-project:us-central1:production-postgres',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        username: 'postgres',
        password: 'db-secret',
        database: 'app',
      },
      createdAt: now,
      updatedAt: now,
    };

    const access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);

    expect(access).toMatchObject({
      source: 'private_connector',
      temporary: true,
    });
    expect(access.releaseToken).toEqual(expect.any(String));
    expect(access.connectionUrl).toMatch(/^postgresql:\/\/postgres:db-secret@localhost\/app\?host=/);
    expect(startLocalProxy).toHaveBeenCalledWith({
      instanceConnectionName: 'gcp-project:us-central1:production-postgres',
      ipType: IpAddressTypes.PUBLIC,
      listenOptions: { path: expect.stringMatching(/hv-cloudsql-.*\.s\.PGSQL\.5432$/) },
    });

    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);
    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes a failed connector acquisition before surfacing the error', async () => {
    const adapter = await connectedAdapter();
    vi.spyOn(Connector.prototype, 'startLocalProxy').mockRejectedValue(new Error('connector denied'));
    const close = vi.spyOn(Connector.prototype, 'close').mockImplementation(() => {});
    const now = new Date();
    const environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    } as Environment;
    const component = {
      id: 'component-1', environmentId: environment.id, type: 'postgres', externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql', connectionName: 'gcp-project:us-central1:production-postgres',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        username: 'postgres', password: 'db-secret', database: 'app',
      },
      createdAt: now, updatedAt: now,
    } as Component;

    await expect(adapter.acquireTemporaryDatabaseAccess(environment, component, 5432))
      .rejects.toThrow('connector denied');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
