import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runner from '../backup-runner.js';
import { parseBackupHelperEnvironment } from '../backup-runner.js';
import * as storage from '../../domain/services/object-storage-transfer.service.js';
import type { StorageObjectClient } from '../../domain/ports/storage.port.js';

function fixture(): NodeJS.ProcessEnv {
  return {
    HYPERVIBE_BACKUP_CONFIG: JSON.stringify({ version: 1, operation: 'recovery-set', project: 'test', environment: 'staging', contractHash: 'a'.repeat(64), objects: [], runId: 'be1c6bcb-4e37-4118-b0e9-a88cbfa6b141',
      database: { source: { provider: 'railway', primaryExternalId: 'service-id', providerScope: { projectId: 'project', environmentId: 'staging' }, resourceIdentity: {} } },
      destination: { provider: 's3', externalId: 'archive-bucket', instanceScope: { region: 'us-east-1' } },
      archiveBucket: 'archive-bucket',
    }),
    HYPERVIBE_BACKUP_DATABASE_URL: 'postgresql://test_user:db-secret@postgres.railway.internal/test_db',
    HYPERVIBE_BACKUP_PRIVATE_HOST: 'postgres.railway.internal',
    HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON: JSON.stringify({ bucket: 'archive-bucket', endpoint: 'https://s3.example.invalid',
      region: 'us-east-1', accessKeyId: 'access-secret', secretAccessKey: 'storage-secret', urlStyle: 'path' }),
  };
}

describe('managed PostgreSQL backup helper boundary', () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });
  it('accepts the exact source, archive and reserved run without requiring a public DB URL', () => {
    expect(parseBackupHelperEnvironment(fixture()).config).toMatchObject({ operation: 'recovery-set', archiveBucket: 'archive-bucket' });
  });

  it.each(['wrong-bucket', 'invalid-json', 'source-url', 'public-host', 'missing-private-host', 'arbitrary-command', 'target-url'])('rejects %s without leaking credentials', change => {
    const env = fixture();
    if (change === 'wrong-bucket') env.HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON = env.HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON!.replace('archive-bucket', 'wrong-bucket');
    if (change === 'invalid-json') env.HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON = 'storage-secret';
    if (change === 'source-url') env.HYPERVIBE_BACKUP_DATABASE_URL = 'https://test_user:db-secret@example.invalid/test_db';
    if (change === 'public-host') env.HYPERVIBE_BACKUP_DATABASE_URL = env.HYPERVIBE_BACKUP_DATABASE_URL!.replace('postgres.railway.internal', 'public.example.invalid');
    if (change === 'missing-private-host') delete env.HYPERVIBE_BACKUP_PRIVATE_HOST;
    if (change === 'arbitrary-command') env.HYPERVIBE_BACKUP_CONFIG = JSON.stringify({ ...JSON.parse(env.HYPERVIBE_BACKUP_CONFIG!), command: 'echo db-secret' });
    if (change === 'target-url') env.HYPERVIBE_BACKUP_CONFIG = JSON.stringify({ ...JSON.parse(env.HYPERVIBE_BACKUP_CONFIG!), restoreUrl: env.HYPERVIBE_BACKUP_DATABASE_URL });
    expect(() => parseBackupHelperEnvironment(env)).toThrow(/^Backup helper configuration is invalid\.$/);
  });

  it('packages Hypervibe code and PostgreSQL under a non-root fixed entrypoint', () => {
    const dockerfile = readFileSync(new URL('../../../templates/backup-runner/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('FROM postgres:16-bookworm AS runtime');
    expect(dockerfile).toContain('USER postgres');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/opt/hypervibe/dist/ci/backup-runner.js"]');
    expect(dockerfile).not.toMatch(/COPY\s+\.\s/);
    const context = readFileSync(new URL('../../../templates/backup-runner/Dockerfile.dockerignore', import.meta.url), 'utf8');
    expect(context).toMatch(/^\*\*\n/);
    expect(context).toContain('\nnode_modules\n');
  });

  it('retains invalid worker-input diagnostics without serializing rejected configuration', () => {
    const env = fixture(); env.HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON = 'storage-secret';
    let caught: unknown;
    try { parseBackupHelperEnvironment(env); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ diagnostic: { stage: 'worker-input', category: 'invalid-input' } });
    expect(JSON.stringify(caught)).not.toContain('storage-secret');
  });

  it('redacts archive client initialization errors and identifies the failed boundary', async () => {
    vi.spyOn(storage, 'createS3ObjectClient').mockImplementation(() => { throw new Error('storage-secret'); });
    const error = await runner.runBackupHelper(fixture()).catch(error => error);
    expect(error).toMatchObject({ diagnostic: { stage: 'archive-open', category: 'execution' } });
    expect(String(error)).not.toContain('storage-secret');
  });

  it('keeps shutdown failures inside the typed diagnostic boundary', async () => {
    const archive: StorageObjectClient = { list: vi.fn().mockRejectedValue(new Error('private-object-key')),
      get: vi.fn(), put: vi.fn(), destroy: vi.fn(() => { throw new Error('storage-secret'); }) };
    vi.spyOn(storage, 'createS3ObjectClient').mockReturnValue(archive);
    const env = fixture();
    const config = JSON.parse(env.HYPERVIBE_BACKUP_CONFIG!); delete config.database;
    config.objects = [{ name: 'documents', identity: { provider: 's3', externalId: 'documents', instanceScope: { region: 'us-east-1' } }, bucket: 'documents' }];
    env.HYPERVIBE_BACKUP_CONFIG = JSON.stringify(config);
    env.HYPERVIBE_BACKUP_OBJECTS_CREDENTIALS_JSON = JSON.stringify({ documents: {
      ...JSON.parse(env.HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON!), bucket: 'documents',
    } });
    const error = await runner.runBackupHelper(env).catch(error => error);
    expect(error).toMatchObject({ diagnostic: { stage: 'recovery-reservation', category: 'execution', localCleanupFailed: true } });
    expect(String(error)).not.toMatch(/storage-secret|private-object-key/);
    expect(archive.destroy).toHaveBeenCalledTimes(2);
  });

  it.each(['valid-config', 'invalid-config'] as const)('emits a failure marker only for a validated execution identity (%s)', async mode => {
    const env = fixture(); env.HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON = 'storage-secret';
    if (mode === 'invalid-config') env.HYPERVIBE_BACKUP_CONFIG = JSON.stringify({
      runId: 'be1c6bcb-4e37-4118-b0e9-a88cbfa6b141', unsafe: 'db-secret',
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await runner.runBackupHelperCli(env);
    const output = [...stdout.mock.calls, ...stderr.mock.calls].map(call => String(call[0])).join('');
    const markers = output.split('\n').filter(line => line.startsWith('HYPERVIBE_RECOVERY_FAILURE:'));
    if (mode === 'valid-config') {
      expect(markers).toHaveLength(1);
      expect(JSON.parse(markers[0].slice('HYPERVIBE_RECOVERY_FAILURE:'.length))).toEqual({ version: 1,
        executionId: 'be1c6bcb-4e37-4118-b0e9-a88cbfa6b141', diagnostic: { stage: 'worker-input', category: 'invalid-input' } });
    } else expect(markers).toEqual([]);
    expect(output).toContain('Hypervibe backup helper did not produce verified completion evidence.');
    expect(output).not.toMatch(/storage-secret|db-secret|access-secret/);
    expect(process.exitCode).toBe(1);
  });
});
