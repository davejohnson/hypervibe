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

  it('builds the S3 adapter from an existing verified ECS connection', async () => {
    const connectionRepo = new ConnectionRepository();
    const connection = connectionRepo.create({
      provider: 'ecs',
      credentialsEncrypted: getSecretStore().encryptObject({
        accessKeyId: 'A'.repeat(20),
        secretAccessKey: 's'.repeat(40),
      }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');
    const project = new ProjectRepository().create({ name: 'storage-auth-reuse' });

    await expect(adapterFactory.getStorageAdapter('s3', project)).resolves.toMatchObject({
      success: true,
      adapter: { name: 's3' },
    });
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

    await expect(adapterFactory.getStorageAdapter('gcs', project)).resolves.toMatchObject({
      success: true,
      adapter: { name: 'gcs' },
    });
  });

  it('builds the Memorystore adapter from an existing verified Cloud Run connection', async () => {
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
      success: true,
      adapter: { name: 'memorystore' },
    });
  });

  it('builds the Azure Blob adapter from an existing verified Container Apps connection', async () => {
    const connectionRepo = new ConnectionRepository();
    const connection = connectionRepo.create({
      provider: 'azure-container-apps',
      credentialsEncrypted: getSecretStore().encryptObject({
        tenantId: '11111111-1111-4111-8111-111111111111',
        subscriptionId: '22222222-2222-4222-8222-222222222222',
        clientId: '33333333-3333-4333-8333-333333333333',
        clientSecret: 'secret-value',
      }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');
    const project = new ProjectRepository().create({ name: 'storage-auth-reuse-azure' });

    await expect(adapterFactory.getStorageAdapter('azureblob', project)).resolves.toMatchObject({
      success: true,
      adapter: { name: 'azureblob' },
    });
  });
});
