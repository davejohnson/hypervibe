import { z } from 'zod';
import type { PlanAction } from '../plan/plan.types.js';
import { operatorRetirementDeclarationSchema } from './operator-retirement.port.js';

const preparationFailureSchema = z.object({
  phase: z.enum(['source-verification','source-snapshot','credential-selection','credential-scan','builder-creation','image-build','image-verification','image-archive','filesystem-scan','cleanup']),
  reason: z.enum(['command-failed','verification-failed','cleanup-unverified']),
  cleanup: z.enum(['verified','unverified']),
  recoveryDirectory: z.string().regex(/^hypervibe-candidate-[A-Za-z0-9]{6}$/).optional(),
}).strict().refine(value => value.cleanup === 'unverified' ? Boolean(value.recoveryDirectory) : !value.recoveryDirectory)
  .refine(value => value.reason !== 'cleanup-unverified' || value.phase === 'cleanup' && value.cleanup === 'unverified');
export type OperatorArtifactPreparationFailure = z.infer<typeof preparationFailureSchema>;
const preparationPhaseText: Record<OperatorArtifactPreparationFailure['phase'], string> = {
  'source-verification':'checking the reviewed source', 'source-snapshot':'copying the reviewed source for the build',
  'credential-selection':'selecting saved private-package access', 'credential-scan':'checking for copied package credentials',
  'builder-creation':'starting the local Docker builder', 'image-build':'building the app image locally',
  'image-verification':'checking the built image', 'image-archive':'checking the saved image layers',
  'filesystem-scan':'checking the image filesystem', cleanup:'checking local build cleanup',
};
function preparationMessage(value: OperatorArtifactPreparationFailure): string {
  const next = value.cleanup === 'unverified'
    ? `Local build cleanup is incomplete. Preserve ${value.recoveryDirectory}/cleanup.json in the system temporary folder. Ask your coding agent to inspect that saved cleanup record before another build.`
    : value.phase === 'credential-selection' ? 'Ask your coding agent to check the saved package-read connection for this repository before another hv_plan.'
    : 'Ask your coding agent to diagnose this local preparation step before using hv_plan to prepare the image again.';
  return `App preparation stopped while ${preparationPhaseText[value.phase]} (phase=${value.phase}, reason=${value.reason}, cleanup=${value.cleanup}). ${next} This preparation did not upload or deploy an image.`;
}
/** Local preparation only: no native output, credentials or arbitrary paths. */
export class OperatorArtifactPreparationError extends Error {
  readonly phase: OperatorArtifactPreparationFailure['phase'];
  readonly reason: OperatorArtifactPreparationFailure['reason'];
  readonly cleanup: OperatorArtifactPreparationFailure['cleanup'];
  readonly recoveryDirectory?: string;
  constructor(input: OperatorArtifactPreparationFailure) {
    const value = preparationFailureSchema.parse(input);
    super(preparationMessage(value)); this.name = 'OperatorArtifactPreparationError';
    this.phase=value.phase; this.reason=value.reason; this.cleanup=value.cleanup; this.recoveryDirectory=value.recoveryDirectory;
  }
}
export function operatorArtifactPreparationMessage(error: unknown): string | undefined {
  if (!(error instanceof OperatorArtifactPreparationError)) return undefined;
  const parsed = preparationFailureSchema.safeParse({phase:error.phase,reason:error.reason,cleanup:error.cleanup,
    ...(error.recoveryDirectory ? {recoveryDirectory:error.recoveryDirectory} : {})});
  return parsed.success ? preparationMessage(parsed.data) : undefined;
}

export const operatorArtifactDeclarationSchema = z.object({
  provider: z.string().min(1).max(100),
  nativeScope: z.record(z.string().min(1).max(100), z.string().min(1).max(2048)),
  artifacts: z.array(z.enum(['aws-collection-template-v1', 'aws-deployment-template-v1', 'holding-v1', 'backup-runner-v1', 'application-candidate-v1'])).min(1).max(4),
  refreshFrom: z.object({ installationId: z.string().guid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  retirement: operatorRetirementDeclarationSchema.optional(),
}).strict().refine(value => new Set(value.artifacts).size === value.artifacts.length, 'Select each artifact once.')
  .refine(value => !(value.refreshFrom && value.retirement), 'Refresh and retirement are separate reviews.');
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
