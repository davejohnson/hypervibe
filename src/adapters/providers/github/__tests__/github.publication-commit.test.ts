import {afterEach, expect, it, vi} from 'vitest';
import {GitHubAdapter} from '../github.adapter.js';

// GitHub REST Git Trees and Git Commits: a null blob SHA removes a path,
// base_tree preserves untouched paths, and a commit records the tree and parents.
afterEach(() => vi.restoreAllMocks());
it.each([true, false])('materializes one complete publication tree and verifies its parent (matches=%s)', async matches => {
  const parent = 'a'.repeat(40), baseTree = 'b'.repeat(40), tree = 'c'.repeat(40), head = 'd'.repeat(40);
  const adapter = new GitHubAdapter(); adapter.connect({apiToken: 'fixture'});
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({sha: parent, tree: {sha: baseTree}, committer: {date: '2026-11-01T00:00:00Z'}}))
    .mockResolvedValueOnce(Response.json({sha: tree}, {status: 201}))
    .mockResolvedValueOnce(Response.json({sha: head, tree: {sha: tree}, parents: [{sha: matches ? parent : head}]}, {status: 201}));
  const result = adapter.createPublicationCommit('owner','repo',parent,'reviewed proposal',
    [{path: '.github/workflows/new.yml', content: 'name: new'}, {path: '.github/workflows/old.yml', content: null}]);
  if (matches) await expect(result).resolves.toBe(head);
  else await expect(result).rejects.toThrow(/publication commit/);
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({base_tree: baseTree, tree: [
    {path: '.github/workflows/new.yml', mode: '100644', type: 'blob', content: 'name: new'},
    {path: '.github/workflows/old.yml', mode: '100644', type: 'blob', sha: null},
  ]});
  expect(fetch.mock.calls.map(([url]) => String(url).split('/git/')[1])).toEqual(['commits/' + parent, 'trees', 'commits']);
});
