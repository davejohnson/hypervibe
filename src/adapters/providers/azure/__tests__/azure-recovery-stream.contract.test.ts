import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { IHttpClient } from '@azure/storage-blob';
import { AzureBlobStorageAdapter } from '../azure-blob.adapter.js';

// Official REST contracts: /rest/api/storageservices/list-blobs,
// /get-blob, /put-block-list, /delete-blob and /specifying-conditional-headers-for-blob-service-operations.
describe('Azure recovery stream SDK HTTP boundary', () => {
  it('pins blob revisions and applies conditional commit/deletion through the real SDK', async () => {
    const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const transport: IHttpClient = { async sendRequest(request) {
      requests.push({ method: request.method, url: request.url,
        headers: Object.fromEntries(Object.entries(request.headers.rawHeaders()).map(([key, value]) => [key.toLowerCase(), value])) });
      const headers = request.headers.clone();
      const url = new URL(request.url);
      if (url.searchParams.get('comp') === 'list') {
        headers.set('content-type', 'application/xml');
        return { request, status: 200, headers, bodyAsText: '<EnumerationResults ServiceEndpoint="https://testaccount.blob.core.windows.net" ContainerName="documents"><Blobs><Blob><Name>file.txt</Name><Properties><Content-Length>3</Content-Length><BlobType>BlockBlob</BlobType><Etag>"revision-1"</Etag><Last-Modified>Wed, 30 Sep 2026 00:00:00 GMT</Last-Modified></Properties></Blob></Blobs><NextMarker /></EnumerationResults>' };
      }
      if (request.method === 'GET') {
        if (request.headers.get('if-match') === '"stale"') { headers.set('content-type', 'application/xml'); return { request, status: 412, headers, bodyAsText: '<Error><Code>ConditionNotMet</Code><Message>Condition not met</Message></Error>' }; }
        headers.set('etag', '"revision-1"'); headers.set('content-length', '3'); headers.set('x-ms-version-id', 'version-1');
        headers.set('last-modified', 'Wed, 30 Sep 2026 00:00:00 GMT');
        return { request, status: 200, headers, readableStreamBody: Readable.from(['abc']) };
      }
      const body = typeof request.body === 'function' ? request.body() : request.body;
      if (body && typeof body === 'object' && Symbol.asyncIterator in body) for await (const _chunk of body as AsyncIterable<unknown>) { /* Drain. */ }
      headers.set('etag', '"written"');
      return { request, status: request.method === 'DELETE' ? 202 : 201, headers };
    } };
    const subscriptionId = '22222222-2222-4222-8222-222222222222';
    const account = { id: `/subscriptions/${subscriptionId}/resourceGroups/group/providers/Microsoft.Storage/storageAccounts/testaccount`, name: 'testaccount', location: 'westus2' };
    const adapter = new AzureBlobStorageAdapter({ storageHttpClient: transport, controlPlaneFactory: () => ({
      getAccount: async () => account, listKeys: async () => Buffer.from('contract-account-key').toString('base64'),
    } as never) });
    await adapter.connect({ tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId,
      clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'contract-secret' });
    const client = await adapter.openObjectTransfer({ id: 'env', projectId: 'project', name: 'production', platformBindings: {}, createdAt: new Date(), updatedAt: new Date() },
      { subscriptionId, resourceGroup: 'group' }, `${account.id}/blobServices/default/containers/documents`);
    const listed = await client.list({ prefix: 'file' });
    expect(listed).toEqual([{ key: 'file.txt', size: 3, revision: { etag: '"revision-1"', lastModified: '2026-09-30T00:00:00.000Z' } }]);
    expect(requests[0].url).toContain('prefix=file');
    const object = await client.get('file.txt', { etag: '"revision-1"', versionId: 'version-1' });
    for await (const _chunk of object.body as Readable) { /* Drain. */ }
    expect(object.revision).toMatchObject({ etag: '"revision-1"', versionId: 'version-1' });
    expect(requests[1].headers['if-match']).toBe('"revision-1"'); expect(requests[1].url).toContain('versionid=version-1');
    await expect(client.get('file.txt', { etag: '"stale"' })).rejects.toThrow();
    await client.put('recovery/object', { body: Readable.from(['abc']), size: 3 }, { ifAbsent: true });
    expect(requests.find(request => request.url.includes('comp=blocklist'))?.headers['if-none-match']).toBe('*');
    await client.remove!('recovery/object', { etag: '"written"' });
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', headers: { 'if-match': '"written"' } });
  });
});
