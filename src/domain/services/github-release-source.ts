import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { assertCurrentReleaseAttempt, assertSameReleaseAttempt } from './ios-release-attempt.js';

type History = Awaited<ReturnType<GitHubAdapter['listWorkflowRuns']>>;
type HistoryRun = History['workflow_runs'][number];
type ReleaseRun = Awaited<ReturnType<GitHubAdapter['getWorkflowRun']>>;
type ReleaseArtifact = Awaited<ReturnType<GitHubAdapter['listWorkflowRunArtifacts']>>['artifacts'][number];
type ReleaseSource = { repository: string; branch: string; workflow: string; prefix: string };
const attemptContract = { assertCurrentReleaseAttempt, assertSameReleaseAttempt };
const url = new URL('../../../templates/managed-ci/release-source.cjs', import.meta.url);
export const releaseSourceRuntimeBase64 = readFileSync(url).toString('base64');
export const releaseSource = createRequire(import.meta.url)(fileURLToPath(url)) as {
  rollbackHistory(readPage: (page: number) => Promise<History>, excludeId?: number): Promise<Array<HistoryRun & {run_attempt: number}>>;
  assertRollbackRunOrder(selected: HistoryRun, runs: HistoryRun[]): void;
  trustedReleaseHead(ref: unknown, branch: string): string;
  matchesReleaseProducer(run: unknown, artifact: unknown, repository: string, branch: string, workflow: string): boolean;
  rollbackArtifactsForAttempt(run: ReleaseRun, artifacts: ReleaseArtifact[], source: ReleaseSource, contract: typeof attemptContract,
    readJobs: (id: number, attempt: number) => Promise<unknown>, readRun: (id: number) => Promise<ReleaseRun>): Promise<ReleaseArtifact[]>;
  isCommitOnReleaseBranch(sha: string, head: string, compare: (base: string, head: string) => Promise<unknown>): Promise<boolean>;
};

export function rollbackArtifactsForAttempt(github: GitHubAdapter, owner: string, repo: string,
  source: Omit<ReleaseSource, 'repository'>, run: ReleaseRun, artifacts: ReleaseArtifact[]): Promise<ReleaseArtifact[]> {
  return releaseSource.rollbackArtifactsForAttempt(run, artifacts, { ...source, repository: owner + '/' + repo }, attemptContract,
    (id, attempt) => github.listWorkflowRunAttemptJobs(owner, repo, id, attempt),
    id => github.getWorkflowRun(owner, repo, id));
}

export function rollbackHistory(github: GitHubAdapter, owner: string, repo: string, workflow: string) {
  return releaseSource.rollbackHistory(page => github.listWorkflowRuns(owner, repo, workflow, { per_page: 100, page }));
}
