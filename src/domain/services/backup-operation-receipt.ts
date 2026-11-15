import { RECOVERY_FAILURE_CATEGORIES, RECOVERY_FAILURE_STAGES, type RecoveryDiagnostic } from '../ports/recovery-diagnostics.port.js';

export const BACKUP_HEALTH_REASON_CODES = ['backup-missing', 'backup-stale', 'backup-unverified', 'restore-unverified',
  'files-unverified', 'references-unverified', 'source-mismatch', 'destination-mismatch', 'retention-unknown', 'cleanup-unverified',
  'scheduler-stale', 'execution-failed', 'observation-unavailable', 'receipt-missing', 'receipt-invalid'] as const;
const receiptRules = { stages: RECOVERY_FAILURE_STAGES, categories: RECOVERY_FAILURE_CATEGORIES, reasons: BACKUP_HEALTH_REASON_CODES };

/** Self-contained runtime validator, used unchanged in the controller and emitted
 * alert/deployment gate. It accepts legacy receipts; only v2 permits diagnostics. */
function parseBackupOperationReceipt(value: unknown, rules: {
  stages: readonly string[]; categories: readonly string[]; reasons: readonly string[];
}) {
  const object = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  const keys = (item: Record<string, unknown>, allowed: string[]) => Object.keys(item).every(key => allowed.includes(key));
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0;
  if (!object(value) || !keys(value, ['version', 'environment', 'status', 'reasonCodes', 'counts', 'setId', 'completedAt', 'diagnostic'])
    || ![1, 2].includes(value.version as number)
    || typeof value.environment !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(value.environment)
    || !['healthy', 'unhealthy', 'unknown'].includes(value.status as string)
    || !Array.isArray(value.reasonCodes) || value.reasonCodes.length > 24
    || value.reasonCodes.some(code => typeof code !== 'string' || !rules.reasons.includes(code))
    || (value.status === 'healthy' && (value.reasonCodes.length > 0 || value.diagnostic !== undefined))) return undefined;
  if (value.setId !== undefined && (typeof value.setId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.setId))) return undefined;
  if (value.completedAt !== undefined && (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt)))) return undefined;
  let counts: { applied: number | null; skipped: number } | undefined;
  if (value.counts !== undefined) {
    if (!object(value.counts) || !keys(value.counts, ['applied', 'skipped'])
      || !(value.counts.applied === null || count(value.counts.applied)) || !count(value.counts.skipped)) return undefined;
    counts = { applied: value.counts.applied as number | null, skipped: value.counts.skipped };
  }
  let diagnostic: RecoveryDiagnostic | undefined;
  if (value.diagnostic !== undefined) {
    const d = value.diagnostic;
    if (value.version !== 2 || !object(d) || !keys(d, ['stage', 'category', 'httpStatus', 'localCleanupFailed', 'task'])
      || !rules.stages.includes(d.stage as string) || !rules.categories.includes(d.category as string)
      || (d.localCleanupFailed !== undefined && d.localCleanupFailed !== true)
      || (d.httpStatus !== undefined && (!Number.isInteger(d.httpStatus) || (d.httpStatus as number) < 100 || (d.httpStatus as number) > 599))) return undefined;
    if (d.task !== undefined) {
      const task = d.task;
      if (!object(task) || !Object.keys(task).length || !keys(task, ['status', 'exitCode', 'mutationAttempted', 'cleanupVerified'])
        || (task.status !== undefined && !['running', 'completed', 'failed', 'timeout'].includes(task.status as string))
        || (task.exitCode !== undefined && (!Number.isInteger(task.exitCode) || (task.exitCode as number) < -2147483648 || (task.exitCode as number) > 2147483647))
        || (task.mutationAttempted !== undefined && typeof task.mutationAttempted !== 'boolean')
        || (task.cleanupVerified !== undefined && typeof task.cleanupVerified !== 'boolean')) return undefined;
    }
    diagnostic = d as RecoveryDiagnostic;
  }
  return { version: value.version as 1 | 2, environment: value.environment,
    status: value.status as 'healthy' | 'unhealthy' | 'unknown', reasonCodes: value.reasonCodes as string[],
    ...(counts ? { counts } : {}), ...(diagnostic ? { diagnostic } : {}),
    ...(value.setId === undefined ? {} : { setId: value.setId as string }),
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt as string }) };
}
export type BackupOperationReceipt = NonNullable<ReturnType<typeof parseBackupOperationReceipt>>;
export const backupOperationReceiptSchema = {
  safeParse(value: unknown): { success: true; data: BackupOperationReceipt } | { success: false } {
    const data = parseBackupOperationReceipt(value, receiptRules);
    return data ? { success: true, data } : { success: false };
  },
  parse(value: unknown): BackupOperationReceipt {
    const parsed = this.safeParse(value);
    if (!parsed.success) throw new Error('Invalid backup operation receipt.');
    return parsed.data;
  },
};
export function backupOperationReceiptValidatorSource(): string {
  return `const parseBackupOperationReceipt = ${parseBackupOperationReceipt.toString()};\nconst backupReceiptRules = ${JSON.stringify(receiptRules)};`;
}
