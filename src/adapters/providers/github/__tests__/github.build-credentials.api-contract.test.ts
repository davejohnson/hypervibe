import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';

// Reconstructed from pinned official GitHub examples, not a live observation.
const root = 'test/provider-contracts/github/build-credentials/';
const source = JSON.parse(readFileSync(root + 'source.json', 'utf8'));
const bytes = readFileSync(root + source.schemaFile, 'utf8');
const document = JSON.parse(bytes);
const environmentRoute = '/repos/{owner}/{repo}/environments/{environment_name}';
const rulesRoute = environmentRoute + '/deployment_protection_rules';
const ajv = new Ajv({strict: false, allErrors: true, validateFormats: false});
ajv.addSchema(document, 'github-build-credentials');
const validators = ['', '/secrets', '/deployment_protection_rules'].map(suffix => ajv.compile({
  $ref: 'github-build-credentials#/paths/' + (environmentRoute + suffix).replaceAll('~', '~0').replaceAll('/', '~1')
    + '/get/responses/200/content/application~1json/schema',
}));
const secret = (name: string) => ({...document.components.examples['actions-secret-paginated'].value.secrets[0], name});
const failure = 'Cannot verify the existing GitHub build credentials environment.';

function fixture(environmentName = 'Production') {
  const environment = {...document.components.examples.environment.value, name: environmentName};
  const pages = [{total_count: 2, secrets: [secret('MATCH_PASSWORD'), secret('UNREQUESTED_PRIVATE_NAME')]}];
  const rules = structuredClone(document.paths[rulesRoute].get.responses['200'].content['application/json'].examples.default.value);
  rules.total_count = 0; rules.custom_deployment_protection_rules = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(init?.method).toBe('GET');
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deployment_protection_rules')) return Response.json(rules);
    if (url.pathname.endsWith('/secrets')) return Response.json(pages[Number(url.searchParams.get('page') ?? '1') - 1] ?? {});
    return Response.json(environment);
  });
  const adapter = new GitHubAdapter();
  adapter.connect({apiToken: 'synthetic-token-never-in-errors'});
  const execute = (names: string[] = ['MATCH_PASSWORD']) => adapter.observeBuildCredentialsEnvironment('owner', 'repo', environmentName, names);
  return {environment, pages, rules, fetch, adapter, execute};
}

afterEach(() => vi.restoreAllMocks());

describe('GitHub alternate iOS build credential environment transport', () => {
  it('pins official endpoint schemas and validates reconstructed successful responses', async () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.schemaSha256);
    expect(source.sourceSha256).toBe('3177ad6a86ca04c57a9bef3fc24e28a339efb8eb040c6f950af3d3ed2fee7fa3');
    const f = fixture();
    [f.environment, f.pages[0], f.rules].forEach((body, index) => {
      expect(validators[index](body), JSON.stringify(validators[index].errors)).toBe(true);
    });
    expect(await f.execute(['MATCH_PASSWORD', 'MISSING_KEY'])).toEqual({
      id: f.environment.id, name: 'Production', secretNames: ['MATCH_PASSWORD'], customProtectionRuleIds: [],
    });
    expect(f.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.github.com/repos/owner/repo/environments/Production',
      'https://api.github.com/repos/owner/repo/environments/Production/secrets?per_page=100&page=1',
      'https://api.github.com/repos/owner/repo/environments/Production/deployment_protection_rules',
      'https://api.github.com/repos/owner/repo/environments/Production',
    ]);
  });

  it('reads two bounded pages and returns only sorted requested names', async () => {
    const f = fixture();
    f.pages.splice(0, 1, {total_count: 102, secrets: Array.from({length: 100}, (_, i) => secret('OTHER_' + i))},
      {total_count: 102, secrets: [secret('MATCH_PASSWORD'), secret('MATCH_GIT_URL')]});
    f.pages.forEach(page => expect(validators[1](page)).toBe(true));
    expect((await f.execute(['MATCH_PASSWORD', 'MATCH_GIT_URL', 'MATCH_PASSWORD'])).secretNames).toEqual(['MATCH_GIT_URL', 'MATCH_PASSWORD']);
    expect(f.fetch.mock.calls.map(([url]) => String(url))).toContain('https://api.github.com/repos/owner/repo/environments/Production/secrets?per_page=100&page=2');
  });

  it('matches case-insensitive environment and secret names without assuming optional built-in rules', async () => {
    const f = fixture('production');
    f.environment.name = 'Production';
    delete f.environment.protection_rules;
    delete f.environment.deployment_branch_policy;
    expect(validators[0](f.environment)).toBe(true);
    expect(await f.execute(['match_password'])).toEqual({id: f.environment.id, name: 'Production', secretNames: ['match_password'], customProtectionRuleIds: []});
  });

  it('encodes environment path characters without opening another endpoint', async () => {
    const f = fixture('Signing/Prod #1');
    await f.adapter.observeBuildCredentialsEnvironment('owner/name', 'repo?#', 'Signing/Prod #1', ['MATCH_PASSWORD']);
    expect(f.fetch.mock.calls.every(([url]) => String(url).startsWith('https://api.github.com/repos/owner%2Fname/repo%3F%23/environments/Signing%2FProd%20%231'))).toBe(true);
  });

  it('returns enabled custom rule IDs so lifecycle planning can block deployment:false', async () => {
    const f = fixture();
    Object.assign(f.rules, structuredClone(document.paths[rulesRoute].get.responses['200'].content['application/json'].examples.default.value));
    expect(validators[2](f.rules)).toBe(true);
    expect((await f.execute()).customProtectionRuleIds).toEqual([3, 4]);
  });

  it('rejects an environment replaced while reading its name-scoped inventories', async () => {
    const f = fixture();
    const normal = f.fetch.getMockImplementation()!;
    let reads = 0;
    f.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/Production') && ++reads > 1) return Response.json({...f.environment, id: f.environment.id + 1});
      return normal(input, init);
    });
    await expect(f.execute()).rejects.toThrow(failure);
  });

  it.each([
    ['wrong environment name', (f: ReturnType<typeof fixture>) => { f.environment.name = 'another'; }],
    ['missing environment identity', f => { delete f.environment.id; }],
    ['wrong environment identity', f => { f.environment.id = 0; }],
    ['omitted secret count', f => { delete (f.pages[0] as Partial<typeof f.pages[0]>).total_count; }],
    ['partial page', f => { f.pages[0].total_count = 3; }],
    ['count exceeds bound', f => { f.pages[0].total_count = 1001; }],
    ['duplicate secret names', f => { f.pages[0].secrets = [secret('MATCH_PASSWORD'), secret('match_password')]; }],
    ['malformed secret entry', f => { f.pages[0].secrets[0] = {name: 'MATCH_PASSWORD'}; }],
    ['missing custom rule inventory', f => { delete f.rules.custom_deployment_protection_rules; }],
    ['partial custom rule inventory', f => { f.rules.total_count = 1; }],
    ['duplicate custom rule identities', f => {
      const rule = document.paths[rulesRoute].get.responses['200'].content['application/json'].examples.default.value.custom_deployment_protection_rules[0];
      f.rules.total_count = 2; f.rules.custom_deployment_protection_rules = [rule, {...rule}];
    }],
    ['contradictory disabled custom rule', f => {
      const rule = document.paths[rulesRoute].get.responses['200'].content['application/json'].examples.default.value.custom_deployment_protection_rules[0];
      f.rules.total_count = 1; f.rules.custom_deployment_protection_rules = [{...rule, enabled: false}];
    }],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => void]>)('rejects %s as unknown rather than absent', async (_label, corrupt) => {
    const f = fixture(); corrupt(f);
    await expect(f.execute()).rejects.toThrow(failure);
  });

  it('rejects changing totals and repeated names across secret pages', async () => {
    const f = fixture();
    f.pages.splice(0, 1, {total_count: 101, secrets: Array.from({length: 100}, (_, i) => secret('KEY_' + i))},
      {total_count: 102, secrets: [secret('MATCH_PASSWORD')]});
    await expect(f.execute()).rejects.toThrow(failure);
    f.pages[1] = {total_count: 101, secrets: [secret('KEY_0')]};
    await expect(f.execute()).rejects.toThrow(failure);
  });

  it.each([403, 404, 429, 500])('redacts unknown HTTP %s errors at every read boundary', async status => {
    for (const endpoint of ['', '/secrets', '/deployment_protection_rules']) {
      const f = fixture();
      const normal = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const target = endpoint ? url.pathname.endsWith(endpoint) : !url.pathname.endsWith('/secrets') && !url.pathname.endsWith('/deployment_protection_rules');
        return target ? Response.json({message: 'synthetic-token-never-in-errors UNREQUESTED_PRIVATE_NAME'}, {status}) : normal(input, init);
      });
      await expect(f.execute()).rejects.toThrow(failure);
      vi.restoreAllMocks();
    }
  });

  it('redacts transport and malformed JSON failures', async () => {
    const f = fixture();
    f.fetch.mockRejectedValueOnce(new Error('synthetic-token-never-in-errors'));
    await expect(f.execute()).rejects.toThrow(failure);
    f.fetch.mockResolvedValueOnce(new Response('synthetic-token-never-in-errors'));
    await expect(f.execute()).rejects.toThrow(failure);
  });

  it.each(['', '9INVALID', 'A-B', '${{ secrets.KEY }}', 'KEY\nNAME'])('rejects non-static requested key %j before transport', async name => {
    const f = fixture();
    await expect(f.execute([name])).rejects.toThrow(failure);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('rejects interpolated environment selection before transport', async () => {
    const f = fixture('${{ inputs.environment }}');
    await expect(f.execute()).rejects.toThrow(failure);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
