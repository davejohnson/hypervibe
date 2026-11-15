import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GcsStorageAdapter } from '../gcs.adapter.js';
const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock('node:https', () => ({ request: rawRequest }));

// Official JSON API: /storage/docs/json_api/v1/objects/get and /insert;
// /storage/docs/request-preconditions and /storage/docs/transcoding.
describe('GCS recovery stream HTTP boundary', () => {
  afterEach(() => { vi.unstubAllGlobals(); rawRequest.mockReset(); });
  it('pins generation/metageneration, preserves compressed bytes, and guards new writes/deletion', async () => {
    const bytes = gzipSync(Buffer.from('unchanged stored bytes'));
    const metadata = { name: 'file.gz', size: String(bytes.length), generation: '42', metageneration: '7',
      contentType: 'application/octet-stream', contentEncoding: 'gzip', metadata: { source: 'original' } };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
      const url = String(raw); requests.push({ url, init });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.includes('/upload/') && init?.method === 'POST') return Response.json({ ...metadata, generation: '43', metageneration: '1' });
      if (init?.method === 'PATCH') return Response.json({ ...metadata, generation: '43', metageneration: '2' });
      if (url.includes('alt=media')) return new Response(bytes, { headers: { 'content-length': String(bytes.length), 'content-encoding': 'gzip',
        'x-goog-generation': '42', 'x-goog-metageneration': '7' } });
      if (url.includes('/o?')) return Response.json({ items: [metadata] });
      return Response.json(metadata);
    });
    const adapter = new GcsStorageAdapter({ fetch: fetch as typeof globalThis.fetch,
      tokenProvider: async () => ({ token: 'test-token', email: 'test@example.com' }) });
    await adapter.connect({ credentials: JSON.stringify({ type: 'service_account', project_id: 'test-project', client_email: 'test@example.com', private_key: 'test-key' }) });
    const client = await adapter.openObjectTransfer({ id: 'env', projectId: 'project', name: 'production', platformBindings: {}, createdAt: new Date(), updatedAt: new Date() }, { projectId: 'test-project' }, 'test-bucket');
    const listed = await client.list({ prefix: 'file' });
    expect(listed).toEqual([{ key: 'file.gz', size: bytes.length, revision: { generation: '42', metageneration: '7' } }]);
    expect(requests[0].url).toContain('prefix=file');
    const object = await client.get('file.gz', listed[0].revision);
    const chunks: Buffer[] = []; for await (const chunk of Readable.fromWeb(object.body as ReadableStream<Uint8Array>)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes); expect(object.metadata).toEqual({ source: 'original' });
    expect(requests.find(request => request.url.includes('alt=media'))).toMatchObject({
      url: expect.stringContaining('ifGenerationMatch=42'), init: { headers: expect.objectContaining({ 'Accept-Encoding': 'gzip' }) },
    });
    await client.put('owned/new', { body: Readable.from(['abc']), size: 3, metadata: { preserved: 'yes' } }, { ifAbsent: true });
    expect(requests.find(request => request.init?.method === 'POST')?.url).toContain('ifGenerationMatch=0');
    expect(requests.find(request => request.init?.method === 'PATCH')?.url).toContain('ifGenerationMatch=43');
    await client.remove!('owned/new', { generation: '43', metageneration: '2' });
    expect(requests.at(-1)?.url).toContain('ifGenerationMatch=43');
  });

  it('uses undecoded HTTPS bytes in the default media path for a stored gzip object', async () => {
    const bytes = gzipSync(Buffer.from('stored representation'));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'file.gz', size: String(bytes.length),
      generation: '42', metageneration: '7', contentEncoding: 'gzip' })));
    rawRequest.mockImplementation((_url, options, receive) => {
      expect(options.headers['accept-encoding']).toBe('gzip');
      const request = { once: vi.fn(), end() {
        receive(Object.assign(Readable.from([bytes]), { statusCode: 200, headers: { 'content-length': String(bytes.length),
          'content-encoding': 'gzip', 'x-goog-generation': '42', 'x-goog-metageneration': '7' } }));
      } };
      return request;
    });
    const adapter = new GcsStorageAdapter({ tokenProvider: async () => ({ token: 'token', email: 'test@example.com' }) });
    await adapter.connect({ credentials: JSON.stringify({ type: 'service_account', project_id: 'test-project', client_email: 'test@example.com', private_key: 'test-key' }) });
    const client = await adapter.openObjectTransfer({ id: 'env', projectId: 'project', name: 'production', platformBindings: {}, createdAt: new Date(), updatedAt: new Date() }, { projectId: 'test-project' }, 'bucket');
    const payload = await client.get('file.gz', { generation: '42', metageneration: '7' });
    const chunks: Buffer[] = []; for await (const chunk of Readable.fromWeb(payload.body as ReadableStream<Uint8Array>)) chunks.push(Buffer.from(chunk));
    expect(rawRequest).toHaveBeenCalledTimes(1); expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(payload.contentEncoding).toBe('gzip');
  });
});
