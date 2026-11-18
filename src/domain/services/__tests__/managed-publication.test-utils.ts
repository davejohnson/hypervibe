import { vi } from 'vitest';
import { GitHubAdapter, type GitHubPullRequestSummary } from '../../../adapters/providers/github/github.adapter.js';

export function mockManagedPublication(number: number) {
  const refs = new Map([['heads/main', 'a'.repeat(40)]]);
  const pulls: GitHubPullRequestSummary[] = [];
  vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({default_branch: 'main'});
  vi.spyOn(GitHubAdapter.prototype, 'getRef').mockImplementation(async (_owner, _repo, ref) =>
    refs.has(ref) ? {ref: 'refs/' + ref, object: {sha: refs.get(ref)!}} : null);
  vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockImplementation(async (owner, _repo, filter) =>
    pulls.filter(pull => owner + ':' + pull.head.ref === filter?.head));
  vi.spyOn(GitHubAdapter.prototype, 'createRef').mockImplementation(async (_owner, _repo, ref, sha) => {refs.set(ref.slice(5), sha);});
  const write = vi.spyOn(GitHubAdapter.prototype, 'createPublicationCommit').mockResolvedValue('b'.repeat(40));
  const createPull = vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockImplementation(async (owner, repo, input) => {
    const repository = {full_name: owner + '/' + repo};
    const pull = {number, html_url: 'https://github.com/' + repository.full_name + '/pull/' + number,
      head: {ref: input.head, sha: refs.get('heads/' + input.head)!, repo: repository},
      base: {ref: input.base, sha: refs.get('heads/' + input.base)!, repo: repository},
      title: input.title, body: input.body, state: 'open' as const, merged_at: null};
    pulls.push(pull);
    return pull;
  });
  return {write, createPull};
}
