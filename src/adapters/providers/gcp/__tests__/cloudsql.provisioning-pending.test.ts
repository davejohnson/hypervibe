import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudSqlAdapter } from '../cloudsql.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

// Reconstructed from the 2026-10-31 disposable create: the instance remained
// PENDING_CREATE beyond ten minutes while its CREATE operation was unfinished.
// Native operation semantics: https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/operations
// Transport and time are synthetic; this does not establish live recovery.
describe('Cloud SQL incomplete provisioning', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function fixture(operationTarget = 'reviewed-postgres', options: { malformedStatus?: boolean; echoedPassword?: boolean } = {}) {
    vi.useFakeTimers();
    const adapter = new CloudSqlAdapter();
    await adapter.connect({ projectId: 'reviewed-project', region: 'us-central1', credentials: JSON.stringify({
      type: 'service_account', project_id: 'reviewed-project', private_key: 'synthetic', client_email: 'operator@reviewed-project.iam.gserviceaccount.com',
    }) });
    Object.assign(adapter, { accessToken: 'synthetic-access-token', tokenExpiry: new Date(Date.now() + 3_600_000) });
    const now = new Date();
    const environment: Environment = { id: 'environment-1', projectId: 'customer-1', name: 'test', platformBindings: {}, createdAt: now, updatedAt: now };
    let created = false, password = '';
    const requests: { url: string; method: string }[] = [];
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET'; requests.push({ url, method });
      if (url.endsWith('/instances/reviewed-postgres') && method === 'GET') return created
        ? Response.json({ kind: 'sql#instance', name: 'reviewed-postgres', project: 'reviewed-project', region: 'us-central1',
          databaseVersion: 'POSTGRES_15', state: 'PENDING_CREATE', createTime: '2026-10-31T21:20:10.027Z', connectionName: 'reviewed-project:us-central1:reviewed-postgres' })
        : new Response('', { status: 404 });
      if (url.endsWith('/instances') && method === 'POST') {
        created = true; password = JSON.parse(String(init?.body)).rootPassword;
        return Response.json({ kind: 'sql#operation', name: 'native-create-operation', operationType: 'CREATE', status: 'PENDING', targetProject: 'reviewed-project', targetId: operationTarget });
      }
      if (url.endsWith('/operations/native-create-operation') && method === 'GET') return Response.json({
        kind: 'sql#operation', name: 'native-create-operation', operationType: 'CREATE', status: options.malformedStatus ? 'NOT_A_STATE' : options.echoedPassword ? 'DONE' : 'RUNNING', targetProject: 'reviewed-project', targetId: operationTarget,
        ...(options.echoedPassword ? { error: { errors: [{ code: 'SYNTHETIC', message: `Provider echoed ${password}` }] } } : {}),
      });
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    return { adapter, environment, requests, password: () => password };
  }

  it('returns pending and preserves private credentials and the native operation after the observation budget', async () => {
    const f = await fixture();
    const work = f.adapter.provision('postgres', f.environment, { resourceName: 'reviewed-postgres', databaseName: 'app' });
    await vi.runAllTimersAsync();
    const result = await work;
    expect(result.receipt).toMatchObject({ success: false, status: 'pending' });
    expect(result.component).toMatchObject({ externalId: 'reviewed-postgres', bindings: {
      provider: 'cloudsql', username: 'postgres', database: 'app', password: f.password(),
      provisioningRecovery: { schemaVersion: 1, operationId: 'native-create-operation', phase: 'instance-operation',
        targetProject: 'reviewed-project', targetId: 'reviewed-postgres', region: 'us-central1', databaseVersion: 'POSTGRES_15' },
    } });
    expect(f.password()).not.toBe('');
    expect(JSON.stringify(result.receipt)).not.toContain(f.password());
    expect(f.requests.filter(r => r.method !== 'GET')).toEqual([{ method: 'POST', url: 'https://sqladmin.googleapis.com/v1/projects/reviewed-project/instances' }]);
  });

  it('rejects another target operation without treating it as resumable creation', async () => {
    const f = await fixture('another-postgres');
    const work = f.adapter.provision('postgres', f.environment, { resourceName: 'reviewed-postgres', databaseName: 'app' });
    await vi.runAllTimersAsync();
    const result = await work;
    expect(result.receipt.error).toContain('does not match');
    expect(result.component.bindings).not.toHaveProperty('provisioningRecovery');
    expect(f.requests.filter(r => r.method !== 'GET')).toHaveLength(1);
  });

  it('does not classify an unknown native status as pending', async () => {
    const f = await fixture('reviewed-postgres', { malformedStatus: true });
    const work = f.adapter.provision('postgres', f.environment, { resourceName: 'reviewed-postgres' });
    await vi.runAllTimersAsync();
    expect((await work).receipt.status).not.toBe('pending');
  });

  it('removes a generated credential from native failure diagnostics', async () => {
    const f = await fixture('reviewed-postgres', { echoedPassword: true });
    const work = f.adapter.provision('postgres', f.environment, { resourceName: 'reviewed-postgres' });
    await vi.runAllTimersAsync();
    const result = await work;
    expect(f.password()).not.toBe('');
    expect(JSON.stringify(result.receipt)).not.toContain(f.password());
  });
});
