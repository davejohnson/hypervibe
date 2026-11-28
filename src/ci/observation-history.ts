import { z } from 'zod';
import type { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import type { ReleaseArtifact, ReleaseRun } from '../domain/ports/github-workflow-history.port.js';

const stamp = z.iso.datetime();
const cursorSchema = z.object({
  version: z.literal(1),
  repositoryId: z.string().regex(/^\d+$/),
  environment: z.string().min(1),
  provider: z.enum(['aws', 'azure', 'gcp']),
  hostedReview: z.literal(true).optional(),
  logs: stamp, jobs: stamp,
  // Start times of observed executions can precede the poll in which a schedule becomes overdue.
  starts: z.record(z.string(), z.array(stamp).max(1000)),
  schedules: z.record(z.string(), z.object({ definition: z.string(), since: stamp }).strict()),
}).strict();

export type ObserverCursor = z.infer<typeof cursorSchema>;
export type ObservationHistory = Pick<GitHubAdapter, 'listWorkflowRuns' | 'getWorkflowRun' | 'listWorkflowRunArtifacts' | 'readJsonArtifact'>;
export interface MonitorScope {
  repository: string; repositoryId: string; environment: string; branch: string; runId: string;
  provider: ObserverCursor['provider'];
}

async function* trustedObservationRuns(api: ObservationHistory, scope: MonitorScope) {
  const [owner, repo] = scope.repository.split('/');
  const file = `hypervibe-observe-${scope.environment}.yml`;
  for (let page = 1; page <= 10; page++) {
    const history = await api.listWorkflowRuns(owner, repo, file, { status: 'completed', per_page: 100, page });
    for (const candidate of history.workflow_runs) {
      if (candidate.id >= Number(scope.runId) || candidate.head_branch !== scope.branch || !['schedule', 'workflow_dispatch'].includes(candidate.event)) continue;
      const run = await api.getWorkflowRun(owner, repo, candidate.id);
      if (run.id !== candidate.id || run.repository?.id !== Number(scope.repositoryId) || run.head_repository?.id !== Number(scope.repositoryId)
        || run.run_attempt !== 1 || run.path !== `.github/workflows/${file}` || run.head_branch !== scope.branch
        || !['success', 'failure', 'cancelled', 'timed_out'].includes(run.conclusion ?? '') || run.status !== 'completed' || !['schedule', 'workflow_dispatch'].includes(run.event)) continue;
      const artifacts = await api.listWorkflowRunArtifacts(owner, repo, run.id);
      if (artifacts.total_count !== artifacts.artifacts.length) throw new Error('Incomplete runtime observation artifact listing.');
      // A runner can stop after collection committed both artifacts. An unfinished
      // collection supplies neither a cloud checkpoint nor hosted retry data.
      if (run.conclusion !== 'success' && (!artifactFor(run, artifacts.artifacts, scope, 'hypervibe-runtime-cursor')
        || !artifactFor(run, artifacts.artifacts, scope, 'hypervibe-runtime-observation'))) continue;
      yield { run, artifacts: artifacts.artifacts };
    }
    if (page * 100 >= history.total_count) return;
  }
  throw new Error('Runtime observation history could not be read completely.');
}

function artifactFor(run: ReleaseRun, artifacts: ReleaseArtifact[], scope: MonitorScope, name: string) {
  const matches = artifacts.filter(a => a.name === name);
  if (matches.length > 1) throw new Error('Ambiguous runtime observation artifact.');
  const artifact = matches[0];
  if (!artifact || artifact.expired) return undefined;
  const provenance = artifact.workflow_run;
  if (!provenance || provenance.id !== run.id || provenance.repository_id !== Number(scope.repositoryId)
    || provenance.head_repository_id !== Number(scope.repositoryId) || provenance.head_branch !== scope.branch
    || provenance.head_sha !== run.head_sha) throw new Error('Runtime observation artifact provenance could not be verified.');
  return artifact;
}

async function readCursor(api: ObservationHistory, scope: MonitorScope, artifact: ReleaseArtifact, now: Date) {
  const [owner, repo] = scope.repository.split('/');
  const cursor = cursorSchema.parse(await api.readJsonArtifact(owner, repo, artifact.id, 'next-cursor.json'));
  if (cursor.environment !== scope.environment || cursor.repositoryId !== scope.repositoryId
    || Date.parse(cursor.jobs) > now.getTime() || Date.parse(cursor.logs) > now.getTime()) throw new Error('Runtime observation checkpoint does not match this run.');
  return cursor;
}

export async function restoreObservationCursor(api: ObservationHistory, scope: MonitorScope, now: Date): Promise<{ cursor?: ObserverCursor; gap?: string }> {
  for await (const { run, artifacts } of trustedObservationRuns(api, scope)) {
    const artifact = artifactFor(run, artifacts, scope, 'hypervibe-runtime-cursor');
    if (!artifact) return { gap: 'The previous monitoring checkpoint is unavailable. Earlier coverage is unknown.' };
    const cursor = await readCursor(api, scope, artifact, now);
    if (cursor.provider !== scope.provider) return { gap: 'Hosting provider changed. Monitoring starts with the current provider.' };
    return { cursor };
  }
  return {};
}

const receiptSchema = cursorSchema.pick({ version: true, environment: true, repositoryId: true, provider: true }).extend({
  runId: z.number().int().positive(), offset: z.number().int().min(0).max(5010), complete: z.boolean(),
}).strict();
export type HostedProgress = Pick<z.infer<typeof receiptSchema>, 'runId' | 'offset' | 'complete'>;
export const hostedReplayLimit = 12;

export async function pendingHostedReports(api: ObservationHistory, scope: MonitorScope, now: Date, warn: (message: string) => void) {
  const [owner, repo] = scope.repository.split('/');
  const pending: Array<{ runId: number; artifactId: number; offset: number }> = [];
  let receipt: HostedProgress | undefined;
  for await (const { run, artifacts } of trustedObservationRuns(api, scope)) {
    // Confirm consent on the original collection, including after a disable/re-enable or provider change.
    const cursorArtifact = artifactFor(run, artifacts, scope, 'hypervibe-runtime-cursor');
    if (!cursorArtifact) { warn('A previous observation checkpoint is unavailable. Hosted replay stops at that poll.'); break; }
    const cursor = await readCursor(api, scope, cursorArtifact, now);
    if (!cursor.hostedReview || cursor.provider !== scope.provider) break;
    if (!receipt) {
      const saved = artifactFor(run, artifacts, scope, 'hypervibe-hosted-delivery');
      if (saved) {
        const value = receiptSchema.parse(await api.readJsonArtifact(owner, repo, saved.id, 'hosted-receipt.json'));
        if (value.runId > run.id || value.provider !== scope.provider || value.environment !== scope.environment || value.repositoryId !== scope.repositoryId) {
          throw new Error('Hosted delivery checkpoint does not match this run.');
        }
        receipt = value;
      }
    }
    if (receipt && (run.id < receipt.runId || (run.id === receipt.runId && receipt.complete))) break;
    if (pending.length === hostedReplayLimit) { warn('Hosted replay exceeded 12 prior polls. Older pending observations are outside the retry window.'); break; }
    const report = artifactFor(run, artifacts, scope, 'hypervibe-runtime-observation');
    if (!report) { warn('An earlier observation report is unavailable. Hosted review has a gap at that poll.'); break; }
    pending.push({ runId: run.id, artifactId: report.id, offset: receipt?.runId === run.id ? receipt.offset : 0 });
    if (receipt?.runId === run.id) break;
  }
  return pending.reverse();
}
