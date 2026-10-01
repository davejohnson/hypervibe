import './providers.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import { executeManagedBackup, verifyManagedBackupAuthority } from '../application/managed-backup.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';

export async function runBackupController(env: NodeJS.ProcessEnv = process.env) {
  const operation = env.HYPERVIBE_BACKUP_OPERATION;
  let environment = 'unknown';
  try {
    if (!['backup', 'health'].includes(operation ?? '') || !env.GITHUB_TOKEN
      || !['schedule', 'workflow_dispatch', 'push'].includes(env.GITHUB_EVENT_NAME ?? '')
      || (operation === 'backup' && env.GITHUB_RUN_ATTEMPT !== '1')) throw new Error('Invalid recurring execution.');
    const input = JSON.parse(readFileSync(env.HYPERVIBE_BACKUP_CONTRACT ?? '', 'utf8'));
    if (typeof input.environment === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(input.environment)) environment = input.environment;
    const github = await providerRegistry.createAdapter<GitHubAdapter>('github', { apiToken: env.GITHUB_TOKEN });
    const authorized = await verifyManagedBackupAuthority({ target: input, contractHash: env.HYPERVIBE_BACKUP_CONTRACT_HASH ?? '',
      runnerImage: env.HYPERVIBE_BACKUP_RUNNER_IMAGE ?? '', repository: env.GITHUB_REPOSITORY ?? '', sha: env.GITHUB_SHA ?? '',
      ref: env.GITHUB_REF ?? '', github });
    const receipt = await executeManagedBackup({ ...authorized, operation: operation as 'backup' | 'health',
      repository: env.GITHUB_REPOSITORY ?? '', runId: env.GITHUB_RUN_ID ?? '', credentials: env });
    if (env.HYPERVIBE_BACKUP_RECEIPT) writeFileSync(env.HYPERVIBE_BACKUP_RECEIPT, JSON.stringify(receipt) + '\n', { mode: 0o600 });
    if (receipt.status !== 'healthy') process.exitCode = 1;
    return receipt;
  } catch {
    const receipt = { version: 1, environment, status: 'unknown', reasonCodes: ['observation-unavailable'] };
    try { if (env.HYPERVIBE_BACKUP_RECEIPT) writeFileSync(env.HYPERVIBE_BACKUP_RECEIPT, JSON.stringify(receipt) + '\n', { mode: 0o600 }); } catch { /* Safe console remains. */ }
    process.exitCode = 1; return receipt;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await runBackupController()) + '\n');
}
