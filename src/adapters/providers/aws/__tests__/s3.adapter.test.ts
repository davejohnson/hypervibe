import { describe, expect, it, vi } from 'vitest';
import {
  GetBucketTaggingCommand,
  ListObjectsV2Command,
  ListBucketsCommand,
} from '@aws-sdk/client-s3';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { S3StorageAdapter } from '../s3.adapter.js';

const credentials = {
  accessKeyId: 'A'.repeat(20),
  secretAccessKey: 's'.repeat(40),
};
const region = 'us-west-2';

function environment(): Environment {
  return {
    id: 'environment-1', projectId: 'project-1', name: 'production', platformBindings: {},
    createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('S3StorageAdapter', () => {

  it('inventories bounded buckets with durable account scope', async () => {
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        expect(command).toBeInstanceOf(ListBucketsCommand);
        return { Buckets: [{ Name: 'customer-documents', BucketRegion: 'us-west-2' }, { Name: 'archive' }] };
      }),
      destroy: vi.fn(),
    };
    const sts = { send: vi.fn(async () => ({ Account: '123456789012' })), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);

    await expect(adapter.inspectStorageResources({ resource: 'storage', limit: 1 }))
      .resolves.toMatchObject({
        observation: 'present',
        resource: 'storage',
        storage: [{
          id: 'customer-documents',
          name: 'customer-documents',
          providerScope: { accountId: '123456789012' },
        }],
        truncated: true,
        partial: false,
      });
  });

  it('uses the native AWS credential chain without requiring access keys in Hypervibe', async () => {
    const seen: unknown[] = [];
    const s3 = { send: vi.fn(), destroy: vi.fn() };
    const sts = {
      send: vi.fn(async () => ({ Account: '123456789012' })),
      destroy: vi.fn(),
    };
    const adapter = new S3StorageAdapter((authentication) => {
      seen.push(authentication);
      return { s3, sts };
    });

    await adapter.connect({ authMode: 'default' });

    await expect(adapter.verify()).resolves.toMatchObject({ success: true });
    expect(seen).toEqual([{ authMode: 'default' }]);
  });

  it('does not copy an expiring AWS CLI or SSO session into a deployed service', async () => {
    const s3 = { send: vi.fn(), destroy: vi.fn() };
    const sts = { send: vi.fn(), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(
      () => ({ s3, sts }),
      async () => ({
        accessKeyId: 'A'.repeat(20),
        secretAccessKey: 's'.repeat(40),
        sessionToken: 'temporary-session',
        expiration: new Date(Date.now() + 60 * 60 * 1_000),
      })
    );
    await adapter.connect({ authMode: 'default' });

    await expect(adapter.getRuntimeEnv(
      environment(),
      { accountId: '123456789012', region: 'us-west-2' },
      'managed-bucket',
      'documents'
    )).rejects.toThrow(/will not copy an expiring CLI\/SSO session/);
  });

  it('observes only buckets tagged for the selected Hypervibe environment', async () => {
    const s3 = { send: vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketTaggingCommand) {
        const bucket = (command.input as { Bucket: string }).Bucket;
        return bucket === 'managed-bucket'
          ? { TagSet: [{ Key: 'hypervibe-environment-id', Value: 'environment-1' }, { Key: 'hypervibe-storage-name', Value: 'documents' }] }
          : { TagSet: [{ Key: 'owner', Value: 'someone-else' }] };
      }
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: 'a.pdf', Size: 42 }], IsTruncated: false };
      }
      if (command instanceof ListBucketsCommand) {
        expect(command.input).toMatchObject({ BucketRegion: 'us-west-2' });
        expect(command.input).not.toHaveProperty('Prefix');
      }
      return { Buckets: [{ Name: 'managed-bucket' }, { Name: 'unmanaged-bucket' }] };
    }), destroy: vi.fn() };
    const sts = { send: vi.fn(async () => ({ Account: '123456789012' })), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);
    const context = (await adapter.ensureContext('friend-app', environment(), {}, region)).context!;

    await expect(adapter.observe(environment(), context)).resolves.toEqual([expect.objectContaining({
      provider: 's3', externalId: 'managed-bucket', name: 'documents', region: 'us-west-2',
      instanceScope: expect.objectContaining({ accountId: '123456789012', region: 'us-west-2' }),
      objectCount: 1, sizeBytes: 42,
    })]);
  });

  it('returns the established S3 runtime contract without exposing it in receipts', async () => {
    const s3 = { send: vi.fn(), destroy: vi.fn() };
    const sts = { send: vi.fn(), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);

    expect(adapter.runtimeEnvKeys('documents')).toEqual([
      'AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_S3_BUCKET_NAME', 'AWS_DEFAULT_REGION', 'AWS_S3_URL_STYLE',
    ]);
    await expect(adapter.getRuntimeEnv(environment(), { accountId: '123456789012', region: 'us-west-2' }, 'bucket', 'documents'))
      .resolves.toMatchObject({ AWS_S3_BUCKET_NAME: 'bucket', AWS_DEFAULT_REGION: 'us-west-2' });
  });
});
