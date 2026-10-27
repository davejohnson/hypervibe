import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { providerIdentityScopeMatches } from '../services/binding-identity.js';
import type { PlanAction } from './plan.types.js';
import { databaseFreshInitializationProgressSchema, databaseFreshInitializationTargetSchema } from '../ports/database-fresh-initialization.port.js';

export const DATABASE_FRESH_INITIALIZATION_OPERATION = 'databaseFreshInitialize';
export const databaseInitializationActionId = (componentId: string, intentId: string) =>
  `database-initialization:${encodeURIComponent(componentId)}:${intentId}`;
export const databaseInitializationMetadataSchema = z.object({
  operation: z.literal(DATABASE_FRESH_INITIALIZATION_OPERATION),
  componentId: z.string().min(1), intentId: z.string().min(1).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  target: databaseFreshInitializationTargetSchema,
  configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  bindingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  environmentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DatabaseInitializationMetadata = z.infer<typeof databaseInitializationMetadataSchema>;
export const completedDatabaseInitializationReceiptSchema = z.object({
  intentId: databaseInitializationMetadataSchema.shape.intentId,
  target: databaseFreshInitializationTargetSchema,
  storageId: z.string().min(1), storageInstanceId: z.string().min(1), deploymentId: z.string().min(1),
  configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/), verifiedAt: z.iso.datetime(),
}).strict();
export type CompletedDatabaseInitializationReceipt = z.infer<typeof completedDatabaseInitializationReceiptSchema>;
export const databaseInitializationAttemptSchema = z.object({
  metadata: databaseInitializationMetadataSchema,
  inspectionEncrypted: z.string().min(1), startedAt: z.iso.datetime(),
  progress: databaseFreshInitializationProgressSchema,
  storageBindings: z.record(z.string(), z.unknown()).optional(),
  completed: completedDatabaseInitializationReceiptSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.progress.phase === 'complete' && (!value.storageBindings || !value.completed)) {
    ctx.addIssue({ code: 'custom', message: 'Completed initialization requires exact persisted storage bindings.' });
  }
  if (value.completed && (value.progress.phase !== 'complete'
    || value.completed.intentId !== value.metadata.intentId || !isDeepStrictEqual(value.completed.target, value.metadata.target)
    || value.completed.configurationFingerprint !== value.metadata.configurationFingerprint
    || value.completed.storageId !== value.progress.storageId || value.completed.storageInstanceId !== value.progress.storageInstanceId
    || value.completed.deploymentId !== value.progress.deploymentId || Date.parse(value.completed.verifiedAt) < Date.parse(value.startedAt))) {
    ctx.addIssue({ code: 'custom', message: 'Completed initialization receipt contradicts its reviewed attempt.' });
  }
});
export type DatabaseInitializationAttempt = z.infer<typeof databaseInitializationAttemptSchema>;

export function isDatabaseInitializationAction(action: PlanAction): boolean {
  const metadata = databaseInitializationMetadataSchema.safeParse(action.metadata);
  return metadata.success && action.id === databaseInitializationActionId(metadata.data.componentId, metadata.data.intentId)
    && action.type === 'update' && action.resource.kind === 'database' && action.resource.name === 'postgres'
    && action.resource.provider === metadata.data.target.provider && action.verified === true
    && action.requiresConfirm === true && action.dataBearing === true && action.billable === true
    && !action.dependsOn?.length;
}

/** Malformed persisted progress remains a blocker, never an unused intent. */
export function hasPendingDatabaseInitialization(bindings: Record<string, unknown>): boolean {
  if (!Object.hasOwn(bindings, 'freshInitialization')) return false;
  const parsed = databaseInitializationAttemptSchema.safeParse(bindings.freshInitialization);
  return !parsed.success || parsed.data.progress.phase !== 'complete';
}

/** Validates durable local evidence only. Consumers must re-observe the exact
 * live storage/deployment before SQL or application actions; this is no SQL proof. */
export function getCompletedDatabaseInitializationReceipt(input: {
  component: Component; environment: Pick<Environment, 'id' | 'platformBindings'>;
}): CompletedDatabaseInitializationReceipt | undefined {
  const parsed = databaseInitializationAttemptSchema.safeParse(input.component.bindings.freshInitialization);
  if (!parsed.success || !parsed.data.completed || parsed.data.progress.phase !== 'complete') return undefined;
  const receipt = parsed.data.completed;
  if (input.component.id !== parsed.data.metadata.componentId || input.component.environmentId !== input.environment.id
    || input.component.externalId !== receipt.target.externalId || input.component.bindings.provider !== receipt.target.provider
    || !providerIdentityScopeMatches({ componentBindings: input.component.bindings,
      environmentBindings: input.environment.platformBindings, provider: receipt.target.provider, liveScope: receipt.target.providerScope })
    || Object.entries(parsed.data.storageBindings!).some(([key, value]) => !isDeepStrictEqual(input.component.bindings[key], value))) return undefined;
  return receipt;
}
