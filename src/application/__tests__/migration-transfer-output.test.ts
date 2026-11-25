/**
 * Upgrade safety (workflow DG-137): what hv_migrate generates must not change
 * when the database-move copy is added beside it. The recorded output was
 * captured from the code before that addition: every existing transfer script,
 * and the Cloud Run job an existing database copy creates. Regenerate only for
 * an intended, reviewed change to hv_migrate's own output:
 *   UPDATE_MIGRATION_TRANSFER_BASELINE=1 npx vitest run src/application/__tests__/migration-transfer-output.test.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseExportScript, databaseManifestScript, databaseRestoreScript, databaseTransferScript, storageCheckScript, storageTransferScript } from '../migration-transfer-gcp.js';
import { createdJobBody } from './transfer-job-body.js';

const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migration-transfer-output.baseline.json');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

afterEach(() => { vi.unstubAllGlobals(); });

describe('hv_migrate keeps generating exactly what it did', () => {
  it('every existing transfer script and the existing database copy job are unchanged', async () => {
    const observed = {
      scripts: Object.fromEntries(Object.entries({ databaseTransferScript, databaseExportScript, databaseRestoreScript, databaseManifestScript, storageTransferScript, storageCheckScript })
        .map(([name, build]) => [name, digest(build())])),
      databaseCopyJob: await createdJobBody({ purpose: 'database', image: 'postgres:16-alpine', script: 'echo synthetic', env: { PGTZ: 'UTC' }, sourceSecrets: {},
        secretRefs: { DATABASE_URL: { secretId: 'hv-production-database-url', version: '3' } }, cloudSqlConnectionName: 'demo-project:us-central1:hv-production-db-a1b2c3', timeoutSeconds: 3600 }),
      storageCopyJob: await createdJobBody({ purpose: 'storage', image: 'rclone/rclone:1.68.2', script: 'echo synthetic', env: { SOURCE_BUCKET: 'a' }, sourceSecrets: {}, timeoutSeconds: 3600 }),
    };
    if (process.env.UPDATE_MIGRATION_TRANSFER_BASELINE) writeFileSync(baselinePath, `${JSON.stringify(observed, null, 1)}\n`);
    expect(observed).toEqual(JSON.parse(readFileSync(baselinePath, 'utf8')));
  });
});
