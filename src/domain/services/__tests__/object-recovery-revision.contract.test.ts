import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createS3ObjectClient } from '../object-storage-transfer.service.js';
import { createObjectRecoverySet, observeObjectRecoverySetInventory } from '../object-recovery-set.service.js';

// Synthetic state through the real pinned AWS SDK serialization/deserialization.
// Independent contracts: AWS API_ListObjectsV2.html exposes ETag/LastModified;
// API_GetObject.html exposes the same validators plus a GET-only version ID.
// Native validators identify the independently SHA256-verified retained copy;
// its size alone must not transfer that proof to replaced bytes.
const limits = { maxObjects: 10, maxObjectBytes: 4096, maxTotalBytes: 16384 };
const changedAt = '2026-09-30T00:00:00.000Z';
const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
type ObjectValue = { bytes: Buffer; etag: string; contentType: string };
const value = (text: string | Buffer, contentType = 'application/octet-stream'): ObjectValue => {
  const bytes = Buffer.from(text); return { bytes, etag: `"${createHash('sha256').update(bytes).digest('hex')}"`, contentType };
};
async function bodyBytes(body: unknown, chunked: boolean): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  if (!chunked) return bytes;
  const decoded: Buffer[] = []; let offset = 0;
  for (;;) {
    const end = bytes.indexOf('\r\n', offset), size = Number.parseInt(bytes.subarray(offset, end).toString(), 16);
    if (!Number.isSafeInteger(size) || size < 0 || end < offset) throw new Error('Invalid SDK chunk frame.');
    if (!size) return Buffer.concat(decoded);
    decoded.push(bytes.subarray(end + 2, end + 2 + size)); offset = end + 2 + size + 2;
  }
}
function fixture() {
  const buckets: Record<string, Map<string, ObjectValue>> = { source: new Map([['file', value('abc')]]), archive: new Map() };
  let replaceBeforeFinalInventory = false, readBack = false;
  const handler = { async handle(request: { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body?: unknown }) {
    const [, bucket, ...parts] = request.path.split('/'); const key = decodeURIComponent(parts.join('/')); const objects = buckets[bucket];
    const response = (statusCode: number, bytes: Buffer | string, headers: Record<string, string> = {}) => ({ response: { statusCode, headers, body: Readable.from([bytes]) } });
    if (request.query['list-type'] === '2') {
      if (bucket === 'archive' && readBack && replaceBeforeFinalInventory) {
        for (const [name] of objects) if (name.includes('/objects/')) objects.set(name, value('xyz'));
      }
      const entries = [...objects].filter(([name]) => !request.query.prefix || name.startsWith(request.query.prefix));
      return response(200, `<ListBucketResult><IsTruncated>false</IsTruncated>${entries.map(([name, object]) => `<Contents><Key>${escapeXml(name)}</Key><Size>${object.bytes.length}</Size><ETag>${escapeXml(object.etag)}</ETag><LastModified>${changedAt}</LastModified></Contents>`).join('')}</ListBucketResult>`, { 'content-type': 'application/xml' });
    }
    if (request.method === 'PUT') {
      if (request.headers['if-none-match'] === '*' && objects.has(key)) return response(412, '<Error><Code>PreconditionFailed</Code></Error>');
      objects.set(key, value(await bodyBytes(request.body, request.headers['content-encoding']?.includes('aws-chunked')), request.headers['content-type']));
      return response(200, '');
    }
    const object = objects.get(key);
    if (!object) return response(404, '<Error><Code>NoSuchKey</Code></Error>');
    if (request.headers['if-match'] && request.headers['if-match'] !== object.etag) return response(412, '<Error><Code>PreconditionFailed</Code></Error>');
    if (bucket === 'archive' && key.includes('/objects/')) readBack = true;
    return response(200, object.bytes, { etag: object.etag, 'last-modified': new Date(changedAt).toUTCString(), 'content-length': String(object.bytes.length),
      'content-type': object.contentType, 'x-amz-version-id': 'get-only-version' });
  } };
  const client = (bucket: string) => createS3ObjectClient({ bucket, region: 'us-east-1', endpoint: 'https://storage.invalid', urlStyle: 'path',
    accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, { requestHandler: handler as never });
  return { buckets, source: client('source'), destination: client('archive'), replaceDuringCopy() { replaceBeforeFinalInventory = true; } };
}
const identity = (externalId: string, provider: string) => ({ provider, externalId, instanceScope: { region: 'test' } });
describe('retained-copy revision evidence at the S3-compatible HTTP boundary', () => {
  it.each(['s3', 'railway'])('%s refuses prior restore evidence for a same-size replacement', async provider => {
    const storage = fixture();
    const input = { ...storage, sourceIdentity: identity('source', provider), destinationIdentity: identity('archive', provider), setId: 'set-1', createdAt: changedAt, limits };
    try {
      const completed = await createObjectRecoverySet(input);
      await expect(observeObjectRecoverySetInventory(input)).resolves.toHaveProperty('manifest.setId', 'set-1');
      storage.buckets.archive.set(completed.manifest.entries[0].backupKey, value('xyz'));
      await expect(observeObjectRecoverySetInventory(input)).rejects.toThrow(/revision|changed/i);
    } finally { storage.source.destroy(); storage.destination.destroy(); }
  });
  it('rejects a replacement between verified read-back and completion inventory', async () => {
    const storage = fixture(); storage.replaceDuringCopy();
    try {
      await expect(createObjectRecoverySet({ ...storage, sourceIdentity: identity('source', 's3'), destinationIdentity: identity('archive', 's3'),
        setId: 'set-1', createdAt: changedAt, limits })).rejects.toThrow(/revision|changed/i);
      expect([...storage.buckets.archive.keys()].some(key => key.endsWith('/manifest.json'))).toBe(false);
    } finally { storage.source.destroy(); storage.destination.destroy(); }
  });
});
