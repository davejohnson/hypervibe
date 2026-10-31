import { z } from 'zod';
import type { PlanAction } from '../plan/plan.types.js';

export const operatorArtifactDeclarationSchema = z.object({
  provider: z.string().min(1).max(100),
  nativeScope: z.record(z.string().min(1).max(100), z.string().min(1).max(2048)),
  artifacts: z.array(z.enum(['aws-collection-template-v1', 'aws-deployment-template-v1', 'holding-v1', 'backup-runner-v1', 'application-candidate-v1'])).min(1).max(4),
}).strict().refine(value => new Set(value.artifacts).size === value.artifacts.length, 'Select each artifact once.');
export function parseOperatorArtifactDeclarationV1(value: unknown) { return operatorArtifactDeclarationSchema.parse(value); }
export const OPERATOR_ARTIFACT_OPERATION = 'operatorArtifactPublication';
export const operatorArtifactPlanSchema = z.object({ schemaVersion: z.literal(1), name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  installationId: z.string().guid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/), provider: z.string().min(1).max(100),
  mode: z.enum(['prepare', 'recover', 'verified']),
}).strict();
export type OperatorArtifactPlan = z.infer<typeof operatorArtifactPlanSchema>;
export const operatorArtifactActionMetadataSchema = operatorArtifactPlanSchema.extend({ operation: z.literal(OPERATOR_ARTIFACT_OPERATION), nativeActionId: z.string().min(1).max(200) }).strict();
export function isOperatorArtifactAction(action: PlanAction): boolean {
  const parsed = operatorArtifactActionMetadataSchema.safeParse(action.metadata);
  return parsed.success && action.id === parsed.data.nativeActionId && action.verified
    && (parsed.data.mode === 'prepare' ? ['create', 'update', 'noop'].includes(action.type) && (action.type === 'noop' || action.requiresConfirm === true)
      : parsed.data.mode === 'recover' && action.type === 'update' && !action.requiresConfirm && !action.billable);
}
