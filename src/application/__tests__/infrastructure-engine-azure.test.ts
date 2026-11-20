import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAzureEnvironmentConfiguration } from '../../adapters/providers/azure/tofu/azure-engine.config.js';
import * as sharedEngine from '../engine-shared.js';
import { azureCiRegistry } from '../../adapters/providers/azure/azure-ci-registry.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { AzureTokens } from '../../adapters/providers/azure/azure-ops.client.js';
import {
  AZURE_DATABASE_LOGIN_OPERATION, AZURE_FAILED_ENVIRONMENT_OPERATION, AZURE_IMAGE_BUILD_OPERATION, azureFailedEnvironmentAction, AZURE_SECRET_OPERATION, AZURE_TEARDOWN_CLEANUP_OPERATION, azureBindingToSave, azureEngineLayout, azureLegacyNames, azureResourceName, azureEngineProblems,
  azureEnvironmentSecretKeys, azureProfileFor, azureTestingEnvironments, buildAzureEngineInput, buildAzureSharedInput, runAzureAction, type AzureEngineContext,
} from '../infrastructure-engine-azure.js';

afterEach(() => vi.restoreAllMocks());

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
  // Observed live on 2026-11-19: project hvlive, environments fx-604326d6 and fx-604326d6b. The second apply failed with
  // 'azurerm_user_assigned_identity.runtime: a resource with the ID ".../hv-hvlive-fx-604326d-runtime" already exists'.
  it('keeps environments apart when their names differ only past the length Azure allows', () => {
    const live = { id: 'p', name: 'hvlive' };
    const a = azureEngineLayout(live, 'fx-604326d6', 'E1', connection);
    const b = azureEngineLayout(live, 'fx-604326d6b', 'E2', connection);
    expect(a.prefix).not.toBe(b.prefix);
    const long = { id: 'p', name: 'sequence-resource-planner' };
    const production = azureEngineLayout(long, 'production', 'E1', connection);
    const staging = azureEngineLayout(long, 'staging', 'E2', connection);
    expect(production.prefix).not.toBe(staging.prefix);
    expect(production.shared.prefix).not.toBe(staging.shared.prefix);
    expect(azureResourceName(a.prefix, 'notifications-api')).not.toBe(azureResourceName(a.prefix, 'notifications-worker'));
    for (const name of [a.prefix, b.prefix, production.prefix, staging.prefix, production.shared.prefix]) expect(name).toMatch(/^[a-z][a-z0-9-]{1,18}[a-z0-9]$/);
    expect(azureResourceName(a.prefix, 'notifications-worker')).toMatch(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);
  });

  it('leaves names that fit, and the names of environments that already exist, exactly as they were', () => {
    expect(azureEngineLayout(project, 'test', 'ENV1', connection).prefix).toBe('hv-billforge-test');
    expect(azureResourceName('hv-billforge-test', 'web')).toBe('hv-billforge-test-web');
    const existing = { platformBindings: { azure: { kind: 'opentofu', image: 'registry/app@sha256:1' } } } as never;
    const fresh = { platformBindings: {} } as never;
    expect(azureLegacyNames(existing)).toBe(true);
    expect(azureLegacyNames(fresh)).toBe(false);
    // The first thing saved about a new environment records its naming, so later saves cannot turn it into an old one.
    expect(azureLegacyNames({ platformBindings: { azure: { ...azureBindingToSave(fresh), kind: 'opentofu' } } } as never)).toBe(false);
    expect(azureBindingToSave(existing)).toEqual({ kind: 'opentofu', image: 'registry/app@sha256:1' });
    const old = azureEngineLayout({ id: 'p', name: 'hvlive' }, 'fx-604326d6', 'E1', connection, true);
    expect(old.prefix).toBe('hv-hvlive-fx-604326d');
    expect(azureResourceName(old.prefix, 'notifications-worker', true)).toBe('hv-hvlive-fx-604326d-notificatio');
    expect(azureEngineLayout({ id: 'p', name: 'sequence-resource-planner' }, 'production', 'E1', connection, true).shared.prefix).toBe('hv-sequence-resource');
  });

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

  it('configures account-wide Blob soft delete and signed browser uploads, and rejects incompatible container settings', () => {
    const documents = { provider: 'azureblob', type: 'bucket', region: 'eastus2', injectInto: [], versioning: true, browserUploads: true };
    const desired = spec({ test: testing({ storage: { documents } }) });
    expect(azureEngineProblems(desired, 'test')).toEqual([]);
    const layout = azureEngineLayout(project, 'test', 'ENV1', connection);
    const input = buildAzureEngineInput(desired, 'test', { connection: connection as never, ...layout, environment: { id: 'ENV1' } }, { secretKeys: [] });
    const storage = buildAzureEnvironmentConfiguration(input).files['storage.tf.json'];
    expect(storage).toMatchObject({ resource: { azurerm_storage_account: { files: {
      shared_access_key_enabled: false, allow_nested_items_to_be_public: false, blob_properties: [{
        delete_retention_policy: [{ days: 30 }], cors_rule: [{ allowed_methods: ['PUT', 'POST', 'GET', 'HEAD'], allowed_origins: ['*'] }],
      }],
    } }, azurerm_storage_container: { documents: { container_access_type: 'private' } } } });
    const mixed = spec({ test: testing({ storage: { documents, scratch: { ...documents, browserUploads: false } } }) });
    expect(azureEngineProblems(mixed, 'test')).toContainEqual(expect.stringMatching(/share one storage account.*browserUploads/));
  });

  it('builds web, on-demand worker, cron job, storage and secrets from the spec, with every secret it references', () => {
    const desired = spec({ test: testing() });
    const layout = azureEngineLayout(project, 'test', 'ENV1', connection);
    const keys = azureEnvironmentSecretKeys(desired, 'test');
    expect(keys).toEqual({ generated: ['JWT_SECRET'], outside: [], build: [], all: ['DATABASE_URL', 'JWT_SECRET'] });
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
    const azure = setup((method) => method === 'GET' ? json(200, { value: [] }) : json(200));
    await expect(runAzureAction(azure.ctx, azure.context, action(AZURE_SECRET_OPERATION, { key: 'JWT_SECRET' }), { project: project as never, spec: spec({ test: testing() }) })).resolves.toMatchObject({ success: true });
    const put = azure.calls.find((call) => call.method === 'PUT')!;
    expect(put.url).toContain('/secrets/test--jwt-secret?');
    expect(JSON.parse(put.body!).value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('blocks generated secret writes when the current Key Vault secret is disabled', async () => {
    const azure = setup((method, url) => method === 'GET' ? json(200, { value: [{ id: `${new URL(url).origin}/secrets/test--jwt-secret`, attributes: { enabled: false } }] }) : json(200));
    await expect(runAzureAction(azure.ctx, azure.context, action(AZURE_SECRET_OPERATION, { key: 'JWT_SECRET' }), { project: project as never, spec: spec({ test: testing() }) }))
      .resolves.toMatchObject({ success: false, status: 'blocked' });
    expect(azure.calls.filter((call) => call.method === 'PUT')).toEqual([]);
  });

  it('creates the database login, stores DATABASE_URL and the worker\'s counting login, and records both', async () => {
    const azure = setup(() => json(200));
    const statements: string[] = [];
    const result = await runAzureAction(azure.ctx, azure.context, action(AZURE_DATABASE_LOGIN_OPERATION, { host: 'srv.postgres.database.azure.com', waker: true }), { project: project as never, spec: spec({ test: testing() }) },
      { sqlRunner: () => async (_database, run) => { await run(async (sql) => { statements.push(sql); return { rows: [] }; }); }, setupAccess: (_context, _sql, work) => work() });
    expect(result).toMatchObject({ success: true });
    expect(azure.calls.filter((call) => call.method === 'PUT').map((call) => new URL(call.url).pathname)).toEqual(['/secrets/test--database-url', '/secrets/test--hv-waker-url']);
    expect(azure.bindings().azure).toMatchObject({ databaseLoginAt: expect.any(String), wakerLoginAt: expect.any(String), database: {
      serverId: `/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${azure.context.shared.serverName}`,
      subscriptionId: connection.subscriptionId, resourceGroup: connection.resourceGroup, host: 'srv.postgres.database.azure.com',
      name: 'app_test', owner: 'app_test', secretUrl: `${azure.context.vault.uri}secrets/test--database-url`,
    } });
    expect(statements).toContain('CREATE DATABASE app_test OWNER app_test');
  });

  it('records the digest-pinned image a build produced', async () => {
    const azure = setup(() => json(200));
    const result = await runAzureAction(azure.ctx, azure.context, action(AZURE_IMAGE_BUILD_OPERATION, { directory: '/repo', commitSha: 'a'.repeat(40) }), { project: project as never, spec: spec({ test: testing() }) },
      { buildImage: async () => ({ image: `r.azurecr.io/app@sha256:${'b'.repeat(64)}` }) });
    expect(result).toMatchObject({ success: true });
    expect(azure.bindings().azure).toMatchObject({ image: `r.azurecr.io/app@sha256:${'b'.repeat(64)}`, imageCommit: 'a'.repeat(40) });
  });

  it.each([false, true])('requires an exact applied registry before a CI image build (%s)', async (present) => {
    const azure = setup(() => json(200));
    const registry = azureCiRegistry({ ...connection, environmentId: 'ENV1' });
    const state = { values: { root_module: { resources: [{ address: 'azurerm_container_registry.ci_images', values: { id: registry.id, name: registry.name, login_server: registry.loginServer, tags: { 'managed-by': 'hypervibe', 'hv-environment': 'env1' } } }] } } };
    vi.spyOn(sharedEngine, 'openTofuEngine').mockResolvedValue({ inspectState: async (params: { project: (state: unknown) => unknown }) => present
      ? { ok: true, present: true, value: params.project(state) } : { ok: true, present: false } } as never);
    const desired = { ...spec({ test: testing({ deploy: { strategy: 'branch', branch: 'main' } }) }), gitRemoteUrl: 'https://github.com/owner/app.git' };
    const buildImage = vi.fn(async (context: AzureEngineContext) => {
      expect(context.environment.platformBindings).toMatchObject({ azure: { buildRegistry: { id: registry.id, loginServer: registry.loginServer } } });
      return { image: `${registry.loginServer}/app@sha256:${'b'.repeat(64)}` };
    });
    const result = await runAzureAction(azure.ctx, azure.context, action(AZURE_IMAGE_BUILD_OPERATION, { directory: '/repo', commitSha: 'a'.repeat(40) }), { project: project as never, spec: desired }, { buildImage });
    expect(result.success).toBe(present);
    expect(buildImage).toHaveBeenCalledTimes(present ? 1 : 0);
  });

  /**
   * Azure as it behaved live on 2026-11-20 (West US 2): creating the shared app environment failed with
   * ManagedEnvironmentProvisioningError ("creation of the managed cluster failed, please retry later") and
   * left the environment behind in state Failed, with the tags Hypervibe sent. OpenTofu did not record it,
   * so the next apply refused with "a resource with the ID ... already exists".
   */
  const leftover = (properties: Record<string, unknown>, tags: Record<string, string> = { 'managed-by': 'hypervibe', 'hv-shared': 'testing' }) => {
    const state = { present: true, deletes: 0 };
    const azure = setup((method, url) => {
      if (!new URL(url).pathname.endsWith('/providers/Microsoft.App/managedEnvironments/hv-billforge-shared-apps')) throw new Error(`Unexpected call ${method} ${url}`);
      if (method === 'DELETE') { state.deletes++; state.present = false; return json(202); }
      return state.present ? json(200, { tags, properties }) : json(404, { error: { code: 'ResourceNotFound' } });
    });
    return { azure, state };
  };
  const params = () => ({ project: project as never, spec: spec({ test: testing() }) });

  it('plans to remove a shared app environment that Azure failed to create, and removes it', async () => {
    const { azure, state } = leftover({ provisioningState: 'Failed' });
    const planned = await azureFailedEnvironmentAction(azure.context);
    expect(planned).toMatchObject({ id: 'shared-repair:apps', type: 'destroy', requiresConfirm: true, reason: expect.stringContaining('Azure failed to create'), metadata: { operation: AZURE_FAILED_ENVIRONMENT_OPERATION } });
    expect(azure.calls.filter((call) => call.method !== 'GET' && !call.url.startsWith('https://login.'))).toEqual([]);
    await expect(runAzureAction(azure.ctx, azure.context, planned as never, params(), { pollMs: 0 })).resolves.toMatchObject({ success: true });
    expect(state).toEqual({ present: false, deletes: 1 });
  });

  it('leaves a working app environment, and one Hypervibe did not create, alone', async () => {
    for (const { azure, state } of [leftover({ provisioningState: 'Succeeded' }), leftover({ provisioningState: 'Failed' }, { 'managed-by': 'someone' }), leftover({ provisioningState: 'Failed' }, { 'managed-by': 'hypervibe', 'hv-shared': 'production' })]) {
      await expect(azureFailedEnvironmentAction(azure.context)).resolves.toBeUndefined();
      // Even a plan made while it was failed must not delete it once it is not.
      const stale = action(AZURE_FAILED_ENVIRONMENT_OPERATION);
      await expect(runAzureAction(azure.ctx, azure.context, stale, params(), { pollMs: 0 })).resolves.toMatchObject({ success: false, status: 'blocked' });
      expect(state.deletes).toBe(0);
    }
  });

  it('plans nothing when the app environment is absent or unreadable, and reports an already removed one as done', async () => {
    const gone = leftover({ provisioningState: 'Failed' }); gone.state.present = false;
    await expect(azureFailedEnvironmentAction(gone.azure.context)).resolves.toBeUndefined();
    await expect(runAzureAction(gone.azure.ctx, gone.azure.context, action(AZURE_FAILED_ENVIRONMENT_OPERATION), params(), { pollMs: 0 })).resolves.toMatchObject({ success: true });
    const unreadable = setup(() => json(403, { error: { code: 'AuthorizationFailed' } }));
    await expect(azureFailedEnvironmentAction(unreadable.context)).resolves.toBeUndefined();
    await expect(runAzureAction(unreadable.ctx, unreadable.context, action(AZURE_FAILED_ENVIRONMENT_OPERATION), params(), { pollMs: 0 })).resolves.toMatchObject({ success: false, status: 'blocked' });
    expect(unreadable.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('keeps the environment in the spec when anything tagged for it remains after teardown', async () => {
    const azure = setup((_method, url) => url.includes("vault.azure.net/secrets?") ? json(200, { value: [] }) : json(200, { value: [{ name: 'hv-billforge-test-web' }] }));
    const result = await runAzureAction(azure.ctx, azure.context, action(AZURE_TEARDOWN_CLEANUP_OPERATION, { sharedRemoved: false }), { project: project as never, spec: spec({ test: testing() }) });
    expect(result).toMatchObject({ success: false, message: expect.stringContaining('hv-billforge-test-web') });
    expect(azure.bindings().azure).toBeUndefined();
  });
});

describe('saved Azure plans', () => {
  it('pass the saved-plan check, so hv_apply can load them', async () => {
    const { planRunDocumentSchema } = await import('../../domain/plan/converge.executor.js');
    const azure = await import('../infrastructure-engine-azure.js');
    const operations = [azure.AZURE_SECRET_OPERATION, azure.AZURE_DATABASE_LOGIN_OPERATION, azure.AZURE_IMAGE_BUILD_OPERATION,
      azure.AZURE_STORAGE_EMPTY_OPERATION, azure.AZURE_DATABASE_DROP_OPERATION, azure.AZURE_TEARDOWN_CLEANUP_OPERATION, azure.AZURE_FAILED_ENVIRONMENT_OPERATION];
    const document = {
      kind: 'hv_plan', scope: 'infrastructure-engine', environmentName: 'test', specRevision: 1, observedFingerprint: null, unmanaged: [], warnings: [],
      engine: { planId: 'p1', azure: { subscriptionId: 's', resourceGroup: 'g', prefix: 'hv-x' } },
      actions: operations.map((operation) => ({ id: operation, type: 'create', verified: true, resource: { kind: 'service', name: operation, provider: 'azure' }, reason: 'r', metadata: { operation } })),
    };
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
  });
});

describe('Azure regions', () => {
  it('uses the spec region over the setup region, and keeps environments sharing a server in one region', async () => {
    const { azureLocationFor, azureSharedLocation } = await import('../infrastructure-engine-azure.js');
    const spec = { environments: { test: { hosting: { provider: 'azure', engine: 'opentofu', region: 'westus2' } }, preview: { hosting: { provider: 'azure', engine: 'opentofu' } } } } as never;
    expect(azureLocationFor(spec, 'test', { location: 'eastus2' })).toBe('westus2');
    expect(azureLocationFor(spec, 'preview', { location: 'eastus2' })).toBe('eastus2');
    expect(azureSharedLocation(spec, ['test'], { location: 'eastus2' })).toBe('westus2');
    expect(azureSharedLocation(spec, ['test', 'preview'], { location: 'eastus2' })).toMatchObject({ blocked: expect.stringContaining('one region') });
  });
});
