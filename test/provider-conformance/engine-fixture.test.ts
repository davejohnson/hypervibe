import { describe, expect, it } from 'vitest';
import { awsEngineProblems } from '../../src/application/infrastructure-engine-aws.js';
import { azureEngineProblems } from '../../src/application/infrastructure-engine-azure.js';
import type { AzureTokenProvider } from '../../src/adapters/providers/azure/azure-ops.client.js';
import { projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
import { environmentProfile } from '../../src/domain/services/infrastructure-engine-selection.js';
import { classifyDatabaseProbe, engineFixtureEnvironment, engineFixtureResponseProblem, probeDatabaseFromHere, readAzureDatabaseExposure,
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
    const spec = projectSpecSchema.parse({ version: 1, project: 'fixture', environments: { 'fx-0a1b2c3d': engineFixtureEnvironment(cloud, 'create') } });
    expect(problems(spec, 'fx-0a1b2c3d')).toEqual([]);
    expect(environmentProfile('fx-0a1b2c3d')).toBe('testing');
    expect(Object.keys(spec.environments['fx-0a1b2c3d']!.services)).toEqual(['web', 'worker']);
    expect(spec.environments['fx-0a1b2c3d']!.database).toBeTruthy();
    expect(selectLiveFixtureProfile(`${cloud}-engine`)).toMatchObject({ provider: cloud, path: 'engine-environment' });
  });
});

describe('engine fixture application check', () => {
  const good = { service: 'hypervibe-provider-conformance', revision: 'update', database: true, worker: true };
  it('passes only when the revision, the database write and the worker write are all shown', () => {
    expect(engineFixtureResponseProblem(200, good, 'update')).toBeUndefined();
    expect(engineFixtureResponseProblem(200, good, 'create')).toMatch(/create revision/);
    expect(engineFixtureResponseProblem(200, { ...good, database: false }, 'update')).toMatch(/database/);
    expect(engineFixtureResponseProblem(200, { ...good, worker: false }, 'update')).toMatch(/worker/);
    expect(engineFixtureResponseProblem(503, good, 'update')).toMatch(/HTTP 503/);
    expect(engineFixtureResponseProblem(200, null, 'update')).toMatch(/did not answer as the fixture/);
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
