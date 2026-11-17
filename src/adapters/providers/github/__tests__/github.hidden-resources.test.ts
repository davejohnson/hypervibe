import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';
import { GitHubCodeHostIdentityAdapter } from '../github-devops.adapter.js';

// #375: GitHub answers 404 for a private resource the token may not see
// (docs: "404 Not Found for an existing resource"). A 404 alone is not absence.
// Absence of an environment is proven only by a complete environment list that lacks it.
afterEach(() => vi.restoreAllMocks());

function github(options: { environments: 'hidden' | string[] }) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET'; calls.push(`${method} ${url.pathname}`);
    if (method === 'GET' && url.pathname.endsWith('/environments')) {
      return options.environments === 'hidden' ? Response.json({ message: 'Not Found' }, { status: 404 })
        : Response.json({ total_count: options.environments.length, environments: options.environments.map((name, id) => ({ id: id + 1, name })) });
    }
    if (method === 'PUT' && /\/environments\/[^/]+$/.test(url.pathname)) return Response.json({ id: 9, name: 'production' });
    if (url.pathname.endsWith('/secrets/public-key')) return Response.json({ key_id: 'k', key: Buffer.alloc(32, 1).toString('base64') });
    if (method === 'PUT') return new Response(null, { status: 204 });
    return Response.json({ message: 'Not Found' }, { status: 404 });
  });
  const adapter = new GitHubAdapter(); adapter.connect({ apiToken: 'private-api-token' });
  return { adapter, calls };
}

describe('GitHub 404 is not proof of absence', () => {
  it('lists no secrets only when the complete environment list lacks the environment', async () => {
    const { adapter } = github({ environments: ['staging'] });
    await expect(adapter.listEnvironmentSecrets('acme', 'app', 'production')).resolves.toEqual([]);
  });
  it('refuses to call an environment empty when the repository environments cannot be read', async () => {
    const { adapter } = github({ environments: 'hidden' });
    await expect(adapter.listEnvironmentSecrets('acme', 'app', 'production')).rejects.toThrow(/cannot be confirmed/i);
  });
  it('refuses when the list shows the environment exists although its own read said 404', async () => {
    const { adapter } = github({ environments: ['Production'] });
    await expect(adapter.listEnvironmentSecrets('acme', 'app', 'production')).rejects.toThrow(/cannot be confirmed/i);
  });
  it('never creates an environment while writing a secret unless its absence is proven', async () => {
    const hidden = github({ environments: 'hidden' });
    await expect(hidden.adapter.setEnvironmentSecret('acme', 'app', 'production', 'API_KEY', 'value')).rejects.toThrow(/cannot be confirmed/i);
    expect(hidden.calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
    const absent = github({ environments: [] });
    await absent.adapter.setEnvironmentSecret('acme', 'app', 'production', 'API_KEY', 'value');
    expect(absent.calls).toContain('PUT /repos/acme/app/environments/production');
  });
  it('reports an unreadable repository as unknown, not absent', async () => {
    const { adapter } = github({ environments: 'hidden' });
    const code = new GitHubCodeHostIdentityAdapter(adapter);
    await expect(code.observeRepository('acme/app')).resolves.toMatchObject({ state: 'unknown', reason: expect.stringMatching(/not found, or/i) });
  });
});
