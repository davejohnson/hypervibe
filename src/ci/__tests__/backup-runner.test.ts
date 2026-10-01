import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBackupHelperEnvironment } from '../backup-runner.js';

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
});
