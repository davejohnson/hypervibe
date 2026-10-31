import { z } from 'zod';
import type { PlanAction } from './plan.types.js';
import { databaseProvisioningProgressSchema, databaseProvisioningTargetSchema } from '../ports/database-provisioning-recovery.port.js';

export const DATABASE_PROVISIONING_RECOVERY_OPERATION = 'databaseProvisioningRecovery';
export const databaseProvisioningRecoveryActionId = (componentId: string) => `database-provisioning-recovery:${encodeURIComponent(componentId)}`;
export const databaseProvisioningRecoveryMetadataSchema = z.object({
  operation: z.literal(DATABASE_PROVISIONING_RECOVERY_OPERATION), componentId: z.string().min(1),
  target: databaseProvisioningTargetSchema, replaceCredential: z.boolean(), createDatabase: z.boolean(),
  bindingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  environmentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const databaseProvisioningRecoveryAttemptSchema = z.object({
  metadata: databaseProvisioningRecoveryMetadataSchema, reviewEncrypted: z.string().min(1),
  startedAt: z.iso.datetime(), progress: databaseProvisioningProgressSchema,
}).strict();
export function isDatabaseProvisioningRecoveryAction(action: PlanAction): boolean {
  const p = databaseProvisioningRecoveryMetadataSchema.safeParse(action.metadata);
  return p.success && action.id === databaseProvisioningRecoveryActionId(p.data.componentId)
    && action.type === 'update' && action.resource.kind === 'database' && action.resource.name === 'postgres'
    && action.resource.provider === p.data.target.provider && action.verified === true && action.requiresConfirm === true
    && action.dataBearing === true && action.billable === false && !action.dependsOn?.length;
}
