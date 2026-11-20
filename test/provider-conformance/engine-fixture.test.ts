import { describe, expect, it } from 'vitest';
import { awsEngineProblems } from '../../src/application/infrastructure-engine-aws.js';
import { azureEngineProblems } from '../../src/application/infrastructure-engine-azure.js';
import type { AzureTokenProvider } from '../../src/adapters/providers/azure/azure-ops.client.js';
import { projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
import { environmentProfile } from '../../src/domain/services/infrastructure-engine-selection.js';
import { classifyDatabaseProbe, engineFixtureEnvironment, readGcpDatabaseExposure, readGcpInventory, engineFixtureResponseProblem, engineFixtureSiblingEnvironment, engineFixtureSiblingResponseProblem, probeDatabaseFromHere, readAzureDatabaseExposure,
  readAzureInventory, sinceBaseline } from './engine-fixture.js';
import { resourceKey, runDisposableFixture, type FixtureJournal, type NativeFixtureResource } from './lifecycle-live-harness.js';
import { selectLiveFixtureProfile } from './live-fixture-profiles.js';

const server = '/subscriptions/s1/resourceGroups/hv-fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/hv-fixture-shared';

/** Resource Manager as the readers see it: one canned answer per URL, in order when a URL repeats. */
function azure(answers: Record<string, Array<{ status: number; body: unknown }>>): AzureTokenProvider & { requests: string[] } {
  const requests: string[] = [];
  return { requests, get: async () => 'token', fetchImpl: (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method} ${url}`);
    const answer = (answers[url] ?? []).shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch };
}

describe('engine fixture desired state', () => {
  it.each([['aws', awsEngineProblems], ['azure', azureEngineProblems]] as const)('is a testing environment the %s planner admits', (cloud, problems) => {
    const spec = projectSpecSchema.parse({ version: 1, project: 'fixture', environments: { 'fx-0a1b2c3d': engineFixtureEnvironment(cloud, 'create', cloud === 'aws' ? 'us-east-1' : 'eastus2') } });
    expect(problems(spec, 'fx-0a1b2c3d')).toEqual([]);
    expect(environmentProfile('fx-0a1b2c3d')).toBe('testing');
    expect(Object.keys(spec.environments['fx-0a1b2c3d']!.services)).toEqual(['web', 'worker', 'ondemand', 'scheduled']);
    expect(spec.environments['fx-0a1b2c3d']!.storage!.files).toMatchObject({ region: cloud === 'aws' ? 'us-east-1' : 'eastus2', injectInto: ['web'] });
    expect(spec.environments['fx-0a1b2c3d']!.database).toBeTruthy();
    expect(selectLiveFixtureProfile(`${cloud}-engine`)).toMatchObject({ provider: cloud, path: 'engine-environment' });
    const placed = projectSpecSchema.parse({ version: 1, project: 'fixture', environments: { 'fx-0a1b2c3d': engineFixtureEnvironment(cloud, 'create', 'elsewhere', cloud === 'aws' ? 'us-west-2' : 'westus2') } });
    expect(problems(placed, 'fx-0a1b2c3d')).toEqual([]);
    expect(placed.environments['fx-0a1b2c3d']!.storage!.files!.region).toBe(cloud === 'aws' ? 'us-west-2' : 'westus2');
  });
});

describe('engine fixture application check', () => {
  const good = { service: 'hypervibe-provider-conformance', revision: 'update', database: true, worker: true, storage: true, scheduled: true, onDemand: true };
  it('passes only when the revision and proof from the database, every workload and storage are all shown', () => {
    expect(engineFixtureResponseProblem(200, good, 'update')).toBeUndefined();
    expect(engineFixtureResponseProblem(200, good, 'create')).toMatch(/create revision/);
    expect(engineFixtureResponseProblem(200, { ...good, database: false }, 'update')).toMatch(/database/);
    expect(engineFixtureResponseProblem(200, { ...good, worker: false }, 'update')).toMatch(/worker/);
    expect(engineFixtureResponseProblem(200, { ...good, storage: false }, 'update')).toMatch(/storage/);
    expect(engineFixtureResponseProblem(200, { ...good, scheduled: undefined }, 'update')).toMatch(/scheduled job/);
    expect(engineFixtureResponseProblem(200, { ...good, onDemand: false }, 'update')).toMatch(/on-demand worker/);
    expect(engineFixtureResponseProblem(503, good, 'update')).toMatch(/HTTP 503/);
    expect(engineFixtureResponseProblem(200, null, 'update')).toMatch(/did not answer as the fixture/);
  });
});

describe('second environment', () => {
  it.each([['aws', awsEngineProblems], ['azure', azureEngineProblems]] as const)('is a testing environment the %s planner admits beside the first', (cloud, problems) => {
    const spec = projectSpecSchema.parse({ version: 1, project: 'fixture', environments: {
      'fx-0a1b2c3d': engineFixtureEnvironment(cloud, 'create', cloud === 'aws' ? 'us-east-1' : 'eastus2'), 'fx-0a1b2c3db': engineFixtureSiblingEnvironment(cloud) } });
    expect(problems(spec, 'fx-0a1b2c3db')).toEqual([]);
    expect(problems(spec, 'fx-0a1b2c3d')).toEqual([]);
    expect(environmentProfile('fx-0a1b2c3db')).toBe('testing');
  });

  it('passes only with its own settings and a database the first environment does not write to', () => {
    const good = { service: 'hypervibe-provider-conformance', revision: 'sibling', database: true, worker: false };
    expect(engineFixtureSiblingResponseProblem(200, good)).toBeUndefined();
    expect(engineFixtureSiblingResponseProblem(200, { ...good, worker: true })).toMatch(/share a database/);
    expect(engineFixtureSiblingResponseProblem(200, { ...good, database: false })).toMatch(/could not use its database/);
    expect(engineFixtureSiblingResponseProblem(200, { ...good, revision: 'create' })).toMatch(/own settings/);
    expect(engineFixtureSiblingResponseProblem(502, good)).toMatch(/HTTP 502/);
  });
});

describe('database exposure from outside', () => {
  it('treats a server that checks the password as reachable and everything earlier as closed', () => {
    expect(classifyDatabaseProbe(undefined)).toBe('reachable');
    expect(classifyDatabaseProbe(Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' }))).toBe('reachable');
    expect(classifyDatabaseProbe(Object.assign(new Error('no pg_hba.conf entry for host "203.0.113.7"'), { code: '28000' }))).toBe('closed');
    expect(classifyDatabaseProbe(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe('closed');
    expect(classifyDatabaseProbe(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))).toBe('closed');
    expect(classifyDatabaseProbe(new Error('timeout expired'))).toBe('closed');
  });

  it('probes the given host once and refuses anything that is not a host name', async () => {
    const hosts: string[] = [];
    expect(await probeDatabaseFromHere('db.example.com', async (host) => { hosts.push(host); })).toBe('reachable');
    expect(await probeDatabaseFromHere('db.example.com', async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); })).toBe('closed');
    expect(hosts).toEqual(['db.example.com']);
    await expect(probeDatabaseFromHere('db.example.com/x?y', async () => undefined)).rejects.toThrow(/host name/);
  });

  it('reports an Azure server with public access on or a firewall rule left behind', async () => {
    const urls = { server: `https://management.azure.com${server}?api-version=2024-08-01`, rules: `https://management.azure.com${server}/firewallRules?api-version=2024-08-01` };
    const state = (access: string, rules: string[]) => azure({
      [urls.server]: [{ status: 200, body: { properties: { fullyQualifiedDomainName: 'hv-fixture-shared.postgres.database.azure.com', network: { publicNetworkAccess: access } } } }],
      [urls.rules]: [{ status: 200, body: { value: rules.map((name) => ({ name })) } }],
    });
    expect(await readAzureDatabaseExposure(state('Disabled', []), server)).toEqual({ host: 'hv-fixture-shared.postgres.database.azure.com', problems: [] });
    expect((await readAzureDatabaseExposure(state('Enabled', ['hypervibe-setup']), server)).problems).toEqual(['public network access is Enabled', 'firewall rules remain: hypervibe-setup']);
    const reader = state('Disabled', []);
    await readAzureDatabaseExposure(reader, server);
    expect(reader.requests.every((request) => request.startsWith('GET '))).toBe(true);
    await expect(readAzureDatabaseExposure(azure({}), server)).rejects.toThrow(/unknown/);
  });
});

describe('leftover inventory', () => {
  const list = 'https://management.azure.com/subscriptions/s1/resourceGroups/hv-fixture/resources?api-version=2021-04-01';
  const vault = { id: '/subscriptions/s1/resourceGroups/hv-fixture/providers/Microsoft.KeyVault/vaults/HV-Fixture-1', type: 'Microsoft.KeyVault/vaults' };

  it('lists every page of the Azure resource group and never reads an error as empty', async () => {
    const next = 'https://management.azure.com/next-page';
    const tokens = azure({ [list]: [{ status: 200, body: { value: [vault], nextLink: next } }], [next]: [{ status: 200, body: { value: [{ id: server, type: 'Microsoft.DBforPostgreSQL/flexibleServers' }] } }] });
    const found = await readAzureInventory(tokens, 's1', 'hv-fixture');
    expect(found.map((resource) => resource.type)).toEqual(['microsoft.keyvault/vaults', 'microsoft.dbforpostgresql/flexibleservers']);
    expect(found[1]!.id).toBe(server.toLowerCase());
    await expect(readAzureInventory(azure({ [list]: [{ status: 403, body: {} }] }), 's1', 'hv-fixture')).rejects.toThrow(/unknown/);
    await expect(readAzureInventory(azure({ [list]: [{ status: 200, body: { value: [vault], nextLink: 'https://example.com/elsewhere' } }] }), 's1', 'hv-fixture')).rejects.toThrow(/outside/);
  });

  it('counts only what appeared after the baseline', () => {
    const before: NativeFixtureResource = { provider: 'azure', type: 'microsoft.keyvault/vaults', id: vault.id.toLowerCase(), address: vault.id.toLowerCase() };
    const created: NativeFixtureResource = { provider: 'azure', type: 'microsoft.dbforpostgresql/flexibleservers', id: server.toLowerCase(), address: server.toLowerCase() };
    expect(sinceBaseline([before, created], [resourceKey(before)])).toEqual([created]);
    expect(sinceBaseline([before], [resourceKey(before)])).toEqual([]);
  });

  it('fails the run and asks for cleanup when a resource outlives teardown', async () => {
    // The driver the live runner builds, with the account replaced by a list: teardown leaves the server behind.
    const baseline = [resourceKey({ provider: 'azure', type: 'vault', id: 'vault', address: 'vault' })];
    let account: NativeFixtureResource[] = [{ provider: 'azure', type: 'vault', id: 'vault', address: 'vault' }];
    const built: NativeFixtureResource[] = [{ provider: 'azure', type: 'server', id: 'server', address: 'server' }, { provider: 'azure', type: 'app', id: 'web', address: 'web' }];
    const journal: FixtureJournal = { version: 1, profile: 'azure-engine', project: 'fixture', environment: 'fx-0a1b2c3d', phase: 'prepared', resources: [], checks: { created: false, noop: false, updated: false, absent: false } };
    const run = (leave: NativeFixtureResource[]) => runDisposableFixture({ journal, save: () => undefined, driver: {
      inventory: async () => sinceBaseline(account, baseline),
      observe: async (resource) => account.some((entry) => resourceKey(entry) === resourceKey(resource)) ? 'present' : 'absent',
      assertNoop: async () => undefined, verifyRunning: async () => undefined,
      converge: async (revision) => { account = revision === 'absent' ? [account[0]!, ...leave] : [account[0]!, ...built]; },
    } });
    await expect(run([built[0]!])).rejects.toThrow(/cleanup is unverified/);
    expect(journal.phase).toBe('cleanup-required');
    journal.phase = 'prepared'; journal.resources = [];
    account = [account[0]!];
    await expect(run([])).resolves.toMatchObject({ phase: 'cleaned', checks: { created: true, updated: true, absent: true } });
  });
});

describe('web start command checks', () => {
  it('leaves the image in charge when no start command is given, and reports how the web service was started', async () => {
    const { engineFixtureEnvironment, engineFixtureResponseProblem, engineFixtureEntrypointDockerfile } = await import('./engine-fixture.js');
    const services = (webStart?: string | null) => (engineFixtureEnvironment('aws', 'create', 'us-east-1', undefined, webStart) as { services: Record<string, { startCommand?: string }> }).services;
    expect(services(null).web).not.toHaveProperty('startCommand');
    expect(services().web!.startCommand).toBe('node server.mjs');
    expect(services('node server.mjs gained').web!.startCommand).toBe('node server.mjs gained');
    const body = { service: 'hypervibe-provider-conformance', revision: 'create', database: true, worker: true, storage: true, scheduled: true, onDemand: true, entrypoint: false, startedWith: 'gained' };
    expect(engineFixtureResponseProblem(200, body, 'create', { entrypoint: false, startedWith: 'gained' })).toBeUndefined();
    expect(engineFixtureResponseProblem(200, body, 'create', { entrypoint: true, startedWith: null })).toContain("without the image's entrypoint");
    expect(engineFixtureResponseProblem(200, body, 'create')).toBeUndefined();
    const dockerfile = engineFixtureEntrypointDockerfile('FROM node:22-alpine\nCMD ["node", "server.mjs"]\n');
    expect(dockerfile).toContain('ENTRYPOINT ["/app/entry.sh"]\nCMD ["node", "server.mjs"]');
    expect(() => engineFixtureEntrypointDockerfile('FROM scratch\n')).toThrow();
  });
});

describe('Google Cloud fixture readers', () => {
  const access = { projectId: 'p1', region: 'us-central1', token: async () => 'token' };
  const instance = (networks: Array<{ value: string }>) => ({ settings: { ipConfiguration: { ipv4Enabled: true, authorizedNetworks: networks } }, ipAddresses: [{ type: 'PRIMARY', ipAddress: '203.0.113.7' }] });
  const created: NativeFixtureResource[] = ['hv-fx-1-db-aaaaaa', 'hv-fs-1-db-bbbbbb'].map((id) => ({ provider: 'gcp', type: 'sql-instance', id, address: `sql-instance/${id}` }));

  it('builds a spec the schema accepts', () => {
    const spec = projectSpecSchema.parse({ version: 1, project: 'fixture', environments: {
      one: engineFixtureEnvironment('gcp', 'create', 'us-central1'), two: engineFixtureSiblingEnvironment('gcp') } });
    expect(spec.environments.one).toMatchObject({ hosting: { provider: 'cloudrun', region: 'us-central1' }, database: { provider: 'cloudsql' }, storage: { files: { provider: 'gcs' } } });
  });

  it('reports any network allowed to connect, on either environment, and refuses an unreadable or missing answer', async () => {
    const original = globalThis.fetch;
    const answer = (byName: Record<string, unknown>, status = 200) => { globalThis.fetch = (async (url: string | URL) => new Response(JSON.stringify(byName[String(url).split('/').pop()!] ?? {}), { status })) as typeof fetch; };
    try {
      answer({ 'hv-fx-1-db-aaaaaa': instance([]), 'hv-fs-1-db-bbbbbb': instance([]) });
      expect(await readGcpDatabaseExposure(access, created, 'fx-1')).toEqual({ host: '203.0.113.7', problems: [] });
      answer({ 'hv-fx-1-db-aaaaaa': instance([]), 'hv-fs-1-db-bbbbbb': instance([{ value: '0.0.0.0/0' }]) });
      expect((await readGcpDatabaseExposure(access, created, 'fx-1')).problems).toEqual(['instance hv-fs-1-db-bbbbbb allows connections from 0.0.0.0/0']);
      answer({}, 403);
      await expect(readGcpDatabaseExposure(access, created, 'fx-1')).rejects.toThrow(/exposure is unknown/);
      answer({ 'hv-fx-1-db-aaaaaa': {}, 'hv-fs-1-db-bbbbbb': instance([]) });
      await expect(readGcpDatabaseExposure(access, created, 'fx-1')).rejects.toThrow(/no network settings/);
      await expect(readGcpDatabaseExposure(access, created, 'fx-9')).rejects.toThrow(/exactly one database instance/);
      answer({}, 500);
      await expect(readGcpInventory(access)).rejects.toThrow(/what exists is unknown/);
    } finally { globalThis.fetch = original; }
  });
});
