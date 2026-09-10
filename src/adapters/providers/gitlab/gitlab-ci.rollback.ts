import { AuditRepository } from '../../db/repositories/audit.repository.js';
import { RunRepository } from '../../db/repositories/run.repository.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Project } from '../../../domain/entities/project.entity.js';
import { resolvePlanActionAuthority } from '../../../domain/plan/action-authority.js';
import { ConvergeExecutor, type ActionResult, type PlanRunDocument } from '../../../domain/plan/converge.executor.js';
import type { PlanAction } from '../../../domain/plan/plan.types.js';
import type { CiJobSummary, CiRunSummary } from '../../../domain/ports/devops.port.js';
import { SpecStore } from '../../../domain/spec/spec.store.js';
import type {
  CiRollbackFailure,
  CiRollbackResult,
} from '../../../domain/services/ci-rollback.service.js';
import { CI_ROLLBACK_NOTE } from '../../../domain/services/ci-rollback.service.js';
import {
  GITLAB_CI_ROLLBACK_OPERATION,
  GITLAB_ROLLBACK_REF_ENSURE_OPERATION,
} from '../../../domain/services/ci-rollback.contract.js';
import { observeGitLabManagedProgram } from './gitlab-ci.lifecycle.js';

const FULL_SHA = /^[0-9a-f]{40}$/i;
const runRepo = new RunRepository();
const auditRepo = new AuditRepository();

type Selection = 'explicit' | 'last_known_good' | 'previous_successful';

type ReleaseEvidence = {
  sha: string;
  artifactId: string;
  jobId: string;
  pipelineId: string;
  createdAt: string;
  imageUri?: string;
};

type GitLabRollbackObservation = {
  program: Exclude<Awaited<ReturnType<typeof observeGitLabManagedProgram>>, { error: string }>;
  latestPipelineId: string;
  latestPhase: string;
  selection: Selection;
  currentRelease?: ReleaseEvidence;
  targetRelease: ReleaseEvidence;
  rollbackRef: string;
  specRevision: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error(`Cannot produce a rollback ref for environment ${value}`);
  return slug;
}

function sortRuns(runs: CiRunSummary[]): CiRunSummary[] {
  return [...runs].sort((left, right) => (
    new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime()
    || Number(right.id) - Number(left.id)
  ));
}

function currentJob(jobs: CiJobSummary[], name: string): CiJobSummary | null {
  const matches = jobs.filter((job) => job.name === name);
  const current = matches.filter((job) => job.attempt !== 'retried');
  const candidates = current.length > 0 ? current : matches;
  return candidates.sort((left, right) => Number(right.id) - Number(left.id))[0] ?? null;
}

async function evidenceFor(params: {
  observation: GitLabRollbackObservation['program'];
  environmentName: string;
  run: CiRunSummary;
  job: CiJobSummary;
}): Promise<ReleaseEvidence | null> {
  if (params.run.phase !== 'succeeded' || params.job.phase !== 'succeeded') return null;
  const artifact = await params.observation.adapter.readJobArtifactFile(
    params.observation.repository,
    params.job.id,
    '.hypervibe-release.json'
  );
  if (artifact.state === 'absent') return null;
  if (artifact.state === 'unknown') throw new Error(artifact.reason);
  let value: unknown;
  try {
    value = JSON.parse(artifact.value);
  } catch {
    throw new Error(`GitLab job ${params.job.id} emitted malformed Hypervibe release evidence`);
  }
  const evidence = asRecord(value);
  const expected = params.observation.releaseEvidence;
  const evidenceServices = Array.isArray(evidence?.services)
    ? [...evidence.services].sort()
    : null;
  const evidenceResources = Array.isArray(evidence?.providerResources)
    ? [...evidence.providerResources].sort()
    : null;
  const ci = asRecord(evidence?.ci);
  const imageUri = typeof evidence?.imageUri === 'string'
    ? evidence.imageUri.trim().toLowerCase()
    : '';
  const deployments = Array.isArray(evidence?.deployments) ? evidence.deployments : [];
  const deployedResources = expected.providerResources.length > 0
    ? deployments.map((entry) => {
        const deployment = asRecord(entry);
        return typeof deployment?.kind === 'string' && typeof deployment.name === 'string'
          ? `${deployment.kind}:${deployment.name}`
          : '';
      }).sort()
    : [];
  const immutableDeploymentsMatch = !expected.requiresImmutableImage || deployments.every((entry) => {
    const deployment = asRecord(entry);
    return deployment?.imageUri === imageUri
      && deployment.imageDigest === imageUri.split('@')[1];
  });
  if (
    evidence?.version !== 2
    || evidence.provider !== params.observation.hostingProvider
    || evidence.repository !== params.observation.repository.canonicalScope
    || evidence.environment !== params.environmentName
    || typeof evidence.sha !== 'string'
    || !FULL_SHA.test(evidence.sha)
    || evidence.sha.toLowerCase() !== params.run.sha.toLowerCase()
    || evidence.programFingerprint !== params.observation.programHash
    || evidence.deploymentContractFingerprint !== expected.deploymentContractFingerprint
    || !same(evidenceServices, expected.services)
    || !same(evidence?.providerIdentity, expected.providerIdentity)
    || !same(evidenceResources, expected.providerResources)
    || ci?.projectId !== params.observation.repository.nativeId
    || ci?.pipelineId !== params.run.id
    || ci?.jobId !== params.job.id
    || deployments.length === 0
    || (expected.providerResources.length > 0 && !same(deployedResources, expected.providerResources))
    || (expected.requiresImmutableImage && !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(imageUri))
    || !immutableDeploymentsMatch
  ) {
    throw new Error(`GitLab job ${params.job.id} release evidence does not match the exact managed repository, environment, services, provider identity, SHA, program, and CI execution`);
  }
  return {
    sha: evidence.sha.toLowerCase(),
    artifactId: `${params.job.id}:.hypervibe-release.json`,
    jobId: params.job.id,
    pipelineId: params.run.id,
    createdAt: params.job.completedAt ?? params.run.updatedAt ?? params.run.createdAt ?? '',
    ...(expected.requiresImmutableImage ? { imageUri } : {}),
  };
}

async function observeRollback(params: {
  project: Project;
  environment: Environment;
  toSha?: string;
}): Promise<CiRollbackFailure | { ok: true; observation: GitLabRollbackObservation }> {
  const stored = new SpecStore().get(params.project);
  const environmentSpec = stored?.spec.environments[params.environment.name];
  if (!stored || !environmentSpec) {
    return { ok: false, reason: 'invalid_target', error: `No desired-state spec exists for ${params.project.name}/${params.environment.name}.` };
  }
  const program = await observeGitLabManagedProgram({
    project: params.project,
    spec: stored.spec,
    environmentName: params.environment.name,
  });
  if ('error' in program) {
    return { ok: false, reason: 'workflow_drift', error: program.error, provider: 'gitlab' };
  }
  try {
    const runs = sortRuns(await program.adapter.listRuns(program.repository, program.rootPath, 100));
    const relevant: Array<{ run: CiRunSummary; job: CiJobSummary }> = [];
    for (const run of runs) {
      const jobs = await program.adapter.listJobs(program.repository, run.id, 100);
      const job = currentJob(jobs, program.deployJobName);
      if (job) relevant.push({ run, job });
    }
    const latest = relevant[0];
    if (!latest) {
      return { ok: false, reason: 'no_target_release', error: `No managed ${params.environment.name} GitLab deploy jobs exist.` };
    }
    if (latest.run.phase === 'queued' || latest.run.phase === 'running' || latest.job.phase === 'queued' || latest.job.phase === 'running') {
      return { ok: false, reason: 'rollback_in_progress', error: `GitLab pipeline ${latest.run.id} has managed deploy job ${latest.job.name} in phase ${latest.job.phase}.` };
    }
    const successful: ReleaseEvidence[] = [];
    for (const candidate of relevant) {
      const evidence = await evidenceFor({
        observation: program,
        environmentName: params.environment.name,
        run: candidate.run,
        job: candidate.job,
      });
      if (evidence) successful.push(evidence);
    }
    const currentRelease = latest.run.phase === 'succeeded' && latest.job.phase === 'succeeded'
      ? successful.find((release) => release.pipelineId === latest.run.id)
      : undefined;
    if (latest.run.phase === 'succeeded' && latest.job.phase === 'succeeded' && !currentRelease) {
      return { ok: false, reason: 'observation_failed', error: `Latest successful managed GitLab pipeline ${latest.run.id} has no valid release evidence.` };
    }
    const requested = params.toSha?.trim().toLowerCase();
    if (requested && !FULL_SHA.test(requested)) {
      return { ok: false, reason: 'invalid_target', error: 'toSha must be a full 40-character Git commit SHA.' };
    }
    if (requested && requested === currentRelease?.sha) {
      return { ok: false, reason: 'invalid_target', error: `The current verified release is already ${requested}.` };
    }
    let selection: Selection;
    let targetRelease: ReleaseEvidence | undefined;
    if (requested) {
      selection = 'explicit';
      targetRelease = successful.find((release) => release.sha === requested);
    } else if (currentRelease) {
      selection = 'previous_successful';
      targetRelease = successful.find((release) => release.sha !== currentRelease.sha);
    } else {
      selection = 'last_known_good';
      targetRelease = successful[0];
    }
    if (!targetRelease) {
      return {
        ok: false,
        reason: 'no_target_release',
        error: requested
          ? `No valid unexpired GitLab release evidence exists for ${requested}.`
          : 'No previous distinct successful GitLab release is available to restore.',
      };
    }
    const rollbackRef = `hypervibe-rollback-${safeSlug(params.environment.name)}-${targetRelease.sha.slice(0, 12)}-${targetRelease.jobId}`;
    return {
      ok: true,
      observation: {
        program,
        latestPipelineId: latest.run.id,
        latestPhase: latest.job.phase,
        selection,
        ...(currentRelease ? { currentRelease } : {}),
        targetRelease,
        rollbackRef,
        specRevision: stored.revision,
      },
    };
  } catch (error) {
    return { ok: false, reason: 'observation_failed', error: `Could not verify GitLab rollback evidence: ${error instanceof Error ? error.message : String(error)}`, provider: 'gitlab' };
  }
}

function sameObservation(left: GitLabRollbackObservation, right: GitLabRollbackObservation): boolean {
  return left.program.repository.nativeId === right.program.repository.nativeId
    && left.program.repository.instanceScope === right.program.repository.instanceScope
    && left.program.rootPath === right.program.rootPath
    && left.program.programHash === right.program.programHash
    && left.latestPipelineId === right.latestPipelineId
    && left.latestPhase === right.latestPhase
    && left.selection === right.selection
    && left.targetRelease.sha === right.targetRelease.sha
    && left.targetRelease.artifactId === right.targetRelease.artifactId
    && left.targetRelease.jobId === right.targetRelease.jobId
    && left.targetRelease.pipelineId === right.targetRelease.pipelineId
    && left.targetRelease.imageUri === right.targetRelease.imageUri
    && left.rollbackRef === right.rollbackRef;
}

export async function executeGitLabCiRollback(params: {
  project: Project;
  environment: Environment;
  toSha?: string;
}): Promise<CiRollbackFailure | CiRollbackResult> {
  const observed = await observeRollback(params);
  if (!observed.ok) return observed;
  const planned = observed.observation;
  const repository = planned.program.repository.canonicalScope;
  const refAction: PlanAction = {
    id: `repo:gitlab:rollback-ref:${planned.rollbackRef}`,
    type: 'create',
    resource: { kind: 'repo', name: planned.rollbackRef, provider: 'gitlab' },
    verified: true,
    reason: `Create immutable rollback ref ${planned.rollbackRef} at ${planned.targetRelease.sha}`,
    metadata: {
      operation: GITLAB_ROLLBACK_REF_ENSURE_OPERATION,
      repositoryId: planned.program.repository.nativeId,
      instanceScope: planned.program.repository.instanceScope,
      repositoryScope: repository,
      rollbackRef: planned.rollbackRef,
      targetSha: planned.targetRelease.sha,
      targetArtifactId: planned.targetRelease.artifactId,
      targetJobId: planned.targetRelease.jobId,
      targetPipelineId: planned.targetRelease.pipelineId,
      ...(planned.targetRelease.imageUri ? { targetImageUri: planned.targetRelease.imageUri } : {}),
      observedLatestPipelineId: planned.latestPipelineId,
    },
  };
  const dispatchAction: PlanAction = {
    id: `ci:gitlab-ci:${params.environment.name}:rollback`,
    type: 'update',
    resource: { kind: 'ci', name: `deploy-branch:${params.environment.name}`, provider: 'gitlab-ci' },
    verified: true,
    reason: `Restore verified ${params.environment.name} release ${planned.targetRelease.sha}`,
    dependsOn: [refAction.id],
    metadata: {
      operation: GITLAB_CI_ROLLBACK_OPERATION,
      repositoryId: planned.program.repository.nativeId,
      instanceScope: planned.program.repository.instanceScope,
      repositoryScope: repository,
      definition: planned.program.rootPath,
      environmentName: params.environment.name,
      rollbackRef: planned.rollbackRef,
      targetSha: planned.targetRelease.sha,
      targetArtifactId: planned.targetRelease.artifactId,
      targetJobId: planned.targetRelease.jobId,
      targetPipelineId: planned.targetRelease.pipelineId,
      ...(planned.targetRelease.imageUri ? { targetImageUri: planned.targetRelease.imageUri } : {}),
      observedLatestPipelineId: planned.latestPipelineId,
      programHash: planned.program.programHash,
      selection: planned.selection,
    },
  };
  const document: PlanRunDocument = {
    kind: 'hv_plan',
    environmentName: params.environment.name,
    specRevision: planned.specRevision,
    observedFingerprint: null,
    actions: [refAction, dispatchAction],
    warnings: [CI_ROLLBACK_NOTE],
  };
  const planRun = runRepo.create({
    projectId: params.project.id,
    environmentId: params.environment.id,
    type: 'plan',
    plan: document as unknown as Record<string, unknown>,
  });
  runRepo.updateStatus(planRun.id, 'succeeded');

  const handler = async (action: PlanAction): Promise<ActionResult> => {
    const authority = resolvePlanActionAuthority(action);
    const isRef = action.metadata?.operation === GITLAB_ROLLBACK_REF_ENSURE_OPERATION;
    const expectedCapability = isRef ? 'gitlab.rollback-ref.ensure' : 'gitlab.ci.rollback';
    if (
      authority?.capability !== expectedCapability
      || action.metadata?.repositoryId !== planned.program.repository.nativeId
      || action.metadata?.instanceScope !== planned.program.repository.instanceScope
      || action.metadata?.repositoryScope !== repository
      || action.metadata?.rollbackRef !== planned.rollbackRef
      || action.metadata?.targetSha !== planned.targetRelease.sha
      || action.metadata?.targetArtifactId !== planned.targetRelease.artifactId
      || action.metadata?.targetJobId !== planned.targetRelease.jobId
      || action.metadata?.targetPipelineId !== planned.targetRelease.pipelineId
      || action.metadata?.targetImageUri !== planned.targetRelease.imageUri
      || action.metadata?.observedLatestPipelineId !== planned.latestPipelineId
      || (!isRef && (
        action.metadata?.definition !== planned.program.rootPath
        || action.metadata?.environmentName !== params.environment.name
        || action.metadata?.programHash !== planned.program.programHash
        || action.metadata?.selection !== planned.selection
      ))
    ) {
      return { success: false, status: 'blocked', message: `Rollback action ${action.id} has stale mutation authority`, error: 'The reviewed GitLab repository, release evidence, or rollback ref changed.' };
    }
    const fresh = await observeRollback(params);
    if (!fresh.ok) return { success: false, status: 'blocked', message: 'GitLab rollback evidence could not be re-verified', error: fresh.error };
    if (!sameObservation(planned, fresh.observation)) {
      return { success: false, status: 'blocked', message: `GitLab rollback evidence changed after plan ${planRun.id}`, error: 'A newer managed deploy or different release target was observed. Start a new hv_rollback.' };
    }
    const tag = await fresh.observation.program.adapter.observeTag(
      fresh.observation.program.repository,
      planned.rollbackRef
    );
    if (tag.state === 'unknown') return { success: false, status: 'blocked', message: 'GitLab rollback ref observation is unknown', error: tag.reason };
    if (isRef) {
      if (tag.state === 'present' && tag.value.sha !== planned.targetRelease.sha) {
        return { success: false, status: 'blocked', message: 'GitLab rollback ref collision', error: `${planned.rollbackRef} points at a different commit.` };
      }
      if (tag.state === 'absent') {
        await fresh.observation.program.adapter.createTag(
          fresh.observation.program.repository,
          planned.rollbackRef,
          planned.targetRelease.sha
        );
      }
      const verified = await fresh.observation.program.adapter.observeTag(
        fresh.observation.program.repository,
        planned.rollbackRef
      );
      if (verified.state !== 'present' || verified.value.sha !== planned.targetRelease.sha) {
        return { success: false, status: 'blocked', message: 'GitLab rollback ref creation did not converge', error: verified.state === 'unknown' ? verified.reason : 'The exact tag is absent.' };
      }
      return { success: true, message: `Verified immutable GitLab rollback ref ${planned.rollbackRef}`, data: { rollbackRef: planned.rollbackRef, targetSha: planned.targetRelease.sha } };
    }
    if (tag.state !== 'present' || tag.value.sha !== planned.targetRelease.sha) {
      return { success: false, status: 'blocked', message: 'GitLab rollback ref dependency is missing', error: 'The exact reviewed rollback tag is not present.' };
    }
    const run = await fresh.observation.program.adapter.dispatch(
      fresh.observation.program.repository,
      {
        definition: planned.program.rootPath,
        ref: planned.rollbackRef,
        sha: planned.targetRelease.sha,
        inputs: {
          environment: params.environment.name,
          commit_sha: planned.targetRelease.sha,
          rollback: 'true',
          expected_latest_run_id: planned.latestPipelineId,
          source_artifact_id: planned.targetRelease.artifactId,
          source_pipeline_id: planned.targetRelease.pipelineId,
        },
      }
    );
    auditRepo.create({
      action: 'rollback.ci_dispatched',
      resourceType: 'gitlab_pipeline',
      resourceId: `${repository}/${run.id}`,
      details: {
        environment: params.environment.name,
        targetSha: planned.targetRelease.sha,
        rollbackRef: planned.rollbackRef,
        sourceArtifactId: planned.targetRelease.artifactId,
        sourcePipelineId: planned.targetRelease.pipelineId,
        ...(planned.targetRelease.imageUri ? { targetImageUri: planned.targetRelease.imageUri } : {}),
        planId: planRun.id,
      },
    });
    return {
      success: false,
      status: 'pending',
      message: `GitLab rollback pipeline ${run.id} dispatched for verified release ${planned.targetRelease.sha}`,
      data: { pipelineId: run.id, rollbackRef: planned.rollbackRef, rollbackToSha: planned.targetRelease.sha },
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
  const errors = converge.receipts.map((receipt) => receipt.error).filter((error): error is string => Boolean(error));
  return {
    ok: true,
    success: false,
    pending,
    strategy: 'managed-ci',
    status: pending ? 'pending' : blocked ? 'blocked' : 'failed',
    planId: planRun.id,
    ...(converge.applyRunId ? { applyRunId: converge.applyRunId } : {}),
    repository,
    workflow: planned.program.rootPath,
    ref: planned.rollbackRef,
    environment: params.environment.name,
    rollbackToSha: planned.targetRelease.sha,
    ...(planned.currentRelease ? { currentSha: planned.currentRelease.sha } : {}),
    sourceArtifactId: planned.targetRelease.artifactId,
    sourceWorkflowRunId: planned.targetRelease.pipelineId,
    observedLatestWorkflowRunId: planned.latestPipelineId,
    selection: planned.selection,
    receipts: converge.receipts,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
