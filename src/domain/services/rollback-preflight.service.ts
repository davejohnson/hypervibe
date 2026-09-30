import { createHash } from 'node:crypto';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { SpecStore } from '../spec/spec.store.js';
import { resolveDevOpsSelection } from '../spec/devops-selection.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { getGitHubAdapter } from './github-ops.service.js';
import { observeManagedWorkflowFiles, resolveManagedWorkflowContract } from './ci-deploy.service.js';
import { MANAGED_CI_RELEASE_EVIDENCE_FILE, managedCiReleaseArtifactName } from './managed-ci-evidence.js';
import { inspectRollbackEvidence, type RollbackPreviewBlocker } from './rollback-preflight-evidence.js';

/** Read-only inspection of one exact recovery candidate, including the current release. */
export async function previewManagedCiRollback(params: {
  project: Project; environment: Environment; toSha: string; sourceWorkflowRunId: number; sourceArtifactId: number;
}) {
  const { project, environment } = params;
  const stored = new SpecStore().getForInspection(project);
  const selected = stored?.spec.environments[environment.name];
  const repository = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!stored || !selected || !repository || selected.deploy?.strategy !== 'branch'
      || (selected.deploy.trigger ?? 'ci') !== 'ci' || resolveDevOpsSelection(stored.spec)?.ci?.provider !== 'github-actions') {
    throw new Error('Read-only rollback preview requires a reviewed managed GitHub deployment target.');
  }
  const contract = resolveManagedWorkflowContract({ project, environmentName: environment.name, environmentSpec: selected, environment });
  if (!contract.ok) throw new Error(contract.error);
  const resolved = getGitHubAdapter(repository);
  if ('error' in resolved) throw new Error('A verified repository-scoped GitHub connection is required for rollback preview.');
  const github = resolved.adapter;
  const [owner, repo] = repository.split('/');
  const sha = params.toSha.toLowerCase();
  const blockers: RollbackPreviewBlocker[] = [];
  const run = await github.getWorkflowRun(owner, repo, params.sourceWorkflowRunId);
  if (run.id !== params.sourceWorkflowRunId || run.path !== contract.workflow.path
      || run.status !== 'completed' || run.conclusion !== 'success'
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
      || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error('Rollback source run provenance is incomplete or does not belong to this successful managed workflow.');
  const artifacts = await github.listWorkflowRunArtifacts(owner, repo, run.id);
  const candidates = artifacts.artifacts.filter(artifact => artifact.id === params.sourceArtifactId);
  if (artifacts.total_count !== artifacts.artifacts.length || candidates.length !== 1) throw new Error('Rollback artifact observation is incomplete or ambiguous.');
  const artifact = candidates[0];
  if (run.run_attempt !== 1) blockers.push({ code: 'retried_source_run', message: 'A retried source run needs attempt-specific artifact provenance before recovery can be authorized.' });
  const legacyName = `hypervibe-server-release-${environment.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${sha}`;
  if (artifact.expired || artifact.workflow_run?.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha
      || !Number.isSafeInteger(artifact.workflow_run.repository_id) || artifact.workflow_run.repository_id <= 0
      || artifact.workflow_run.repository_id !== artifact.workflow_run.head_repository_id
      || ![managedCiReleaseArtifactName(environment.name, sha), legacyName].includes(artifact.name)) {
    throw new Error('Rollback artifact does not match the exact source run, repository, SHA and environment, or has expired.');
  }
  const [files, sourceSpecText, sourceBindingsText, sourceWorkflowText, observation, latest, repositoryInfo, workflows] = await Promise.all([
    github.readArtifactFiles(owner, repo, artifact.id),
    github.getFileContent(owner, repo, '.hypervibe/spec.json', sha),
    github.getFileContent(owner, repo, '.hypervibe/bindings.json', run.head_sha),
    github.getFileContent(owner, repo, contract.workflow.path, run.head_sha),
    observeManagedWorkflowFiles({ adapter: github, owner, repo, contract }),
    github.listWorkflowRuns(owner, repo, contract.workflow.path, { per_page: 1 }),
    github.getRepository(owner, repo),
    github.listWorkflows(owner, repo),
  ]);
  if (Object.keys(files).length !== 1 || !Object.hasOwn(files, MANAGED_CI_RELEASE_EVIDENCE_FILE)
      || !sourceSpecText || !sourceWorkflowText) throw new Error('Original release bytes, source spec or producer workflow are unavailable.');
  if ((JSON.parse(files[MANAGED_CI_RELEASE_EVIDENCE_FILE]) as {version?: unknown}).version === 2 ? artifact.name !== legacyName : artifact.name === legacyName) {
    throw new Error('Rollback artifact name and evidence format disagree.');
  }
  const inspected = inspectRollbackEvidence({
    repository, sha, environment: environment.name, provider: selected.hosting.provider,
    evidenceText: files[MANAGED_CI_RELEASE_EVIDENCE_FILE], sourceSpecText, sourceBindingsText,
    currentSpec: stored.spec, target: contract.target.releaseTarget!, programFingerprint: contract.target.programFingerprint!,
  });
  if (observation.acceptance === 'drift') blockers.push({ code: 'workflow_drift', message: 'The managed deployment workflow must be reconciled before a rollback can be dispatched.' });
  if (repositoryInfo.default_branch !== contract.workflow.branch) blockers.push({ code: 'default_branch_changed', message: 'The managed deployment branch differs from the repository default branch.' });
  if (!workflows.workflows.some(workflow => workflow.path === contract.workflow.path && workflow.state === 'active')) {
    blockers.push({ code: 'workflow_inactive', message: 'The exact managed deployment workflow is not active.' });
  }
  const latestRun = latest.workflow_runs[0];
  if (!latestRun || latestRun.status !== 'completed') blockers.push({ code: 'deployment_not_terminal', message: 'The latest managed deployment is missing or still running.' });
  if (!contract.workflow.supportsImmutableRollback) blockers.push({ code: 'immutable_rollback_unsupported', message: 'The hosting workflow cannot restore an immutable image.' });
  blockers.push(...inspected.blockers);
  return {
    mode: 'preview' as const, status: blockers.length ? 'blocked' : 'evidence-compatible',
    evidenceCompatible: blockers.length === 0, restoreVerified: false,
    repository, workflow: contract.workflow.path, environment: environment.name,
    rollbackToSha: sha, sourceArtifactId: artifact.id, sourceWorkflowRunId: run.id,
    sourceWorkflowSha: run.head_sha,
    sourceWorkflowSha256: createHash('sha256').update(sourceWorkflowText, 'utf8').digest('hex'),
    ...(latestRun ? { observedLatestWorkflowRunId: latestRun.id } : {}),
    ...inspected, blockers,
    unchecked: ['Registry image availability and pull authorization', 'Live provider resource identities and runtime configuration', 'Application startup, migrations and health after restoration'],
    mutationCounts: { providerWrites: 0, ciDispatches: 0 },
  };
}
