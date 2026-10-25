import { z } from 'zod';
import type { PlanAction } from '../plan/plan.types.js';

export const LOCAL_CLOUD_SCOPE_OPERATION = 'cloudScopePrepare';
export const localCloudScopePlanSchema = z.object({
  schemaVersion: z.literal(1),
  installationId: z.string().guid(),
  installationPlanDigest: z.string().regex(/^[a-f0-9]{64}$/),
  hostingProvider: z.string().min(1).max(100),
  mode: z.enum(['allocate', 'recover', 'verified', 'bind']),
}).strict();
export type LocalCloudScopePlan = z.infer<typeof localCloudScopePlanSchema>;
export const localCloudScopeActionMetadataSchema = localCloudScopePlanSchema.extend({
  operation: z.literal(LOCAL_CLOUD_SCOPE_OPERATION),
  nativeActionId: z.string().min(1).max(200),
}).strict();
export function isLocalCloudScopeAction(action: PlanAction): boolean {
  const parsed = localCloudScopeActionMetadataSchema.safeParse(action.metadata);
  return parsed.success && action.id === parsed.data.nativeActionId && action.verified
    && (parsed.data.mode === 'allocate' ? ['create', 'update', 'noop'].includes(action.type) && (action.type === 'noop' || action.requiresConfirm === true)
      : parsed.data.mode === 'bind' ? action.id === 'cloud-scope:bind' && action.type === 'update' && action.requiresConfirm === true
      : parsed.data.mode === 'recover' && action.type === 'update' && action.requiresConfirm !== true && action.billable !== true);
}
