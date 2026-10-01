import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { StorageObjectClient, StorageObjectPayload } from '../../ports/storage.port.js';
import { createObjectRecoverySet, verifyObjectRecoverySet, restoreObjectRecoverySet, planObjectRecoveryRetention, type VerifiedObjectRecoverySet } from '../object-recovery-set.service.js';

const identity = (name: string) => ({ provider: 'railway', externalId: name, instanceScope: { projectId: 'project', environmentId: 'production' } });
const limits = { maxObjects: 100, maxObjectBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxManifestBytes: 1024 * 1024 };
type Stored = { bytes: Buffer; metadata?: Record<string, string>; contentType?: string; revision: { etag: string } };
function memory(initial: Record<string, string> = {}) {
  const objects = new Map<string, Stored>();
  for (const [key, text] of Object.entries(initial)) objects.set(key, { bytes: Buffer.from(text), revision: { etag: `"${key}-1"` }, contentType: 'text/plain', metadata: { purpose: 'source' } });
  const list = vi.fn(async (options?: { prefix?: string }) => [...objects.entries()]
    .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
    .map(([key, object]) => ({ key, size: object.bytes.length, revision: object.revision })));
  const get = vi.fn(async (key: string, expected?: { etag?: string }): Promise<StorageObjectPayload> => {
    const object = objects.get(key); if (!object) throw new Error('404');
    if (expected?.etag && expected.etag !== object.revision.etag) throw new Error('412');
    return { ...object, size: object.bytes.length, body: Readable.from([object.bytes]), revision: object.revision };
  });
  const put = vi.fn(async (key: string, payload: StorageObjectPayload, options?: { ifAbsent?: boolean }) => {
    if (options?.ifAbsent && objects.has(key)) throw new Error('412');
    const chunks: Buffer[] = [];
    for await (const chunk of payload.body as Readable) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    objects.set(key, { bytes, ...(payload.metadata ? { metadata: payload.metadata } : {}),
      ...(payload.contentType ? { contentType: payload.contentType } : {}), revision: { etag: `"${createHash('sha256').update(bytes).digest('hex')}"` } });
  });
  const remove = vi.fn(async (key: string) => { objects.delete(key); });
  const client = { list, get, put, remove, destroy: vi.fn() } as StorageObjectClient;
  return { client, objects, list, get, put, remove };
}
const input = (source: StorageObjectClient, destination: StorageObjectClient, setId = 'set-001') => ({
  source, destination, sourceIdentity: identity('source'), destinationIdentity: identity('backup'),
  setId, createdAt: '2026-09-30T03:17:00.000Z', limits,
});

describe('retained object recovery sets', () => {
  it('streams bytes into a separate immutable set, verifies hashes, and writes the manifest last', async () => {
    const source = memory({ 'one.txt': 'abc', 'nested/two.txt': 'defg' }); const destination = memory();
    const result = await createObjectRecoverySet(input(source.client, destination.client));
    expect(result.receipt).toMatchObject({ objectCount: 2, totalBytes: '7', contentVerified: true, applied: 2, skipped: 0 });
    expect(result.manifest.entries.map(entry => entry.key)).toEqual(['nested/two.txt', 'one.txt']);
    expect(result.manifest.entries.find(entry => entry.key === 'one.txt')?.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(destination.put.mock.calls.at(-1)![0]).toMatch(/\/manifest\.json$/);
    expect(source.put).not.toHaveBeenCalled(); expect(source.remove).not.toHaveBeenCalled();
    const verified = await verifyObjectRecoverySet({ destination: destination.client, sourceIdentity: identity('source'), destinationIdentity: identity('backup'), setId: 'set-001', limits });
    expect(verified.receipt.manifestSha256).toBe(result.receipt.manifestSha256);
  });

  it('treats a repeated completed execution as verification and never overwrites retained data', async () => {
    const source = memory({ file: 'abc' }); const destination = memory();
    await createObjectRecoverySet(input(source.client, destination.client));
    destination.put.mockClear(); source.get.mockClear();
    const repeated = await createObjectRecoverySet(input(source.client, destination.client));
    expect(repeated.receipt).toMatchObject({ applied: 0, skipped: 1 });
    expect(destination.put).not.toHaveBeenCalled(); expect(source.get).not.toHaveBeenCalled();
  });

  it('does not overwrite a partial set or report it as recoverable', async () => {
    const source = memory({ file: 'abc' }); const destination = memory();
    destination.put.mockImplementationOnce(async (key, payload) => {
      destination.objects.set(key, { bytes: Buffer.from('corrupt'), revision: { etag: 'partial' } });
      (payload.body as Readable).resume();
      throw new Error('connection lost after accepting bytes');
    });
    await expect(createObjectRecoverySet(input(source.client, destination.client))).rejects.toThrow();
    expect([...destination.objects.keys()].some(key => key.endsWith('/manifest.json'))).toBe(false);
    destination.put.mockClear();
    await expect(createObjectRecoverySet(input(source.client, destination.client))).rejects.toThrow(/partial/i);
    expect(destination.put).not.toHaveBeenCalled();
  });

  it.each(['same-size corruption', 'short stream', 'changed revision', 'missing revision', 'duplicate inventory', 'changed inventory'])(
    'rejects %s before committing a completion manifest', async failure => {
      const source = memory({ file: 'abc' }); const destination = memory();
      if (failure === 'same-size corruption') {
        const original = destination.get.getMockImplementation()!;
        destination.get.mockImplementation(async (key, revision) => ({ ...await original(key, revision), body: Readable.from(['xyz']) }));
      }
      if (failure === 'short stream') {
        const original = source.get.getMockImplementation()!;
        source.get.mockImplementation(async (key, revision) => ({ ...await original(key, revision), body: Readable.from(['a']) }));
      }
      if (failure === 'changed revision') source.get.mockImplementation(async () => { throw new Error('412'); });
      if (failure === 'missing revision') source.list.mockResolvedValue([{ key: 'file', size: 3 }] as never);
      if (failure === 'duplicate inventory') source.list.mockResolvedValue([{ key: 'file', size: 3, revision: { etag: '1' } }, { key: 'file', size: 3, revision: { etag: '1' } }]);
      if (failure === 'changed inventory') source.list.mockResolvedValueOnce([{ key: 'file', size: 3, revision: { etag: '"file-1"' } }])
        .mockResolvedValue([{ key: 'file', size: 3, revision: { etag: 'new' } }]);
      await expect(createObjectRecoverySet(input(source.client, destination.client))).rejects.toThrow();
      expect([...destination.objects.keys()].some(key => key.endsWith('/manifest.json'))).toBe(false);
      expect(source.put).not.toHaveBeenCalled();
    });

  it.each([{ maxObjects: 1 }, { maxObjectBytes: 2 }, { maxTotalBytes: 5 }])('enforces inventory and byte limits before copies: %j', bound => {
    const source = memory({ a: 'abc', b: 'def' }); const destination = memory();
    return expect(createObjectRecoverySet({ ...input(source.client, destination.client), limits: { ...limits, ...bound } }))
      .rejects.toThrow(/limit/i).then(() => expect(destination.put).not.toHaveBeenCalled());
  });

  it('rejects source/destination aliasing and invalid execution identifiers before writing', async () => {
    const source = memory({ a: 'abc' }); const destination = memory();
    await expect(createObjectRecoverySet({ ...input(source.client, destination.client), destinationIdentity: identity('source') })).rejects.toThrow(/distinct/i);
    await expect(createObjectRecoverySet(input(source.client, destination.client, '../other'))).rejects.toThrow();
    expect(destination.put).not.toHaveBeenCalled();
  });

  it('restores all bytes and metadata into a fresh isolated target then independently verifies them', async () => {
    const source = memory({ 'file.txt': 'abc' }); const backup = memory(); const target = memory();
    const completed = await createObjectRecoverySet(input(source.client, backup.client));
    const restored = await restoreObjectRecoverySet({ backup: backup.client, target: target.client,
      manifest: completed.manifest, targetIdentity: identity('restore'), restoreId: 'drill-001', limits });
    expect(restored).toMatchObject({ setId: 'set-001', objectCount: 1, totalBytes: '3', contentVerified: true, restoreVerified: true });
    const entry = [...target.objects.values()][0];
    expect(entry.bytes.toString()).toBe('abc'); expect(entry.metadata).toEqual({ purpose: 'source' });
    expect(source.put).not.toHaveBeenCalled(); expect(backup.remove).not.toHaveBeenCalled();
  });

  it('keeps production streaming ahead by bounded chunks instead of buffering an object', async () => {
    const chunk = Buffer.alloc(32 * 1024, 7); const chunkCount = 512; const size = chunk.length * chunkCount;
    let produced = 0; let consumed = 0; let maxAhead = 0;
    const body = (track = false) => Readable.from((async function* () {
      for (let index = 0; index < chunkCount; index++) {
        if (track) { produced++; maxAhead = Math.max(maxAhead, produced - consumed); }
        yield chunk;
      }
    })());
    const source: StorageObjectClient = { list: async () => [{ key: 'large', size, revision: { etag: 'large-1' } }],
      get: async () => ({ body: body(true), size, revision: { etag: 'large-1' } }),
      put: async () => { throw new Error('Source must stay read-only'); }, destroy() {} };
    const manifests = memory(); let savedKey: string | undefined;
    const destination: StorageObjectClient = { list: async () => [
      ...(savedKey ? [{ key: savedKey, size, revision: { etag: 'saved' } }] : []), ...await manifests.client.list(),
    ], get: async key => key === savedKey ? { body: body(), size } : manifests.client.get(key),
      put: async (key, payload, options) => {
        if (key.endsWith('/manifest.json')) return manifests.client.put(key, payload, options);
        for await (const bytes of payload.body as Readable) { consumed += Buffer.byteLength(bytes) / chunk.length; await setImmediate(); }
        savedKey = key;
      }, destroy() {} };
    await createObjectRecoverySet({ ...input(source, destination), limits: { ...limits, maxObjectBytes: size, maxTotalBytes: size } });
    expect(produced).toBe(chunkCount); expect(consumed).toBe(chunkCount); expect(maxAhead).toBeLessThanOrEqual(16);
  });

  it('retains seven completed sets and the latest verified restore; deletion plans contain only exact owned keys', async () => {
    const source = memory({ file: 'abc' }); const destination = memory(); const completed: VerifiedObjectRecoverySet[] = [];
    for (let index = 0; index < 9; index++) completed.push(await createObjectRecoverySet({
      ...input(source.client, destination.client, `set-${index}`), createdAt: `2026-09-${String(10 + index).padStart(2, '0')}T03:17:00.000Z`,
    }));
    const plan = planObjectRecoveryRetention({ completed, retainCompleted: 7, latestVerifiedRestoreSetId: 'set-0' });
    expect(plan.map(set => set.setId)).toEqual(['set-1']);
    expect(plan[0].keys).toEqual([...completed[1].manifest.entries.map(entry => entry.backupKey), expect.stringMatching(/\/manifest\.json$/)]);
    expect(destination.remove).not.toHaveBeenCalled();
    const unverified = structuredClone(completed); unverified[8].receipt.contentVerified = false as never;
    expect(() => planObjectRecoveryRetention({ completed: unverified, retainCompleted: 7 })).toThrow(/verified/i);
    expect(() => planObjectRecoveryRetention({ completed, retainCompleted: 7, latestVerifiedRestoreSetId: 'unobserved' })).toThrow(/restore/i);
  });
});
