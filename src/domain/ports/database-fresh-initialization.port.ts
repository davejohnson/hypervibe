import { z } from 'zod';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { recoveryIdentityStringSchema } from '../services/recovery-source.js';

export const databaseFreshInitializationTargetSchema = z.object({
  provider: recoveryIdentityStringSchema,
  externalId: recoveryIdentityStringSchema,
  providerScope: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), recoveryIdentityStringSchema)
    .refine(scope => Object.keys(scope).length > 0, 'Initialization requires exact native scope.'),
}).strict();
export const databaseFreshInitializationIntentSchema = z.object({
  id: z.string().min(1).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  discardExistingData: z.literal(true),
  target: databaseFreshInitializationTargetSchema.omit({ provider: true }),
  /** Separate reviewed schema bootstrap after storage activation. Never a release receipt. */
  bootstrap: z.object({
    service: z.string().min(1).max(128),
    image: z.string().regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/),
  }).strict().optional(),
}).strict();
export const databaseFreshInitializationInspectionSchema = z.object({
  target: databaseFreshInitializationTargetSchema,
  /** Non-secret identity, configuration names and key presence; never credential hashes. */
  configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** Provider configuration and credentials. Encrypt before persistence; never render. */
  privateConfiguration: z.record(z.string(), z.unknown()),
}).strict();
export type DatabaseFreshInitializationInspection = z.infer<typeof databaseFreshInitializationInspectionSchema>;

export const databaseFreshInitializationProgressSchema = z.object({
  phase: z.enum(['prepared', 'configuration-attempted', 'configuration-verified',
    'storage-attempted', 'storage-identified', 'storage-verified',
    'activation-attempted', 'activation-identified', 'complete']),
  storageId: recoveryIdentityStringSchema.optional(),
  storageInstanceId: recoveryIdentityStringSchema.optional(),
  deploymentId: recoveryIdentityStringSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const storageIdentified = ['storage-identified', 'storage-verified', 'activation-attempted', 'activation-identified', 'complete'].includes(value.phase);
  const storageVerified = ['storage-verified', 'activation-attempted', 'activation-identified', 'complete'].includes(value.phase);
  const activationIdentified = ['activation-identified', 'complete'].includes(value.phase);
  if (storageIdentified
    && !value.storageId) ctx.addIssue({ code: 'custom', message: 'Initialization progress requires its acknowledged storage identity.' });
  if (storageVerified && !value.storageInstanceId) ctx.addIssue({ code: 'custom', message: 'Initialization progress requires its exact verified storage instance.' });
  if (activationIdentified && !value.deploymentId) {
    ctx.addIssue({ code: 'custom', message: 'Initialization progress requires its acknowledged deployment identity.' });
  }
  if (!storageIdentified && (value.storageId || value.storageInstanceId) || !activationIdentified && value.deploymentId) {
    ctx.addIssue({ code: 'custom', message: 'Initialization progress cannot contain identities before their acknowledged phase.' });
  }
});
export type DatabaseFreshInitializationProgress = z.infer<typeof databaseFreshInitializationProgressSchema>;

export type DatabaseFreshInitializationEligibility =
  | { state: 'eligible'; inspection: DatabaseFreshInitializationInspection }
  | { state: 'unknown' | 'ineligible'; reason: string };
export interface DatabaseFreshInitializationResult {
  state: 'complete' | 'pending' | 'unknown' | 'failed';
  progress: DatabaseFreshInitializationProgress;
  /** Non-secret provider storage coordinates only. Existing bindings cannot be replaced. */
  storageBindings?: Record<string, unknown>;
  reason?: string;
}

/** Explicit empty persistent storage for an exact existing database with no storage.
 * Never replace its service, credentials, references or application workloads.
 * Await saveProgress before EVERY mutation, and immediately after receiving an ID.
 * An attempted write without an acknowledged ID cannot be reissued on retry.
 * Completion requires exact storage and the newly acknowledged deployment.
 */
export interface IDatabaseFreshInitialization {
  inspect(input: { environment: Environment; component: Component }): Promise<DatabaseFreshInitializationEligibility>;
  apply(input: {
    environment: Environment;
    component: Component;
    reviewed: DatabaseFreshInitializationInspection;
    progress: DatabaseFreshInitializationProgress;
    saveProgress: (progress: DatabaseFreshInitializationProgress) => Promise<void>;
  }): Promise<DatabaseFreshInitializationResult>;
}
