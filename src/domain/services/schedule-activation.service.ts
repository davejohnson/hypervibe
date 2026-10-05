import { environmentDeploymentContractHashForApply } from './deployment-contract.service.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ProjectSpec, EnvironmentSpec } from '../spec/spec.schema.js';
import type { ObservedState } from '../ports/observe.port.js';
import { parseHostingBindings, pendingScheduleActivationSchema } from '../ports/hosting.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { adapterFactory } from './adapter.factory.js';
import { getGitHubAdapter, releaseEvidenceValidationRuntime } from './github-ops.service.js';
import { observeManagedWorkflowFiles, resolveManagedWorkflowContract, workflowFilesContentHash } from './ci-deploy.service.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { MANAGED_CI_RELEASE_EVIDENCE_FILE, managedCiReleaseArtifactName } from './managed-ci-evidence.js';
import { resolveDevOpsSelection } from '../spec/devops-selection.js';

export const SCHEDULE_ACTIVATION_OPERATION = 'hostingScheduleActivate';
export const scheduleActivationActionMetadataSchema = z.object({
  operation: z.literal(SCHEDULE_ACTIVATION_OPERATION),
  environmentName: z.string().min(1),
  pending: pendingScheduleActivationSchema,
  grantJobInvoker: z.literal(true),
  release: z.object({
    repository: z.string().min(1), workflow: z.string().min(1), ref: z.string().min(1),
    targetSha: z.string().regex(/^[0-9a-f]{40}$/i),
    workflowInputHash: z.string().regex(/^[0-9a-f]{64}$/),
    workflowContentHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict();

export function planScheduleActivations(params: {
  environment: Environment | null; environmentSpec: EnvironmentSpec; observed: ObservedState | null;
}): PlanAction[] {
  if (!params.environment) return [];
  const bindings = parseHostingBindings(params.environment);
  if (bindings.provider !== params.environmentSpec.hosting.provider) return [];
  return Object.entries(bindings.services ?? {}).flatMap(([name, bound]) => {
    if (!bound.scheduleActivation || params.environmentSpec.services[name]?.workloadKind !== 'cron') return [];
    const live = params.observed?.services.find(service => service.name === name && service.externalId === bound.serviceId);
    return [{
      id: `service:${name}:activate-schedule`, type: 'update' as const,
      resource: { kind: 'service' as const, name, provider: bindings.provider! },
      verified: live?.scheduleActivationPending === true, billable: true, requiresConfirm: true,
      reason: 'Grant the runtime identity invocation of this exact Job and activate its trigger after the application release is verified',
      metadata: { operation: SCHEDULE_ACTIVATION_OPERATION, environmentName: params.environment!.name,
        pending: bound.scheduleActivation, grantJobInvoker: true,
        ...(live?.scheduleActivationPending === true ? {} : { blockedReason: 'schedule_activation_observation_unknown' }),
      },
    }];
  });
}

/** Only the reviewed Job invocation grant and its missing trigger are mutable here. CI release and workload updates are separate actions. */
export async function applyScheduleActivation(params: {
  project: Project; spec: ProjectSpec; environmentName: string; action: PlanAction;
}): Promise<ActionResult> {
  const blocked = (message: string): ActionResult => ({ success: false, status: 'blocked', message,
    data: { applied: 0, skipped: 1, providerMutations: 0 } });
  const parsed = scheduleActivationActionMetadataSchema.safeParse(params.action.metadata);
  const environmentSpec = params.spec.environments[params.environmentName];
  const environmentRepo = new EnvironmentRepository();
  const environment = environmentRepo.findByProjectAndName(params.project.id, params.environmentName);
  const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl);
  if (!parsed.success || !environment || !environmentSpec || parsed.data.environmentName !== params.environmentName
      || parsed.data.release.repository !== repository || params.action.type !== 'update'
      || params.action.resource.kind !== 'service' || params.action.resource.provider !== environmentSpec.hosting.provider
      || params.action.id !== `service:${params.action.resource.name}:activate-schedule`
      || resolveDevOpsSelection(params.spec)?.ci?.provider !== 'github-actions') {
    return blocked('Schedule activation authority does not match the current environment. Re-run hv_plan.');
  }
  const metadata = parsed.data;
  const desired = environmentSpec.services[params.action.resource.name];
  const bindings = parseHostingBindings(environment);
  const bound = bindings.services?.[params.action.resource.name];
  const service = new ServiceRepository().findByProjectAndName(params.project.id, params.action.resource.name);
  if (!service || desired?.workloadKind !== 'cron' || !desired.cronSchedule || !bound?.scheduleActivation
      || bindings.provider !== environmentSpec.hosting.provider
      || bound.resourceUid !== metadata.pending.jobUid
      || bound.serviceId !== metadata.pending.jobName || bound.jobName !== metadata.pending.jobName
      || JSON.stringify(bound.scheduleActivation) !== JSON.stringify(metadata.pending)) {
    return blocked('Prepared schedule identity changed or is no longer pending. Re-run hv_plan.');
  }
  const contract = resolveManagedWorkflowContract({ project: params.project, environmentName: params.environmentName, environmentSpec, environment });
  if (!contract.ok || contract.workflow.path !== metadata.release.workflow || contract.workflow.branch !== metadata.release.ref
      || contract.inputHash !== metadata.release.workflowInputHash) return blocked('The reviewed release contract has changed. Re-run hv_plan.');
  const resolved = getGitHubAdapter(repository!);
  if ('error' in resolved) return blocked('A verified repository-scoped GitHub connection is required for schedule activation.');
  const [owner, repo] = repository!.split('/');
  let imageUri: string;
  let runId: number;
  try {
    const github = resolved.adapter;
    const [observation, ref, runs] = await Promise.all([
      observeManagedWorkflowFiles({ adapter: github, owner, repo, contract }),
      github.getRef(owner, repo, `heads/${metadata.release.ref}`),
      github.listWorkflowRuns(owner, repo, contract.workflow.path, { per_page: 1 }),
    ]);
    if (observation.acceptance === 'drift' || observation.liveContentHash !== metadata.release.workflowContentHash
        || ref?.object.sha !== metadata.release.targetSha || runs.workflow_runs.length !== 1) throw new Error('Release observation changed');
    const run = await github.getWorkflowRun(owner, repo, runs.workflow_runs[0].id);
    if (run.id !== runs.workflow_runs[0].id || run.path !== contract.workflow.path || run.run_attempt !== 1
        || run.status !== 'completed' || run.conclusion !== 'success' || !/^[a-f0-9]{40}$/.test(run.head_sha)
        || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) throw new Error('Unverified workflow run');
    const artifacts = await github.listWorkflowRunArtifacts(owner, repo, run.id);
    const matches = artifacts.artifacts.filter(artifact => artifact.name === managedCiReleaseArtifactName(params.environmentName, metadata.release.targetSha));
    if (artifacts.total_count !== artifacts.artifacts.length || matches.length !== 1) throw new Error('Incomplete release artifact observation');
    const artifact = matches[0];
    if (artifact.expired || artifact.workflow_run?.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha
        || !Number.isSafeInteger(artifact.workflow_run.repository_id) || artifact.workflow_run.repository_id <= 0
        || artifact.workflow_run.repository_id !== artifact.workflow_run.head_repository_id) throw new Error('Unverified artifact provenance');
    const [files, producerFiles] = await Promise.all([
      github.readArtifactFiles(owner, repo, artifact.id),
      Promise.all(observation.desiredFiles.map(async file => ({ path: file.path, content: await github.getFileContent(owner, repo, file.path, run.head_sha) }))),
    ]);
    if (Object.keys(files).length !== 1 || !Object.hasOwn(files, MANAGED_CI_RELEASE_EVIDENCE_FILE)
        || producerFiles.some(file => file.content === null)
        || workflowFilesContentHash(producerFiles as Array<{ path: string; content: string }>) !== observation.liveContentHash) throw new Error('Unverified release producer');
    // Execute only our trusted shared v4 consumer, never downloaded workflow code.
    const module = { exports: {} as {
      validateReleaseEvidence(evidence: unknown, expected: Record<string, unknown>): { imageUri: string };
    } };
    new Function('require', 'module', 'exports', releaseEvidenceValidationRuntime())(createRequire(import.meta.url), module, module.exports);
    const validated = module.exports.validateReleaseEvidence(JSON.parse(files[MANAGED_CI_RELEASE_EVIDENCE_FILE]), {
      label: 'Schedule activation', provider: environmentSpec.hosting.provider, environment: params.environmentName,
      repository, sha: metadata.release.targetSha, target: contract.target.releaseTarget,
      programFingerprint: contract.target.programFingerprint,
      deploymentContractFingerprint: environmentDeploymentContractHashForApply(params.spec, params.environmentName),
      requireImmutableImage: true,
    });
    imageUri = validated.imageUri;
    if (imageUri === metadata.pending.holdingImage) throw new Error('Holding image cannot activate a schedule');
    const [latest, currentRef] = await Promise.all([
      github.listWorkflowRuns(owner, repo, contract.workflow.path, { per_page: 1 }),
      github.getRef(owner, repo, `heads/${metadata.release.ref}`),
    ]);
    if (latest.workflow_runs.length !== 1 || latest.workflow_runs[0].id !== run.id
        || latest.workflow_runs[0].status !== 'completed' || latest.workflow_runs[0].conclusion !== 'success'
        || currentRef?.object.sha !== metadata.release.targetSha) throw new Error('Release changed during evidence verification');
    runId = run.id;
  } catch {
    return blocked('The latest managed release does not prove the exact current application, environment and workload identities. No schedule was activated.');
  }
  const resolvedHosting = await adapterFactory.getProviderAdapter(environmentSpec.hosting.provider, params.project);
  const adapter = resolvedHosting.adapter;
  if (!resolvedHosting.success || !adapter?.capabilities.supportsDeferredCronActivation || !adapter.activateSchedule) {
    return blocked('The hosting provider cannot activate prepared schedules through the shared release contract.');
  }
  await adapter.configureTarget?.({ region: environmentSpec.hosting.region });
  const result = await adapter.activateSchedule({ ...service, buildConfig: { ...service.buildConfig, ...desired } }, environment, {
    expectedImage: imageUri, expectedJobUid: metadata.pending.jobUid, sourceCommitSha: metadata.release.targetSha,
  });
  if (!result.receipt.success || result.status !== 'configured' || result.externalId !== metadata.pending.jobName
      || result.receipt.data?.scheduleActivated !== true || result.receipt.data?.invokerPermissionVerified !== true || result.receipt.data?.jobName !== metadata.pending.jobName
      || typeof result.receipt.data?.createdScheduler !== 'boolean'
      || typeof result.receipt.data?.invokerGrantApplied !== 'boolean'
      || typeof result.receipt.data?.schedulerJobName !== 'string' || !result.receipt.data.schedulerJobName.trim()) {
    return { success: false, message: 'Schedule activation did not return verified completion; its pending identity was retained.',
      data: { applied: null, skipped: 0 } };
  }
  const { scheduleActivation: _pending, ...retained } = bound;
  environmentRepo.updatePlatformBindings(environment.id, { services: { ...bindings.services,
    [service.name]: { ...retained, imageUri, schedulerJobName: result.receipt.data.schedulerJobName },
  } });
  const providerMutations = Number(result.receipt.data.createdScheduler) + Number(result.receipt.data.invokerGrantApplied);
  return { success: true, message: `Activated the verified schedule for ${service.name}`,
    data: { applied: providerMutations, skipped: providerMutations === 0 ? 1 : 0,
      providerMutations, bindingsApplied: 1, sourceWorkflowRunId: runId, imageUri } };
}
