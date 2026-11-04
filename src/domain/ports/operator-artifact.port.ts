import { z } from 'zod';
import type { PlanAction } from '../plan/plan.types.js';
import { operatorRetirementDeclarationSchema } from './operator-retirement.port.js';

export const OPERATOR_BUILD_REPORTED_MARKERS = ['npm-E401','npm-E403','npm-E404','npm-EINTEGRITY','npm-code-1','native-gyp-configure','native-gyp-build','disk-full','typescript-error','build-command-failed','image-metadata-failed','registry-rate-limit'] as const;
export type OperatorBuildReportedMarker = typeof OPERATOR_BUILD_REPORTED_MARKERS[number];
export const OPERATOR_BUILD_STEPS = ['npm-install','npm-script','node-command','system-package'] as const;
export type OperatorBuildStep = typeof OPERATOR_BUILD_STEPS[number];
const commandFailureSchema = z.object({
  kind: z.enum(['spawn','exit','abort','output-limit']),
  exitCode: z.number().int().min(1).max(0xffffffff).optional(),
  reported: z.array(z.enum(OPERATOR_BUILD_REPORTED_MARKERS)).min(1).max(OPERATOR_BUILD_REPORTED_MARKERS.length)
    .refine(values=>new Set(values).size===values.length).optional(),
  dockerfileLine: z.number().int().min(1).max(100000).optional(),
  buildStep: z.enum(OPERATOR_BUILD_STEPS).optional(),
}).strict().refine(value => value.exitCode === undefined || value.kind === 'exit')
  .refine(value => !value.buildStep || !!value.dockerfileLine && value.reported?.includes('build-command-failed'));
export type OperatorArtifactCommandFailure = z.infer<typeof commandFailureSchema>;
/** Native command lifecycle facts only; never copy an Error message or output. */
export class OperatorArtifactCommandError extends Error {
  readonly commandFailure: OperatorArtifactCommandFailure;
  constructor(input: OperatorArtifactCommandFailure) {
    const value = commandFailureSchema.parse(input);
    super(`Operator artifact command failed (${value.kind}${value.exitCode === undefined ? '' : `, exitCode=${value.exitCode}`}).`);
    this.name='OperatorArtifactCommandError'; this.commandFailure=value;
  }
}
export function operatorArtifactCommandFailure(error: unknown): OperatorArtifactCommandFailure | undefined {
  if (!(error instanceof OperatorArtifactCommandError)) return undefined;
  const parsed=commandFailureSchema.safeParse(error.commandFailure);
  return parsed.success ? parsed.data : undefined;
}

const preparationFailureSchema = z.object({
  phase: z.enum(['source-verification','source-snapshot','credential-selection','credential-scan','builder-creation','image-build','image-verification','image-archive','filesystem-scan','cleanup']),
  reason: z.enum(['command-failed','verification-failed','cleanup-unverified']),
  cleanup: z.enum(['verified','unverified']),
  commandFailure: commandFailureSchema.optional(),
  recoveryDirectory: z.string().regex(/^hypervibe-candidate-[A-Za-z0-9]{6}$/).optional(),
}).strict().refine(value => value.cleanup === 'unverified' ? Boolean(value.recoveryDirectory) : !value.recoveryDirectory)
  .refine(value => value.reason !== 'cleanup-unverified' || value.phase === 'cleanup' && value.cleanup === 'unverified')
  .refine(value => !value.commandFailure || value.reason === 'command-failed');
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
  const command = value.commandFailure ? `, command=${value.commandFailure.kind}${value.commandFailure.exitCode === undefined ? '' : `, exitCode=${value.commandFailure.exitCode}`}` : '';
  const reportedText:Record<OperatorBuildReportedMarker,string>={'npm-E401':'npm E401','npm-E403':'npm E403','npm-E404':'npm E404','npm-EINTEGRITY':'npm EINTEGRITY',
    'npm-code-1':'npm exit code 1','native-gyp-configure':'a native dependency configuration error','native-gyp-build':'a native dependency build error',
    'disk-full':'no space left','typescript-error':'a TypeScript compiler error','build-command-failed':'a failed build command',
    'image-metadata-failed':'an image metadata lookup failure','registry-rate-limit':'a registry rate-limit response'};
  const steps:Record<OperatorBuildStep,string>={'npm-install':'the reviewed npm dependency-install instruction','npm-script':'the reviewed npm script instruction',
    'node-command':'the reviewed Node command instruction','system-package':'the reviewed system-package instruction'};
  const reported = [...(value.commandFailure?.reported?.map(marker=>reportedText[marker])??[]),
    ...(value.commandFailure?.buildStep ? [steps[value.commandFailure.buildStep]] : []),
    ...(value.commandFailure?.dockerfileLine ? [`Dockerfile line ${value.commandFailure.dockerfileLine}`] : [])];
  const observation = reported.length ? ` Build reported ${reported.join(', ')}. These are observed messages, not a verified cause.` : '';
  return `App preparation stopped while ${preparationPhaseText[value.phase]} (phase=${value.phase}, reason=${value.reason}, cleanup=${value.cleanup}${command}).${observation} ${next} This preparation did not upload or deploy an image.`;
}
/** Local preparation only: no native output, credentials or arbitrary paths. */
export class OperatorArtifactPreparationError extends Error {
  readonly phase: OperatorArtifactPreparationFailure['phase'];
  readonly reason: OperatorArtifactPreparationFailure['reason'];
  readonly cleanup: OperatorArtifactPreparationFailure['cleanup'];
  readonly commandFailure?: OperatorArtifactCommandFailure;
  readonly recoveryDirectory?: string;
  constructor(input: OperatorArtifactPreparationFailure) {
    const value = preparationFailureSchema.parse(input);
    super(preparationMessage(value)); this.name = 'OperatorArtifactPreparationError';
    this.phase=value.phase; this.reason=value.reason; this.cleanup=value.cleanup; this.recoveryDirectory=value.recoveryDirectory; this.commandFailure=value.commandFailure;
  }
}
export function operatorArtifactPreparationMessage(error: unknown): string | undefined {
  if (!(error instanceof OperatorArtifactPreparationError)) return undefined;
  const parsed = preparationFailureSchema.safeParse({phase:error.phase,reason:error.reason,cleanup:error.cleanup,
    ...(error.recoveryDirectory ? {recoveryDirectory:error.recoveryDirectory} : {}),
    ...(error.commandFailure ? {commandFailure:error.commandFailure} : {})});
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
  mode: z.enum(['prepare', 'recover', 'verified', 'retire']),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  retryActions: z.array(z.object({actionId:z.string().min(1),attemptId:z.string().guid()}).strict()).min(1).max(1).optional(),
}).strict().refine(value => (value.mode === 'retire') === Boolean(value.bindingHash), 'A retirement review pins the current complete binding map.');
export type OperatorArtifactPlan = z.infer<typeof operatorArtifactPlanSchema>;
export const operatorArtifactActionMetadataSchema = operatorArtifactPlanSchema.safeExtend({ operation: z.literal(OPERATOR_ARTIFACT_OPERATION), nativeActionId: z.string().min(1).max(200) }).strict();
export function isOperatorArtifactAction(action: PlanAction): boolean {
  const parsed = operatorArtifactActionMetadataSchema.safeParse(action.metadata);
  return parsed.success && action.id === parsed.data.nativeActionId && action.verified
    && (parsed.data.mode === 'prepare' ? ['create', 'update', 'noop'].includes(action.type) && (action.type === 'noop' || action.requiresConfirm === true)
      : parsed.data.mode === 'retire' ? ['destroy', 'update', 'noop'].includes(action.type) && (action.type === 'noop' || action.requiresConfirm === true)
      : parsed.data.mode === 'recover' && action.type === 'update' && !action.requiresConfirm && !action.billable);
}
