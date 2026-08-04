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
          region: 'us-central1',
          replicaNames: ['production-postgres-rr-analytics'],
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
      if (url.endsWith('/instances/production-postgres-rr-analytics') && method === 'GET') {
        return Response.json({
          name: 'production-postgres-rr-analytics',
          state: 'RUNNABLE',
          databaseVersion: 'POSTGRES_15',
          region: 'us-west1',
          connectionName: 'gcp-project:us-west1:production-postgres-rr-analytics',
          masterInstanceName: 'production-postgres',
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
      externalId: 'production-postgres',
      name: 'production-postgres',
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
          externalId: 'production-postgres-rr-analytics',
          status: 'running',
          region: 'us-west1',
          tier: 'db-custom-2-7680',
          connectionName: 'gcp-project:us-west1:production-postgres-rr-analytics',
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

  it('patches and verifies the provider-managed backup policy', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/primary-1') && method === 'PATCH') {
        return Response.json({ name: 'backup-op' });
      }
      if (url.endsWith('/operations/backup-op') && method === 'GET') {
        return Response.json({ name: 'backup-op', status: 'DONE' });
      }
      if (url.endsWith('/instances/primary-1') && method === 'GET') {
        return Response.json({
          name: 'primary-1', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15',
          settings: {
            backupConfiguration: {
              enabled: true,
              pointInTimeRecoveryEnabled: true,
              transactionLogRetentionDays: 7,
              backupRetentionSettings: { retentionUnit: 'COUNT', retainedBackups: 8 },
            },
          },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const component: Component = {
      id: 'component-1', environmentId: 'env-1', type: 'postgres', externalId: 'primary-1',
      bindings: { provider: 'cloudsql', instanceId: 'primary-1' }, createdAt: now, updatedAt: now,
    };
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const receipt = await adapter.configureBackupPolicy(environment, component, {
      retainedBackups: 8,
      pitrRetentionDays: 7,
    });

    expect(receipt.success).toBe(true);
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      settings: {
        backupConfiguration: {
          enabled: true,
          pointInTimeRecoveryEnabled: true,
          transactionLogRetentionDays: 7,
          backupRetentionSettings: { retainedBackups: 8 },
        },
      },
    });
  });

  it('provisions a labelled read replica and returns only its durable binding', async () => {
    const adapter = await connectedAdapter();
    let targetReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/primary-1') && method === 'GET') {
        return Response.json({
          name: 'primary-1', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', region: 'us-central1', settings: { tier: 'db-custom-1-3840' },
        });
      }
      if (url.endsWith('/instances/primary-1-rr-analytics') && method === 'GET') {
        targetReads += 1;
        if (targetReads === 1) return new Response('missing', { status: 404 });
        return Response.json({
          name: 'primary-1-rr-analytics', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', region: 'us-west1',
          connectionName: 'gcp-project:us-west1:primary-1-rr-analytics', masterInstanceName: 'primary-1',
          ipAddresses: [{ type: 'PRIMARY', ipAddress: '203.0.113.10' }],
          settings: { tier: 'db-custom-2-7680', userLabels: { 'hypervibe-managed': 'true', 'hypervibe-replica': 'analytics' } },
        });
      }
      if (url.endsWith('/instances') && method === 'POST') return Response.json({ name: 'replica-op' });
      if (url.endsWith('/operations/replica-op') && method === 'GET') return Response.json({ name: 'replica-op', status: 'DONE' });
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const component: Component = {
      id: 'component-1', environmentId: 'env-1', type: 'postgres', externalId: 'primary-1',
      bindings: { provider: 'cloudsql', instanceId: 'primary-1', username: 'app', password: 'secret', database: 'app', port: 5432 },
      createdAt: now, updatedAt: now,
    };
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.provisionReadReplica(environment, component, 'analytics', {
      region: 'us-west1', tier: 'db-custom-2-7680',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.replica).toMatchObject({
      externalId: 'primary-1-rr-analytics', region: 'us-west1', tier: 'db-custom-2-7680',
      connectionName: 'gcp-project:us-west1:primary-1-rr-analytics',
    });
    const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      name: 'primary-1-rr-analytics',
      masterInstanceName: 'primary-1',
      settings: { userLabels: { 'hypervibe-managed': 'true', 'hypervibe-replica': 'analytics' } },
    });
  });

  it('refuses to delete a replica when provider ownership identity does not match', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/replica-1') && method === 'GET') {
        return Response.json({
          name: 'replica-1', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', masterInstanceName: 'different-primary',
          settings: { userLabels: { 'hypervibe-replica': 'analytics' } },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const component: Component = {
      id: 'component-1', environmentId: 'env-1', type: 'postgres', externalId: 'primary-1',
      bindings: { provider: 'cloudsql', instanceId: 'primary-1' }, createdAt: now, updatedAt: now,
    };
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const receipt = await adapter.destroyReadReplica(environment, component, 'analytics', { externalId: 'replica-1' });

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('Refusing to delete');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
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
        username: 'postgres', password: 'db-secret', database: 'app',
      },
      createdAt: now, updatedAt: now,
    } as Component;

    await expect(adapter.acquireTemporaryDatabaseAccess(environment, component, 5432))
      .rejects.toThrow('connector denied');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('waits for terminal absence after Cloud SQL accepts deletion', async () => {
    vi.stubEnv('HYPERVIBE_CLOUDSQL_DELETE_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_CLOUDSQL_DELETE_DELAY_MS', '0');
    const adapter = await connectedAdapter();
    let instanceRead = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        instanceRead += 1;
        return instanceRead < 3
          ? Response.json({
              name: 'production-postgres',
              state: instanceRead === 1 ? 'RUNNABLE' : 'PENDING_DELETE',
            })
          : new Response('not found', { status: 404 });
      }
      if (url.endsWith('/instances/production-postgres') && method === 'DELETE') {
        return Response.json({ name: 'delete-instance-op' });
      }
      if (url.endsWith('/operations/delete-instance-op') && method === 'GET') {
        return Response.json({ name: 'delete-instance-op', status: 'DONE' });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: { provider: 'cloudsql' },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Deleted Cloud SQL instance');
    expect(instanceRead).toBe(3);
  });

  it('treats an already-absent Cloud SQL instance as idempotent success', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response('not found', { status: 404 });
      throw new Error(`Unexpected request: ${init?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: { provider: 'cloudsql' },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already absent');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('does not mistake a failed Cloud SQL deletion preflight for absence', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('backend unavailable', { status: 503 })));
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: { provider: 'cloudsql' },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('503 backend unavailable');
  });
});
