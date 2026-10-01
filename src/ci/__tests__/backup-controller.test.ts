import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
