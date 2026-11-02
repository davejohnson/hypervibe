import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const managedReleaseTargetSchema = z.object({ repository: z.string().min(1), environmentName: z.string().min(1),
  workflow: z.string().min(1), ref: z.string().min(1), targetSha: z.string().regex(/^[a-f0-9]{40}$/),
  workflowInputHash: hash, workflowContentHash: hash, deploymentContractHash: hash, credentialOperationsHash: hash }).strict();
const attemptSchema = z.object({ id: z.uuid(), target: managedReleaseTargetSchema,
  status: z.enum(['attempted', 'acknowledged', 'completed', 'succeeded', 'failed', 'rejected']), startedAt: z.iso.datetime(),
  runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), previousAttemptId: z.uuid().optional() }).strict();
export type ManagedReleaseDispatch = z.infer<typeof attemptSchema>;
export type ManagedReleaseTarget = z.infer<typeof managedReleaseTargetSchema>;
export function retainedManagedReleaseDispatch(environment: Environment): ManagedReleaseDispatch | undefined {
  return environment.platformBindings.managedReleaseDispatch === undefined ? undefined : attemptSchema.parse(environment.platformBindings.managedReleaseDispatch);
}
export function beginManagedReleaseDispatch(environment: Environment, target: ManagedReleaseTarget, retryAttemptId?: string, previousAttemptId?: string): ManagedReleaseDispatch {
  const prior = retainedManagedReleaseDispatch(environment);
  if (prior && !(['failed', 'rejected'].includes(prior.status) && retryAttemptId === prior.id)
    && !(['completed', 'succeeded'].includes(prior.status) && previousAttemptId === prior.id && !isDeepStrictEqual(prior.target, target))) throw new Error('A retained release attempt requires read-only recovery before another dispatch.');
  const attempt = attemptSchema.parse({ id: randomUUID(), target, status: 'attempted', startedAt: new Date().toISOString(),
    ...(prior ? { previousAttemptId: prior.id } : {}) });
  if (!new EnvironmentRepository().compareAndSwapPlatformBindings(environment.id, environment.platformBindings,
    { ...environment.platformBindings, managedReleaseDispatch: attempt })) throw new Error('Concurrent release authority changed before dispatch.');
  return attempt;
}
export function settleManagedReleaseDispatch(environmentId: string, attempt: ManagedReleaseDispatch, patch: Partial<Pick<ManagedReleaseDispatch, 'runId' | 'status'>>): ManagedReleaseDispatch {
  const repository = new EnvironmentRepository(), environment = repository.findById(environmentId);
  if (!environment || !isDeepStrictEqual(retainedManagedReleaseDispatch(environment), attempt)) throw new Error('Retained release attempt changed.');
  const next = attemptSchema.parse({ ...attempt, ...patch });
  if (attempt.runId !== undefined && next.runId !== attempt.runId) throw new Error('Native release run identity changed.');
  if (!repository.compareAndSwapPlatformBindings(environment.id, environment.platformBindings,
    { ...environment.platformBindings, managedReleaseDispatch: next })) throw new Error('Concurrent release recovery changed.');
  return next;
}
export function sameManagedReleaseTarget(attempt: ManagedReleaseDispatch, target: ManagedReleaseTarget): boolean {
  return isDeepStrictEqual(attempt.target, target);
}
