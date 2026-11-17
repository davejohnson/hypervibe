import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from '../github.adapter.js';

// #290: a secret list is complete only when it holds total_count names (GitHub REST: the
// list-secrets responses carry total_count and at most per_page items per page).
// #293: every GitHub request has a deadline.
afterEach(() => vi.restoreAllMocks());
const names = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ name: `SECRET_${from + i}` }));

function github(pages: Array<{ total_count: number; secrets: Array<{ name: string }> }>) {
  const requests: string[] = []; const signals: Array<AbortSignal | null | undefined> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input)); requests.push(url.pathname + url.search); signals.push(init?.signal);
    return Response.json(pages[Number(url.searchParams.get('page') ?? '1') - 1] ?? { total_count: pages[0]!.total_count, secrets: [] });
  });
  const adapter = new GitHubAdapter(); adapter.connect({ apiToken: 'private-api-token' });
  return { adapter, requests, signals };
}

describe('GitHub Actions secret names', () => {
  it.each(['repository', 'environment'] as const)('reads every page of %s secrets', async (scope) => {
    const { adapter, requests } = github([{ total_count: 150, secrets: names(0, 100) }, { total_count: 150, secrets: names(100, 50) }]);
    const listed = scope === 'repository' ? await adapter.listRepositorySecrets('acme', 'app') : await adapter.listEnvironmentSecrets('acme', 'app', 'production');
    expect(listed).toHaveLength(150);
    expect(listed).toContain('SECRET_149');
    expect(requests).toHaveLength(2);
  });
  it('refuses a list that never reaches its stated total instead of returning part of it', async () => {
    const { adapter } = github([{ total_count: 150, secrets: names(0, 100) }]);
    await expect(adapter.listRepositorySecrets('acme', 'app')).rejects.toThrow(/incomplete/i);
  });
  it('sends every request with a deadline', async () => {
    const { adapter, signals } = github([{ total_count: 1, secrets: names(0, 1) }]);
    await adapter.listRepositorySecrets('acme', 'app');
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});
