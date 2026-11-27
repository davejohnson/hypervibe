import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageObjectClient, StorageObjectPayload, StorageObjectRevision } from '../../ports/storage.port.js';
import { observeDailyBucketBackups, runDailyBucketBackup } from '../daily-bucket-backup.service.js';
import { enrolledBucketClients, enrollmentKey } from '../bucket-backup-enrollment.js';

type Stored = { bytes: Buffer; revision: { etag: string; lastModified?: string; versionId?: string }; props?: Pick<StorageObjectPayload, 'contentType' | 'metadata'> };
function store(initial: Record<string, string> = {}) {
  let version = 0;
  const records = new Map<string, Stored>();
  const insert = (key: string, bytes: Buffer, props?: Stored['props']) => records.set(key, { bytes, revision: { etag: String(++version) }, props });
  for (const [key, value] of Object.entries(initial)) insert(key, Buffer.from(value), { contentType: 'text/plain', metadata: { label: 'original' } });
  const list = vi.fn(async (options?: { prefix?: string; maxObjects?: number }) => [...records].filter(([key]) => key.startsWith(options?.prefix ?? ''))
    .map(([key, object]) => ({ key, size: object.bytes.length, revision: object.revision })));
  const get = vi.fn(async (key: string, revision?: StorageObjectRevision) => {
    const object = records.get(key);
    if (!object || (revision && revision.etag !== object.revision.etag)) throw new Error('Missing or changed object.');
    return { ...object.props, size: object.bytes.length, body: Readable.from([object.bytes]), revision: object.revision };
  });
  const put = vi.fn(async (key: string, object: StorageObjectPayload, condition?: { ifAbsent?: boolean }) => {
    const chunks = [];
    for await (const chunk of object.body as Readable) chunks.push(Buffer.from(chunk));
    if (!condition?.ifAbsent || records.has(key)) throw new Error('Create-only write failed.');
    insert(key, Buffer.concat(chunks), { contentType: object.contentType, metadata: object.metadata });
  });
  const remove = vi.fn(async (key: string, revision?: StorageObjectRevision) => {
    if (!revision?.etag || records.get(key)?.revision.etag !== revision.etag) throw new Error('Conditional delete failed.');
    records.delete(key);
  });
  return { records, insert, get, put, remove, list, client: { list, get, put, remove, destroy() {} } satisfies StorageObjectClient };
}
const identity = (name: string) => ({ provider: 'gcs', externalId: name, instanceScope: { projectId: 'example' } });
function setup() {
  const source = store({ 'folder/document.pdf': 'original' }), archive = store();
  const input = { source: source.client, archive: archive.client, sourceIdentity: identity('source'), destinationIdentity: identity('archive') };
  const day = (day: number) => vi.setSystemTime(new Date(Date.UTC(2026, 10, day, 4)));
  vi.useFakeTimers({ toFake: ['Date'] }); day(1);
  return { source, archive, input, day };
}
afterEach(() => vi.useRealTimers());

describe('once-daily independent bucket recovery points', () => {
  it.each(['s3', 'azureblob'])('rejects a copied enrollment marker on the same named %s source and archive before observing or retiring any originals', async provider => {
    const { source, archive, input, day } = setup();
    const id = '01234567-89ab-cdef-0123-456789abcdef', key = enrollmentKey(id);
    const original = { etag: '"same-content"', lastModified: '2026-10-31T00:00:00.000Z' };
    const witness = { source: original, archive: original };
    const marker = { bytes: Buffer.from(id), revision: original };
    source.records.set(key, marker); archive.records.set(key, marker);
    const enrolled = () => enrolledBucketClients({ ...input, sourceIdentity: { ...input.sourceIdentity, provider },
      destinationIdentity: { ...input.destinationIdentity, provider } }, id, witness);
    const opened = await enrolled();
    for (let n = 1; n <= 7; n++) { day(n); await runDailyBucketBackup(opened); }
    const originals = new Map(archive.records);
    const copied = { bytes: Buffer.from(id), revision: { etag: provider === 's3' ? original.etag : '"new-azure-etag"', lastModified: '2026-11-08T00:00:00.000Z' } };
    source.records.clear(); source.records.set(key, copied);
    for (let n = 8; n <= 15; n++) {
      day(n);
      await expect(enrolled().then(runDailyBucketBackup)).rejects.toThrow();
      await expect(runDailyBucketBackup(opened)).rejects.toThrow();
    }
    await expect(enrolled().then(observeDailyBucketBackups)).rejects.toThrow();
    await expect(observeDailyBucketBackups(opened)).rejects.toThrow();
    expect(archive.records).toEqual(originals);
    source.records.set(key, marker); archive.records.set(key, copied);
    await expect(enrolled().then(runDailyBucketBackup)).rejects.toThrow();
    await expect(runDailyBucketBackup(opened)).rejects.toThrow();
    await expect(observeDailyBucketBackups(opened)).rejects.toThrow();
    expect(archive.remove).not.toHaveBeenCalled();
  });
  it.each(['s3', 'azureblob'])('keeps all seven copies when a %s source or archive is recreated under its old name', async provider => {
    const { source, archive, input, day } = setup();
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const key = enrollmentKey(id);
    const markers = { source: { etag: 'source', lastModified: '2026-10-31T00:00:00.000Z' }, archive: { etag: 'archive', lastModified: '2026-10-31T00:00:00.000Z' } };
    source.records.set(key, { bytes: Buffer.from(id), revision: markers.source }); archive.records.set(key, { bytes: Buffer.from(id), revision: markers.archive });
    const clients = { ...input, sourceIdentity: { ...input.sourceIdentity, provider }, destinationIdentity: { ...input.destinationIdentity, provider } };
    for (let n = 1; n <= 7; n++) {
      day(n); await runDailyBucketBackup(await enrolledBucketClients(clients, id, markers));
    }
    const kept = await observeDailyBucketBackups(await enrolledBucketClients(clients, id, markers));
    expect(kept.points.map(point => point.objectCount)).toEqual(Array(7).fill(1));
    const before = new Map(archive.records);
    const replacement = store();
    for (let n = 8; n <= 15; n++) {
      day(n);
      await expect(enrolledBucketClients({ ...clients, source: replacement.client }, id, markers).then(runDailyBucketBackup)).rejects.toThrow();
      await expect(enrolledBucketClients({ ...clients, archive: replacement.client }, id, markers).then(runDailyBucketBackup)).rejects.toThrow();
    }
    expect(archive.records).toEqual(before);
    expect(replacement.records.size).toBe(0);
  });
  it('stops before retention when a copy replaces a versioned marker after publication, even with the same ETag and timestamp', async () => {
    const { source, archive, input, day } = setup();
    const id = '8c617752-a37c-4375-b08b-64bb955f6a12', key = enrollmentKey(id);
    const revision = { etag: 'same-etag', lastModified: '2026-10-31T00:00:00.000Z', versionId: 'original' };
    const original = { bytes: Buffer.from(id), revision };
    source.records.set(key, original); archive.records.set(key, original);
    const bound = await enrolledBucketClients(input, id, { source: revision, archive: revision });
    for (let n = 1; n <= 7; n++) { day(n); await runDailyBucketBackup(bound); }
    const manifests = (await observeDailyBucketBackups(bound)).points.map(point => point.manifestKey);
    const put = archive.put.getMockImplementation()!;
    archive.put.mockImplementation(async (keyToWrite, payload, condition) => {
      await put(keyToWrite, payload, condition);
      if (keyToWrite.includes('/points/')) archive.records.set(key, { bytes: Buffer.from(id), revision: { ...revision, versionId: 'copied' } });
    });
    day(8);
    await expect(runDailyBucketBackup(bound)).rejects.toThrow(/marker/);
    expect(manifests.every(manifest => archive.records.has(manifest))).toBe(true);
    expect(archive.remove).not.toHaveBeenCalled();
  });
  it('publishes one checked point per UTC date and preserves previous bytes, names and metadata through source deletion', async () => {
    const { source, archive, input, day } = setup();
    await runDailyBucketBackup(input);
    const { points: [first] } = await observeDailyBucketBackups(input);
    const manifest = JSON.parse(archive.records.get(first.manifestKey)!.bytes.toString());
    expect(manifest.entries[0]).toMatchObject({ key: 'folder/document.pdf', metadata: { label: 'original' }, http: { contentType: 'text/plain' } });
    const retained = archive.records.get(manifest.entries[0].backupKey)!;
    expect(retained.bytes.toString()).toBe('original');
    expect(first).toMatchObject({ date: '2026-11-01', objectCount: 1, totalBytes: '8' });
    const writes = archive.put.mock.calls.length;
    source.records.clear();
    await runDailyBucketBackup(input);
    expect(archive.put.mock.calls.length).toBe(writes);
    day(2); await runDailyBucketBackup(input);
    expect((await observeDailyBucketBackups(input)).points.map(point => point.objectCount)).toEqual([0, 1]);
    expect(archive.records.get(manifest.entries[0].backupKey)).toBe(retained);
    expect(source.remove).not.toHaveBeenCalled();
  });

  it('never counts an interrupted copy, retries only a known completed copy, and keeps seven successful dates', async () => {
    const { source, archive, input, day } = setup();
    for (let n = 1; n <= 7; n++) { day(n); await runDailyBucketBackup(input); }
    const previous = (await observeDailyBucketBackups(input)).points;
    day(8);
    const get = source.get.getMockImplementation()!;
    source.insert('z-second-file', Buffer.from('also private'));
    source.get.mockImplementationOnce(get).mockRejectedValueOnce(new Error('source read failed'));
    await expect(runDailyBucketBackup(input)).rejects.toThrow();
    source.get.mockImplementation(get);
    expect([...archive.records.keys()].some(key => key.includes('daily-2026-11-08-') && key.includes('/objects/'))).toBe(true);
    await expect(runDailyBucketBackup(input)).rejects.toThrow();
    expect((await observeDailyBucketBackups(input)).points).toEqual(previous);
    expect(archive.remove).not.toHaveBeenCalled();
    day(9); await runDailyBucketBackup(input);
    const { points } = await observeDailyBucketBackups(input);
    expect(points.map(point => point.date)).toEqual(['09','07','06','05','04','03','02'].map(n => '2026-11-' + n));
    expect(archive.records.has(previous[6].manifestKey)).toBe(false);
    expect(archive.remove.mock.calls.every(([, rev]) => Boolean(rev?.etag))).toBe(true);
  });

  it('reconciles a lost completion acknowledgement without copying source data a second time', async () => {
    const { archive, source, input } = setup();
    const put = archive.put.getMockImplementation()!;
    archive.put.mockImplementation(async (key, payload, condition) => {
      await put(key, payload, condition);
      if (key.endsWith('/manifest.json')) throw new Error('Acknowledgement lost.');
    });
    await expect(runDailyBucketBackup(input)).rejects.toThrow();
    expect((await observeDailyBucketBackups(input)).points).toHaveLength(0);
    archive.put.mockImplementation(put);
    source.records.clear(); source.get.mockClear();
    const { point } = await runDailyBucketBackup(input);
    expect(point.objectCount).toBe(1);
    expect(source.get).not.toHaveBeenCalled();
    expect((await observeDailyBucketBackups(input)).points).toEqual([point]);
  });

  it('permits a single immutable copy when two executions start on the same date', async () => {
    const { source, input } = setup();
    const attempts = await Promise.allSettled([runDailyBucketBackup(input), runDailyBucketBackup(input)]);
    expect(attempts.some(attempt => attempt.status === 'fulfilled')).toBe(true);
    expect((await observeDailyBucketBackups(input)).points).toHaveLength(1);
    expect(source.get).toHaveBeenCalledTimes(1);
  });

  it('clears abandoned object bytes and reservations across repeated interrupted dates as well as successful dates', async () => {
    const { source, archive, input, day } = setup();
    source.insert('z-last-file', Buffer.from('last'));
    const get = source.get.getMockImplementation()!;
    for (let n = 1; n <= 8; n++) {
      day(n);
      source.get.mockImplementationOnce(get).mockRejectedValueOnce(new Error('second object failed'));
      await expect(runDailyBucketBackup(input)).rejects.toThrow();
    }
    const objectKeys = () => [...archive.records.keys()].filter(key => key.includes('/objects/'));
    // Repeated failures may leave the current attempt. Each following daily run
    // must reconcile earlier attempts, even when its own source copy will fail.
    expect(objectKeys().length).toBeLessThanOrEqual(2);
    for (let n = 9; n <= 16; n++) { day(n); await runDailyBucketBackup(input); }
    const { points } = await observeDailyBucketBackups(input);
    expect(points).toHaveLength(7);
    expect(objectKeys()).toHaveLength(14);
    expect([...archive.records.keys()].filter(key => key.includes('/runs/'))).toHaveLength(7);
  });

  it('recovers a complete prior-day manifest after a crash before its point was published', async () => {
    const { archive, input, source, day } = setup();
    const put = archive.put.getMockImplementation()!;
    archive.put.mockImplementation(async (key, payload, condition) => {
      if (key.includes('/points/')) throw new Error('Process stopped before publication.');
      return put(key, payload, condition);
    });
    await expect(runDailyBucketBackup(input)).rejects.toThrow();
    source.records.clear(); archive.put.mockImplementation(put); day(2);
    await runDailyBucketBackup(input);
    expect((await observeDailyBucketBackups(input)).points.map(point => point.objectCount)).toEqual([0, 1]);
  });

  it.each(['unchanged', 'same bytes', 'different bytes'])('retains an unacknowledged upload without its original revision (%s)', async replacement => {
    const { archive, input, source, day } = setup();
    const put = archive.put.getMockImplementation()!;
    archive.put.mockImplementation(async (key, payload, condition) => {
      await put(key, payload, condition);
      if (key.includes('/objects/')) throw new Error('Connection lost after commit.');
    });
    await expect(runDailyBucketBackup(input)).rejects.toThrow();
    const key = [...archive.records.keys()].find(key => key.includes('/objects/'))!;
    const original = archive.records.get(key)!;
    if (replacement === 'same bytes') archive.insert(key, original.bytes, original.props);
    if (replacement === 'different bytes') archive.insert(key, Buffer.alloc(original.bytes.length, 'x'), original.props);
    const retainedRevision = archive.records.get(key)!.revision;
    source.records.clear(); archive.put.mockImplementation(put); day(2);
    const result = await runDailyBucketBackup(input);
    expect(result.unverifiedPartials?.objects).toBe(1);
    expect(archive.records.get(key)?.revision).toEqual(retainedRevision);
  });

  it('keeps foreign data and a same-byte replacement with a changed native revision, and reports both without names', async () => {
    const { source, archive, input, day } = setup();
    source.insert('z-last', Buffer.from('late'));
    source.get.mockImplementationOnce(source.get.getMockImplementation()!).mockRejectedValueOnce(new Error('Interrupted after first object.'));
    await expect(runDailyBucketBackup(input)).rejects.toThrow();
    const key = [...archive.records.keys()].find(key => key.includes('/objects/'))!;
    const object = archive.records.get(key)!;
    archive.insert(key, object.bytes, object.props);
    const foreign = key.slice(0, key.lastIndexOf('/') + 1) + 'unrecognized-private-name';
    archive.insert(foreign, Buffer.from('foreign'));
    day(2);
    const result = await runDailyBucketBackup(input);
    expect(result.unverifiedPartials).toEqual({ dates: 1, objects: 2, bytes: '15' });
    expect(archive.records.has(key)).toBe(true); expect(archive.records.has(foreign)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('unrecognized-private-name');
  });

  it('bounds unresolved partial bytes before admitting more data without touching earlier completed sets', async () => {
    const { source, archive, input, day } = setup();
    await runDailyBucketBackup(input);
    const earlier = (await observeDailyBucketBackups(input)).points;
    day(2); source.insert('z-last', Buffer.from('late'));
    source.get.mockImplementationOnce(source.get.getMockImplementation()!).mockRejectedValueOnce(new Error('Interrupted.'));
    await expect(runDailyBucketBackup(input)).rejects.toThrow();
    const own = [...archive.records.keys()].find(key => key.includes('daily-2026-11-02-') && key.includes('/objects/'))!;
    const foreign = own.slice(0, own.lastIndexOf('/') + 1) + 'private-file';
    archive.insert(foreign, Buffer.from('unverified'));
    const list = archive.list.getMockImplementation()!;
    archive.list.mockImplementation(async opts => (await list(opts)).map(row => row.key === foreign ? { ...row, size: 100 * 1024 ** 3 } : row));
    day(3); source.get.mockClear();
    await expect(runDailyBucketBackup(input)).rejects.toThrow('1 dates, 1 objects, 107374182400 bytes');
    expect(source.get).not.toHaveBeenCalled();
    expect(archive.records.has(foreign)).toBe(true);
    expect((await observeDailyBucketBackups(input)).points).toEqual(earlier);
  });

  it('fences a delayed manifest at the same immutable key before pruning its partial objects', async () => {
    const { source, archive, input, day } = setup();
    const put = archive.put.getMockImplementation()!;
    let notify!: () => void, release!: () => void, paused = false;
    const publishing = new Promise<void>(resolve => { notify = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    archive.put.mockImplementation(async (key, payload, condition) => {
      if (key.endsWith('/manifest.json') && !paused) { paused = true; notify(); await gate; }
      return put(key, payload, condition);
    });
    const previous = runDailyBucketBackup(input);
    await publishing;
    day(2); source.records.clear();
    await runDailyBucketBackup(input);
    release();
    await expect(previous).rejects.toThrow(/Create-only/);
    expect((await observeDailyBucketBackups(input)).points.map(point => point.date)).toEqual(['2026-11-02']);
    expect([...archive.records.keys()].some(key => key.includes('/objects/'))).toBe(false);
  });

  it('rechecks both enrolled containers before deleting partials, then resumes a lost conditional-delete acknowledgement', async () => {
    const { source, archive, input, day } = setup();
    const id = '327d3a65-372f-49f3-9d97-aa6948eaa288', key = enrollmentKey(id);
    const revision = { etag: 'original', lastModified: '2026-10-31T00:00:00.000Z' };
    const marker = { bytes: Buffer.from(id), revision };
    source.records.set(key, marker); archive.records.set(key, marker);
    const bound = await enrolledBucketClients(input, id, { source: revision, archive: revision });
    source.insert('z-last', Buffer.from('late'));
    const get = source.get.getMockImplementation()!;
    source.get.mockImplementation(async (key, revision) => {
      if (key === 'z-last') throw new Error('Interrupted.');
      return get(key, revision);
    });
    await expect(runDailyBucketBackup(bound)).rejects.toThrow();
    source.get.mockImplementation(get);
    day(2); source.records.delete(key);
    await expect(runDailyBucketBackup(bound)).rejects.toThrow();
    source.records.set(key, marker); archive.records.delete(key);
    await expect(runDailyBucketBackup(bound)).rejects.toThrow();
    expect(archive.remove).not.toHaveBeenCalled();
    archive.records.set(key, marker);
    const remove = archive.remove.getMockImplementation()!;
    archive.remove.mockImplementationOnce(async (key, revision) => { await remove(key, revision); throw new Error('Delete acknowledgement lost.'); });
    await expect(runDailyBucketBackup(bound)).rejects.toThrow();
    const result = await runDailyBucketBackup(bound);
    expect(result.point.objectCount).toBe(2);
    expect(result).not.toHaveProperty('unverifiedPartials');
  });

  it('blocks health and deletion when a same-length retained object changes revision', async () => {
    const { archive, input, day } = setup();
    for (let n = 1; n <= 7; n++) { day(n); await runDailyBucketBackup(input); }
    const first = (await observeDailyBucketBackups(input)).points[6];
    const { entries } = JSON.parse(archive.records.get(first.manifestKey)!.bytes.toString());
    archive.insert(entries[0].backupKey, Buffer.from('replaced'));
    await expect(observeDailyBucketBackups(input)).rejects.toThrow();
    day(8); await expect(runDailyBucketBackup(input)).rejects.toThrow();
    expect(archive.remove).not.toHaveBeenCalled();
  });

  it('resumes interrupted retention using witnessed exact revisions and leaves the seven newer sets readable', async () => {
    const { archive, input, day } = setup();
    for (let n = 1; n <= 7; n++) { day(n); await runDailyBucketBackup(input); }
    const oldest = (await observeDailyBucketBackups(input)).points[6];
    const realRemove = archive.remove.getMockImplementation()!;
    archive.remove.mockImplementationOnce(realRemove).mockRejectedValueOnce(new Error('lost network'));
    day(8); await expect(runDailyBucketBackup(input)).rejects.toThrow();
    expect((await observeDailyBucketBackups(input)).points).toHaveLength(7);
    await runDailyBucketBackup(input);
    expect(archive.records.has(oldest.manifestKey)).toBe(false);
    expect((await observeDailyBucketBackups(input)).points).toHaveLength(7);
  });
});
