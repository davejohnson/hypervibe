import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createS3ObjectClient } from '../object-storage-transfer.service.js';

// Official wire contracts: API_GetObject.html (If-Match/versionId),
// API_PutObject.html (If-None-Match:*), API_ListObjectsV2.html (ETag/LastModified),
// API_DeleteObject.html (If-Match). Railway documents S3 compatibility at
// https://docs.railway.com/storage-buckets; this is synthetic wire evidence,
// not certification that a Railway account supports every conditional header.
describe('S3-compatible recovery stream wire boundary', () => {
  async function fixture(provider: string) {
    const requests: Array<{ method: string; url: string; headers: Record<string, unknown> }> = [];
    const handler = { async handle(request: { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body?: unknown }) {
      const url = request.path + '?' + new URLSearchParams(request.query).toString();
      requests.push({ method: request.method, url, headers: request.headers });
      if (request.body && typeof request.body === 'object' && Symbol.asyncIterator in request.body) {
        for await (const _chunk of request.body as AsyncIterable<unknown>) { /* Drain SDK-serialized body. */ }
      }
      const response = (statusCode: number, body: string, headers: Record<string, string> = {}) => ({ response: {
        statusCode, headers, body: Readable.from([body]),
      } });
      if (request.query['list-type'] === '2') return response(200,
        '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>folder/file</Key><Size>3</Size><ETag>"rev-1"</ETag><LastModified>2026-09-30T00:00:00.000Z</LastModified></Contents></ListBucketResult>', { 'content-type': 'application/xml' });
      if (request.method === 'GET') {
        if (request.headers['if-match'] === '"stale"') return response(412, '<Error><Code>PreconditionFailed</Code></Error>');
        return response(200, 'abc', { etag: '"rev-1"', 'last-modified': 'Wed, 30 Sep 2026 00:00:00 GMT', 'x-amz-version-id': 'version-1', 'content-length': '3' });
      }
      return response(request.method === 'DELETE' ? 204 : 200, '', { etag: '"new"' });
    } };
    const client = createS3ObjectClient({ bucket: `${provider}-bucket`, endpoint: 'https://object-contract.invalid', region: 'us-east-1',
      accessKeyId: 'contract-id', secretAccessKey: 'contract-secret', urlStyle: 'path' }, { requestHandler: handler as never });
    return { client, requests };
  }

  it.each(['s3', 'railway'])('%s serializes exact revisions and create-only writes through the real SDK', async provider => {
    const { client, requests } = await fixture(provider);
    try {
      const listed = await client.list({ prefix: 'folder/' });
      expect(listed).toEqual([{ key: 'folder/file', size: 3, revision: { etag: '"rev-1"', lastModified: '2026-09-30T00:00:00.000Z' } }]);
      expect(requests[0].url).toContain('prefix=folder%2F');
      const object = await client.get('folder/file', { etag: '"rev-1"', versionId: 'version-1' });
      for await (const _chunk of object.body as Readable) { /* Drain. */ }
      expect(object.revision).toMatchObject({ etag: '"rev-1"', versionId: 'version-1' });
      expect(requests[1]).toMatchObject({ headers: { 'if-match': '"rev-1"' } }); expect(requests[1].url).toContain('versionId=version-1');
      await expect(client.get('folder/file', { etag: '"stale"' })).rejects.toThrow();
      await client.put('recovery/object', { body: Readable.from(['abc']), size: 3 }, { ifAbsent: true });
      expect(requests.at(-1)).toMatchObject({ method: 'PUT', headers: { 'if-none-match': '*' } });
      await client.remove!('recovery/object', { etag: '"new"' });
      expect(requests.at(-1)).toMatchObject({ method: 'DELETE', headers: { 'if-match': '"new"' } });
    } finally { client.destroy(); }
  });
});
