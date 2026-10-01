import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3StorageAdapter } from '../../../adapters/providers/aws/s3.adapter.js';
import { GcsStorageAdapter } from '../../../adapters/providers/gcp/gcs.adapter.js';
import { AzureBlobStorageAdapter, type AzureBlobDataPlane } from '../../../adapters/providers/azure/azure-blob.adapter.js';
import { createRailwayStorageAdapter } from '../../../adapters/providers/railway/railway-storage.factory.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from '../../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { IStorageAdapter, StorageContext } from '../../ports/storage.port.js';
import { openRecoveryStorage } from '../managed-backup-target.service.js';

const environment: Environment = { id: 'production', name: 'production', projectId: 'app',
  platformBindings: {}, createdAt: new Date(), updatedAt: new Date() };
const boundLocalId = 'original-checkout-uuid';
const credentials = { accessKeyId: 'A'.repeat(20), secretAccessKey: 's'.repeat(40) };
const azureCredentials = { tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'test-secret' };
const accountId = `/subscriptions/${azureCredentials.subscriptionId}/resourceGroups/app-production/providers/Microsoft.Storage/storageAccounts/retainedaccount`;
const containerId = `${accountId}/blobServices/default/containers/documents`;
const serviceAccount = JSON.stringify({ type: 'service_account', project_id: 'cloud-project',
  client_email: 'test@cloud-project.iam.gserviceaccount.com', private_key: 'unused-test-key' });

// These exercise real SDK serialization / adapter HTTP clients, with synthetic
// responses shaped by the official contracts. They do not certify live access.
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html
// https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/list
// https://learn.microsoft.com/en-us/rest/api/storagerp/blob-containers/get
describe('recovery storage exact bound observation', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function s3Fixture(status = 200, region: string | null = 'us-west-2') {
    const requests: Array<{ method: string; hostname: string; path: string; headers: Record<string, string> }> = [];
    const adapter = new S3StorageAdapter((_credentials, configuredRegion) => ({
      s3: new S3Client({ region: configuredRegion, credentials: { ...credentials }, maxAttempts: 1, requestHandler: { async handle(request: any) {
        requests.push(request);
        if (request.method !== 'HEAD') throw new Error('Exact observation must only HEAD the bound bucket');
        return { response: { statusCode: status, headers: region ? { 'x-amz-bucket-region': region } : {}, body: Readable.from([]) } };
      } } }),
      sts: { send: vi.fn(async () => { throw new Error('No account-wide lookup'); }), destroy() {} },
    }));
    await adapter.connect(credentials);
    const scope = { accountId: '123456789012', region: 'us-west-2', environmentId: boundLocalId };
    return { adapter, requests, scope };
  }

  it('opens an exact S3 binding using native owner/region evidence despite a different local environment ID', async () => {
    const { adapter, requests, scope } = await s3Fixture();
    const client = await openRecoveryStorage(adapter, environment, { provider: 's3', externalId: 'retained-bucket', instanceScope: scope });
    client.destroy(); await adapter.disconnect();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'HEAD', hostname: 'retained-bucket.s3.us-west-2.amazonaws.com',
      headers: { 'x-amz-expected-bucket-owner': scope.accountId } });
  });

  it.each([{ status: 403, region: 'us-west-2' }, { status: 404, region: 'us-west-2' },
    { status: 200, region: 'us-east-1' }, { status: 200, region: null }])(
    'rejects S3 inaccessible, absent, wrong-region or incomplete native evidence: %j', async ({ status, region }) => {
      const f = await s3Fixture(status, region);
      const open = vi.spyOn(f.adapter, 'openObjectTransfer');
      await expect(openRecoveryStorage(f.adapter, environment, { provider: 's3', externalId: 'retained-bucket', instanceScope: f.scope })).rejects.toThrow();
      expect(f.requests).toHaveLength(1); expect(f.requests[0].method).toBe('HEAD');
      expect(open).not.toHaveBeenCalled(); await f.adapter.disconnect();
    });

  async function gcsFixture(items: unknown[] = [{ name: 'retained-bucket', location: 'US-CENTRAL1',
    labels: { hypervibe_environment_id: boundLocalId, hypervibe_storage_name: 'documents' } }]) {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.method ?? 'GET').toBe('GET');
      expect(url.pathname).toBe('/storage/v1/b');
      expect(url.searchParams.get('project')).toBe('cloud-project');
      expect(url.searchParams.get('prefix')).toBe('retained-bucket');
      return Response.json({ items });
    });
    const adapter = new GcsStorageAdapter({ fetch: request as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'test@cloud-project.iam.gserviceaccount.com' }) });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });
    const scope = { projectId: 'cloud-project', region: 'us-central1', environmentId: boundLocalId };
    return { adapter, request, scope };
  }

  it('opens a GCS binding only from the exact project inventory, ignoring local discovery labels', async () => {
    const f = await gcsFixture();
    const client = await openRecoveryStorage(f.adapter, environment, { provider: 'gcs', externalId: 'retained-bucket', instanceScope: f.scope });
    client.destroy(); expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each(['project', 'near-match', 'region'])('rejects GCS %s mismatch before opening object access', async kind => {
    const f = await gcsFixture(kind === 'near-match' ? [{ name: 'retained-bucket-copy', location: 'US-CENTRAL1' }]
      : kind === 'region' ? [{ name: 'retained-bucket', location: 'EU' }] : undefined);
    const open = vi.spyOn(f.adapter, 'openObjectTransfer');
    await expect(openRecoveryStorage(f.adapter, environment, { provider: 'gcs', externalId: 'retained-bucket',
      instanceScope: { ...f.scope, ...(kind === 'project' ? { projectId: 'foreign-project' } : {}) } })).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    if (kind === 'project') expect(f.request).not.toHaveBeenCalled();
  });

  it('rejects repeated GCS inventory pages instead of treating a partial inventory as exact evidence', async () => {
    const f = await gcsFixture();
    f.request.mockImplementation(async () => f.request.mock.calls.length > 2
      ? Response.json({ error: { message: 'unexpected third page' } }, { status: 400 })
      : Response.json({ items: [], nextPageToken: 'repeated' }));
    await expect(openRecoveryStorage(f.adapter, environment, { provider: 'gcs', externalId: 'retained-bucket', instanceScope: f.scope }))
      .rejects.toThrow(/pagination/);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('selects only the requested Railway bucket in the native environment through serialized GraphQL', async () => {
    const f = await railwayHttpFixture();
    f.buckets.set('bucket-other', { id: 'bucket-other', name: 'other', projectId });
    f.environments.get(productionId)!.config.buckets!['bucket-other'] = { region: 'iad', isCreated: true, isDeleted: false };
    const adapter = createRailwayStorageAdapter(f.adapter);
    expect(await adapter.observe(environment, { projectId, environmentId: productionId }, { externalId: 'bucket-documents' }))
      .toMatchObject([{ externalId: 'bucket-documents', instanceScope: { projectId, environmentId: productionId } }]);
    expect(await adapter.observe(environment, { projectId, environmentId: stagingId }, { externalId: 'bucket-documents' })).toEqual([]);
    expect(await adapter.observe(environment, { projectId, environmentId: productionId }, { externalId: 'bucket-documents-copy' })).toEqual([]);
    expect(f.mutations).toEqual([]); expect(f.contractErrors).toEqual([]);
  });

  async function azureFixture(change?: 'account' | 'container' | 'location') {
    const requests: Array<{ url: URL; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token' });
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.pathname === accountId) return Response.json({ id: change === 'account' ? accountId.replace('app-production', 'foreign') : accountId,
        name: 'retainedaccount', location: change === 'location' ? 'eastus' : 'westus2', tags: { 'hypervibe-environment-id': boundLocalId } });
      if (url.pathname === containerId) return Response.json({ id: change === 'container' ? `${containerId}-copy` : containerId, name: 'documents' });
      if (url.pathname === `${accountId}/listKeys`) return Response.json({ keys: [{ value: 'test-key' }] });
      throw new Error(`Unexpected ARM request ${url.pathname}`);
    }));
    const plane: AzureBlobDataPlane = { list: vi.fn(), get: vi.fn(), put: vi.fn(), deleteAll: vi.fn(), destroy: vi.fn() };
    const dataPlaneFactory = vi.fn(() => plane);
    const adapter = new AzureBlobStorageAdapter({ dataPlaneFactory });
    await adapter.connect(azureCredentials);
    const scope = { subscriptionId: azureCredentials.subscriptionId, resourceGroup: 'app-production', location: 'westus2', environmentId: boundLocalId };
    return { adapter, requests, scope, plane, dataPlaneFactory };
  }

  it('reads the exact Azure account/container without local UUID tags or credential reads during observation', async () => {
    const f = await azureFixture();
    const observed = await (f.adapter as IStorageAdapter).observe(environment, f.scope, { externalId: containerId });
    expect(observed).toMatchObject([{ provider: 'azureblob', externalId: containerId, instanceScope: f.scope, status: 'ready' }]);
    expect(f.requests.map(r => [r.method, r.url.pathname])).toEqual([['GET', accountId], ['GET', containerId]]);
    expect(f.dataPlaneFactory).not.toHaveBeenCalled();
    const client = await openRecoveryStorage(f.adapter, environment, { provider: 'azureblob', externalId: containerId, instanceScope: f.scope });
    expect(client).toBe(f.plane);
    expect(f.requests.filter(r => r.method !== 'GET').map(r => [r.method, r.url.pathname])).toEqual([['POST', `${accountId}/listKeys`]]);
    expect(f.plane.list).not.toHaveBeenCalled();
  });

  it.each(['subscription', 'group', 'account', 'container', 'location'] as const)(
    'rejects Azure %s mismatch before reading storage keys or opening data access', async kind => {
      const f = await azureFixture(['account', 'container', 'location'].includes(kind) ? kind as 'account' | 'container' | 'location' : undefined);
      const scope: StorageContext = { ...f.scope, ...(kind === 'group' ? { resourceGroup: 'foreign' } : {}),
        ...(kind === 'subscription' ? { subscriptionId: '44444444-4444-4444-8444-444444444444' } : {}) };
      await expect(openRecoveryStorage(f.adapter, environment, { provider: 'azureblob', externalId: containerId, instanceScope: scope })).rejects.toThrow();
      expect(f.requests.some(r => r.url.pathname.endsWith('/listKeys'))).toBe(false);
      expect(f.dataPlaneFactory).not.toHaveBeenCalled();
      if (kind === 'group' || kind === 'subscription') expect(f.requests).toEqual([]);
    });
});
