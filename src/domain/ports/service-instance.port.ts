import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';

const identity = z.string().min(1).max(512).regex(/^[A-Za-z0-9_.:/-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const serviceInstanceTargetSchema = z.object({
  projectId: identity, environmentId: identity, serviceId: identity, sourceEnvironmentId: identity,
}).strict().refine(value => value.environmentId !== value.sourceEnvironmentId);
export type ServiceInstanceTarget = z.infer<typeof serviceInstanceTargetSchema>;
export const serviceInstanceIntentSchema = z.object({
  version: z.literal(1), provider: identity, target: serviceInstanceTargetSchema,
  sourceEnvironmentLocalId: identity, sourceBindingSha256: digest,
  nativeFingerprint: digest,
  workflowId: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_./:-]+$/).optional(),
  priorCreateRecoverySha256: digest.optional(),
  completed: z.literal(true).optional(),
}).strict();
export type ServiceInstanceIntent = z.infer<typeof serviceInstanceIntentSchema>;
export const serviceInstanceIntentsSchema = z.record(z.string().min(1), serviceInstanceIntentSchema);

export type ServiceInstanceObservation =
  | { state: 'absent' | 'empty'; fingerprint: string }
  | { state: 'unknown'; code: string };

/** Optional native capability: an existing accepted parent, a new isolated instance.
 * This is not name-based adoption and never grants authority over sibling instances.
 */
export interface IServiceInstances {
  resolveTarget(source: Environment, target: Environment, serviceName: string): ServiceInstanceTarget | undefined;
  observe(target: ServiceInstanceTarget, workflowId?: string): Promise<ServiceInstanceObservation>;
  /** Invoke beforeWrite after final native reads, immediately before dispatch. */
  create(target: ServiceInstanceTarget, expectedFingerprint: string, beforeWrite: () => void, acknowledged: (workflowId: string) => void): Promise<{
    mutationAttempted: boolean; success: boolean; code?: string;
  }>;
}
