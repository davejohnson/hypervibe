import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import type { BranchDeployTarget } from '../ports/ci-deploy.port.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import { preparedHostingReleaseEvidenceSchema, type PreparedHostingReleaseEvidence } from '../ports/hosting-prepared.port.js';
import { getGitHubAdapter, releaseEvidenceValidationRuntime } from './github-ops.service.js';
import { observeManagedWorkflowFiles, resolveManagedWorkflowContract, workflowFilesContentHash } from './ci-deploy.service.js';
import { environmentDeploymentContractHashForApply } from './deployment-contract.service.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { MANAGED_CI_RELEASE_EVIDENCE_FILE, managedCiReleaseArtifactName } from './managed-ci-evidence.js';
import { resolveDevOpsSelection } from '../spec/devops-selection.js';

export type ManagedReleaseExpectation = Pick<PreparedHostingReleaseEvidence, 'workflow' | 'branch' | 'sourceCommitSha' | 'workflowInputHash' | 'workflowContentHash'> & { runId?: number };
type ReleaseInput = { project: Project; spec: ProjectSpec; environment: Environment; expected?: ManagedReleaseExpectation; reviewed?: PreparedHostingReleaseEvidence };
export type ManagedReleaseArtifactEvidence = Omit<PreparedHostingReleaseEvidence, 'targets'> & { resources: NonNullable<BranchDeployTarget['releaseTarget']>['resources'] };

/** Read only. Reuses the schedule-activation proof: native run/artifact provenance,
 * exact committed producer files and our trusted v4 consumer. Missing authority
 * or uncertain evidence means unavailable, never a guessed successful release.
 */
export async function observeManagedReleaseArtifact(input: ReleaseInput): Promise<ManagedReleaseArtifactEvidence | undefined> {
  try {
    const { project, spec, environment } = input, environmentSpec = spec.environments[environment.name];
    const repository = parseGitHubRepoFromRemote(project.gitRemoteUrl);
    if (!environmentSpec || !repository || resolveDevOpsSelection(spec)?.ci?.provider !== 'github-actions') return;
    const contract = resolveManagedWorkflowContract({ project, environmentName: environment.name, environmentSpec, environment,
      ...(input.reviewed ? { reviewedTargetEnvironment: environment } : {}) });
    if (!contract.ok || !contract.target.releaseTarget || !contract.target.programFingerprint) return;
    const expected = input.expected ?? input.reviewed;
    if (expected && (contract.workflow.path !== expected.workflow || contract.workflow.branch !== expected.branch
      || contract.inputHash !== expected.workflowInputHash)) return;
    const resolved = getGitHubAdapter(repository);
    if ('error' in resolved) return;
    const github = resolved.adapter, [owner, repo] = repository.split('/');
    const [observation, ref, runs] = await Promise.all([
      observeManagedWorkflowFiles({ adapter: github, owner, repo, contract }),
      github.getRef(owner, repo, `heads/${contract.workflow.branch}`),
      github.listWorkflowRuns(owner, repo, contract.workflow.path, { per_page: 1 }),
    ]);
    const sha = ref?.object.sha;
    if (!sha || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha) || expected && expected.sourceCommitSha !== sha
      || observation.acceptance === 'drift' || !observation.liveContentHash
      || expected && observation.liveContentHash !== expected.workflowContentHash || runs.workflow_runs.length !== 1) return;
    const run = await github.getWorkflowRun(owner, repo, runs.workflow_runs[0].id);
    if (expected?.runId !== undefined && run.id !== expected.runId || run.id !== runs.workflow_runs[0].id || run.path !== contract.workflow.path || run.run_attempt !== 1
      || run.status !== 'completed' || run.conclusion !== 'success' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(run.head_sha)
      || run.head_branch !== contract.workflow.branch || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) return;
    const artifacts = await github.listWorkflowRunArtifacts(owner, repo, run.id);
    const matches = artifacts.artifacts.filter(artifact => artifact.name === managedCiReleaseArtifactName(environment.name, sha));
    if (artifacts.total_count !== artifacts.artifacts.length || matches.length !== 1) return;
    const artifact = matches[0];
    if (artifact.expired || artifact.workflow_run?.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha
      || !Number.isSafeInteger(artifact.workflow_run.repository_id) || artifact.workflow_run.repository_id <= 0
      || artifact.workflow_run.repository_id !== artifact.workflow_run.head_repository_id) return;
    const [files, producerFiles] = await Promise.all([
      github.readArtifactFiles(owner, repo, artifact.id),
      Promise.all(observation.desiredFiles.map(async file => ({ path: file.path, content: await github.getFileContent(owner, repo, file.path, run.head_sha) }))),
    ]);
    if (Object.keys(files).length !== 1 || !Object.hasOwn(files, MANAGED_CI_RELEASE_EVIDENCE_FILE)
      || producerFiles.some(file => file.content === null)
      || workflowFilesContentHash(producerFiles as Array<{ path: string; content: string }>) !== observation.liveContentHash) return;
    const module = { exports: {} as { validateReleaseEvidence(evidence: unknown, expected: Record<string, unknown>): { imageUri: string } } };
    new Function('require', 'module', 'exports', releaseEvidenceValidationRuntime())(createRequire(import.meta.url), module, module.exports);
    const deploymentContractFingerprint = environmentDeploymentContractHashForApply(spec, environment.name);
    const validated = module.exports.validateReleaseEvidence(JSON.parse(files[MANAGED_CI_RELEASE_EVIDENCE_FILE]), {
      label: 'Prepared workload', provider: environmentSpec.hosting.provider, environment: environment.name,
      repository, sha, target: contract.target.releaseTarget, programFingerprint: contract.target.programFingerprint,
      deploymentContractFingerprint, requireImmutableImage: true,
    });
    const [latest, currentRef, currentRun] = await Promise.all([
      github.listWorkflowRuns(owner, repo, contract.workflow.path, { per_page: 1 }),
      github.getRef(owner, repo, `heads/${contract.workflow.branch}`),
      github.getWorkflowRun(owner, repo, run.id),
    ]);
    if (latest.workflow_runs.length !== 1 || latest.workflow_runs[0].id !== run.id
      || latest.workflow_runs[0].status !== 'completed' || latest.workflow_runs[0].conclusion !== 'success'
      || latest.workflow_runs[0].head_sha !== run.head_sha || currentRef?.object.sha !== sha
      || currentRun.id !== run.id || currentRun.run_attempt !== 1 || currentRun.status !== 'completed' || currentRun.conclusion !== 'success'
      || currentRun.path !== run.path || currentRun.head_sha !== run.head_sha || currentRun.head_branch !== run.head_branch
      || currentRun.repository?.full_name !== repository || currentRun.head_repository?.full_name !== repository) return;
    const result: ManagedReleaseArtifactEvidence = { schemaVersion: 1, repository, workflow: contract.workflow.path, branch: contract.workflow.branch,
      sourceCommitSha: sha, workflowSourceCommitSha: run.head_sha, runId: run.id, runAttempt: run.run_attempt, artifactId: artifact.id,
      workflowInputHash: contract.inputHash, workflowContentHash: observation.liveContentHash, programFingerprint: contract.target.programFingerprint,
      deploymentContractFingerprint, imageUri: validated.imageUri, resources: contract.target.releaseTarget.resources };
    return result;
  } catch { return; }
}

/** Prepared handoff additionally requires the original native resource lifetimes. */
export async function observeManagedReleaseEvidence(input: ReleaseInput): Promise<PreparedHostingReleaseEvidence | undefined> {
  try {
    const artifact = await observeManagedReleaseArtifact(input); if (!artifact) return;
    const { resources, ...proof } = artifact, bindings = parseHostingBindings(input.environment);
    const targets = resources.map(resource => {
      const bound = bindings.services?.[resource.logicalName];
      const id = resource.providerResourceType === 'job' ? bound?.jobName ?? bound?.serviceId : bound?.serviceId;
      if (!bound?.resourceUid || id !== resource.providerResourceId) throw new Error();
      return { workload: resource.logicalName, kind: resource.providerResourceType, resourceId: resource.providerResourceId, resourceUid: bound.resourceUid };
    });
    const result = preparedHostingReleaseEvidenceSchema.parse({ ...proof, targets });
    if (input.reviewed && !isDeepStrictEqual(result, input.reviewed)) return;
    return result;
  } catch { return; }
}
