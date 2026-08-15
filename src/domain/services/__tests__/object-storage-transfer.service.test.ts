import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { StorageCredentials } from '../../ports/storage.port.js';
import {
  transferObjectStorage,
  type StorageObjectClient,
} from '../object-storage-transfer.service.js';

const credentials: StorageCredentials = {
  bucket: 'bucket',
  endpoint: 'https://objects.example.test',
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  region: 'test-1',
  urlStyle: 'path',
};

function client(initial: Record<string, Buffer>): StorageObjectClient & { objects: Record<string, Buffer> } {
  const objects = { ...initial };
  return {
    objects,
    list: async () => Object.entries(objects)
      .map(([key, value]) => ({ key, size: value.byteLength }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    get: async (key) => ({ body: Readable.from(objects[key]), size: objects[key].byteLength }),
    put: async (key, payload) => {
      const chunks: Buffer[] = [];
      for await (const chunk of payload.body as Readable) chunks.push(Buffer.from(chunk));
      objects[key] = Buffer.concat(chunks);
    },
    destroy: vi.fn(),
  };
}

describe('transferObjectStorage', () => {
  it('streams all objects and returns a non-secret verification manifest', async () => {
    const source = client({ 'documents/a.pdf': Buffer.from('one'), 'documents/b.pdf': Buffer.from('second') });
    const target = client({});
    const clients = [source, target];
    const result = await transferObjectStorage(credentials, credentials, {
      createClient: () => clients.shift()!,
    });

    expect(target.objects).toEqual(source.objects);
    expect(result).toMatchObject({ objectCount: 2, totalBytes: '9' });
    expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(source.destroy).toHaveBeenCalled();
    expect(target.destroy).toHaveBeenCalled();
  });

  it('fails verification when the target manifest differs', async () => {
    const source = client({ a: Buffer.from('one') });
    const target = client({});
    target.list = async () => [{ key: 'a', size: 2 }];
    const clients = [source, target];

    await expect(transferObjectStorage(credentials, credentials, {
      createClient: () => clients.shift()!,
    })).rejects.toThrow('target keys or object sizes differ');
  });

  it('treats provider-native listing order as irrelevant to the manifest', async () => {
    const source = client({ a: Buffer.from('one'), b: Buffer.from('two') });
    const target = client({});
    source.list = async () => [{ key: 'b', size: 3 }, { key: 'a', size: 3 }];
    target.list = async () => [{ key: 'a', size: 3 }, { key: 'b', size: 3 }];
    const clients = [source, target];

    await expect(transferObjectStorage(credentials, credentials, {
      createClient: () => clients.shift()!,
    })).resolves.toMatchObject({ objectCount: 2, totalBytes: '6' });
  });
});
