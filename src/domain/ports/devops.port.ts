import type { Observation } from './provider-observation.js';

export interface CodeRepositoryIdentity {
  provider: string;
  nativeId: string;
  instanceScope: string;
  canonicalScope: string;
  path: string;
  defaultBranch: string;
  webUrl: string;
  cloneUrls: string[];
}

export interface CodeRepositoryFile {
  path: string;
  ref: string;
  content: string;
  contentHash: string;
  lastCommitId?: string;
}

export interface CodeRepositoryCommitAction {
  action: 'create' | 'update' | 'delete';
  path: string;
  content?: string;
  previousPath?: string;
  /** Provider-observed optimistic concurrency token for an existing file. */
  lastCommitId?: string;
}

export interface CodeChangeRequest {
  nativeId: string;
  number: string;
  state: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  sourceSha?: string;
  mergedSha?: string;
  webUrl: string;
}

export interface CodeHostPort {
  observeRepository(scope: string): Promise<Observation<CodeRepositoryIdentity>>;
  observeFile(identity: CodeRepositoryIdentity, path: string, ref: string): Promise<Observation<CodeRepositoryFile>>;
  observeBranch(identity: CodeRepositoryIdentity, branch: string): Promise<Observation<{ name: string; sha: string }>>;
  createBranch(identity: CodeRepositoryIdentity, branch: string, ref: string): Promise<void>;
  createCommit(
    identity: CodeRepositoryIdentity,
    request: {
      branch: string;
      commitMessage: string;
      actions: CodeRepositoryCommitAction[];
      startBranch?: string;
      startSha?: string;
      force?: boolean;
    }
  ): Promise<{ id: string; webUrl?: string }>;
  listChangeRequests(
    identity: CodeRepositoryIdentity,
    request: { sourceBranch: string; targetBranch: string; state: 'opened' | 'merged' | 'closed' }
  ): Promise<CodeChangeRequest[]>;
  createChangeRequest(
    identity: CodeRepositoryIdentity,
    request: { sourceBranch: string; targetBranch: string; title: string; description: string }
  ): Promise<CodeChangeRequest>;
}

/** Identity is universal; mutation facets remain optional provider capabilities. */
export interface CodeHostIdentityPort {
  observeRepository(scope: string): Promise<Observation<CodeRepositoryIdentity>>;
}

export type CiPhase = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'skipped' | 'unknown';

export interface CiDefinitionSummary {
  id: string;
  name: string;
  path?: string;
  state: string;
  webUrl?: string;
}

export interface CiRunSummary {
  id: string;
  attempt?: string;
  name: string;
  phase: CiPhase;
  nativeStatus: string;
  sha: string;
  ref?: string;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  webUrl?: string;
}

export interface CiJobSummary {
  id: string;
  attempt?: string;
  name: string;
  phase: CiPhase;
  nativeStatus: string;
  startedAt?: string;
  completedAt?: string;
  webUrl?: string;
}

export interface CiArtifactSummary {
  id: string;
  name: string;
  runId?: string;
  jobId?: string;
  expired?: boolean;
  createdAt?: string;
  expiresAt?: string;
}

export interface CiDispatchRequest {
  definition: string;
  ref: string;
  sha?: string;
  inputs?: Record<string, string>;
}

export interface CiOperationsPort {
  listDefinitions(repository: CodeRepositoryIdentity): Promise<CiDefinitionSummary[]>;
  listRuns(repository: CodeRepositoryIdentity, definition: string, limit: number): Promise<CiRunSummary[]>;
  listJobs(repository: CodeRepositoryIdentity, runId: string, limit: number): Promise<CiJobSummary[]>;
  getJobLog(repository: CodeRepositoryIdentity, jobId: string): Promise<string>;
  listArtifacts(repository: CodeRepositoryIdentity, runId?: string, limit?: number): Promise<CiArtifactSummary[]>;
  dispatch(repository: CodeRepositoryIdentity, request: CiDispatchRequest): Promise<CiRunSummary>;
}

export type CiVariableValueVisibility = 'plaintext' | 'redacted' | 'omitted' | 'unknown';

export interface CiVariableObservation {
  id?: string;
  key: string;
  scope: string;
  precedence: string;
  protected: boolean;
  masked: boolean;
  hidden?: boolean;
  /** True means the provider passes the value literally without expansion. */
  raw: boolean;
  valueVisibility: CiVariableValueVisibility;
  valueHash?: string;
}
