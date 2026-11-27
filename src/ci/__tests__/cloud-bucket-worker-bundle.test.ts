import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { cloudBucketBackupBundle } from '../../adapters/providers/cloud-bucket-backup-bundle.js';
import { gcpDailyBucketBackupCommand } from '../../adapters/providers/gcp/gcp-daily-bucket-backup-workload.js';

describe('packaged daily bucket jobs', () => {
  it.each(['s3', 'azure-blob', 'gcs'] as const)('loads the exact deployed %s executable in standalone Node and rejects untrusted inputs without exposing their values', provider => {
    const gcp = gcpDailyBucketBackupCommand();
    expect(gcp.command).toEqual(['node']);
    const result = spawnSync(process.execPath, provider === 'gcs' ? gcp.args : ['--input-type=commonjs', '-'], {
      cwd: tmpdir(), input: provider === 'gcs' ? undefined : cloudBucketBackupBundle(provider), encoding: 'utf8',
      env: { HYPERVIBE_BUCKET_BACKUP_CONFIG: JSON.stringify({ version: 1, provider, privateMarker: 'must-never-leak' }) }, timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('The cloud bucket backup could not be verified.\n');
  });
});
