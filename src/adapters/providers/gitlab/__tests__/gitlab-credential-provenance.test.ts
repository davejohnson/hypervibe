import { afterEach, expect, it, vi } from 'vitest';
import { GitLabAdapter } from '../gitlab.adapter.js';
const repository = { provider: 'gitlab', nativeId: '42', instanceScope: 'https://gitlab.com', canonicalScope: 'https://gitlab.com/acme/app', path: 'acme/app', defaultBranch: 'main', webUrl: 'https://gitlab.com/acme/app', cloneUrls: ['https://gitlab.com/acme/app.git'] };
afterEach(() => vi.restoreAllMocks());
// Official GitLab GET pipeline and commit refs contracts; reconstructed wire
// observations intentionally include a same-name tag counterexample.
it.each([false, true])('requires an exact successful branch pipeline, tag=%s', async tag => {
  const adapter = new GitLabAdapter(); await adapter.connect({ apiToken: 'private-token', instanceUrl: 'https://gitlab.com' });
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input)); requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/pipelines/20')) return Response.json({ id: 20, project_id: 42, sha: 'a'.repeat(40), ref: 'main', tag, source: 'api', status: 'success', created_at: '2026-10-25T00:00:00Z' });
    if (url.pathname.endsWith('/refs')) return Response.json([{ type: 'branch', name: 'main' }]);
    throw new Error('Unexpected request');
  });
  const observation = await (adapter as any).observeManagedCredentialRun(repository, '20', 'main');
  expect(observation.state).toBe(tag ? 'unknown' : 'present');
  if (!tag) expect(requests.some(value => value.includes('/refs?type=branch'))).toBe(true);
});
