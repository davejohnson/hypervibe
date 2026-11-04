import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import type { Environment } from '../../src/domain/entities/environment.entity.js';
import type { IDatabaseAdapter } from '../../src/domain/ports/database.port.js';
import { CloudSqlAdapter } from '../../src/adapters/providers/gcp/cloudsql.adapter.js';
import { AzurePostgresAdapter } from '../../src/adapters/providers/azure/azure-postgres.adapter.js';
import { RdsAdapter } from '../../src/adapters/providers/aws/rds.adapter.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { databaseFreshInitializationIntentSchema } from '../../src/domain/ports/database-fresh-initialization.port.js';
import { SqliteAdapter } from '../../src/adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../src/application/context.js';
import { AdapterFactory } from '../../src/domain/services/adapter.factory.js';
import { PlanService } from '../../src/domain/plan/plan.service.js';
import type { PlanAction } from '../../src/domain/plan/plan.types.js';
import { SpecStore } from '../../src/domain/spec/spec.store.js';
import { projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
import { applyDatabaseFreshInitialization } from '../../src/domain/services/database-fresh-initialization.service.js';
import { bindingIdentityFingerprint } from '../../src/domain/services/binding-identity.js';
import { databaseInitializationActionId, DATABASE_FRESH_INITIALIZATION_OPERATION } from '../../src/domain/plan/database-initialization.contract.js';

interface EvidenceRow {
  provider: string;
  model: 'managed-database' | 'service-volume';
  provisioningMode: 'native-database' | 'database-template';
  nativeCreate: string;
  durability: string;
  identity: string;
  completion: string;
  recovery: string;
  prerequisites: string;
  coverage: string;
  runtimeReferenceBinding: 'implemented' | 'unsupported';
  runtimeReferenceEvidence: string;
  provisioningRecovery: { implementation: 'implemented' | 'unsupported'; evidence: string };
  freshInitializationRepair: {
    implementation: 'planned' | 'implemented' | 'unsupported';
    prerequisites: string;
    nativeOperation: string;
    completion: string;
    recovery: string;
    officialSources: string[];
  };
  officialSources: string[];
}
const evidence = JSON.parse(readFileSync(
  new URL('./database-provisioning-provider-matrix.json', import.meta.url), 'utf8',
)) as { schemaVersion: number; providers: EvidenceRow[] };

// Expected paths come from the official sources in the matrix. These are
// reconstructed HTTP preflights and rejected writes, not recorded live success.
// Only the transport is intercepted; request encoding and response/error parsing
// remain in each real adapter/client, including provider-owned authentication.
const nativeHttpProviders = ['cloudsql', 'azure-postgres'] as const;
// Native account/project coordinates follow the matrix's linked provider APIs.
// Hypervibe's key spellings are checked separately against the actual registry;
// do not derive these fixtures from the fresh-initialization schema.
const unsupportedInitializationProviders = [
  { provider: 'cloudsql', hosting: 'cloudrun', scope: { projectId: 'contract-gcp-project' } },
  { provider: 'rds', hosting: 'ecs', scope: { accountId: '123456789012', region: 'us-east-1' } },
  { provider: 'azure-postgres', hosting: 'azure-container-apps', scope: {
    subscriptionId: '22222222-2222-4222-8222-222222222222', resourceGroup: 'contract-group',
  } },
] as const;
type NativeHttpProvider = typeof nativeHttpProviders[number];
const subscriptionId = '22222222-2222-4222-8222-222222222222';
const resourceGroupId = `/subscriptions/${subscriptionId}/resourceGroups/contract-group`;
const resourceName = 'contract-postgres';
const nativeRequests: Record<NativeHttpProvider, { method: string; url: string }> = {
  cloudsql: { method: 'POST', url: 'https://sqladmin.googleapis.com/v1/projects/contract-project/instances' },
  'azure-postgres': {
    method: 'PUT',
    url: `https://management.azure.com${resourceGroupId}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${resourceName}`,
  },
};

function environment(provider: NativeHttpProvider): Environment {
  return {
    id: 'contract-environment', projectId: 'local-project', name: 'production',
    platformBindings: provider === 'azure-postgres' ? {
      provider: 'azure-container-apps', projectId: resourceGroupId,
      environmentId: `${resourceGroupId}/providers/Microsoft.App/managedEnvironments/contract-host`,
      services: {},
    } : {},
    createdAt: new Date(), updatedAt: new Date(),
  };
}

async function connected(provider: NativeHttpProvider): Promise<IDatabaseAdapter> {
  if (provider === 'cloudsql') {
    const adapter = new CloudSqlAdapter();
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    await adapter.connect({ projectId: 'contract-project', region: 'us-central1', credentials: JSON.stringify({
      type: 'service_account', project_id: 'contract-project', private_key: privateKey,
      client_email: 'synthetic@contract-project.iam.gserviceaccount.com',
    }) });
    return adapter;
  }
  {
    const adapter = new AzurePostgresAdapter();
    await adapter.connect({ tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId,
      clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'synthetic-azure-secret' });
    return adapter;
  }
}

async function registeredDatabaseAdapters(): Promise<Record<string, IDatabaseAdapter>> {
  const railway = await providerRegistry.get('railway')!.derivedAdapters!.database!(new RailwayAdapter(), {
    environment: environment('cloudsql'),
  }) as IDatabaseAdapter;
  return {
    railway, cloudsql: new CloudSqlAdapter(), rds: new RdsAdapter(),
    'azure-postgres': new AzurePostgresAdapter(), };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('complete database provisioning persistence contract', () => {
  it('matches reviewed incomplete-provision completion capability to every registered database adapter', async () => {
    const adapters = await registeredDatabaseAdapters();
    expect(Object.keys(adapters).sort()).toEqual(providerRegistry.namesFor('database').sort());
    for (const row of evidence.providers) {
      expect(row.provisioningRecovery.evidence.length, row.provider).toBeGreaterThan(30);
      expect(Boolean(adapters[row.provider].provisioningRecovery), row.provider)
        .toBe(row.provisioningRecovery.implementation === 'implemented');
    }
  });
  it.each(unsupportedInitializationProviders)('accepts the native $provider scope before explicit capability rejection', ({ scope }) => {
    expect(databaseFreshInitializationIntentSchema.parse({ id: 'fresh-production', discardExistingData: true,
      target: { externalId: 'bound-database', providerScope: scope } }).target.providerScope).toEqual(scope);
  });

  it.each(unsupportedInitializationProviders)('$provider rejects fresh initialization through real planning and apply without native fallback', async ({ provider, hosting, scope }) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-initialization-unsupported-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
    try {
      const adapters = await registeredDatabaseAdapters();
      const adapter = adapters[provider];
      // Only adapter dispatch is substituted. The registry, concrete adapter,
      // schema, SQLite repositories and shared plan/apply boundaries are real.
      const dispatch = vi.spyOn(AdapterFactory.prototype, 'getDatabaseAdapter')
        .mockResolvedValue({ success: true, adapter });
      const provision = vi.spyOn(adapter, 'provision');
      const destroy = vi.spyOn(adapter, 'destroy');
      const observe = vi.spyOn(adapter, 'observeDatabase');
      const transport = vi.fn(() => { throw new Error('Unsupported initialization must not contact a provider.'); });
      vi.stubGlobal('fetch', transport);
      const context = createCommandContext();
      const project = context.repos.projects.create({ name: `unsupported-${provider}`, defaultPlatform: hosting });
      const target = { externalId: 'bound-database', providerScope: scope };
      const intent = { id: 'fresh-production', discardExistingData: true, target };
      const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
        production: { hosting: { provider: hosting }, services: {}, database: { provider, freshInitialization: intent } },
      } });
      new SpecStore().replace(project, spec);
      const environment = context.repos.environments.create({ projectId: project.id, name: 'production',
        platformBindings: { provider: hosting, services: {} } });
      const component = context.repos.components.create({ environmentId: environment.id, type: 'postgres',
        externalId: target.externalId, bindings: { provider, providerScope: scope, resourceKind: 'database' } });

      const plan = await new PlanService().plan(project, 'production', { includeEnvFile: false });
      expect(plan).toMatchObject({ scope: 'database-initialization', verified: false, actions: [],
        blocked: [{ category: 'prerequisite', provider,
          reason: 'This database provider does not implement explicit fresh initialization.' }] });
      expect(dispatch).toHaveBeenCalledWith(provider, expect.objectContaining({ id: project.id }));

      // A synthetic reviewed action exercises apply's independent capability
      // guard; this is not provider eligibility or successful mutation evidence.
      const reviewed = { target: { provider, ...target }, configurationFingerprint: 'a'.repeat(64), privateConfiguration: {} };
      const action: PlanAction = { id: databaseInitializationActionId(component.id, intent.id), type: 'update',
        resource: { kind: 'database', name: 'postgres', provider }, verified: true,
        requiresConfirm: true, billable: true, dataBearing: true, reason: 'Synthetic unsupported capability review',
        metadata: { operation: DATABASE_FRESH_INITIALIZATION_OPERATION, componentId: component.id,
          intentId: intent.id, target: reviewed.target, configurationFingerprint: reviewed.configurationFingerprint,
          bindingsFingerprint: bindingIdentityFingerprint(component.bindings),
          environmentFingerprint: bindingIdentityFingerprint(environment.platformBindings) } };
      const result = await applyDatabaseFreshInitialization({ project, spec: spec.environments.production,
        environmentName: 'production', action, confirmed: new Set([action.id]),
        encrypted: context.secretStore.encryptObject(reviewed) });
      expect(result).toMatchObject({ success: false, status: 'blocked',
        message: 'Explicit database initialization is unavailable for this provider.' });
      const noop = await applyDatabaseFreshInitialization({ project, spec: spec.environments.production,
        environmentName: 'production', action: { ...action, type: 'noop' }, confirmed: new Set([action.id]),
        encrypted: context.secretStore.encryptObject(reviewed) });
      expect(noop).toMatchObject({ success: false, status: 'blocked' });
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(context.repos.components.findById(component.id)).toEqual(component);
      expect(context.repos.environments.findById(environment.id)).toEqual(environment);
      expect(provision).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      SqliteAdapter.resetInstance();
      rmSync(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
  it('requires explicit persistence and recovery evidence for every registered database provider', () => {
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.providers.map(row => row.provider).sort()).toEqual(providerRegistry.namesFor('database').sort());
    for (const row of evidence.providers) {
      expect(providerRegistry.get(row.provider)?.databaseRuntime, row.provider).toBeDefined();
      expect(row.provisioningMode).toBe(row.provider === 'railway' ? 'database-template' : 'native-database');
      expect(row.model).toBe(row.provider === 'railway' ? 'service-volume' : 'managed-database');
      for (const key of ['nativeCreate', 'durability', 'identity', 'completion', 'recovery', 'prerequisites', 'coverage', 'runtimeReferenceEvidence'] as const) {
        expect(row[key].length, `${row.provider}: ${key}`).toBeGreaterThan(20);
      }
      expect(row.officialSources.length, row.provider).toBeGreaterThanOrEqual(2);
      for (const source of row.officialSources) expect(new URL(source).protocol).toBe('https:');
    }
    // Railway has a separate pinned GraphQL template/persistence contract;
    // RDS has existing SDK-command lifecycle coverage, explicitly not wire proof.
    expect([...nativeHttpProviders, 'railway', 'rds'].sort()).toEqual(providerRegistry.namesFor('database').sort());
  });

  it('matches runtime-reference metadata normalization admission to the real database adapters for all reviewed providers', async () => {
    // Capability admission is an interface check, not live permission or
    // reference-resolution evidence. Railway's real derived factory receives
    // an in-memory environment; no local adoption or provider read is needed.
    const adapters = await registeredDatabaseAdapters();
    expect(Object.keys(adapters).sort()).toEqual(providerRegistry.namesFor('database').sort());
    expect(evidence.providers.filter(row => row.runtimeReferenceBinding === 'implemented').map(row => row.provider))
      .toEqual(['railway']);
    for (const row of evidence.providers) {
      expect(row.runtimeReferenceBinding, row.provider).toBe(row.provider === 'railway' ? 'implemented' : 'unsupported');
      expect(typeof adapters[row.provider].observeRuntimeReferenceBinding === 'function', row.provider)
        .toBe(row.runtimeReferenceBinding === 'implemented');
    }
  });

  it('requires named fresh-initialization evidence and matches actual capability admission for every database provider', async () => {
    const adapters = await registeredDatabaseAdapters();
    expect(Object.keys(adapters).sort()).toEqual(providerRegistry.namesFor('database').sort());
    expect(evidence.providers.map(row => row.provider).sort()).toEqual(providerRegistry.namesFor('database').sort());
    expect(unsupportedInitializationProviders.map(row => row.provider).sort())
      .toEqual(evidence.providers.filter(row => row.freshInitializationRepair.implementation === 'unsupported')
        .map(row => row.provider).sort());
    for (const fixture of unsupportedInitializationProviders) {
      expect(Object.keys(fixture.scope).sort(), fixture.provider)
        .toEqual(providerRegistry.get(fixture.provider)?.inspection?.selectors.database?.scopeKeys.slice().sort());
    }
    for (const row of evidence.providers) {
      const review = row.freshInitializationRepair;
      expect(review, row.provider).toBeDefined();
      expect(['planned', 'implemented', 'unsupported']).toContain(review.implementation);
      if (row.provider !== 'railway') expect(review.implementation, row.provider).toBe('unsupported');
      for (const key of ['prerequisites', 'nativeOperation', 'completion', 'recovery'] as const) {
        expect(review[key].length, `${row.provider}: fresh initialization ${key}`).toBeGreaterThan(20);
      }
      expect(review.officialSources.length, row.provider).toBeGreaterThanOrEqual(2);
      for (const source of review.officialSources) expect(new URL(source).protocol).toBe('https:');
      // Admission is inspected on real adapters, including Railway's derived
      // adapter. This does not by itself prove mutation-free lifecycle rejection.
      const capability = adapters[row.provider].freshInitialization;
      expect(capability !== undefined, row.provider).toBe(review.implementation === 'implemented');
      if (capability) {
        expect(typeof capability.inspect, row.provider).toBe('function');
        expect(typeof capability.apply, row.provider).toBe('function');
      }
    }
  });

  it.each(nativeHttpProviders)('%s rejects native database creation without falling back to hosting compute', async provider => {
    const expected = nativeRequests[provider];
    const mutations: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const endpoint = `${url.origin}${url.pathname}`;
      if (endpoint === 'https://oauth2.googleapis.com/token') {
        expect(provider).toBe('cloudsql');
        return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 });
      }
      if (url.hostname === 'login.microsoftonline.com') {
        expect(provider).toBe('azure-postgres');
        return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 });
      }
      if (!['GET', 'HEAD'].includes(method)) {
        mutations.push({ method, url: endpoint, body: JSON.parse(String(init?.body)) });
        expect(method).toBe(expected.method);
        expect(endpoint).toBe(expected.url);
        return Response.json({ error: { code: 'InvalidParameter', message: 'Synthetic create rejection' }, message: 'Synthetic create rejection' }, { status: 400 });
      }
      if (provider === 'cloudsql' && endpoint === `${expected.url}/${resourceName}`) {
        return Response.json({ error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } }, { status: 404 });
      }
      if (provider === 'azure-postgres' && endpoint === `https://management.azure.com${resourceGroupId}`) {
        return Response.json({ id: resourceGroupId, name: 'contract-group', location: 'canadacentral',
          tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'contract-environment' } });
      }
      if (provider === 'azure-postgres' && endpoint === expected.url.replace(`/${resourceName}`, '')) {
        return Response.json({ value: [] });
      }
      throw new Error(`Unexpected read in ${provider} provisioning contract: ${endpoint}`);
    }));
    const adapter = await connected(provider);
    const result = await adapter.provision('postgres', environment(provider), { resourceName });
    expect(result.receipt.success).toBe(false);
    expect(result.connectionUrl).toBeUndefined();
    expect(mutations.map(({ method, url }) => ({ method, url }))).toEqual([expected]);
    const body = mutations[0].body;
    if (provider === 'cloudsql') expect(body).toMatchObject({ name: resourceName, databaseVersion: 'POSTGRES_15' });
    if (provider === 'azure-postgres') expect(body).toMatchObject({ properties: { storage: { storageSizeGB: 32, autoGrow: 'Enabled' } } });
  });
});
