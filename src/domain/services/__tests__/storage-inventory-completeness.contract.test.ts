import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { IHttpClient } from '@azure/storage-blob';
import { createS3ObjectClient } from '../object-storage-transfer.service.js';
import { GcsStorageAdapter } from '../../../adapters/providers/gcp/gcs.adapter.js';
import { AzureBlobStorageAdapter } from '../../../adapters/providers/azure/azure-blob.adapter.js';

// Official listing contracts distinguish an empty collection from a malformed
// object row, and require following nonempty continuation tokens:
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
// https://cloud.google.com/storage/docs/json_api/v1/objects/list
// https://learn.microsoft.com/en-us/rest/api/storageservices/list-blobs
// These reconstructed HTTP responses exercise real SDK deserialization. They
// are counterexamples for fail-closed observation, not observed provider bugs.
const environment = { id: 'env', projectId: 'project', name: 'production', platformBindings: {}, createdAt: new Date(), updatedAt: new Date() };
function s3(xml: string) {
  return createS3ObjectClient({ bucket: 'bucket', endpoint: 'https://storage.invalid', region: 'us-east-1', accessKeyId: 'fixture', secretAccessKey: 'fixture', urlStyle: 'path' },
    { requestHandler: { handle: async () => ({ response: { statusCode: 200, headers: { 'content-type': 'application/xml' }, body: Readable.from([xml]) } }) } as never });
}
async function gcs(body: unknown) {
  const adapter = new GcsStorageAdapter({ fetch: (async () => Response.json(body)) as typeof fetch, tokenProvider: async () => ({ token: 'fixture', email: 'test@example.com' }) });
  await adapter.connect({ credentials: JSON.stringify({ type: 'service_account', project_id: 'test-project', client_email: 'test@example.com', private_key: 'fixture' }) });
  return adapter.openObjectTransfer(environment, { projectId: 'test-project' }, 'bucket');
}
async function azure(pages: string[]) {
  let requests = 0;
  const transport: IHttpClient = { async sendRequest(request) {
    const headers = request.headers.clone(); headers.set('content-type', 'application/xml');
    return { request, status: 200, headers, bodyAsText: pages[Math.min(requests++, pages.length - 1)] };
  } };
  const subscriptionId = '22222222-2222-4222-8222-222222222222';
  const account = { id: `/subscriptions/${subscriptionId}/resourceGroups/group/providers/Microsoft.Storage/storageAccounts/testaccount`, name: 'testaccount', location: 'westus2' };
  const adapter = new AzureBlobStorageAdapter({ storageHttpClient: transport, controlPlaneFactory: () => ({ getAccount: async () => account,
    listKeys: async () => Buffer.from('fixture-key').toString('base64') } as never) });
  await adapter.connect({ tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId, clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'fixture-secret' });
  const client = await adapter.openObjectTransfer(environment, { subscriptionId, resourceGroup: 'group' }, `${account.id}/blobServices/default/containers/documents`);
  return { client, requests: () => requests };
}
const blobPage = (rows = '', next = '') => `<EnumerationResults ServiceEndpoint="https://testaccount.blob.core.windows.net" ContainerName="documents"><Blobs>${rows}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`;
describe('complete provider object inventories', () => {
  it.each([
    '<ListBucketResult />',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Size>3</Size></Contents></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>zero-or-unknown</Key></Contents></ListBucketResult>',
  ])('rejects incomplete S3-compatible rows/pagination instead of inferring an empty object inventory', async xml => {
    const client = s3(xml); try { await expect(client.list()).rejects.toThrow(); } finally { client.destroy(); }
  });
  it.each([{ items: [{ size: '3', generation: '1' }] }, { items: [{ name: 'zero-or-unknown', generation: '1' }] },
    { items: null }, { items: [], nextPageToken: 0 }])('rejects incomplete GCS inventory %j', async body => {
    const client = await gcs(body); try { await expect(client.list()).rejects.toThrow(); } finally { client.destroy(); }
  });
  it.each(['<Blob><Properties><Content-Length>3</Content-Length></Properties></Blob>',
    '<Blob><Name>zero-or-unknown</Name><Properties><BlobType>BlockBlob</BlobType></Properties></Blob>'])('rejects incomplete Azure object rows', async row => {
    const { client } = await azure([blobPage(row)]); try { await expect(client.list()).rejects.toThrow(); } finally { client.destroy(); }
  });
  it('rejects repeated Azure empty continuation pages before issuing a third request', async () => {
    const { client, requests } = await azure([blobPage('', 'same-marker'), blobPage('', 'same-marker'), blobPage()]);
    try { await expect(client.list({ maxObjects: 10 })).rejects.toThrow(/pagination/i); expect(requests()).toBe(2); } finally { client.destroy(); }
  });
  it('accepts native empty inventories and explicitly zero-byte objects', async () => {
    const clients = [s3('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'), await gcs({}), (await azure([blobPage()])).client];
    try { for (const client of clients) expect(await client.list()).toEqual([]); } finally { for (const client of clients) client.destroy(); }
    const zero = [s3('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>zero</Key><Size>0</Size></Contents></ListBucketResult>'),
      await gcs({ items: [{ name: 'zero', size: '0' }] }), (await azure([blobPage('<Blob><Name>zero</Name><Properties><Content-Length>0</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>')])).client];
    try { for (const client of zero) expect(await client.list()).toMatchObject([{ key: 'zero', size: 0 }]); } finally { for (const client of zero) client.destroy(); }
  });
});
