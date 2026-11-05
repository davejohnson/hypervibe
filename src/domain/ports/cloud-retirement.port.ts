import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { CLOUD_INSTALLATION_REASONS } from './cloud-installation.port.js';
import type { PlanAction } from '../plan/plan.types.js';

export const cloudRetirementDeclarationSchema = z.object({
  id: z.string().uuid(), mode: z.enum(['disconnect', 'delete-owned']),
  connectionIds: z.array(z.string().uuid()).min(1).max(2).transform(ids => ids.sort()),
  baseUrl: z.string().url().max(2048).refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; } catch { return false; }
  }, 'Use the exact HTTPS origin of the approved Hypervibe connection.'),
}).strict().refine(value => value.connectionIds.length === (value.mode === 'disconnect' ? 1 : 2)
  && new Set(value.connectionIds).size === value.connectionIds.length, 'Select one original collection connection to disconnect, or both original collection and deployment connections to delete owned resources.');
export type CloudRetirementDeclaration = z.infer<typeof cloudRetirementDeclarationSchema>;
const safeText = z.string().min(1).max(2048).refine(value => !/-----BEGIN .*PRIVATE KEY-----|\bhvc_[0-9a-f-]{36}_|\bBearer\s+\S+|\bya29\./i.test(value));
const reviewSchema = z.object({ resources: z.array(z.object({ kind: safeText, name: safeText, scope: safeText }).strict()).max(300).optional(),
  permissions: z.array(z.object({ principal: safeText, scope: safeText, actions: z.array(safeText).max(100),
    purpose: z.enum(['writer', 'installation-verification', 'hosted-trust-removal', 'deployment-provision', 'deployment-release', 'runtime-reader']) }).strict()).max(300),
  costs: z.array(z.object({ resource: safeText, description: safeText, pricingUrl: safeText.refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }) }).strict()).max(300), warnings: z.array(safeText).max(100) }).strict();
export const cloudRetirementResponseSchema = z.object({ id: z.string().uuid(), environment: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  mode: z.enum(['disconnect', 'delete-owned']), connectionIds: z.array(z.string().uuid()).min(1).max(2).transform(ids => ids.sort()),
  status: z.enum(['authorization-required', 'review-required', 'ready', 'pending', 'blocked', 'disconnected', 'retired']),
  reviewUrl: z.string().url().max(2048), planDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), review: reviewSchema.optional(),
  reason: z.enum([...CLOUD_INSTALLATION_REASONS, 'records_changed', 'release_active', 'release_status_unknown']).optional(),
  completedActionIds: z.array(safeText).max(300).optional(), remainingActionIds: z.array(safeText).max(300).optional(), retained: z.array(safeText).max(300).optional(),
}).strict().superRefine((value, ctx) => {
  const actionIds = [...(value.completedActionIds ?? []), ...(value.remainingActionIds ?? [])];
  if (value.planDigest && (!value.completedActionIds || !value.remainingActionIds || !actionIds.length || actionIds.length > 300
    || new Set(actionIds).size !== actionIds.length))
    ctx.addIssue({ code: 'custom', message: 'The exact reviewed cleanup actions need complete, disjoint outcome evidence.' });
  if (new Set(value.connectionIds).size !== value.connectionIds.length || value.connectionIds.length !== (value.mode === 'disconnect' ? 1 : 2)
    || ['ready', 'pending', 'disconnected', 'retired'].includes(value.status) && !value.planDigest
    || value.status === 'disconnected' && value.mode !== 'disconnect' || value.status === 'retired' && value.mode !== 'delete-owned'
    || ['disconnected', 'retired'].includes(value.status) && value.remainingActionIds?.length)
    ctx.addIssue({ code: 'custom', message: 'The cloud cleanup outcome is inconsistent.' });
});
export type CloudRetirementResponse = z.infer<typeof cloudRetirementResponseSchema>;
export const cloudRetirementActionIds = (response: CloudRetirementResponse) => [...(response.completedActionIds ?? []), ...(response.remainingActionIds ?? [])].sort();
export const CLOUD_RETIREMENT_OPERATION = 'cloudRetirementContinue';
export const cloudRetirementPlanSchema = z.object({ declaration: cloudRetirementDeclarationSchema,
  repository: z.string().regex(/^github\.com\/[^/]+\/[^/]+$/), projectId: z.string().min(1).max(200),
  environment: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), grantId: z.string().uuid(), grantFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  response: cloudRetirementResponseSchema }).strict();
export type CloudRetirementPlan = z.infer<typeof cloudRetirementPlanSchema>;
export const cloudRetirementComplete = (response: CloudRetirementResponse) => response.status === 'retired' || response.status === 'disconnected';
export function cloudRetirementActions(proof: CloudRetirementPlan): PlanAction[] {
  if (!['ready', 'pending'].includes(proof.response.status)) return [];
  return [{ id: `cloud-retirement:${proof.declaration.id}`, type: proof.response.status === 'pending' ? 'update' : 'destroy',
    resource: { kind: 'environment', name: proof.environment, provider: 'hypervibe' }, verified: true, requiresConfirm: true,
    dataBearing: proof.declaration.mode === 'delete-owned',
    reason: proof.response.status === 'pending' ? 'Recover the exact approved cleanup before continuing its remaining actions.'
      : proof.declaration.mode === 'disconnect' ? 'Remove hosted collection access while retaining the app and its secret reader.'
        : 'Delete only the original owned GCP installation resources reviewed by the owner; preserve cleanup history.',
    metadata: { operation: CLOUD_RETIREMENT_OPERATION, ...proof } }];
}
export function cloudRetirementPlanMatches(proof: CloudRetirementPlan, actions: PlanAction[]) {
  return isDeepStrictEqual(actions, cloudRetirementActions(proof)) && proof.response.id === proof.declaration.id
    && proof.response.environment === proof.environment && proof.response.mode === proof.declaration.mode
    && isDeepStrictEqual(proof.response.connectionIds, proof.declaration.connectionIds);
}
