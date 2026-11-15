import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { adapterFactory } from '../adapter.factory.js';

describe('compatible cloud connection reuse', () => {
  beforeEach(() => {
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-storage-connection-')), 'test.db')).migrate();
  });

  it('builds the GCS adapter from an existing verified Cloud Run connection', async () => {
    const serviceAccount = {
      type: 'service_account',
      project_id: 'cloud-project',
      client_email: 'hypervibe@cloud-project.iam.gserviceaccount.com',
      private_key: 'private-key',
    };
    const connectionRepo = new ConnectionRepository();
    const connection = connectionRepo.create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'cloud-project',
        credentials: JSON.stringify(serviceAccount),
      }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');
    const project = new ProjectRepository().create({ name: 'storage-auth-reuse-gcp' });

    await expect(adapterFactory.getStorageOperations('gcs', project)).resolves.toMatchObject({
      success: true,
      connectionProvider: 'cloudrun',
      adapter: { name: 'gcs' },
    });
  });

  it('does not revive retired Memorystore provisioning through a verified Cloud Run connection', async () => {
    const serviceAccount = {
      type: 'service_account',
      project_id: 'cloud-project',
      client_email: 'hypervibe@cloud-project.iam.gserviceaccount.com',
      private_key: 'private-key',
    };
    const connectionRepo = new ConnectionRepository();
    const connection = connectionRepo.create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'cloud-project',
        credentials: JSON.stringify(serviceAccount),
      }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');
    const project = new ProjectRepository().create({ name: 'cache-auth-reuse-gcp' });

    await expect(adapterFactory.getCacheAdapter('memorystore', project)).resolves.toMatchObject({
      success: false,
    });
  });
});
