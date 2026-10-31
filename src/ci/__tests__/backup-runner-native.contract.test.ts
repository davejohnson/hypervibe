import { describe, expect, it } from 'vitest';
import { parseBackupHelperEnvironment } from '../backup-runner.js';

// Provider source: cloud-sql-nodejs-connector v1.10.0 README and connect-run
// documentation. A selected PUBLIC connector is encrypted IAM-authenticated
// transport, distinct from a PRIVATE route; there is no automatic fallback.
export function nativeBackupEnvironment(ipType = 'PRIVATE'): NodeJS.ProcessEnv {
  const identity = (bucket: string) => ({ provider: 'gcs', externalId: bucket, instanceScope: { projectId: 'sequence-prod', region: 'us-central1' } });
  return { HYPERVIBE_BACKUP_DATABASE_URL: 'postgresql://app:synthetic-db-secret@10.10.1.2/sequence',
    HYPERVIBE_BACKUP_CONFIG: JSON.stringify({ version: 1, operation: 'recovery-set', project: 'sequence', environment: 'production', contractHash: 'a'.repeat(64), runId: 'be1c6bcb-4e37-4118-b0e9-a88cbfa6b141', archiveBucket: 'sequence-backup',
      database: { source: { provider: 'cloudsql', primaryExternalId: 'sequence-db', providerScope: { projectId: 'sequence-prod', region: 'us-central1' }, resourceIdentity: { instanceId: 'sequence-db' } } },
      destination: identity('sequence-backup'), objects: [{ name: 'media', identity: identity('sequence-media'), bucket: 'sequence-media' }],
      fileReferenceQueries: [{ storageName: 'media', query: 'SELECT object_key FROM media' }],
      nativeAccess: { provider: 'cloudrun', configuration: { projectId: 'sequence-prod', instanceConnectionName: 'sequence-prod:us-central1:sequence-db', ipType, runtimeServiceAccountEmail: 'backup@sequence-prod.iam.gserviceaccount.com' } },
    }),
  };
}

describe('native managed recovery helper contract', () => {
  it.each(['PRIVATE', 'PUBLIC'])('accepts exact reviewed %s connector scope with native storage and no copied key JSON', mode => {
    const parsed = parseBackupHelperEnvironment(nativeBackupEnvironment(mode));
    expect(parsed.config).toMatchObject({ nativeAccess: { provider: 'cloudrun', configuration: { ipType: mode } } });
    expect(parsed.credentials).toBeUndefined();
  });

  it.each(['unknown-provider', 'other-project', 'other-instance', 'other-region', 'other-bucket-project', 'wrong-role', 'unknown-route', 'copied-key', 'public-fallback', 'unexpected-field'])('blocks %s without rendering credentials', change => {
    const env = nativeBackupEnvironment(); const config = JSON.parse(env.HYPERVIBE_BACKUP_CONFIG!);
    if (change === 'unknown-provider') config.nativeAccess.provider = 'unknown';
    if (change === 'other-project') config.nativeAccess.configuration.projectId = 'another-project';
    if (change === 'other-instance') config.nativeAccess.configuration.instanceConnectionName = 'sequence-prod:us-central1:other-db';
    if (change === 'other-region') config.database.source.providerScope.region = 'us-west1';
    if (change === 'other-bucket-project') config.objects[0].identity.instanceScope.projectId = 'another-project';
    if (change === 'wrong-role') config.nativeAccess.configuration.runtimeServiceAccountEmail = 'backup@other-project.iam.gserviceaccount.com';
    if (change === 'unknown-route') delete config.nativeAccess.configuration.ipType;
    if (change === 'copied-key') env.HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON = JSON.stringify({ private_key: 'synthetic-private-key' });
    if (change === 'public-fallback') config.nativeAccess.configuration.ipType = 'AUTO';
    if (change === 'unexpected-field') config.nativeAccess.configuration.restoreUrl = 'postgresql://secret@elsewhere/db';
    env.HYPERVIBE_BACKUP_CONFIG = JSON.stringify(config);
    expect(() => parseBackupHelperEnvironment(env)).toThrow(/^Backup helper configuration is invalid\.$/);
  });
});
