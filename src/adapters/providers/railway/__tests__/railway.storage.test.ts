import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { RailwayAdapter } from '../railway.adapter.js';

function environment(): Environment {
  return { id: 'local', projectId: 'project', name: 'staging', platformBindings: { projectId: 'rp', environmentId: 're' }, createdAt: new Date(), updatedAt: new Date() };
}

describe('Railway storage buckets', () => {
  it('observes only bucket instances attached to the bound environment', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ project: {
        id: 'rp', name: 'app',
        environments: { edges: [
          { node: { id: 're', name: 'staging', config: { buckets: { 'bucket-docs': { region: 'sjc', isCreated: true } } } } },
          { node: { id: 're-prod', name: 'production', config: { buckets: { 'bucket-docs': { region: 'iad', isCreated: true } } } } },
        ] },
        buckets: { edges: [{ node: { id: 'bucket-docs', name: 'documents' } }] },
        services: { edges: [] }, plugins: { edges: [] },
      } })
      .mockResolvedValueOnce({ bucketInstanceDetails: { objectCount: 3, sizeBytes: 42 } });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const result = await adapter.observe(environment());

    expect(result.storage).toEqual([{ provider: 'railway', kind: 'object', externalId: 'bucket-docs', name: 'documents', region: 'sjc', status: 'ready', objectCount: 3, sizeBytes: 42 }]);
  });

  it('creates a project bucket and commits its environment instance', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ project: { buckets: { edges: [] }, environments: { edges: [{ node: { id: 're', unmergedChangesCount: 0 } }] } }, environment: { config: { buckets: {} } } })
      .mockResolvedValueOnce({ bucketCreate: { id: 'bucket-1', name: 'uploads', projectId: 'rp' } })
      .mockResolvedValueOnce({ environmentPatchCommit: true });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({ success: true, data: { externalId: 'bucket-1', region: 'sjc' } });
    expect(request.mock.calls[1]?.[1]).toEqual({ input: { projectId: 'rp', name: 'uploads' } });
    expect(request.mock.calls[2]?.[1]).toMatchObject({ environmentId: 're', patch: { buckets: { 'bucket-1': { region: 'sjc', isCreated: true, isDeleted: false } } } });
  });

  it('attaches a separate environment instance when the project bucket already exists', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { buckets: { edges: [{ node: { id: 'bucket-1', name: 'documents' } }] }, environments: { edges: [{ node: { id: 're', unmergedChangesCount: 0 } }] } },
        environment: { config: { buckets: {} } },
      })
      .mockResolvedValueOnce({ environmentPatchCommit: true });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    const receipt = await adapter.ensureStorage(environment(), 'documents', { region: 'sjc' });
    expect(receipt).toMatchObject({ success: true, data: { externalId: 'bucket-1' } });
    expect(String(request.mock.calls[1]?.[0])).toContain('environmentPatchCommit');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refuses to mutate around unrelated staged changes', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      project: { buckets: { edges: [] }, environments: { edges: [{ node: { id: 're', unmergedChangesCount: 2 } }] } },
      environment: { config: { buckets: {} } },
    });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });
    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('staged');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retrieves S3 credentials internally without putting them in a receipt', async () => {
    const request = vi.fn().mockResolvedValueOnce({ bucketS3Credentials: [{
      endpoint: 'https://storage.railway.app', accessKeyId: 'key', secretAccessKey: 'secret',
      bucketName: 'uploads-hash', region: 'auto', urlStyle: 'virtual',
    }] });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    await expect(adapter.getStorageCredentials(environment(), 'bucket-1')).resolves.toEqual({
      endpoint: 'https://storage.railway.app', accessKeyId: 'key', secretAccessKey: 'secret',
      bucket: 'uploads-hash', region: 'auto', urlStyle: 'virtual',
    });
  });
});
