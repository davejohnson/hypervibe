import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as managed from '../../application/managed-backup.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { runBackupController } from '../backup-controller.js';

const directories: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('recurring backup failure receipts', () => {
  it('reports zero writes and a skipped backup when a rerun is rejected before execution', async () => {
    const execute = vi.spyOn(managed, 'executeManagedBackup');
    const result = await runBackupController({ HYPERVIBE_BACKUP_OPERATION: 'backup', GITHUB_RUN_ATTEMPT: '2',
      GITHUB_TOKEN: 'synthetic-token', GITHUB_EVENT_NAME: 'workflow_dispatch' });
    expect(result).toMatchObject({ status: 'unknown', counts: { applied: 0, skipped: 1 } });
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ version: 2, diagnostic: { stage: 'input', category: 'invalid-input' } });
  });

  it('reports unknown writes after execution fails without forwarding private errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'backup-controller-receipt-')); directories.push(directory);
    const contract = join(directory, 'contract.json');
    writeFileSync(contract, JSON.stringify({ environment: 'staging' }));
    vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue({});
    vi.spyOn(managed, 'verifyManagedBackupAuthority').mockResolvedValue({ target: {}, environment: {} } as never);
    vi.spyOn(managed, 'executeManagedBackup').mockRejectedValue(new Error('provider echoed synthetic-private-value after a write'));
    const result = await runBackupController({ HYPERVIBE_BACKUP_OPERATION: 'backup', GITHUB_RUN_ATTEMPT: '1',
      GITHUB_TOKEN: 'synthetic-token', GITHUB_EVENT_NAME: 'workflow_dispatch', HYPERVIBE_BACKUP_CONTRACT: contract });
    expect(result).toMatchObject({ status: 'unknown', counts: { applied: null, skipped: 0 } });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
  });

  it('preserves a real application archive-open failure through the saved controller receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'backup-controller-diagnostic-')); directories.push(directory);
    const contract = join(directory, 'contract.json'), receipt = join(directory, 'receipt.json');
    writeFileSync(contract, JSON.stringify({ environment: 'staging' }));
    const identity = { provider: 's3', externalId: 'archive', instanceScope: { accountId: '123456789012', region: 'us-east-1' } };
    const target = { version: 1, project: 'test', environment: 'staging', hosting: { provider: 'vercel', providerScope: {} },
      runnerImage: `example.invalid/helper@sha256:${'a'.repeat(64)}`, destination: { name: 'archive', identity },
      objects: [], fileReferenceQueries: [], retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 };
    const open = vi.fn(async () => { throw new Error('private-storage-key-echo'); });
    vi.spyOn(providerRegistry, 'createAdapter').mockImplementation(async provider => provider === 'github' ? {} : {
      name: 's3', observe: async () => [{ ...identity, status: 'ready' }], openObjectTransfer: open,
    });
    vi.spyOn(managed, 'verifyManagedBackupAuthority').mockResolvedValue({ target, environment: {} } as never);
    const result = await runBackupController({ HYPERVIBE_BACKUP_OPERATION: 'backup', GITHUB_RUN_ATTEMPT: '1',
      GITHUB_TOKEN: 'synthetic-token', GITHUB_EVENT_NAME: 'workflow_dispatch', HYPERVIBE_BACKUP_CONTRACT: contract,
      HYPERVIBE_BACKUP_RECEIPT: receipt, GITHUB_REPOSITORY: 'owner/project', GITHUB_RUN_ID: '123',
      AWS_ACCESS_KEY_ID: 'private-access', AWS_SECRET_ACCESS_KEY: 'private-secret' });
    expect(open).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ version: 2, status: 'unknown', counts: { applied: 0, skipped: 1 },
      diagnostic: { stage: 'archive-open', category: 'unknown', task: { mutationAttempted: false } } });
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/private-/);
  });

  it.each(['healthy', 'unknown'] as const)('preserves %s execution facts when saving the receipt fails', async status => {
    const directory = mkdtempSync(join(tmpdir(), 'backup-controller-write-')); directories.push(directory);
    const contract = join(directory, 'contract.json');
    writeFileSync(contract, JSON.stringify({ environment: 'staging' }));
    vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue({});
    vi.spyOn(managed, 'verifyManagedBackupAuthority').mockResolvedValue({ target: {}, environment: {} } as never);
    vi.spyOn(managed, 'executeManagedBackup').mockResolvedValue({ version: 2, environment: 'staging', status,
      reasonCodes: status === 'healthy' ? [] : ['retention-unknown'], counts: { applied: 1, skipped: 0 },
      ...(status === 'healthy' ? {} : { diagnostic: { stage: 'retention', category: 'unknown' } }),
    } as never);
    const result = await runBackupController({ HYPERVIBE_BACKUP_OPERATION: 'backup', GITHUB_RUN_ATTEMPT: '1',
      GITHUB_TOKEN: 'synthetic-token', GITHUB_EVENT_NAME: 'workflow_dispatch', HYPERVIBE_BACKUP_CONTRACT: contract,
      HYPERVIBE_BACKUP_RECEIPT: directory });
    expect(result).toMatchObject({ version: 2, status: 'unknown', counts: { applied: 1, skipped: 0 },
      diagnostic: { stage: status === 'healthy' ? 'receipt-write' : 'retention', category: 'unknown' } });
    if (status === 'unknown') expect(result.reasonCodes).toContain('retention-unknown');
    expect(JSON.stringify(result)).not.toContain(directory);
  });
});
