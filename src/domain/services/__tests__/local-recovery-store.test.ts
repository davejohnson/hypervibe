import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { rm, stat } from 'node:fs/promises';
import { createLocalRecoveryStore } from '../local-recovery-store.js';

const observed = vi.hoisted(() => ({ directories: [] as string[], capacity: vi.fn() }));
vi.mock('node:fs/promises', async importActual => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, statfs: observed.capacity, mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
    const path = await actual.mkdtemp(...args);
    observed.directories.push(String(path));
    return path;
  } };
});
afterEach(async () => {
  await Promise.all(observed.directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  observed.capacity.mockReset();
});

describe('owned isolated file restore scratch space', () => {
  it('removes the owned directory if capacity cannot be observed', async () => {
    observed.capacity.mockRejectedValue(new Error('Filesystem observation failed'));
    await expect(createLocalRecoveryStore()).rejects.toThrow('Filesystem observation failed');
    expect(observed.directories).toHaveLength(1);
    await expect(stat(observed.directories[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds aggregate bytes before consuming a body and keeps opaque keys inside owned scratch', async () => {
    observed.capacity.mockResolvedValue({ bavail: 10, bsize: 1 });
    const target = await createLocalRecoveryStore();
    try {
      await target.client.put('../../outside', { size: 5, body: Readable.from([Buffer.from('hello')]) }, { ifAbsent: true });
      const body = Readable.from([Buffer.from('four')]);
      await expect(target.client.put('second', { size: 4, body }, { ifAbsent: true })).rejects.toThrow('insufficient bounded scratch space');
      expect(body.readableDidRead).toBe(false);
      const retained = await target.client.get('../../outside');
      const chunks: Buffer[] = [];
      for await (const chunk of retained.body as Readable) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('hello');
      expect(await target.client.list()).toHaveLength(1);
    } finally { await target.cleanup(); }
    await expect(stat(observed.directories[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
