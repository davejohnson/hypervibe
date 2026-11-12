import { describe, expect, it } from 'vitest';
import { buildAzureEnvironmentConfiguration } from '../../adapters/providers/azure/tofu/azure-engine.config.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { AzureTokens } from '../azure-ops.js';
import {
  AZURE_DATABASE_LOGIN_OPERATION, AZURE_IMAGE_BUILD_OPERATION, AZURE_SECRET_OPERATION, AZURE_TEARDOWN_CLEANUP_OPERATION, azureEngineLayout, azureEngineProblems,
  azureEnvironmentSecretKeys, azureProfileFor, azureTestingEnvironments, buildAzureEngineInput, buildAzureSharedInput, runAzureAction, type AzureEngineContext,
} from '../infrastructure-engine-azure.js';

const connection = { tenantId: '11111111-2222-3333-4444-555555555555', subscriptionId: '66666666-7777-8888-9999-000000000000', resourceGroup: 'hv-billforge',
  location: 'eastus2', deployPrincipalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', clientSecret: 'client-secret-value-1',
  clientSecretExpiresAt: '2027-11-12T00:00:00Z' };
const project = { id: 'proj1', name: 'billforge' };

const testing = (extra: Record<string, unknown> = {}) => ({
  hosting: { provider: 'azure', engine: 'opentofu' }, envVars: { PORT: '3000' },
  database: { provider: 'azure-postgres', version: 17 },
  storage: { documents: { provider: 'azureblob', type: 'bucket', region: 'eastus2', injectInto: ['web'] } },
  services: {
    web: { public: true, healthCheckPath: '/health' },
    worker: { workloadKind: 'worker', startCommand: 'npm run worker', onDemand: { pendingWorkQuery: "SELECT count(*) FROM jobs WHERE status = 'queued'" } },
    nightly: { workloadKind: 'cron', cronSchedule: '0 3 * * *', startCommand: 'npm run nightly' },
  },
  ...extra,
});
const spec = (environments: Record<string, unknown>) => projectSpecSchema.parse({
  version: 1, project: 'billforge', environments,
  secrets: { JWT_SECRET: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: Object.keys(environments) } },
});

describe('Azure engine planning', () => {
  it('shares the production shape with staging; testing environments share one server and registry', () => {
    expect(azureProfileFor('staging')).toBe('production');
    expect(azureProfileFor('pr-12')).toBe('testing');
    const desired = spec({ test: testing(), 'pr-1': testing(), staging: testing() });
    expect(azureTestingEnvironments(desired)).toEqual(['pr-1', 'test']);
    const a = azureEngineLayout(project, 'test', 'ENV1', connection);
    const b = azureEngineLayout(project, 'pr-1', 'ENV2', connection);
    expect(a.shared).toEqual(b.shared);
    expect(a.shared.state).toEqual({ provider: 'azure', projectId: 'proj1', environmentId: 'shared-testing', partition: 'project-shared' });
    expect(a.state).toMatchObject({ environmentId: 'ENV1', partition: 'environment' });
    expect(azureEngineLayout(project, 'staging', 'ENV3', connection).shared.label).toBe('staging');
  });

  it('lists what it cannot build instead of ignoring it', () => {
    const desired = spec({ test: testing({ cache: { provider: 'railway' } }), 'pr-1': testing({ database: { provider: 'azure-postgres', version: 16 } }) });
    expect(azureEngineProblems(desired, 'test')).toEqual(expect.arrayContaining([expect.stringMatching(/Redis caches/), expect.stringMatching(/one PostgreSQL server.*16 and 17/)]));
    expect(azureEngineProblems(spec({ staging: testing() }), 'staging')[0]).toMatch(/production profile/);
    const zoned = spec({ test: testing({ storage: {}, services: { nightly: { workloadKind: 'cron', cronSchedule: '0 3 * * *', timeZone: 'Europe/Paris', startCommand: 'npm run nightly' } } }) });
    expect(azureEngineProblems(zoned, 'test')).toEqual([expect.stringMatching(/UTC/)]);
    expect(azureEngineProblems(spec({ test: testing() }), 'test')).toEqual([]);
  });

  it('builds web, on-demand worker, cron job, storage and secrets from the spec, with every secret it references', () => {
    const desired = spec({ test: testing() });
    const layout = azureEngineLayout(project, 'test', 'ENV1', connection);
    const keys = azureEnvironmentSecretKeys(desired, 'test');
    expect(keys).toEqual({ generated: ['JWT_SECRET'], outside: [], all: ['DATABASE_URL', 'JWT_SECRET'] });
    const input = buildAzureEngineInput(desired, 'test', { connection: connection as never, ...layout, environment: { id: 'ENV1' } }, { secretKeys: keys.all, image: 'r.azurecr.io/app@sha256:abc' });
    expect(input.services).toEqual([expect.objectContaining({ resourceName: 'hv-billforge-test-web', targetPort: 3000, healthCheckPath: '/health' })]);
    expect(input.workers).toEqual([expect.objectContaining({ resourceName: 'hv-billforge-test-worker', command: ['sh', '-c', 'npm run worker'], pendingWorkQuery: expect.stringContaining('queued') })]);
    expect(input.jobs).toEqual([expect.objectContaining({ resourceName: 'hv-billforge-test-nightly', schedule: '0 3 * * *' })]);
    expect(input.services![0]!.env).toMatchObject({ OBJECT_STORAGE_PROVIDER: 'azureblob', AZURE_STORAGE_CONTAINER_NAME: 'documents' });
    expect(() => buildAzureEnvironmentConfiguration(input)).not.toThrow();
    // Without an image the workloads wait for the first build.
    expect(buildAzureEngineInput(desired, 'test', { connection: connection as never, ...layout, environment: { id: 'ENV1' } }, { secretKeys: [] }).services).toEqual([]);
    expect(buildAzureSharedInput(desired, { connection: connection as never, shared: layout.shared, project: project as never }, ['test']).database).toEqual({ version: 17 });
  });
});

describe('Azure apply actions', () => {
  const json = (status: number, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  const setup = (route: (method: string, url: string, body?: string) => Response) => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      calls.push({ method, url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.startsWith('https://login.microsoftonline.com/')) return json(200, { access_token: 'token', expires_in: 3600 });
      return route(method, url, typeof init?.body === 'string' ? init.body : undefined);
    }) as typeof fetch;
    let bindings: Record<string, unknown> = {};
    const environment = { id: 'ENV1', name: 'test', projectId: 'proj1', get platformBindings() { return bindings; } };
    const ctx = { repos: { environments: { findById: () => environment, updatePlatformBindings: (_id: string, patch: Record<string, unknown>) => { bindings = { ...bindings, ...patch }; return environment; } } } };
    const context = { project, environmentName: 'test', connection, auth: { env: {}, redact: [] }, tokens: new AzureTokens(connection, fetchImpl), environment,
      ...azureEngineLayout(project, 'test', 'ENV1', connection) } as unknown as AzureEngineContext;
    return { calls, ctx: ctx as never, context, bindings: () => bindings };
  };
  const action = (operation: string, metadata: Record<string, unknown> = {}) => ({ id: operation, type: 'create', verified: true, resource: { kind: 'secret', name: 'x', provider: 'azure' },
    metadata: { operation, subscriptionId: connection.subscriptionId, ...metadata } }) as never;

  it('generates a secret only when it is absent', async () => {
    const azure = setup((method) => method === 'GET' ? json(404) : json(200));
    await expect(runAzureAction(azure.ctx, azure.context, action(AZURE_SECRET_OPERATION, { key: 'JWT_SECRET' }), { project: project as never, spec: spec({ test: testing() }) })).resolves.toMatchObject({ success: true });
    const put = azure.calls.find((call) => call.method === 'PUT')!;
    expect(put.url).toContain('/secrets/test--jwt-secret?');
    expect(JSON.parse(put.body!).value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('creates the database login, stores DATABASE_URL and the worker\'s counting login, and records both', async () => {
    const azure = setup(() => json(200));
    const statements: string[] = [];
    const result = await runAzureAction(azure.ctx, azure.context, action(AZURE_DATABASE_LOGIN_OPERATION, { host: 'srv.postgres.database.azure.com', waker: true }), { project: project as never, spec: spec({ test: testing() }) },
      { sqlRunner: () => async (_database, run) => { await run(async (sql) => { statements.push(sql); return { rows: [] }; }); } });
    expect(result).toMatchObject({ success: true });
    expect(azure.calls.filter((call) => call.method === 'PUT').map((call) => new URL(call.url).pathname)).toEqual(['/secrets/test--database-url', '/secrets/test--hv-waker-url']);
    expect(azure.bindings().azure).toMatchObject({ databaseLoginAt: expect.any(String), wakerLoginAt: expect.any(String) });
    expect(statements).toContain('CREATE DATABASE app_test OWNER app_test');
  });

  it('records the digest-pinned image a build produced', async () => {
    const azure = setup(() => json(200));
    const result = await runAzureAction(azure.ctx, azure.context, action(AZURE_IMAGE_BUILD_OPERATION, { directory: '/repo', commitSha: 'a'.repeat(40) }), { project: project as never, spec: spec({ test: testing() }) },
      { buildImage: async () => ({ image: `r.azurecr.io/app@sha256:${'b'.repeat(64)}` }) });
    expect(result).toMatchObject({ success: true });
    expect(azure.bindings().azure).toMatchObject({ image: `r.azurecr.io/app@sha256:${'b'.repeat(64)}`, imageCommit: 'a'.repeat(40) });
  });

  it('keeps the environment in the spec when anything tagged for it remains after teardown', async () => {
    const azure = setup((_method, url) => url.includes("vault.azure.net/secrets?") ? json(200, { value: [] }) : json(200, { value: [{ name: 'hv-billforge-test-web' }] }));
    const result = await runAzureAction(azure.ctx, azure.context, action(AZURE_TEARDOWN_CLEANUP_OPERATION, { sharedRemoved: false }), { project: project as never, spec: spec({ test: testing() }) });
    expect(result).toMatchObject({ success: false, message: expect.stringContaining('hv-billforge-test-web') });
    expect(azure.bindings().azure).toBeUndefined();
  });
});
