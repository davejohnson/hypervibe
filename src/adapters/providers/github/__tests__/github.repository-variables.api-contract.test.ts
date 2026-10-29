import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';
import { GitHubRepositoryVariablesAdapter } from '../github-repository-variables.adapter.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';

// Reconstructed official examples and synthetic failures; no live API evidence.
const base = 'test/provider-contracts/github/repository-variables/';
const source = JSON.parse(readFileSync(base + 'source.json', 'utf8'));
const bytes = readFileSync(base + source.schemaFile, 'utf8');
const pin = JSON.parse(bytes);
const example = pin.components.examples['actions-variables-paginated'].value;
// The upstream example omits language despite its nullable required schema field.
const repo = { ...pin.components.examples['full-repository-default-response'].value, language: null };
repo.parent = { ...repo.parent, language: null };
repo.source = { ...repo.source, language: null };
const token = 'synthetic_provider_token';
const variable = example.variables[0];
const ajv = new Ajv({ strict: false, validateFormats: false });
ajv.addSchema(pin, 'variables');
function schema(path: string, operation: string, suffix: string) {
  return ajv.compile({ $ref: `variables#/paths/${path.replaceAll('~', '~0').replaceAll('/', '~1')}/${operation}/${suffix}` });
}
const collectionPath = '/repos/{owner}/{repo}/actions/variables';
const itemPath = collectionPath + '/{name}';
const validateInventory = schema(collectionPath, 'get', 'responses/200/content/application~1json/schema');
const validateRepository = schema('/repos/{owner}/{repo}', 'get', 'responses/200/content/application~1json/schema');
const validateCreate = schema(collectionPath, 'post', 'requestBody/content/application~1json/schema');
const validateUpdate = schema(itemPath, 'patch', 'requestBody/content/application~1json/schema');

function fixture() {
  let repository: unknown = repo;
  let pages: unknown[] = [example];
  let readStatus = 200;
  let mutationStatus: number | undefined;
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ path: url.pathname + url.search, method, ...(body === undefined ? {} : { body }) });
    expect(url.origin).toBe('https://api.github.com');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': source.apiVersion });
    if (method !== 'GET') {
      const status = mutationStatus ?? (method === 'POST' ? 201 : 204);
      if (status === 201 || status === 204) return new Response(null, { status });
      return Response.json({ message: `echo ${token} private-value` }, { status });
    }
    if (readStatus !== 200) return Response.json({ message: `echo ${token} private-value` }, { status: readStatus });
    if (!url.pathname.includes('/actions/')) return Response.json(repository);
    const data = pages[Number(url.searchParams.get('page')) - 1];
    return data === undefined ? new Response('malformed') : Response.json(data);
  });
  return { adapter: new GitHubRepositoryVariablesAdapter({ apiToken: token }), requests,
    repository(value: unknown) { repository = value; }, pages(value: unknown[]) { pages = value; },
    status(value: number) { readStatus = value; }, mutationStatus(value: number) { mutationStatus = value; } };
}

afterEach(() => vi.restoreAllMocks());

describe('GitHub repository variables serialized API contract', () => {
  it('pins exact official operations and validates independently reconstructed bodies', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.schemaSha256);
    expect(validateRepository(repo), JSON.stringify(validateRepository.errors)).toBe(true);
    expect(validateInventory(example), JSON.stringify(validateInventory.errors)).toBe(true);
    expect(Object.keys(pin.paths[collectionPath].post.responses)).toEqual(['201']);
    expect(Object.keys(pin.paths[itemPath].patch.responses)).toEqual(['204']);
    expect(pin.components.parameters['variables-per-page'].description).toContain('max 30');
  });
  it('accepts the documented empty 201 variable-create acknowledgment', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: String(input), method: init!.method!, body: JSON.parse(String(init!.body)) });
      expect(init!.headers).toMatchObject({
        Authorization: 'Bearer synthetic-provider-token',
        'X-GitHub-Api-Version': '2026-03-10',
      });
      return new Response(null, { status: 201 });
    });
    const adapter = new GitHubAdapter();
    adapter.connect({ apiToken: 'synthetic-provider-token' });
    // Exercise the existing real request serializer before the new facet exists.
    const transport = adapter as unknown as {
      request(method: string, path: string, body: object, options: object): Promise<unknown>;
    };
    await expect(transport.request('POST', '/repos/octocat/Hello-World/actions/variables',
      { name: 'HEALTH_ENABLED', value: 'true' }, { acceptEmpty201: true })).resolves.toEqual({});
    expect(requests).toEqual([{
      url: 'https://api.github.com/repos/octocat/Hello-World/actions/variables', method: 'POST',
      body: { name: 'HEALTH_ENABLED', value: 'true' },
    }]);
  });

  it('returns only hashes and safe identity from a complete scoped inventory', async () => {
    const f = fixture();
    const observed = await f.adapter.observe(repo.full_name);
    expect(observed).toMatchObject({ state: 'present', value: { repository: {
      nativeId: String(repo.id), path: repo.full_name, canonicalScope: `https://github.com/${repo.full_name}`,
    }, variables: example.variables.map((item: typeof variable) => ({ name: item.name,
      valueHash: createHash('sha256').update(item.value).digest('hex'), createdAt: item.created_at, updatedAt: item.updated_at })) } });
    expect(JSON.stringify(observed)).not.toContain('octocat@github.com');
    expect(JSON.stringify(observed)).not.toContain(token);
    expect(f.requests.map(r => r.path)).toEqual([`/repos/${repo.full_name}`, `/repos/${repo.full_name}/actions/variables?per_page=30&page=1`]);
  });

  it('accepts an independently confirmed complete empty inventory', async () => {
    const f = fixture(); f.pages([{ total_count: 0, variables: [] }]);
    expect(await f.adapter.observe(repo.full_name)).toMatchObject({ state: 'present', value: { variables: [] } });
  });

  it('paginates exactly to the stable total without exposing values', async () => {
    const f = fixture();
    const first = Array.from({ length: 30 }, (_, i) => ({ ...variable, name: `FLAG_${i}` }));
    f.pages([{ total_count: 31, variables: first }, { total_count: 31, variables: [variable] }]);
    const result = await f.adapter.observe(repo.full_name);
    expect(result.state).toBe('present');
    if (result.state === 'present') expect(result.value.variables).toHaveLength(31);
    expect(f.requests.at(-1)?.path).toContain('per_page=30&page=2');
  });

  it.each([403, 404, 429, 500])('keeps denied/missing/failed repository reads %s unknown and private', async status => {
    const f = fixture(); f.status(status);
    expect(await f.adapter.observe(repo.full_name)).toEqual({ state: 'unknown', reason: 'GitHub repository variables could not be verified.' });
    expect(f.requests).toHaveLength(1);
  });

  it.each([403, 404, 429, 500])('keeps failed variable inventory %s unknown after valid repository identity', async status => {
    const methods: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      methods.push(init?.method ?? 'GET');
      return String(input).includes('/actions/')
        ? Response.json({ message: `echo ${token}` }, { status }) : Response.json(repo);
    });
    const adapter = new GitHubRepositoryVariablesAdapter({ apiToken: token });
    expect(await adapter.observe(repo.full_name)).toEqual({ state: 'unknown', reason: 'GitHub repository variables could not be verified.' });
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('keeps a network failure unknown without forwarding its private exception', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`timeout ${token}`));
    const adapter = new GitHubRepositoryVariablesAdapter({ apiToken: token });
    expect(await adapter.observe(repo.full_name)).toEqual({ state: 'unknown', reason: 'GitHub repository variables could not be verified.' });
  });

  it('admits the full documented repository capacity within seventeen pages', async () => {
    const f = fixture();
    const entries = Array.from({ length: 500 }, (_, i) => ({ ...variable, name: `FLAG_${i}` }));
    f.pages(Array.from({ length: 17 }, (_, i) => ({ total_count: 500, variables: entries.slice(i * 30, (i + 1) * 30) })));
    const result = await f.adapter.observe(repo.full_name);
    expect(result.state).toBe('present');
    if (result.state === 'present') expect(result.value.variables).toHaveLength(500);
    expect(f.requests).toHaveLength(18);
  });

  it.each([
    { total_count: 2, variables: [variable] },
    { total_count: 0, variables: [variable] },
    { total_count: 1, variables: [] },
    { total_count: 501, variables: [] },
    { total_count: '1', variables: [variable] },
    { total_count: 1, variables: [{ ...variable, value: null }] },
    { total_count: 1, variables: [{ ...variable, created_at: undefined }] },
    { total_count: 1, variables: [{ ...variable, updated_at: 'invalid' }] },
    { total_count: 2, variables: [variable, { ...variable, name: variable.name.toLowerCase() }] },
    { total_count: 1, variables: [{ ...variable, value: 'x'.repeat(48 * 1024 + 1) }] },
  ])('rejects incomplete, duplicate, malformed or oversized inventory %#', async page => {
    const f = fixture(); f.pages([page]);
    expect((await f.adapter.observe(repo.full_name)).state).toBe('unknown');
  });

  it('rejects count drift or a missing subsequent page instead of accepting partial inventory', async () => {
    const f = fixture();
    const first = Array.from({ length: 30 }, (_, i) => ({ ...variable, name: `FLAG_${i}` }));
    for (const next of [undefined, { total_count: 30, variables: [] }]) {
      f.pages([{ total_count: 31, variables: first }, next]);
      expect((await f.adapter.observe(repo.full_name)).state).toBe('unknown');
    }
  });

  it.each([
    { ...repo, id: undefined }, { ...repo, id: '1296269' }, { ...repo, id: 0 },
    { ...repo, id: Number.MAX_SAFE_INTEGER + 1 }, { ...repo, full_name: undefined },
    { ...repo, full_name: 'different/repository' }, { ...repo, default_branch: token },
  ])('requires a matching complete numeric repository identity %#', async repository => {
    const f = fixture(); f.repository(repository);
    expect((await f.adapter.observe(repo.full_name)).state).toBe('unknown');
    expect(f.requests).toHaveLength(1);
  });

  it('does not project credentials echoed in ordinary metadata or names', async () => {
    const f = fixture();
    f.pages([{ total_count: 1, variables: [{ ...variable, name: token.toUpperCase() }] }]);
    expect(await f.adapter.observe(repo.full_name)).toEqual({ state: 'unknown', reason: 'GitHub repository variables could not be verified.' });
    f.repository({ ...repo, full_name: `${token}/repository` });
    expect((await f.adapter.observe(`${token}/repository`)).state).toBe('unknown');
    f.repository({ ...repo, html_url: `https://github.com/${token}`,
      clone_url: token, ssh_url: token }); f.pages([example]);
    const safe = await f.adapter.observe(repo.full_name);
    expect(safe.state).toBe('present');
    expect(JSON.stringify(safe)).not.toContain(token);
  });

  it('rejects a credential echoed as a numeric identity instead of exposing it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).includes('/actions/')
      ? Response.json(example) : Response.json(repo));
    const adapter = new GitHubRepositoryVariablesAdapter({ apiToken: String(repo.id) });
    expect(await adapter.observe(repo.full_name)).toEqual({ state: 'unknown', reason: 'GitHub repository variables could not be verified.' });
  });

  it('normalizes case and rejects reserved, ambiguous or unsafe names without requests', () => {
    const f = fixture();
    expect(f.adapter.normalizeName('health_enabled')).toBe('HEALTH_ENABLED');
    for (const name of ['GITHUB_TOKEN', '1FLAG', 'FLAG/OTHER', 'A B', '', token]) {
      expect(() => f.adapter.normalizeName(name)).toThrow('Invalid GitHub repository variable name.');
    }
    expect(f.requests).toHaveLength(0);
  });

  it('creates and updates only the exact selected repository key after fresh identity verification', async () => {
    const f = fixture();
    const observed = await f.adapter.observe(repo.full_name);
    if (observed.state !== 'present') throw new Error('fixture identity absent');
    f.requests.length = 0;
    await f.adapter.create(observed.value.repository, 'health_enabled', 'true');
    await f.adapter.update(observed.value.repository, 'health_enabled', 'false');
    expect(f.requests).toEqual([
      { method: 'GET', path: `/repos/${repo.full_name}` },
      { method: 'POST', path: `/repos/${repo.full_name}/actions/variables`, body: { name: 'HEALTH_ENABLED', value: 'true' } },
      { method: 'GET', path: `/repos/${repo.full_name}` },
      { method: 'PATCH', path: `/repos/${repo.full_name}/actions/variables/HEALTH_ENABLED`, body: { name: 'HEALTH_ENABLED', value: 'false' } },
    ]);
    expect(validateCreate(f.requests[1].body)).toBe(true);
    expect(validateUpdate(f.requests[3].body)).toBe(true);
  });

  it.each(['create', 'update'] as const)('blocks %s after repository replacement or unknown identity', async operation => {
    const f = fixture();
    const observed = await f.adapter.observe(repo.full_name);
    if (observed.state !== 'present') throw new Error('fixture identity absent');
    for (const repository of [{ ...repo, id: repo.id + 1 }, { ...repo, id: undefined }]) {
      f.requests.length = 0; f.repository(repository);
      await expect(f.adapter[operation](observed.value.repository, 'FLAG', 'true')).rejects.toMatchObject({ outcome: 'rejected' });
      expect(f.requests).toEqual([{ method: 'GET', path: `/repos/${repo.full_name}` }]);
    }
  });

  it.each([200, 202, 404, 403, 500])('rejects unexpected acknowledgment %i with no fallback create or private diagnostics', async status => {
    const f = fixture();
    const observed = await f.adapter.observe(repo.full_name);
    if (observed.state !== 'present') throw new Error('fixture identity absent');
    f.requests.length = 0; f.mutationStatus(status);
    await expect(f.adapter.update(observed.value.repository, 'FLAG', 'true')).rejects.toThrow(
      status === 403 || status === 404
        ? 'Repository variable write was rejected before any provider change; re-plan after correcting access or configuration.'
        : 'GitHub repository variable write could not be verified; inspect before retrying.');
    expect(f.requests.map(r => r.method)).toEqual(['GET', 'PATCH']);
  });

  it('rejects copying its own authority credential into a plain variable before any request', async () => {
    const f = fixture();
    const observed = await f.adapter.observe(repo.full_name);
    if (observed.state !== 'present') throw new Error('fixture identity absent');
    f.requests.length = 0;
    await expect(f.adapter.create(observed.value.repository, 'FLAG', token)).rejects.toMatchObject({ outcome: 'rejected' });
    expect(f.requests).toHaveLength(0);
  });

  it.each([400, 401, 403, 404, 422, 429])('marks native mutation rejection %s as no effect without forwarding provider detail', async status => {
    const f = fixture();
    const observed = await f.adapter.observe(repo.full_name);
    if (observed.state !== 'present') throw new Error('fixture identity absent');
    f.mutationStatus(status);
    const error = await f.adapter.create(observed.value.repository, 'FLAG', 'true').catch(value => value);
    expect(error).toMatchObject({ outcome: 'rejected' });
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain('private-value');
    expect(JSON.stringify(error)).not.toContain(String(status));
  });

  it('marks preflight identity failure as no effect because no mutation was sent', async () => {
    const f = fixture();
    const observed = await f.adapter.observe(repo.full_name);
    if (observed.state !== 'present') throw new Error('fixture identity absent');
    f.requests.length = 0; f.repository({ ...repo, id: repo.id + 1 });
    const error = await f.adapter.update(observed.value.repository, 'FLAG', 'true').catch(value => value);
    expect(error).toMatchObject({ outcome: 'rejected' });
    expect(f.requests.map(r => r.method)).toEqual(['GET']);
  });

  it.each([200, 202, 500, 502])('preserves ambiguous %s acknowledgments without a no-effect claim', async status => {
    const f = fixture();
    const observed = await f.adapter.observe(repo.full_name);
    if (observed.state !== 'present') throw new Error('fixture identity absent');
    f.mutationStatus(status);
    const error = await f.adapter.create(observed.value.repository, 'FLAG', 'true').catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('outcome');
  });
});
