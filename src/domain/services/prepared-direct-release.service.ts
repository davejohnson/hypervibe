import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import { hashEnvValue } from '../ports/observe.port.js';
import { preparedDirectReleaseAttemptSchema, preparedDirectReleaseEvidenceSchema, preparedDirectReleaseTargetSchema, preparedHostingMarkerSchema,
  type PreparedDirectReleaseControl, type PreparedDirectReleaseEvidence, type PreparedDirectReleaseTarget } from '../ports/hosting-prepared.port.js';

const attemptsSchema = z.record(z.string(), preparedDirectReleaseAttemptSchema);
const unavailable = () => new Error('The exact prepared release attempt or current reviewed authority is unavailable; no repeat deployment is authorized.');
const reviewKeys = ['installationId', 'planDigest', 'receiptDigest', 'configurationDigest', 'imageUri', 'projectId', 'environmentId', 'resourceId', 'resourceUid'] as const;
const targetReview = (target: PreparedDirectReleaseTarget) => ({ ...Object.fromEntries(reviewKeys.map(key => [key, target[key]])),
  ...(target.releaseCommandHash ? { releaseCommandHash: target.releaseCommandHash } : {}) });
export function preparedReleaseAttempts(environment: Environment) {
  return attemptsSchema.parse(environment.platformBindings.preparedDirectReleaseAttempts ?? {});
}
function scope(environment: Environment, target: PreparedDirectReleaseTarget) {
  const marker = preparedHostingMarkerSchema.parse(environment.platformBindings.preparedHosting);
  const service = (environment.platformBindings.services as Record<string, Record<string, unknown>> | undefined)?.[target.workload];
  if (environment.platformBindings.provider !== target.provider || environment.platformBindings.projectId !== target.projectId
    || environment.platformBindings.environmentId !== target.environmentId || service?.serviceId !== target.resourceId
    || service.resourceUid !== target.resourceUid || marker.installationId !== target.installationId || marker.planDigest !== target.planDigest
    || marker.receiptDigest !== target.receiptDigest || !marker.pendingFirstRelease.includes(target.workload)
    || marker.firstReleaseConfigurationDigests?.[target.workload] !== target.configurationDigest) throw unavailable();
  return marker;
}
/** Saved action authority is supplied by apply. The callback rechecks source,
 * run and action immediately before every durable attempt transition. */
export function createPreparedDirectReleaseControl(input: {
  planRunId: string; action: PlanAction; confirmed: boolean; expectedImage: string | undefined;
  load(): Environment; save(before: Environment, bindings: Record<string, unknown>): boolean; authorize(): boolean;
}): PreparedDirectReleaseControl {
  const check = (target: PreparedDirectReleaseTarget) => {
    preparedDirectReleaseTargetSchema.parse(target);
    if (!input.authorize() || input.action.type === 'noop' || input.action.requiresConfirm !== true || !input.confirmed
      || !['create', 'update'].includes(input.action.type) || input.action.id !== `service:${target.workload}`
      || input.action.resource.kind !== 'service' || input.action.resource.name !== target.workload
      || input.action.resource.provider !== target.provider || input.expectedImage !== target.imageUri
      || !isDeepStrictEqual(input.action.metadata?.preparedReleaseReview, targetReview(target))) throw unavailable();
    const environment = input.load(); scope(environment, target); return environment;
  };
  return {
    async read(target) {
      const environment = check(target), retained = preparedReleaseAttempts(environment)[target.workload];
      if (retained && !isDeepStrictEqual(retained.target, target)) throw unavailable();
      return retained;
    },
    async begin(target) {
      const environment = check(target), attempts = preparedReleaseAttempts(environment), previous = attempts[target.workload];
      if (previous && (previous.status !== 'rejected' || previous.planRunId === input.planRunId
        || input.action.metadata?.preparedReleaseRetry !== previous.id || !isDeepStrictEqual(previous.target, target))) throw unavailable();
      const attempt = preparedDirectReleaseAttemptSchema.parse({ id: randomUUID(), planRunId: input.planRunId,
        actionId: input.action.id, status: 'attempted', target });
      if (!input.save(environment, { ...environment.platformBindings, preparedDirectReleaseAttempts: { ...attempts, [target.workload]: attempt } })) throw unavailable();
      return attempt;
    },
    async settle(id, status) {
      const environment = input.load(), attempts = preparedReleaseAttempts(environment);
      const entry = Object.entries(attempts).find(([, value]) => value.id === id);
      if (!entry || entry[1].actionId !== input.action.id || !['attempted', 'uncertain'].includes(entry[1].status)
        || entry[1].planRunId !== input.planRunId && input.action.metadata?.preparedReleaseContinuation !== id) throw unavailable();
      check(entry[1].target);
      // A rejected rollout never erases a migration that has already started.
      if (status === 'rejected' && entry[1].releaseTask) status = 'uncertain';
      if (!input.save(environment, { ...environment.platformBindings, preparedDirectReleaseAttempts: { ...attempts, [entry[0]]: { ...entry[1], status } } })) throw unavailable();
    },
    async checkpoint(id, progress) {
      const environment = input.load(), attempts = preparedReleaseAttempts(environment);
      const entry = Object.entries(attempts).find(([, value]) => value.id === id);
      if (!entry || !['attempted', 'uncertain'].includes(entry[1].status)
        || entry[1].planRunId !== input.planRunId && input.action.metadata?.preparedReleaseContinuation !== id) throw unavailable();
      check(entry[1].target);
      const before = entry[1], next = preparedDirectReleaseAttemptSchema.parse({ ...before, ...progress });
      if (before.rolloutAttempted || next.releaseTask && !before.target.releaseCommandHash) throw unavailable();
      if (progress.releaseTask) {
        const phases = ['create-started', 'job-ready', 'run-started', 'run-acknowledged', 'completed'];
        if (phases.indexOf(progress.releaseTask.phase) !== (before.releaseTask ? phases.indexOf(before.releaseTask.phase) + 1 : 0)) throw unavailable();
        for (const [key, value] of Object.entries(before.releaseTask ?? {}))
          if (key !== 'phase' && progress.releaseTask[key as keyof typeof progress.releaseTask] !== value) throw unavailable();
      }
      if (progress.rolloutAttempted && before.target.releaseCommandHash && next.releaseTask?.phase !== 'completed') throw unavailable();
      if (!input.save(environment, { ...environment.platformBindings, preparedDirectReleaseAttempts: { ...attempts, [entry[0]]: next } })) throw unavailable();
    },
  };
}
export function reviewPreparedDirectReleaseActions(actions: PlanAction[], environment: Environment | null, images: Record<string, string>, nativeEvidence: PreparedDirectReleaseEvidence[] = []) {
  if (!environment?.platformBindings.preparedHosting) return actions;
  const marker = preparedHostingMarkerSchema.parse(environment.platformBindings.preparedHosting), attempts = preparedReleaseAttempts(environment);
  const reviewed = actions.map(action => {
    const completed = nativeEvidence.find(item => item.target.workload === action.resource.name && item.target.imageUri === images[action.resource.name]
      && item.attemptId === attempts[action.resource.name]?.id && isDeepStrictEqual(item.target, attempts[action.resource.name]?.target));
    const imageKey = `IMAGE_URI_${action.resource.name.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
    if (action.id === `service:${action.resource.name}` && action.type === 'update' && action.verified && completed
      && attempts[action.resource.name]?.status === 'completed' && !marker.pendingFirstRelease.includes(action.resource.name)
      && action.diff?.length && action.diff.every(item => ['env:IMAGE_URI', `env:${imageKey}`].includes(item.field)))
      return { ...action, type: 'noop' as const, diff: undefined, requiresConfirm: false, billable: false,
        reason: 'The exact immutable application image and reviewed configuration are independently verified; the image selector is not a runtime environment variable.' };
    if (!['create', 'update'].includes(action.type) || action.id !== `service:${action.resource.name}` || action.resource.kind !== 'service' || !marker.pendingFirstRelease.includes(action.resource.name) || !images[action.resource.name]) return action;
    const attempt = attempts[action.resource.name];
    const bound = (environment.platformBindings.services as Record<string, Record<string, unknown>> | undefined)?.[action.resource.name];
    const review = { installationId: marker.installationId, planDigest: marker.planDigest, receiptDigest: marker.receiptDigest,
      configurationDigest: marker.firstReleaseConfigurationDigests?.[action.resource.name], imageUri: images[action.resource.name],
      projectId: environment.platformBindings.projectId, environmentId: environment.platformBindings.environmentId,
      resourceId: bound?.serviceId, resourceUid: bound?.resourceUid,
      ...(() => { const command = action.diff?.find(item => item.field === 'releaseCommand')?.to;
        return typeof command === 'string' && command.trim() ? { releaseCommandHash: hashEnvValue(command.trim()) } : {}; })() };
    if (attempt && ['attempted', 'uncertain'].includes(attempt.status) && !attempt.rolloutAttempted
      && attempt.releaseTask && ['job-ready', 'run-acknowledged', 'completed'].includes(attempt.releaseTask.phase)
      && isDeepStrictEqual(targetReview(attempt.target), review)) return { ...action, requiresConfirm: true,
        reason: 'Continue the acknowledged release task by exact native readback, then roll out only after verified migration success. Never repeat a task create or execution.',
        metadata: { ...action.metadata, preparedReleaseReview: review, preparedReleaseContinuation: attempt.id } };
    if (attempt && ['attempted', 'uncertain'].includes(attempt.status)) return { ...action, verified: false, requiresConfirm: false,
      reason: 'The first release has an unresolved native attempt. Only exact read-only recovery can establish completion; no repeat deployment is authorized.',
      metadata: { ...action.metadata, blockedReason: 'Prepared first-release acknowledgment is unresolved. Re-plan to read the exact native image, configuration and resource lifetime.' } };
    return { ...action, requiresConfirm: true, metadata: { ...action.metadata, preparedReleaseReview: review },
      ...(attempt?.status === 'rejected' ? { reason: `Retry the exactly rejected first release of ${action.resource.name} using the reviewed immutable image.`,
        metadata: { ...action.metadata, preparedReleaseReview: review, preparedReleaseRetry: attempt.id } } : {}) };
  });
  const migrations = reviewed.filter(action => action.id === `service:${action.resource.name}` && action.type !== 'noop'
    && (action.metadata?.preparedReleaseReview as Record<string, unknown> | undefined)?.releaseCommandHash).map(action => action.id);
  return reviewed.map(action => action.id === `service:${action.resource.name}` && marker.pendingFirstRelease.includes(action.resource.name)
    && action.type !== 'noop' && !migrations.includes(action.id) && migrations.length
    ? { ...action, dependsOn: [...new Set([...(action.dependsOn ?? []), ...migrations])] } : action);
}
/** Merge native completion in the same CAS as service bindings. An HTTP
 * acknowledgment or ordinary deploy receipt alone cannot clear preparation. */
export function completePreparedDirectRelease(environment: Environment, value: unknown): Record<string, unknown> {
  const evidence = preparedDirectReleaseEvidenceSchema.parse(value), target = evidence.target;
  const attempts = preparedReleaseAttempts(environment), attempt = attempts[target.workload];
  if (attempt?.status === 'completed' && attempt.id === evidence.attemptId && isDeepStrictEqual(attempt.target, target)
    && isDeepStrictEqual((environment.platformBindings.preparedDirectReleaseEvidence as Record<string, unknown> | undefined)?.[target.workload], evidence)
    && !preparedHostingMarkerSchema.parse(environment.platformBindings.preparedHosting).pendingFirstRelease.includes(target.workload)) return environment.platformBindings;
  const marker = scope(environment, target);
  if (!attempt || attempt.id !== evidence.attemptId || !['attempted', 'uncertain'].includes(attempt.status)
    || !isDeepStrictEqual(attempt.target, target) || evidence.revision === target.holdingRevision
    || target.releaseCommandHash && (attempt.releaseTask?.phase !== 'completed' || !attempt.rolloutAttempted)) throw unavailable();
  const configurations = { ...marker.firstReleaseConfigurationDigests }; delete configurations[target.workload];
  return { ...environment.platformBindings,
    preparedHosting: { ...marker, pendingFirstRelease: marker.pendingFirstRelease.filter(name => name !== target.workload), firstReleaseConfigurationDigests: configurations },
    preparedDirectReleaseAttempts: { ...attempts, [target.workload]: { ...attempt, status: 'completed' } },
    preparedDirectReleaseEvidence: { ...(environment.platformBindings.preparedDirectReleaseEvidence as Record<string, unknown> ?? {}), [target.workload]: evidence },
  };
}
