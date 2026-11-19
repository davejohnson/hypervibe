export interface WorkflowRunSummary {
  id: number;
  name: string;
  display_title?: string;
  run_attempt?: number;
  run_started_at?: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  head_sha: string;
  head_branch: string;
  event: string;
  html_url: string;
}

export interface ReleaseRun {
  id: number;
  path: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  event: string;
  run_attempt: number;
  run_started_at?: string;
  repository: { full_name: string; id?: number };
  head_repository: { full_name: string; id?: number };
}

export interface ReleaseArtifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  updated_at: string;
  workflow_run: {
    id: number;
    repository_id: number;
    head_repository_id: number;
    head_branch: string;
    head_sha: string;
  } | null;
}

export interface WorkflowAttemptJob {
  id: number;
  run_id: number;
  run_attempt?: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface WorkflowHistory {
  total_count: number;
  workflow_runs: WorkflowRunSummary[];
}

export interface RollbackHistoryReader {
  listWorkflowRuns(owner: string, repo: string, workflow: string, options: { per_page: number; page: number }): Promise<WorkflowHistory>;
  listWorkflowRunAttemptJobs(owner: string, repo: string, runId: number, attempt: number): Promise<{ total_count: number; jobs: WorkflowAttemptJob[] }>;
  getWorkflowRun(owner: string, repo: string, runId: number): Promise<ReleaseRun>;
}
