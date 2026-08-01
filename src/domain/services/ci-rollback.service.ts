import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import type { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import { resolvePlanActionAuthority } from '../plan/action-authority.js';
import { ConvergeExecutor, type ActionResult, type PlanRunDocument } from '../plan/converge.executor.js';
import type { PlanAction } from '../plan/plan.types.js';
import { SpecStore } from '../spec/spec.store.js';
import {
  buildBranchDeployWorkflow,
  getGitHubAdapter,
  resolveBranchDeployTargets,
} from './github-ops.service.js';
import { syncProjectIntent } from './intent.service.js';
import { GITHUB_ACTIONS_ROLLBACK_OPERATION } from './ci-rollback.contract.js';

const runRepo = new RunRepository();
const auditRepo = new AuditRepository();
const FULL_SHA = /^[0-9a-f]{40}$/i;

type WorkflowRun = Awaited<ReturnType<GitHubAdapter['listWorkflowRuns']>>['workflow_runs'][number];
type WorkflowRunArtifact = Awaited<ReturnType<GitHubAdapter['listWorkflowRunArtifacts']>>['artifacts'][number];

export const CI_ROLLBACK_NOTE =
  'Managed CI rollback restores application code from a previously verified exact Git SHA. It does not reverse database migrations or provider-side manual configuration; startup and release-command migrations must remain backward-compatible.';

export type CiRollbackFailureReason =
  | 'invalid_target'
  | 'no_target_release'
  | 'no_adapter'
  | 'observation_failed'
  | 'rollback_in_progress'
  | 'workflow_drift'
  | 'workflow_inactive';

export type CiRollbackFailure = {
  ok: false;
  reason: CiRollbackFailureReason;
  error: string;
  hint?: string;
  provider?: 'github';
};

type ReleaseEvidence = {
  sha: string;
  artifactId: number;
  artifactName: string;
  workflowRunId: number;
  createdAt: string;
};

type RollbackSelection = 'explicit' | 'last_known_good' | 'previous_successful';

type ManagedCiRollbackObservation = {
  adapter: GitHubAdapter;
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
  latestWorkflowRunId: number;
  latestWorkflowConclusion: string;
  selection: RollbackSelection;
  currentRelease?: ReleaseEvidence;
  targetRelease: ReleaseEvidence;
  specRevision: number;
};

export type CiRollbackResult = {
  ok: true;
  success: false;
  pending: boolean;
  strategy: 'managed-ci';
  status: 'pending' | 'blocked' | 'failed';
  planId: string;
  applyRunId?: string;
  repository: string;
  workflow: string;
  ref: string;
  environment: string;
  rollbackToSha: string;
  currentSha?: string;
  sourceArtifactId: number;
  sourceWorkflowRunId: number;
  observedLatestWorkflowRunId: number;
  selection: RollbackSelection;
  receipts: Awaited<ReturnType<ConvergeExecutor['execute']>>['receipts'];
  errors?: string[];
  intent: ReturnType<typeof syncProjectIntent>;
};

function safeEnvironmentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

function sortRunsNewestFirst(runs: WorkflowRun[]): WorkflowRun[] {
  return [...runs].sort((left, right) => (
    new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
    || right.id - left.id
  ));
}

async function releaseEvidenceForRun(params: {
  adapter: GitHubAdapter;
  owner: string;
  repo: string;
  environmentName: string;
  run: WorkflowRun;
}): Promise<ReleaseEvidence | null> {
  const artifacts = await params.adapter.listWorkflowRunArtifacts(
    params.owner,
    params.repo,
    params.run.id
  );
  const prefix = `hypervibe-server-release-${safeEnvironmentName(params.environmentName)}-`;
  const matches = artifacts.artifacts
    .filter((artifact) => !artifact.expired && artifact.workflow_run?.id === params.run.id)
    .map((artifact): { artifact: WorkflowRunArtifact; sha: string } | null => {
      if (!artifact.name.startsWith(prefix)) return null;
      const sha = artifact.name.slice(prefix.length).toLowerCase();
      return FULL_SHA.test(sha) ? { artifact, sha } : null;
    })
    .filter((entry): entry is { artifact: WorkflowRunArtifact; sha: string } => entry !== null);

  const distinctShas = new Set(matches.map((entry) => entry.sha));
  if (distinctShas.size > 1) {
    throw new Error(
      `Workflow run ${params.run.id} emitted ambiguous production release evidence for ${Array.from(distinctShas).join(', ')}`
    );
  }
  const selected = matches.sort((left, right) => (
    new Date(right.artifact.created_at).getTime() - new Date(left.artifact.created_at).getTime()
    || right.artifact.id - left.artifact.id
  ))[0];
  if (!selected) return null;
  return {
    sha: selected.sha,
    artifactId: selected.artifact.id,
    artifactName: selected.artifact.name,
    workflowRunId: params.run.id,
    createdAt: selected.artifact.created_at,
  };
}

async function observeManagedCiRollback(params: {
  project: Project;
  environment: Environment;
  toSha?: string;
}): Promise<CiRollbackFailure | { ok: true; observation: ManagedCiRollbackObservation }> {
  const storedSpec = new SpecStore().get(params.project);
  const environmentSpec = storedSpec?.spec.environments[params.environment.name];
  if (!storedSpec || !environmentSpec) {
    return {
      ok: false,
      reason: 'invalid_target',
      error: `No desired-state spec exists for ${params.project.name}/${params.environment.name}.`,
    };
  }

  const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl);
  if (!repository) {
    return {
      ok: false,
      reason: 'invalid_target',
      error: 'Could not determine the managed GitHub repository from project gitRemoteUrl.',
    };
  }
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    return { ok: false, reason: 'invalid_target', error: `Invalid GitHub repository ${repository}.` };
  }

  const targets = resolveBranchDeployTargets(params.project);
  const target = targets.targets.find((candidate) => candidate.environmentName === params.environment.name);
  if (!target) {
    return {
      ok: false,
      reason: 'invalid_target',
      error: `${params.environment.name} is not configured for a Hypervibe-managed GitHub Actions deploy.`,
    };
  }
  const workflow = buildBranchDeployWorkflow(
    environmentSpec.hosting.provider,
    target,
    targets.migration,
    environmentSpec.ios
  );
  const adapterResult = getGitHubAdapter(repository);
  if ('error' in adapterResult) {
    return { ok: false, reason: 'no_adapter', error: adapterResult.error, provider: 'github' };
  }
  const adapter = adapterResult.adapter;

  try {
    const [liveContent, workflows] = await Promise.all([
      adapter.getFileContent(owner, repo, workflow.path),
      adapter.listWorkflows(owner, repo),
    ]);
    if (liveContent !== workflow.content) {
      return {
        ok: false,
        reason: 'workflow_drift',
        error: `Managed rollback is blocked because ${workflow.path} is missing or differs from the current desired workflow.`,
        hint: 'Run hv_plan and hv_apply, merge the generated GitHub infrastructure pull request, then retry hv_rollback.',
      };
    }
    const liveWorkflow = workflows.workflows.find((candidate) => candidate.path === workflow.path);
    if (!liveWorkflow || liveWorkflow.state !== 'active') {
      return {
        ok: false,
        reason: 'workflow_inactive',
        error: `Managed rollback is blocked because ${workflow.path} is not active.`,
      };
    }

    const runsResponse = await adapter.listWorkflowRuns(owner, repo, workflow.path, { per_page: 100 });
    const runs = sortRunsNewestFirst(runsResponse.workflow_runs);
    const latestRun = runs[0];
    if (!latestRun) {
      return {
        ok: false,
        reason: 'no_target_release',
        error: `No production workflow runs exist for ${workflow.path}.`,
      };
    }
    if (latestRun.status !== 'completed') {
      return {
        ok: false,
        reason: 'rollback_in_progress',
        error: `Workflow run ${latestRun.id} is ${latestRun.status}; wait for it to finish before starting a rollback.`,
      };
    }

    const successfulRuns = runs.filter((run) => run.status === 'completed' && run.conclusion === 'success');
    let currentRelease: ReleaseEvidence | undefined;
    if (latestRun.conclusion === 'success') {
      const current = await releaseEvidenceForRun({
        adapter,
        owner,
        repo,
        environmentName: params.environment.name,
        run: latestRun,
      });
      if (!current) {
        return {
          ok: false,
          reason: 'observation_failed',
          error: `Latest successful workflow run ${latestRun.id} has no unexpired Hypervibe release evidence, so the current production release is unknown.`,
        };
      }
      currentRelease = current;
    }

    const requestedSha = params.toSha?.trim().toLowerCase();
    if (requestedSha && !FULL_SHA.test(requestedSha)) {
      return { ok: false, reason: 'invalid_target', error: 'toSha must be a full 40-character Git commit SHA.' };
    }
    if (requestedSha && currentRelease?.sha === requestedSha) {
      return {
        ok: false,
        reason: 'invalid_target',
        error: `Production is already at verified release ${requestedSha}.`,
      };
    }

    let targetRelease: ReleaseEvidence | undefined;
    let selection: RollbackSelection;
    if (requestedSha) {
      selection = 'explicit';
      for (const run of successfulRuns) {
        const evidence = run.id === currentRelease?.workflowRunId
          ? currentRelease
          : await releaseEvidenceForRun({
              adapter,
              owner,
              repo,
              environmentName: params.environment.name,
              run,
            });
        if (evidence?.sha === requestedSha) {
          targetRelease = evidence;
          break;
        }
      }
    } else if (latestRun.conclusion === 'success') {
      selection = 'previous_successful';
      for (const run of successfulRuns) {
        if (run.id === latestRun.id) continue;
        const evidence = await releaseEvidenceForRun({
          adapter,
          owner,
          repo,
          environmentName: params.environment.name,
          run,
        });
        if (evidence && evidence.sha !== currentRelease?.sha) {
          targetRelease = evidence;
          break;
        }
      }
    } else {
      selection = 'last_known_good';
      for (const run of successfulRuns) {
        const evidence = await releaseEvidenceForRun({
          adapter,
          owner,
          repo,
          environmentName: params.environment.name,
          run,
        });
        if (evidence) {
          targetRelease = evidence;
          break;
        }
      }
    }

    if (!targetRelease) {
      return {
        ok: false,
        reason: 'no_target_release',
        error: requestedSha
          ? `No unexpired successful ${params.environment.name} release evidence exists for ${requestedSha}.`
          : latestRun.conclusion === 'success'
            ? `No previous distinct successful ${params.environment.name} release is available to restore.`
            : `No last-known-good ${params.environment.name} release is available to restore after workflow run ${latestRun.id} failed.`,
      };
    }

    return {
      ok: true,
      observation: {
        adapter,
        owner,
        repo,
        workflow: workflow.path,
        ref: target.branch,
        latestWorkflowRunId: latestRun.id,
        latestWorkflowConclusion: latestRun.conclusion ?? 'unknown',
        selection,
        ...(currentRelease ? { currentRelease } : {}),
        targetRelease,
        specRevision: storedSpec.revision,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'observation_failed',
      error: `Could not verify managed rollback evidence: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function sameAuthorizedObservation(
  planned: ManagedCiRollbackObservation,
  fresh: ManagedCiRollbackObservation
): boolean {
  return fresh.owner === planned.owner
    && fresh.repo === planned.repo
    && fresh.workflow === planned.workflow
    && fresh.ref === planned.ref
    && fresh.latestWorkflowRunId === planned.latestWorkflowRunId
    && fresh.latestWorkflowConclusion === planned.latestWorkflowConclusion
    && fresh.selection === planned.selection
    && fresh.targetRelease.sha === planned.targetRelease.sha
    && fresh.targetRelease.artifactId === planned.targetRelease.artifactId
    && fresh.targetRelease.workflowRunId === planned.targetRelease.workflowRunId;
}

export async function executeManagedCiRollback(params: {
  project: Project;
  environment: Environment;
  toSha?: string;
}): Promise<CiRollbackFailure | CiRollbackResult> {
  const observed = await observeManagedCiRollback(params);
  if (!observed.ok) return observed;
  const planned = observed.observation;
  const repository = `${planned.owner}/${planned.repo}`;
  const actionId = `ci:github-actions:${params.environment.name}:rollback`;
  const action: PlanAction = {
    id: actionId,
    type: 'update',
    resource: { kind: 'ci', name: `deploy-branch:${params.environment.name}`, provider: 'github' },
    verified: true,
    reason: `Restore verified ${params.environment.name} release ${planned.targetRelease.sha}`,
    metadata: {
      operation: GITHUB_ACTIONS_ROLLBACK_OPERATION,
      repository,
      workflow: planned.workflow,
      ref: planned.ref,
      targetSha: planned.targetRelease.sha,
      targetArtifactId: planned.targetRelease.artifactId,
      targetWorkflowRunId: planned.targetRelease.workflowRunId,
      observedLatestWorkflowRunId: planned.latestWorkflowRunId,
      observedLatestConclusion: planned.latestWorkflowConclusion,
      selection: planned.selection,
    },
  };
  const document: PlanRunDocument = {
    kind: 'hv_plan',
    environmentName: params.environment.name,
    specRevision: planned.specRevision,
    observedFingerprint: null,
    actions: [action],
    warnings: [CI_ROLLBACK_NOTE],
  };
  const planRun = runRepo.create({
    projectId: params.project.id,
    environmentId: params.environment.id,
    type: 'plan',
    plan: document as unknown as Record<string, unknown>,
  });
  runRepo.updateStatus(planRun.id, 'succeeded');

  const handler = async (candidate: PlanAction): Promise<ActionResult> => {
    const authority = resolvePlanActionAuthority(candidate);
    const metadata = candidate.metadata ?? {};
    if (
      authority?.capability !== 'github.ci.rollback'
      || authority.resource.name !== `deploy-branch:${params.environment.name}`
      || metadata.repository !== repository
      || metadata.workflow !== planned.workflow
      || metadata.ref !== planned.ref
      || metadata.targetSha !== planned.targetRelease.sha
      || metadata.targetArtifactId !== planned.targetRelease.artifactId
      || metadata.targetWorkflowRunId !== planned.targetRelease.workflowRunId
      || metadata.observedLatestWorkflowRunId !== planned.latestWorkflowRunId
    ) {
      return {
        success: false,
        status: 'blocked',
        message: `Rollback action ${candidate.id} has stale mutation authority`,
        error: 'The reviewed repository, workflow, release evidence, or target SHA does not match this rollback. Start a new hv_rollback.',
      };
    }

    const freshResult = await observeManagedCiRollback(params);
    if (!freshResult.ok) {
      return {
        success: false,
        status: 'blocked',
        message: `Rollback evidence could not be re-verified for ${candidate.id}`,
        error: freshResult.error,
      };
    }
    if (!sameAuthorizedObservation(planned, freshResult.observation)) {
      return {
        success: false,
        status: 'blocked',
        message: `Rollback evidence changed after plan ${planRun.id}`,
        error: 'A newer workflow run or different release target was observed. Start a new hv_rollback.',
      };
    }

    await freshResult.observation.adapter.triggerWorkflow(
      planned.owner,
      planned.repo,
      planned.workflow,
      planned.ref,
      {
        commit_sha: planned.targetRelease.sha,
        rollback: 'true',
        expected_latest_run_id: String(planned.latestWorkflowRunId),
        source_artifact_id: String(planned.targetRelease.artifactId),
        source_workflow_run_id: String(planned.targetRelease.workflowRunId),
      }
    );
    auditRepo.create({
      action: 'rollback.ci_dispatched',
      resourceType: 'github_workflow',
      resourceId: `${repository}/${planned.workflow}`,
      details: {
        environment: params.environment.name,
        targetSha: planned.targetRelease.sha,
        sourceArtifactId: planned.targetRelease.artifactId,
        sourceWorkflowRunId: planned.targetRelease.workflowRunId,
        planId: planRun.id,
      },
    });
    return {
      success: false,
      status: 'pending',
      message: `Rollback workflow dispatched for verified release ${planned.targetRelease.sha}`,
      data: {
        repository,
        workflow: planned.workflow,
        ref: planned.ref,
        rollbackToSha: planned.targetRelease.sha,
        sourceArtifactId: planned.targetRelease.artifactId,
        sourceWorkflowRunId: planned.targetRelease.workflowRunId,
      },
    };
  };

  const currentSpecRevision = new SpecStore().get(params.project)?.revision ?? planned.specRevision;
  const converge = await new ConvergeExecutor().execute({
    planRunId: planRun.id,
    currentSpecRevision,
    freshObservedFingerprint: null,
    handler,
  });
  const pending = converge.receipts.some((receipt) => receipt.status === 'pending');
  const blocked = converge.receipts.some((receipt) => receipt.status === 'blocked');
  const errors = converge.receipts
    .map((receipt) => receipt.error)
    .filter((error): error is string => Boolean(error));

  return {
    ok: true,
    success: false,
    pending,
    strategy: 'managed-ci',
    status: pending ? 'pending' : blocked ? 'blocked' : 'failed',
    planId: planRun.id,
    ...(converge.applyRunId ? { applyRunId: converge.applyRunId } : {}),
    repository,
    workflow: planned.workflow,
    ref: planned.ref,
    environment: params.environment.name,
    rollbackToSha: planned.targetRelease.sha,
    ...(planned.currentRelease ? { currentSha: planned.currentRelease.sha } : {}),
    sourceArtifactId: planned.targetRelease.artifactId,
    sourceWorkflowRunId: planned.targetRelease.workflowRunId,
    observedLatestWorkflowRunId: planned.latestWorkflowRunId,
    selection: planned.selection,
    receipts: converge.receipts,
    ...(errors.length > 0 ? { errors } : {}),
    intent: syncProjectIntent(params.project.id),
  };
}
