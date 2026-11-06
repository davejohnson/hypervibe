import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RDSClient } from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import '../../../application/providers.js';
import { AdapterFactory } from '../../../domain/services/adapter.factory.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { SqliteAdapter } from '../../db/sqlite.adapter.js';
import { ConnectionRepository } from '../../db/repositories/connection.repository.js';
import { SecretStore, getSecretStore } from '../../secrets/secret-store.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';

const credentials = { accessKeyId: 'AKIASYNTHETIC12345678', secretAccessKey: 'synthetic-secret-key-for-offline-contracts-only' };
let directory: string;
function saveConnection(provider: string): void {
  const repo = new ConnectionRepository();
  const connection = repo.create({ provider, credentialsEncrypted: getSecretStore().encryptObject(credentials) });
  repo.updateStatus(connection.id, 'verified');
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-cloud-operations-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  vi.stubEnv('HYPERVIBE_SECRET_KEY', '3'.repeat(64));
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request in offline factory contract'); }));
});
afterEach(() => {
  SqliteAdapter.resetInstance();
  SecretStore.resetInstance();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('cloud lifecycle retirement boundary', () => {
  it('blocks cloud provisioning before credentials or provider factories can produce effects, even with saved verified connections', async () => {
    const hosts = ['cloudrun', 'ecs', 'azure-container-apps'];
    const databases = ['cloudsql', 'rds', 'azure-postgres'];
    const storage = ['gcs', 's3', 'azureblob'];
    for (const provider of [...hosts, ...databases, ...storage]) saveConnection(provider);
    const factory = new AdapterFactory();
    const decrypt = vi.spyOn(getSecretStore(), 'decryptObject');
    const create = vi.spyOn(providerRegistry, 'createAdapter');
    const results = await Promise.all([
      ...hosts.map(provider => factory.getHostingAdapterByName(provider)),
      ...databases.map(provider => factory.getDatabaseAdapter(provider)),
      ...storage.map(provider => factory.getStorageAdapter(provider)),
    ]);
    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.adapter).toBeUndefined();
      expect(result.error).toMatch(/lifecycle|planned/i);
    }
    expect(decrypt).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the same saved cloud connection for scoped database reads and object transfers without provisioning', async () => {
    saveConnection('ecs'); // The real registry reuses this connection for RDS and S3.
    const sts = vi.spyOn(STSClient.prototype, 'send').mockResolvedValue({ Account: '123456789012' } as never);
    const rds = vi.spyOn(RDSClient.prototype, 'send').mockResolvedValue({ DBInstances: [{
      DBInstanceIdentifier: 'bound-db', DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:bound-db',
      Endpoint: { Address: 'bound-db.example.test', Port: 5432 },
    }] } as never);
    const s3 = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Contents: [], IsTruncated: false } as never);
    const factory = new AdapterFactory();
    const database = await factory.getDatabaseOperations('rds');
    const storage = await factory.getStorageOperations('s3');
    expect(database).toMatchObject({ success: true, connectionProvider: 'ecs' });
    expect(storage).toMatchObject({ success: true, connectionProvider: 'ecs' });
    if (!database.adapter || !storage.adapter) throw new Error('Existing-resource operations did not resolve');
    const now = new Date();
    const environment: Environment = { id: 'environment-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now };
    const component: Component = { id: 'database-1', environmentId: environment.id, type: 'postgres', externalId: 'bound-db',
      bindings: { provider: 'rds', username: 'app', password: 'synthetic-database-password', database: 'app',
        providerScope: { accountId: '123456789012', region: 'us-west-2' } }, createdAt: now, updatedAt: now };
    await expect(database.adapter.getConnectionUrl(component)).resolves.toBe('postgresql://app:synthetic-database-password@bound-db.example.test:5432/app?sslmode=require');
    const transfer = await storage.adapter.openObjectTransfer!(environment, { accountId: '123456789012', region: 'us-west-2' }, 'bound-bucket');
    try {
      await expect(transfer.list({ prefix: 'retained/' })).resolves.toEqual([]);
    } finally {
      await transfer.destroy?.();
      await database.adapter.disconnect?.();
      await storage.adapter.disconnect?.();
    }
    expect(sts.mock.calls.map(([command]) => command.constructor.name)).toEqual(['GetCallerIdentityCommand']);
    expect(rds.mock.calls.map(([command]) => command.constructor.name)).toEqual(['DescribeDBInstancesCommand']);
    expect(s3.mock.calls.map(([command]) => command.constructor.name)).toEqual(['ListObjectsV2Command']);
    expect((s3.mock.calls[0]![0] as { input: unknown }).input).toMatchObject({ Bucket: 'bound-bucket', Prefix: 'retained/' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
