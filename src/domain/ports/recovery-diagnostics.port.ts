import { z } from 'zod';
import { DatabaseCheckpointObservationError } from './database-checkpoint.port.js';

export const WORKER_RECOVERY_FAILURE_STAGES = ['worker-input', 'archive-open', 'source-open', 'recovery-reservation', 'database-backup', 'database-restore',
  'database-verification', 'object-copy', 'reference-verification', 'object-restore', 'restore-cleanup', 'recovery-completion', 'recovery-set'] as const;
export const RECOVERY_FAILURE_STAGES = ['input', 'authority', 'credentials', 'source-observation',
  'credential-handoff', 'task-preflight', 'task-create', 'task-ownership', 'task-configure', 'task-deploy', 'task-observe',
  'task-execution', 'task-cleanup', 'completion-record', 'retention', 'health', 'receipt-write', ...WORKER_RECOVERY_FAILURE_STAGES] as const;
export const RECOVERY_FAILURE_CATEGORIES = ['invalid-input', 'unsupported', 'authorization', 'schema', 'rate-limit', 'provider',
  'invalid-response', 'timeout', 'execution', 'cleanup', 'unknown'] as const;
export const recoveryDiagnosticSchema = z.object({
  stage: z.enum(RECOVERY_FAILURE_STAGES), category: z.enum(RECOVERY_FAILURE_CATEGORIES),
  httpStatus: z.number().int().min(100).max(599).optional(),
  // Local restore/client cleanup only; never provider task cleanup authority.
  localCleanupFailed: z.literal(true).optional(),
  task: z.object({ status: z.enum(['running', 'completed', 'failed', 'timeout']).optional(),
    exitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
    mutationAttempted: z.boolean().optional(), cleanupVerified: z.boolean().optional(),
  }).strict().refine(value => Object.keys(value).length > 0).optional(),
}).strict();
export type RecoveryDiagnostic = z.infer<typeof recoveryDiagnosticSchema>;

/** Carries only locally selected codes. The original error/cause is never retained. */
export class RecoveryDiagnosticError extends Error {
  readonly diagnostic: RecoveryDiagnostic;
  constructor(diagnostic: RecoveryDiagnostic, message = 'Managed recovery could not be verified.') {
    super(message); this.name = 'RecoveryDiagnosticError';
    this.diagnostic = recoveryDiagnosticSchema.parse(diagnostic);
  }
}

export function recoveryFailure(stage: RecoveryDiagnostic['stage'], category: RecoveryDiagnostic['category'],
  error?: unknown, task?: RecoveryDiagnostic['task'], message?: string): RecoveryDiagnosticError {
  let diagnostic: RecoveryDiagnostic = { stage, category };
  if (error instanceof RecoveryDiagnosticError) diagnostic = recoveryDiagnosticSchema.parse(error.diagnostic);
  else if (error instanceof DatabaseCheckpointObservationError) {
    const categories = { authorization: 'authorization', schema: 'schema', rate_limit: 'rate-limit', provider: 'provider',
      invalid_response: 'invalid-response', unknown: 'unknown' } as const;
    diagnostic = { stage, category: categories[error.category], ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) };
  }
  if (task) diagnostic = { ...diagnostic, task: { ...diagnostic.task, ...task } };
  return new RecoveryDiagnosticError(diagnostic, message);
}

const failureMarker = 'HYPERVIBE_RECOVERY_FAILURE:';
const workerDiagnosticSchema = recoveryDiagnosticSchema.omit({ task: true }).extend({ stage: z.enum(WORKER_RECOVERY_FAILURE_STAGES) }).strict();
const markerSchema = z.object({ version: z.literal(1), executionId: z.string().uuid(), diagnostic: workerDiagnosticSchema }).strict();
export function formatRecoveryFailureMarker(diagnostic: RecoveryDiagnostic, executionId: string): string {
  const value = markerSchema.parse({ version: 1, executionId, diagnostic });
  return `${failureMarker}${JSON.stringify(value)}`;
}
/** Failure detail only: a worker can never attest provider completion or cleanup. */
export function parseRecoveryFailureMarker(output: string | undefined, executionId: string): RecoveryDiagnostic | undefined {
  if (!output || Buffer.byteLength(output, 'utf8') > 65536) return undefined;
  const candidates = output.split(/\r?\n/).filter(line => line.includes(failureMarker));
  if (candidates.length !== 1 || !candidates[0].startsWith(failureMarker) || Buffer.byteLength(candidates[0], 'utf8') > 2048) return undefined;
  try {
    const parsed = markerSchema.safeParse(JSON.parse(candidates[0].slice(failureMarker.length)));
    return parsed.success && parsed.data.executionId === executionId ? parsed.data.diagnostic : undefined;
  } catch { return undefined; }
}
