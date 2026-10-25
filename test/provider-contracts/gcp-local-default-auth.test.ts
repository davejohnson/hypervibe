import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CloudRunAdapter, CloudRunCredentialsSchema } from '../../src/adapters/providers/gcp/cloudrun.adapter.js';
import { CloudSqlAdapter, CloudSqlCredentialsSchema } from '../../src/adapters/providers/gcp/cloudsql.adapter.js';
import type { Environment } from '../../src/domain/entities/environment.entity.js';
import type { Component } from '../../src/domain/entities/component.entity.js';
import { observeRuntimeAccess, planRuntimeAccess } from '../../src/domain/services/runtime-access.service.js';
import { environmentSpecSchema } from '../../src/domain/spec/spec.schema.js';
import { GcpLocalDefaultAuthentication } from '../../src/adapters/providers/gcp/gcp-local-default-authentication.js';

// Reconstructed Google OAuth refresh-token, Cloud Run v2 and SQL Admin v1
// responses. The real GoogleAuth ADC loader, refresh client and adapters execute;
// only HTTP transport is replaced. No user's ADC file or cloud is accessed.
// https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment
// https://developers.google.com/identity/protocols/oauth2/web-server#offline
// https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/testIamPermissions
const projectId = 'cloud-project';
const syntheticToken = 'synthetic-local-google-access';
const folders: string[] = [];
const adapters: Array<CloudRunAdapter | CloudSqlAdapter> = [];
const environment: Environment = { id: 'production-id', projectId: 'local-project', name: 'production',
  platformBindings: { projectId, environmentId: 'us-central1' }, createdAt: new Date(0), updatedAt: new Date(0) };

async function localFixture(status = 200, expiresIn = 3600) {
  const folder = await mkdtemp(path.join(tmpdir(), 'hv-adc-contract-')); folders.push(folder);
  const file = path.join(folder, 'adc.json');
  await writeFile(file, JSON.stringify({ type: 'authorized_user', client_id: 'synthetic-client',
    client_secret: 'synthetic-client-secret', refresh_token: 'synthetic-refresh-token', quota_project_id: 'other-quota-project' }), { mode: 0o600 });
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', file);
  const native: Array<{ url: string; method: string; authorization: string | null; quotaProject: string | null }> = [];
  const refreshes: URLSearchParams[] = [];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), headers = new Headers(init?.headers);
    if (url === 'https://oauth2.googleapis.com/token') {
      refreshes.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: expiresIn === 3600 ? syntheticToken : `${syntheticToken}-${refreshes.length}`,
        expires_in: expiresIn, token_type: 'Bearer' });
    }
    native.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization'), quotaProject: headers.get('x-goog-user-project') });
    if (url === `https://run.googleapis.com/v2/projects/${projectId}/locations/us-central1/services?pageSize=1`
      || url === `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances?maxResults=1`) {
      return Response.json(status === 200 ? {} : { error: { code: status, message: syntheticToken, status: 'PERMISSION_DENIED' } }, { status });
    }
    if (url === 'https://logging.googleapis.com/v2/entries:list') return Response.json({});
    if (url.includes(`/projects/${projectId}/instances/primary/connectSettings`)) {
      return Response.json({ error: { code: 403, message: syntheticToken, status: 'PERMISSION_DENIED' } }, { status: 403 });
    }
    throw new Error('Unexpected synthetic Google endpoint');
  });
  vi.stubGlobal('fetch', request);
  return { native, refreshes, request, file };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.disconnect();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe('GCP explicit local ADC connections', () => {
  it('prepares a separate runtime service account for an ADC user without granting a fabricated deployer principal', async () => {
    const adc = await localFixture();
    const nativeAuth = adc.request.getMockImplementation()!;
    let account: Record<string, unknown> | undefined;
    let actAs = true;
    const writes: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') return nativeAuth(input, init);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(new Headers(init?.headers).get('x-goog-user-project')).toBe('other-quota-project');
      if (url.startsWith('https://run.googleapis.com/')) return Response.json({}, { status: 404 });
      if (url.endsWith('/serviceAccounts') && init?.method === 'POST') {
        writes.push(url);
        account = { name: `projects/${projectId}/serviceAccounts/${body.accountId}@${projectId}.iam.gserviceaccount.com`,
          projectId, uniqueId: '123456789012345678901', email: `${body.accountId}@${projectId}.iam.gserviceaccount.com`, description: body.serviceAccount.description };
        return Response.json(account);
      }
      if (url.endsWith(':testIamPermissions')) {
        expect(body).toEqual({ permissions: ['iam.serviceAccounts.actAs'] });
        return Response.json(actAs ? { permissions: ['iam.serviceAccounts.actAs'] } : {});
      }
      if (url.endsWith(':getIamPolicy')) return Response.json({ etag: 'native-policy', bindings: [] });
      if (url.endsWith(':setIamPolicy')) { writes.push(url); return Response.json({ etag: 'unexpected', bindings: [] }); }
      if (init?.method === 'DELETE') { writes.push(url); account = undefined; return Response.json({}); }
      return account ? Response.json(account) : Response.json({}, { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    const adapter = new CloudRunAdapter(); adapters.push(adapter);
    await adapter.connect({ authMode: 'default', projectId });
    const driver = adapter.runtimeIdentities;
    const input = { environment, service: { name: 'web', buildConfig: {} }, mode: 'ensure' as const };
    const before = await driver.inspect(input);
    expect(before.state).toBe('action'); if (before.state !== 'action') throw new Error('Expected reviewed runtime creation');
    const created = await driver.apply({ ...input, step: before.step, attemptId: 'runtime-create',
      binding: { provider: 'cloudrun', evidence: {}, pending: { attemptId: 'runtime-create', step: before.step } } });
    expect(created.receipt.success).toBe(true);
    expect(await driver.inspect({ ...input, binding: created.binding })).toMatchObject({ state: 'ready' });
    const shared = { environment: { ...environment, platformBindings: { ...environment.platformBindings, runtimeIdentities: { web: created.binding } } },
      environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} } }),
      hosting: adapter, storageAdapters: {} };
    expect(planRuntimeAccess(await observeRuntimeAccess(shared))).toEqual([]);
    expect(writes).toHaveLength(1);
    actAs = false;
    expect(await driver.inspect({ ...input, binding: created.binding })).toMatchObject({ state: 'unknown' });
    expect(writes).toHaveLength(1);
    const cleanupInput = { ...input, binding: created.binding, mode: 'destroy' as const };
    const cleanup = await driver.inspect(cleanupInput);
    expect(cleanup.state).toBe('action'); if (cleanup.state !== 'action') throw new Error('Expected exact owned cleanup');
    const removed = await driver.apply({ ...cleanupInput, step: cleanup.step, attemptId: 'runtime-remove',
      binding: { ...created.binding!, pending: { attemptId: 'runtime-remove', step: cleanup.step } } });
    expect(removed.receipt.success).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain('/serviceAccounts/123456789012345678901');
  });

  it.each(['cloudrun', 'cloudsql'] as const)('%s rejects impersonated ADC before any token or native request', async provider => {
    const fixture = await localFixture();
    await writeFile(fixture.file, JSON.stringify({ type: 'impersonated_service_account',
      service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/operator@management-project.iam.gserviceaccount.com:generateAccessToken',
      delegates: [], source_credentials: { type: 'authorized_user', client_id: 'synthetic-client',
        client_secret: 'synthetic-client-secret', refresh_token: 'synthetic-refresh-token' } }));
    const adapter = provider === 'cloudrun' ? new CloudRunAdapter() : new CloudSqlAdapter(); adapters.push(adapter);
    await expect(adapter.connect({ authMode: 'default', projectId })).rejects.toThrow(/credential type is unsupported/);
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it('rejects a nondefault API port in both native and authenticated SDK transports', async () => {
    const fixture = await localFixture(); const auth = new GcpLocalDefaultAuthentication(projectId);
    await auth.initialize(); const token = await auth.token();
    const url = `https://sqladmin.googleapis.com:444/v1/projects/${projectId}/instances`;
    await expect(auth.request(url, { headers: { Authorization: `Bearer ${token}` } })).rejects.toThrow();
    await expect(auth.auth.request({ url })).rejects.toThrow();
    expect(fixture.native).toEqual([]);
  });

  it('rejects a success response that echoes the transient token', async () => {
    const fixture = await localFixture(); const native = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (input, init) => String(input).startsWith('https://run.googleapis.com/')
      ? Response.json({ services: [{ name: syntheticToken }] }) : native(input, init));
    const adapter = new CloudRunAdapter(); adapters.push(adapter);
    await adapter.connect({ authMode: 'default', projectId });
    const result = await adapter.verify();
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(syntheticToken);
  });

  it('does not expose refresh credentials or fall back after native token rejection', async () => {
    const fixture = await localFixture();
    fixture.request.mockImplementation(async () => Response.json({ error: 'invalid_grant',
      error_description: 'synthetic-refresh-token synthetic-client-secret' }, { status: 400 }));
    const adapter = new CloudSqlAdapter(); adapters.push(adapter);
    await adapter.connect({ authMode: 'default', projectId });
    const result = await adapter.verify();
    expect(result.success).toBe(false);
    expect(result.error).toContain('authorization remains unverified');
    expect(JSON.stringify(result)).not.toMatch(/synthetic-refresh-token|synthetic-client-secret/);
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(String(fixture.request.mock.calls[0]![0])).toBe('https://oauth2.googleapis.com/token');
    expect(fixture.request.mock.calls[0]![1]?.redirect).toBe('error');
  });

  for (const [name, factory, schema] of [
    ['Cloud Run', () => new CloudRunAdapter(), CloudRunCredentialsSchema],
    ['Cloud SQL', () => new CloudSqlAdapter(), CloudSqlCredentialsSchema],
  ] as const) {
    it(`${name} uses native user ADC with the exact selected resource project`, async () => {
      const fixture = await localFixture(); const adapter = factory(); adapters.push(adapter);
      const input = { authMode: 'default', projectId };
      expect(schema.safeParse(input).success).toBe(true);
      await adapter.connect(input);
      expect(await adapter.verify()).toMatchObject({ success: true });
      expect(fixture.refreshes).toHaveLength(1);
      expect(fixture.refreshes[0]!.get('grant_type')).toBe('refresh_token');
      expect(fixture.refreshes[0]!.get('refresh_token')).toBe('synthetic-refresh-token');
      expect(fixture.native[0]!.url).toContain(`/projects/${projectId}/`);
      expect(fixture.native.every(call => call.authorization === `Bearer ${syntheticToken}`)).toBe(true);
      expect(fixture.native.every(call => call.quotaProject === 'other-quota-project')).toBe(true);
      expect(JSON.stringify(await adapter.verify())).not.toContain(syntheticToken);
      expect(fixture.native.some(call => call.url.includes('other-quota-project'))).toBe(false);
    });

    it(`${name} keeps denied native authority distinct from missing login and omits provider echoes`, async () => {
      await localFixture(403); const adapter = factory(); adapters.push(adapter);
      await adapter.connect({ authMode: 'default', projectId });
      const result = await adapter.verify();
      expect(result.success).toBe(false); expect(result.error).toContain('403');
      expect(result.error).not.toMatch(/Not connected|serviceAccount:undefined|synthetic-local-google-access/);
    });

    it(`${name} requires explicit project and refuses mixed default/key authority`, () => {
      expect(schema.safeParse({ authMode: 'default' }).success).toBe(false);
      expect(schema.safeParse({ authMode: 'default', projectId, credentials: '{}' }).success).toBe(false);
    });
  }

  it('uses the same ADC client for actual Cloud SQL Connector transport and keeps its error value-free', async () => {
    const fixture = await localFixture(); const adapter = new CloudSqlAdapter(); adapters.push(adapter);
    await adapter.connect({ authMode: 'default', projectId });
    expect((await adapter.verify()).success).toBe(true);
    const component = { id: 'database-id', environmentId: environment.id, name: 'database', type: 'postgres',
      provider: 'cloudsql', externalId: 'primary', bindings: { instanceId: 'primary', connectionName: `${projectId}:us-central1:primary`,
        providerScope: { projectId, region: 'us-central1' }, username: 'synthetic-user', password: 'synthetic-password', database: 'app' },
      createdAt: new Date(0), updatedAt: new Date(0) } as Component;
    await expect(adapter.acquireTemporaryDatabaseAccess(environment, component, 5432)).rejects.toThrow(/Cloud SQL.*unavailable/);
    expect(fixture.native.some(call => call.url.includes('/connectSettings') && call.authorization === `Bearer ${syntheticToken}`)).toBe(true);
    expect(fixture.native.find(call => call.url.includes('/connectSettings'))?.quotaProject).toBe('other-quota-project');
    expect(fixture.refreshes).toHaveLength(1);
  });

  it('does not mint again while validating a short-lived token already issued to the SQL Connector', async () => {
    const fixture = await localFixture(200, 60); const adapter = new CloudSqlAdapter(); adapters.push(adapter);
    await adapter.connect({ authMode: 'default', projectId });
    const component = { id: 'database-id', environmentId: environment.id, name: 'database', type: 'postgres',
      provider: 'cloudsql', externalId: 'primary', bindings: { instanceId: 'primary', connectionName: `${projectId}:us-central1:primary`,
        providerScope: { projectId, region: 'us-central1' }, username: 'synthetic-user', password: 'synthetic-password', database: 'app' },
      createdAt: new Date(0), updatedAt: new Date(0) } as Component;
    await expect(adapter.acquireTemporaryDatabaseAccess(environment, component, 5432)).rejects.toThrow(/Cloud SQL.*unavailable/);
    expect(fixture.native.find(call => call.url.includes('/connectSettings'))?.authorization).toBe(`Bearer ${syntheticToken}-1`);
    expect(fixture.refreshes).toHaveLength(1);
  });
});
