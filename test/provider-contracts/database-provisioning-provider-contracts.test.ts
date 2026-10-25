import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import type { Environment } from '../../src/domain/entities/environment.entity.js';
import type { IDatabaseAdapter } from '../../src/domain/ports/database.port.js';
import { SupabaseAdapter } from '../../src/adapters/providers/supabase/supabase.adapter.js';
import { NeonAdapter } from '../../src/adapters/providers/neon/neon.adapter.js';
import { CloudSqlAdapter } from '../../src/adapters/providers/gcp/cloudsql.adapter.js';
import { AzurePostgresAdapter } from '../../src/adapters/providers/azure/azure-postgres.adapter.js';
import { FlyDatabaseAdapter } from '../../src/adapters/providers/fly/fly-database.adapter.js';
import { DigitalOceanDatabaseAdapter } from '../../src/adapters/providers/digitalocean/digitalocean-database.adapter.js';
import { RdsAdapter } from '../../src/adapters/providers/aws/rds.adapter.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';

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
  officialSources: string[];
}
const evidence = JSON.parse(readFileSync(
  new URL('./database-provisioning-provider-matrix.json', import.meta.url), 'utf8',
)) as { schemaVersion: number; providers: EvidenceRow[] };

// Expected paths come from the official sources in the matrix. These are
// reconstructed HTTP preflights and rejected writes, not recorded live success.
// Only the transport is intercepted; request encoding and response/error parsing
// remain in each real adapter/client, including provider-owned authentication.
const nativeHttpProviders = ['supabase', 'neon', 'cloudsql', 'azure-postgres', 'fly', 'digitalocean'] as const;
type NativeHttpProvider = typeof nativeHttpProviders[number];
const subscriptionId = '22222222-2222-4222-8222-222222222222';
const resourceGroupId = `/subscriptions/${subscriptionId}/resourceGroups/contract-group`;
const resourceName = 'contract-postgres';
const nativeRequests: Record<NativeHttpProvider, { method: string; url: string }> = {
  supabase: { method: 'POST', url: 'https://api.supabase.com/v1/projects' },
  neon: { method: 'POST', url: 'https://console.neon.tech/api/v2/projects' },
  cloudsql: { method: 'POST', url: 'https://sqladmin.googleapis.com/v1/projects/contract-project/instances' },
  'azure-postgres': {
    method: 'PUT',
    url: `https://management.azure.com${resourceGroupId}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${resourceName}`,
  },
  fly: { method: 'POST', url: 'https://api.machines.dev/v1/postgres' },
  digitalocean: { method: 'POST', url: 'https://api.digitalocean.com/v2/databases' },
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
  if (provider === 'supabase') {
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'synthetic-supabase-token', organizationId: 'contract-org-id' });
    return adapter;
  }
  if (provider === 'neon') {
    const adapter = new NeonAdapter();
    await adapter.connect({ apiKey: 'synthetic-neon-token', organizationId: 'contract-org', regionId: 'aws-us-east-1' });
    return adapter;
  }
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
  if (provider === 'azure-postgres') {
    const adapter = new AzurePostgresAdapter();
    await adapter.connect({ tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId,
      clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'synthetic-azure-secret' });
    return adapter;
  }
  if (provider === 'fly') {
    const adapter = new FlyDatabaseAdapter();
    await adapter.connect({ apiToken: 'flyv1-synthetic-token', organizationSlug: 'contract-org' });
    return adapter;
  }
  const adapter = new DigitalOceanDatabaseAdapter();
  await adapter.connect({ apiToken: 'dop_v1_synthetic-token', region: 'nyc1', databaseSize: 'db-s-1vcpu-1gb', postgresVersion: '17' });
  return adapter;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('complete database provisioning persistence contract', () => {
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
    const railway = await providerRegistry.get('railway')!.derivedAdapters!.database!(new RailwayAdapter(), {
      environment: environment('supabase'),
    }) as IDatabaseAdapter;
    // Capability admission is an interface check, not live permission or
    // reference-resolution evidence. Railway's real derived factory receives
    // an in-memory environment; no local adoption or provider read is needed.
    const adapters: Record<string, IDatabaseAdapter> = {
      railway, supabase: new SupabaseAdapter(), neon: new NeonAdapter(),
      cloudsql: new CloudSqlAdapter(), rds: new RdsAdapter(),
      'azure-postgres': new AzurePostgresAdapter(), fly: new FlyDatabaseAdapter(),
      digitalocean: new DigitalOceanDatabaseAdapter(),
    };
    expect(Object.keys(adapters).sort()).toEqual(providerRegistry.namesFor('database').sort());
    expect(evidence.providers.filter(row => row.runtimeReferenceBinding === 'implemented').map(row => row.provider))
      .toEqual(['railway']);
    for (const row of evidence.providers) {
      expect(row.runtimeReferenceBinding, row.provider).toBe(row.provider === 'railway' ? 'implemented' : 'unsupported');
      expect(typeof adapters[row.provider].observeRuntimeReferenceBinding === 'function', row.provider)
        .toBe(row.runtimeReferenceBinding === 'implemented');
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
      if (provider === 'supabase' && endpoint === 'https://api.supabase.com/v1/organizations') {
        return Response.json([{ id: 'contract-org-id', slug: 'contract-org-slug', name: 'Contract organization' }]);
      }
      if (provider === 'supabase' && endpoint === expected.url) return Response.json([]);
      if (provider === 'neon' && endpoint === expected.url) return Response.json({ projects: [], pagination: {} });
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
      if (provider === 'fly' && endpoint === expected.url) return Response.json({ data: [] });
      if (provider === 'digitalocean' && endpoint === expected.url) return Response.json({ databases: [], links: {} });
      if (provider === 'digitalocean' && endpoint === 'https://api.digitalocean.com/v2/account') {
        return Response.json({ account: { uuid: 'contract-account' } });
      }
      throw new Error(`Unexpected read in ${provider} provisioning contract: ${endpoint}`);
    }));
    const adapter = await connected(provider);
    const result = await adapter.provision('postgres', environment(provider), { resourceName });
    expect(result.receipt.success).toBe(false);
    expect(result.connectionUrl).toBeUndefined();
    expect(mutations.map(({ method, url }) => ({ method, url }))).toEqual([expected]);
    const body = mutations[0].body;
    if (provider === 'supabase') expect(body).toMatchObject({ organization_slug: 'contract-org-slug', name: resourceName });
    if (provider === 'neon') expect(body).toMatchObject({ project: { org_id: 'contract-org', name: resourceName } });
    if (provider === 'cloudsql') expect(body).toMatchObject({ name: resourceName, databaseVersion: 'POSTGRES_15' });
    if (provider === 'azure-postgres') expect(body).toMatchObject({ properties: { storage: { storageSizeGB: 32, autoGrow: 'Enabled' } } });
    if (provider === 'fly') expect(body).toMatchObject({ name: resourceName, org_slug: 'contract-org', disk_size_gb: 10 });
    if (provider === 'digitalocean') expect(body).toMatchObject({ name: resourceName, engine: 'pg', size: 'db-s-1vcpu-1gb' });
  });
});
