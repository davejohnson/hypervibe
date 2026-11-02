import { z } from 'zod';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { recoveryIdentityStringSchema } from '../services/recovery-source.js';

export const databaseProvisioningTargetSchema = z.object({
  provider: recoveryIdentityStringSchema, externalId: recoveryIdentityStringSchema,
  providerScope: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), recoveryIdentityStringSchema)
    .refine(scope => Object.keys(scope).length > 0),
  identityFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  username: recoveryIdentityStringSchema, database: recoveryIdentityStringSchema,
}).strict();
export const databaseProvisioningReviewSchema = z.object({
  target: databaseProvisioningTargetSchema,
  replaceCredential: z.boolean(), createDatabase: z.boolean(),
  /** Private input, encrypted with the reviewed plan and retained attempt. */
  password: z.string().min(1),
}).strict();
export const databaseProvisioningProgressSchema = z.object({
  phase: z.enum(['prepared', 'credential-attempted', 'credential-acknowledged', 'credential-verified',
    'database-attempted', 'database-acknowledged', 'database-verified', 'complete']),
  credentialOperationId: recoveryIdentityStringSchema.optional(),
  databaseOperationId: recoveryIdentityStringSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.phase === 'credential-acknowledged' && !value.credentialOperationId
    || value.phase === 'database-acknowledged' && !value.databaseOperationId) {
    ctx.addIssue({ code: 'custom', message: 'Acknowledged recovery requires the native operation identity.' });
  }
});
export type DatabaseProvisioningReview = z.infer<typeof databaseProvisioningReviewSchema>;
export type DatabaseProvisioningProgress = z.infer<typeof databaseProvisioningProgressSchema>;
export interface IDatabaseProvisioningRecovery {
  /** Read-only. A retained identity is not proof of native readiness or authority. */
  inspect(input: { environment: Environment; component: Component }): Promise<
    | { state: 'ready'; review: DatabaseProvisioningReview }
    | { state: 'pending' | 'unknown'; reason: string }>;
  /** No instance creation, deletion, workload changes, or blind re-submission.
   * Persist before each write and immediately after its acknowledgment. */
  apply(input: {
    environment: Environment; component: Component; reviewed: DatabaseProvisioningReview;
    progress: DatabaseProvisioningProgress;
    saveProgress: (next: DatabaseProvisioningProgress) => Promise<void>;
  }): Promise<{ state: 'complete' | 'pending' | 'unknown'; bindings?: Record<string, unknown> }>;
}
