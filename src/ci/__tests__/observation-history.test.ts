import { expect, it, vi } from 'vitest';
import { restoreObservationCursor, type MonitorScope } from '../observation-history.js';

const scope: MonitorScope = { repository: 'org/repo', repositoryId: '42', runId: '310', branch: 'main', environment: 'production', provider: 'aws' };
const now = new Date('2026-11-27T10:00:00Z');
const cursor = { version: 1, repositoryId: '42', environment: 'production', provider: 'aws', logs: now.toISOString(), jobs: now.toISOString(), starts: {}, schedules: {} };
const run = { id: 301, path: '.github/workflows/hypervibe-observe-production.yml', status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40), head_branch: 'main',
  event: 'schedule', run_attempt: 1, repository: { full_name: 'org/repo', id: 42 }, head_repository: { full_name: 'org/repo', id: 42 } };
const artifact = { id: 65, name: 'hypervibe-runtime-cursor', expired: false, created_at: '', updated_at: '',
  workflow_run: { id: run.id, repository_id: 42, head_repository_id: 42, head_branch: 'main', head_sha: run.head_sha } };
const api = () => ({ listWorkflowRuns: vi.fn().mockResolvedValue({ total_count: 1, workflow_runs: [run] }),
  getWorkflowRun: vi.fn().mockResolvedValue(run), listWorkflowRunArtifacts: vi.fn().mockResolvedValue({ total_count: 1, artifacts: [artifact] }),
  readJsonArtifact: vi.fn().mockResolvedValue(cursor) });

it('reads the cursor from the exact repository, workflow and run', async () => {
  const github = api();
  expect(await restoreObservationCursor(github, scope, now)).toEqual({ cursor });
  expect(github.readJsonArtifact).toHaveBeenCalledWith('org', 'repo', 65, 'next-cursor.json');
});
it('rejects mismatched artifact provenance and distinguishes expired evidence from the first poll', async () => {
  const github = api();
  github.listWorkflowRunArtifacts.mockResolvedValueOnce({ total_count: 1, artifacts: [{ ...artifact, workflow_run: { ...artifact.workflow_run, head_repository_id: 77 } }] });
  await expect(restoreObservationCursor(github, scope, now)).rejects.toThrow('provenance');
  github.listWorkflowRunArtifacts.mockResolvedValueOnce({ total_count: 0, artifacts: [] });
  expect((await restoreObservationCursor(github, scope, now)).gap).toMatch(/unavailable/);
  github.listWorkflowRuns.mockResolvedValueOnce({ total_count: 0, workflow_runs: [] });
  expect(await restoreObservationCursor(github, scope, now)).toEqual({});
});
it('restores a completed collection when the job times out after saving both artifacts', async () => {
  const github = api();
  const timedOut = { ...run, conclusion: 'timed_out' };
  github.listWorkflowRuns.mockImplementation(async (_owner, _repo, _file, options) => {
    return options.status === 'completed' ? { total_count: 1, workflow_runs: [timedOut] } : { total_count: 0, workflow_runs: [] };
  });
  github.getWorkflowRun.mockResolvedValue(timedOut);
  github.listWorkflowRunArtifacts.mockResolvedValue({ total_count: 2, artifacts: [artifact, { ...artifact, id: 66, name: 'hypervibe-runtime-observation' }] });
  expect(await restoreObservationCursor(github, scope, now)).toEqual({ cursor });
  github.listWorkflowRunArtifacts.mockResolvedValue({ total_count: 1, artifacts: [artifact] });
  expect(await restoreObservationCursor(github, scope, now)).toEqual({});
});
