import { z } from 'zod';
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
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { resolveDevOpsSelection } from '../spec/devops-selection.js';
import { observeManagedReleaseEvidence } from './managed-release-observation.js';

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
  const release = await observeManagedReleaseEvidence({ project: params.project, spec: params.spec, environment,
    expected: { workflow: metadata.release.workflow, branch: metadata.release.ref, sourceCommitSha: metadata.release.targetSha,
      workflowInputHash: metadata.release.workflowInputHash, workflowContentHash: metadata.release.workflowContentHash } });
  if (!release || release.imageUri === metadata.pending.holdingImage) {
    return blocked('The latest managed release does not prove the exact current application, environment and workload identities. No schedule was activated.');
  }
  const { imageUri, runId } = release;
  const resolvedHosting = await adapterFactory.getProviderAdapter(environmentSpec.hosting.provider, params.project, undefined, params.environmentName);
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
