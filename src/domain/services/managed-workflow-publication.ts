import { createHash } from 'node:crypto';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import type { GitHubAdapter, GitHubPullRequestSummary } from '../../adapters/providers/github/github.adapter.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { ManagedGitHubFile } from './github-infrastructure.service.js';

type Change = {operation: 'updated' | 'added' | 'removed'; path: string; review?: ManagedGitHubFile['review']};

export async function publishManagedWorkflow(params: {
  adapter: GitHubAdapter; owner: string; repo: string; repository: string; baseBranch: string; baseSha: string;
  legacyBranch: string; desiredFiles: ManagedGitHubFile[]; retiredPaths: string[]; reviewedFileHashes?: Record<string, string | null>;
  title: string; body: (changes: Change[]) => string;
}) {
  const {adapter, owner, repo, repository, baseBranch, baseSha, legacyBranch} = params;
  const blocked = (message: string) => ({success: false, status: 'blocked' as const, message});
  const audit = new AuditRepository();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const intent = canonicalJsonSha256({repository, baseBranch, legacyBranch,
    files: params.desiredFiles.map(file => ({path: file.path, hash: digest(file.content)})), retiredPaths: params.retiredPaths});
  let branch = legacyBranch;
  let priorPull: number | undefined;
  const pending = (pull: {number: number; html_url: string}, head: string) => ({success: false, status: 'pending' as const,
    message: 'Review the managed workflow pull request before deploying.',
    data: {repository, branch, head, baseBranch, pullRequestNumber: pull.number, pullRequestUrl: pull.html_url,
      ...(priorPull ? {previousPullRequestNumber: priorPull, recovery: 'A fresh branch leaves the earlier closed publication intact.'} : {})}});
  const exactPull = (pull: GitHubPullRequestSummary) => Number.isSafeInteger(pull.number) && pull.number > 0
    && pull.base.ref === baseBranch && pull.head.ref === branch && /^[a-f0-9]{40}$/.test(pull.head.sha)
    && [pull.head.repo, pull.base.repo].every(source => source?.full_name.toLowerCase() === repository.toLowerCase());
  try {
    // Closed PR numbers form a durable chain even when refs are deleted or PR prose changes.
    for (let generation = 0; generation < 100; generation++) {
      const scope = canonicalJsonSha256({repository, baseBranch, branch});
      let receipt = audit.findByResource('github-workflow-publication', scope, 1).at(0)?.details;
      const filter = {head: owner + ':' + branch, state: 'all' as const};
      const [ref, pulls] = await Promise.all([adapter.getRef(owner, repo, 'heads/' + branch), adapter.listPullRequests(owner, repo, filter)]);
      if (ref && ref.ref !== 'refs/heads/' + branch || pulls.length > 1 || pulls.some(pull => !exactPull(pull))) {
        return blocked('Publication history is ambiguous. Review the repository, head and base of the existing pull request, then run hv_plan again.');
      }
      const pull = pulls[0];
      if (pull) {
        if (ref && ref.object.sha !== pull.head.sha || receipt && (pull.head.sha !== receipt.head || receipt.pullNumber && receipt.pullNumber !== pull.number)) {
          return blocked('The publication head changed. Review the new commits on the existing branch before publishing.');
        }
        if (pull.state === 'closed') {
          priorPull = pull.number;
          branch = legacyBranch + '-after-' + priorPull;
          continue;
        }
        if (!ref || !receipt || receipt.intent !== intent || pull.merged_at !== null) {
          return blocked('An active pull request already uses this publication branch. Review or finish ' + pull.html_url + ' before applying another publication.');
        }
        return pending(pull, pull.head.sha);
      }
      if (ref && (!receipt || receipt.head !== ref.object.sha)) {
        return blocked('This branch has work without an exact publication receipt. Review its commits and open or finish a pull request before applying again.');
      }
      if (branch === legacyBranch) { branch = legacyBranch + '-v2'; continue; }
      if (receipt && (receipt.intent !== intent || (!ref && receipt.baseSha !== baseSha))) {
        if (ref) return blocked('An unfinished publication has different reviewed workflow inputs. Review its branch before retrying.');
        receipt = undefined;
      }
      const changes: Change[] = [];
      const files: Array<{path: string; content: string | null}> = [];
      for (const file of [...params.desiredFiles, ...params.retiredPaths.map(path => ({path, content: null, review: undefined}))]) {
        const current = await adapter.getFileContent(owner, repo, file.path, baseSha);
        if (params.reviewedFileHashes && params.reviewedFileHashes[file.path] !== (current === null ? null : digest(current))) {
          return blocked('A managed file changed after planning. Review the current contents in a fresh plan.');
        }
        if (current === file.content) continue;
        files.push({path: file.path, content: file.content});
        changes.push({operation: file.content === null ? 'removed' : current === null ? 'added' : 'updated', path: file.path, review: file.review});
      }
      if (!files.length) return blocked('The workflow already matches the default branch. Run hv_plan to record convergence.');
      const head = typeof receipt?.head === 'string' ? receipt.head
        : await adapter.createPublicationCommit(owner, repo, baseSha, 'Publish reviewed Hypervibe workflows (' + intent + ')', files);
      const details = {repository, branch, baseBranch, baseSha: receipt?.baseSha ?? baseSha, head, intent};
      if (!receipt) audit.create({action: 'github.workflow.prepare', resourceType: 'github-workflow-publication', resourceId: scope, details});
      const base = await adapter.getRef(owner, repo, 'heads/' + baseBranch);
      if (base?.ref !== 'refs/heads/' + baseBranch || base.object.sha !== baseSha) return blocked('The default branch changed. Review a fresh plan before publishing.');
      if (!ref) {
        try { await adapter.createRef(owner, repo, 'refs/heads/' + branch, head); }
        catch { /* Verify the actual ref in case the acknowledgement was lost. */ }
      }
      const observed = await adapter.getRef(owner, repo, 'heads/' + branch);
      if (observed?.ref !== 'refs/heads/' + branch || observed.object.sha !== head) return blocked('GitHub has not confirmed the exact publication branch. Review the ref and retry the same plan.');
      try { await adapter.createPullRequest(owner, repo, {head: branch, base: baseBranch, title: params.title, body: params.body(changes), draft: false}); }
      catch { /* Concurrent creates and lost acknowledgements require the same exact observation. */ }
      const verified = await adapter.listPullRequests(owner, repo, filter);
      if (verified.length !== 1 || !exactPull(verified[0]) || verified[0].state !== 'open' || verified[0].merged_at !== null || verified[0].head.sha !== head) {
        return blocked('GitHub has not confirmed an open pull request for the reviewed commit. Check the publication branch and retry this plan.');
      }
      audit.create({action: 'github.workflow.propose', resourceType: 'github-workflow-publication', resourceId: scope,
        details: {...details, pullNumber: verified[0].number}});
      return pending(verified[0], head);
    }
    return blocked('Publication history exceeded the supported review window. Inspect the previous pull requests before continuing.');
  } catch {
    return blocked('GitHub publication evidence could not be read. Check repository access and retry the reviewed plan.');
  }
}
