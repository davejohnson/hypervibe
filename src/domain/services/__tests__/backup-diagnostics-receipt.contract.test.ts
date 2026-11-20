import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBackupController } from '../../../ci/backup-controller.js';
import { backupOperationReceiptSchema } from '../backup-operation-receipt.js';
import { recoveryDiagnosticSchema } from '../../ports/recovery-diagnostics.port.js';

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

describe('backup controller run results', () => {
  it('fails a repeated backup attempt and saves its sanitized diagnostic for the run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hv-backup-receipt-'));
    try {
      const path = join(directory, 'receipt.json');
      const receipt = await runBackupController({ HYPERVIBE_BACKUP_OPERATION: 'backup', GITHUB_RUN_ATTEMPT: '2',
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_TOKEN: 'synthetic-private-token', HYPERVIBE_BACKUP_RECEIPT: path });
      expect(process.exitCode).toBe(1);
      const file = readFileSync(path, 'utf8');
      expect(file).not.toContain('synthetic-private-token');
      expect(backupOperationReceiptSchema.parse(JSON.parse(file))).toEqual(receipt);
      expect(receipt).toMatchObject({ version: 2, status: 'unknown', diagnostic: { stage: 'input', category: 'invalid-input' },
        counts: { applied: 0, skipped: 1 } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('accepts an older receipt and preserves uncertainty about provider writes in current diagnostics', () => {
    const legacy = { version: 1, environment: 'production', status: 'unknown', reasonCodes: ['cleanup-unverified'] };
    expect(backupOperationReceiptSchema.parse(legacy)).toEqual(legacy);
    const current = { ...legacy, version: 2, counts: { applied: null, skipped: 0 }, diagnostic: {
      stage: 'task-create', category: 'authorization', httpStatus: 403, localCleanupFailed: true,
      task: { status: 'failed', mutationAttempted: true, cleanupVerified: false },
    } };
    expect(backupOperationReceiptSchema.parse(current)).toEqual(current);
    expect(backupOperationReceiptSchema.safeParse({ ...current, status: 'healthy' }).success).toBe(false);
  });

  it.each([
    [true, { stage: 'task-create', category: 'authorization', httpStatus: 403, task: { mutationAttempted: true } }],
    [true, { stage: 'object-copy', category: 'unknown' }],
    [false, { stage: 'task-execution', category: 'execution', task: { exitCode: 2147483648 } }],
    [false, { stage: 'task-create', category: 'unknown', httpStatus: 600 }],
    [false, { stage: 'task-create', category: 'unknown', task: {} }],
    [false, { stage: 'task-create', category: 'unknown', task: { status: 'private-error-sentinel' } }],
    [false, { stage: 'task-create', category: 'unknown', task: { mutationAttempted: 'false' } }],
    [false, { stage: 'object-copy', category: 'unknown', message: 'private-error-sentinel' }],
    [true, { stage: 'object-copy', category: 'unknown', localCleanupFailed: true }],
    [false, { stage: 'object-copy', category: 'unknown', localCleanupFailed: false }],
  ] as const)('requires the same admission (%s) at worker and controller: %j', (expected, diagnostic) => {
    const receipt = { version: 2, environment: 'unknown', status: 'unknown', reasonCodes: [], diagnostic };
    expect(recoveryDiagnosticSchema.safeParse(diagnostic).success).toBe(expected);
    expect(backupOperationReceiptSchema.safeParse(receipt).success).toBe(expected);
  });
});
