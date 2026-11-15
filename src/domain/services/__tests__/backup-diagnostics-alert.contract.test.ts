import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runBackupController } from '../../../ci/backup-controller.js';
import { compileBackupWorkflow } from '../backup-workflow.service.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { backupOperationReceiptSchema, backupOperationReceiptValidatorSource } from '../backup-operation-receipt.js';
import { recoveryDiagnosticSchema } from '../../ports/recovery-diagnostics.port.js';

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function alert(receipt: unknown, jobResult = 'failure') {
  const directory = mkdtempSync(join(tmpdir(), 'hv-backup-diagnostic-alert-'));
  try {
    const file = join(directory, 'receipt.json');
    writeFileSync(file, JSON.stringify(receipt));
    const image = `ghcr.io/example/helper@sha256:${'a'.repeat(64)}`;
    const contract = { version: 1, environment: 'unknown', runnerImage: image };
    const files = compileBackupWorkflow({ project: 'test', environment: 'unknown', runnerImage: image,
      contract, contractHash: canonicalJsonSha256(contract), providerCredentialNames: [] });
    const workflow = parse(files.find(item => item.path.endsWith('.yml'))!.content);
    const script = workflow.jobs.alert.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/github-script@')).with.script;
    const writes: Array<{ body: string; state?: string }> = [];
    await new AsyncFunction('require', 'process', 'context', 'fetch', 'core', script)(createRequire(import.meta.url),
      { env: { HYPERVIBE_BACKUP_RECEIPT_PATH: file, HYPERVIBE_BACKUP_ENVIRONMENT: 'unknown', HYPERVIBE_BACKUP_JOB_RESULT: jobResult, GITHUB_TOKEN: 'synthetic-private-token' } },
      { repo: { owner: 'owner', repo: 'repo' }, runId: 12 },
      async (_url: string, options: { method: string; body?: string }) => ({ ok: true, json: async () => {
        if (options.method === 'GET') return [];
        writes.push(JSON.parse(options.body!)); return { number: 12 };
      } }), { notice() {} });
    return writes;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('real backup controller receipt through generated alert consumer', () => {
  it('retains the failing stage and skipped count when a backup rerun is rejected', async () => {
    const receipt = await runBackupController({ HYPERVIBE_BACKUP_OPERATION: 'backup', GITHUB_RUN_ATTEMPT: '2',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_TOKEN: 'synthetic-private-token' });
    const writes = await alert(receipt);
    expect(receipt).toMatchObject({ version: 2, diagnostic: { stage: 'input', category: 'invalid-input' }, counts: { applied: 0, skipped: 1 } });
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toContain('Stage: input; category: invalid-input');
    expect(writes[0].body).toContain('execution-failed');
    expect(JSON.stringify(writes)).not.toContain('synthetic-private-token');
  });

  it.each(['stage', 'extra'])('rejects an untrusted %s diagnostic without forwarding it', async field => {
    const diagnostic = field === 'stage' ? { stage: 'private-error-sentinel', category: 'unknown' }
      : { stage: 'input', category: 'invalid-input', message: 'private-error-sentinel' };
    const writes = await alert({ version: 2, environment: 'unknown', status: 'unknown', reasonCodes: ['observation-unavailable'], diagnostic });
    expect(writes[0].body).toContain('receipt-invalid');
    expect(writes[0].body).toContain('execution-failed');
    expect(JSON.stringify(writes)).not.toContain('private-error-sentinel');
  });

  it('preserves legacy reasons and never treats a failed job as healthy', async () => {
    const legacy = await alert({ version: 1, environment: 'unknown', status: 'unknown', reasonCodes: ['cleanup-unverified'] });
    expect(legacy[0].body).toContain('cleanup-unverified, execution-failed');
    const failed = await alert({ version: 2, environment: 'unknown', status: 'healthy', reasonCodes: [] });
    expect(failed[0].body).toContain('execution-failed');
    expect(failed[0].state).not.toBe('closed');
  });

  it('carries finite provider facts into the alert without treating authorization as zero writes', async () => {
    const receipt = { version: 2, environment: 'unknown', status: 'unknown', reasonCodes: ['observation-unavailable'],
      counts: { applied: null, skipped: 0 }, diagnostic: { stage: 'task-create', category: 'authorization', httpStatus: 403,
        localCleanupFailed: true, task: { status: 'failed', mutationAttempted: true, cleanupVerified: false } } };
    expect(backupOperationReceiptSchema.parse(receipt).counts?.applied).toBeNull();
    const writes = await alert(receipt);
    expect(writes[0].body).toContain('Stage: task-create; category: authorization; HTTP status: 403');
    expect(writes[0].body).toContain('local cleanup: failed');
    expect(writes[0].body).toContain('"mutationAttempted":true,"cleanupVerified":false');
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
  ] as const)('requires the same admission (%s) at worker, controller and emitted alert: %j', (expected, diagnostic) => {
    const receipt = { version: 2, environment: 'unknown', status: 'unknown', reasonCodes: [], diagnostic };
    expect(recoveryDiagnosticSchema.safeParse(diagnostic).success).toBe(expected);
    const emitted = new Function('value', backupOperationReceiptValidatorSource()
      + '\nreturn parseBackupOperationReceipt(value, backupReceiptRules);');
    expect(backupOperationReceiptSchema.safeParse(receipt).success).toBe(expected);
    expect(Boolean(emitted(receipt))).toBe(expected);
  });
});
