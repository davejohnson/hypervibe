import './providers.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import { executeManagedBackup, verifyManagedBackupAuthority } from '../application/managed-backup.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { recoveryFailure, type RecoveryDiagnostic } from '../domain/ports/recovery-diagnostics.port.js';
import { backupOperationReceiptSchema, type BackupOperationReceipt } from '../domain/services/backup-operation-receipt.js';

export async function runBackupController(env: NodeJS.ProcessEnv = process.env) {
  const operation = env.HYPERVIBE_BACKUP_OPERATION;
  let environment = 'unknown';
  let stage: RecoveryDiagnostic['stage'] = 'input';
  let executionReceipt: BackupOperationReceipt | undefined;
  let counts: { applied: number | null; skipped: number } | undefined = operation === 'backup'
    ? { applied: 0, skipped: 1 } : undefined;
  try {
    if (!['backup', 'health'].includes(operation ?? '') || !env.GITHUB_TOKEN
      || !['schedule', 'workflow_dispatch', 'push'].includes(env.GITHUB_EVENT_NAME ?? '')
      || (operation === 'backup' && env.GITHUB_RUN_ATTEMPT !== '1')) throw new Error('Invalid recurring execution.');
    const input = JSON.parse(readFileSync(env.HYPERVIBE_BACKUP_CONTRACT ?? '', 'utf8'));
    if (typeof input.environment === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(input.environment)) environment = input.environment;
    stage = 'credentials';
    const github = await providerRegistry.createAdapter<GitHubAdapter>('github', { apiToken: env.GITHUB_TOKEN });
    stage = 'authority';
    const authorized = await verifyManagedBackupAuthority({ target: input, contractHash: env.HYPERVIBE_BACKUP_CONTRACT_HASH ?? '',
      runnerImage: env.HYPERVIBE_BACKUP_RUNNER_IMAGE ?? '', repository: env.GITHUB_REPOSITORY ?? '', sha: env.GITHUB_SHA ?? '',
      ref: env.GITHUB_REF ?? '', github });
    if (operation === 'backup') counts = { applied: null, skipped: 0 };
    stage = 'task-execution';
    const receipt = backupOperationReceiptSchema.parse(await executeManagedBackup({ ...authorized, operation: operation as 'backup' | 'health',
      repository: env.GITHUB_REPOSITORY ?? '', runId: env.GITHUB_RUN_ID ?? '', credentials: env }));
    executionReceipt = receipt;
    if (receipt.counts) counts = receipt.counts;
    stage = 'receipt-write';
    if (env.HYPERVIBE_BACKUP_RECEIPT) writeFileSync(env.HYPERVIBE_BACKUP_RECEIPT, JSON.stringify(receipt) + '\n', { mode: 0o600 });
    if (receipt.status !== 'healthy') process.exitCode = 1;
    return receipt;
  } catch (error) {
    const diagnostic = executionReceipt?.diagnostic
      ?? recoveryFailure(stage, stage === 'input' ? 'invalid-input' : 'unknown', error).diagnostic;
    if (counts && diagnostic.task?.mutationAttempted === false) counts = { applied: 0, skipped: 1 };
    const receipt = backupOperationReceiptSchema.parse({ version: 2, environment, status: 'unknown',
      reasonCodes: [...new Set([...(executionReceipt?.reasonCodes ?? []), 'observation-unavailable'])],
      diagnostic, ...(counts ? { counts } : {}) });
    try { if (env.HYPERVIBE_BACKUP_RECEIPT) writeFileSync(env.HYPERVIBE_BACKUP_RECEIPT, JSON.stringify(receipt) + '\n', { mode: 0o600 }); } catch { /* Safe console remains. */ }
    process.exitCode = 1; return receipt;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await runBackupController()) + '\n');
}
