import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';

// Reconstructed from official GitHub examples, using the existing pinned
// environment/secrets source. No live credential compatibility is asserted.
const source = JSON.parse(readFileSync('test/provider-contracts/github/secret-inventory/source.json', 'utf8'));
const bytes = readFileSync('test/provider-contracts/github/secret-inventory/' + source.schemaFile, 'utf8');
const pin = JSON.parse(bytes);
const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(pin, 'inventory');
const routes = Object.keys(pin.paths);
const validators = routes.map(route => ajv.compile({ $ref: 'inventory#/paths/' + route.replaceAll('~', '~0').replaceAll('/', '~1') + '/get/responses/200/content/application~1json/schema' }));
const environment = { ...pin.components.examples.environment.value, name: 'Production' };
const secret = { ...pin.components.examples['actions-secret-paginated'].value.secrets[0], name: 'NODE_AUTH_TOKEN' };
function fixture() {
  const requests: string[] = [];
  let environments = [environment];
  let status = 200;
  let pages = [{ total_count: 1, secrets: [secret] }];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(init?.method).toBe('GET');
    const url = new URL(String(input)); requests.push(url.pathname + url.search);
    if (status !== 200) return Response.json({ message: 'private-provider-error' }, { status });
    if (url.pathname.endsWith('/environments')) return Response.json({ total_count: environments.length, environments });
    if (url.pathname.endsWith('/Production')) return Response.json(environment);
    return Response.json(pages[Number(url.searchParams.get('page') ?? '1') - 1]);
  });
  const adapter = new GitHubAdapter(); adapter.connect({ apiToken: 'private-api-token' });
  return { requests, adapter, removeEnvironment: () => { environments = []; }, fail: (code: number) => { status = code; },
    pages: (value: typeof pages) => { pages = value; } };
}
afterEach(() => vi.restoreAllMocks());
describe('GitHub credential inventory transport', () => {
  it('never recreates an absent or replaced environment during a reviewed credential write', async () => {
    const methods: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return Response.json({ message: 'Not Found' }, { status: 404 });
    });
    const adapter = new GitHubAdapter(); adapter.connect({ apiToken: 'synthetic-management-token' });
    await expect(adapter.setEnvironmentSecret('owner', 'repo', 'retired', 'KEY', 'synthetic-value', { expectedEnvironmentId: 17 })).rejects.toThrow('cannot be verified');
    expect(methods).toEqual(['GET']);
    vi.mocked(fetch).mockImplementation(async (_input, init) => { methods.push(init?.method ?? 'GET'); return Response.json({ id: 18 }); });
    await expect(adapter.setEnvironmentSecret('owner', 'repo', 'recreated', 'KEY', 'synthetic-value', { expectedEnvironmentId: 17 })).rejects.toThrow('cannot be verified');
    expect(methods).toEqual(['GET', 'GET']);
  });
  it('pins official GET schemas and validates reconstructed response bodies', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.schemaSha256);
    const bodies = [{ total_count: 1, environments: [environment] }, environment,
      { total_count: 1, secrets: [secret] }, { total_count: 1, secrets: [secret] }];
    bodies.forEach((body, index) => expect(validators[index](body), JSON.stringify(validators[index].errors)).toBe(true));
  });
  it('reads exact scopes and returns metadata only', async () => {
    const f = fixture();
    expect(await f.adapter.observeSecretInventory('owner', 'repo', 'Production')).toMatchObject({
      state: 'present', environmentId: environment.id, secrets: [secret],
    });
    expect(f.requests).toContain('/repos/owner/repo/environments/Production/secrets?per_page=100&page=1');
    expect(await f.adapter.observeSecretInventory('owner', 'repo')).toMatchObject({ state: 'present', secrets: [secret] });
    expect(f.requests).toContain('/repos/owner/repo/actions/secrets?per_page=100&page=1');
  });
  it('proves environment absence only through a complete successful inventory', async () => {
    const f = fixture(); f.removeEnvironment();
    expect(await f.adapter.observeSecretInventory('owner', 'repo', 'Production')).toEqual({ state: 'absent', secrets: [] });
    expect(f.requests).toHaveLength(1);
  });
  it.each([403, 404, 429, 500])('keeps %i unknown without forwarding provider errors', async status => {
    const f = fixture(); f.fail(status);
    expect(await f.adapter.observeSecretInventory('owner', 'repo', 'Production')).toEqual({ state: 'unknown', secrets: [] });
  });
  it('paginates and rejects incomplete or duplicate inventories', async () => {
    const f = fixture(); const first = Array.from({ length: 100 }, (_, i) => ({ ...secret, name: `KEY_${i}` }));
    f.pages([{ total_count: 101, secrets: first }, { total_count: 101, secrets: [secret] }]);
    expect((await f.adapter.observeSecretInventory('owner', 'repo')).secrets).toHaveLength(101);
    f.pages([{ total_count: 101, secrets: [secret] }]);
    expect((await f.adapter.observeSecretInventory('owner', 'repo')).state).toBe('unknown');
    f.pages([{ total_count: 2, secrets: [secret, secret] }]);
    expect((await f.adapter.observeSecretInventory('owner', 'repo')).state).toBe('unknown');
  });
});
