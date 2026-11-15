import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StorageObjectClient, StorageObjectPayload } from '../ports/storage.port.js';
import type { ObjectRecoveryIdentity } from './object-recovery-set.service.js';

/** An owned scratch target, never a caller-selected path or application mount. */
export async function createLocalRecoveryStore(): Promise<{
  client: StorageObjectClient; identity: ObjectRecoveryIdentity; cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'hv-file-restore-'));
  let byteLimit: number;
  try {
    const available = await statfs(directory);
    byteLimit = Math.floor(available.bavail * available.bsize * 0.8);
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 0) throw new Error('Restore scratch capacity is unknown.');
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
  let reservedBytes = 0;
  const entries = new Map<string, { path: string; properties: Omit<StorageObjectPayload, 'body'> }>();
  let closed = false;
  const open = () => { if (closed) throw new Error('Restore target is closed.'); };
  const client: StorageObjectClient = {
    async list(options) { open(); return [...entries].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .map(([key, entry]) => ({ key, size: entry.properties.size, revision: entry.properties.revision })); },
    async get(key, expected) {
      open(); const entry = entries.get(key);
      if (!entry || (expected?.etag && expected.etag !== entry.properties.revision?.etag)) throw new Error('Restore object is absent or changed.');
      return { ...entry.properties, body: createReadStream(entry.path) };
    },
    async put(key, payload, options) {
      open(); if (!options?.ifAbsent || entries.has(key)) throw new Error('Restore targets accept only new immutable objects.');
      if (!Number.isSafeInteger(payload.size) || payload.size < 0 || reservedBytes + payload.size > byteLimit) throw new Error('Restore target has insufficient bounded scratch space.');
      reservedBytes += payload.size;
      // Source keys are opaque data, never local paths.
      const path = join(directory, createHash('sha256').update(key).digest('hex'));
      const hash = createHash('sha256'); let bytes = 0;
      const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > payload.size) { callback(new Error('Restore object exceeds its declared size.')); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      const body = payload.body instanceof Readable ? payload.body : Readable.fromWeb(
        (payload.body instanceof Blob ? payload.body.stream() : payload.body) as import('node:stream/web').ReadableStream);
      await pipeline(body, counter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      if (bytes !== payload.size) throw new Error('Restore object is truncated.');
      const { body: _body, revision: _revision, ...properties } = payload;
      entries.set(key, { path, properties: { ...properties, revision: { etag: hash.digest('hex') } } });
    },
    destroy() { closed = true; },
  };
  return { client, identity: { provider: 'hypervibe-local-restore', externalId: randomUUID(), instanceScope: { execution: randomUUID() } },
    async cleanup() {
      closed = true;
      await rm(directory, { recursive: true });
      try { await stat(directory); throw new Error('Restore target remains.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } };
}
