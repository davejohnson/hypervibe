import { Readable } from 'node:stream';
import { BlobServiceClient, StorageSharedKeyCredential, type StoragePipelineOptions } from '@azure/storage-blob';
import type { TokenCredential } from '@azure/core-auth';
import type { StorageObjectClient, StorageObjectPayload, StorageObjectRecord, StorageObjectRevision } from '../../../domain/ports/storage.port.js';

function readable(payload: StorageObjectPayload): Readable {
  if (payload.body instanceof Readable) return payload.body;
  if (payload.body instanceof Blob) {
    return Readable.fromWeb(payload.body.stream() as ReadableStream<Uint8Array>);
  }
  return Readable.fromWeb(payload.body as ReadableStream<Uint8Array>);
}

// List Blobs XML can omit the quotes that Get Blob and If-Match use for the same ETag.
function azureEtag(value: string): string {
  if (/^"[^"\s]+"$/.test(value)) return value;
  if (/^0x[0-9a-f]+$/i.test(value)) return `"${value}"`;
  throw new Error('Azure Blob returned an invalid strong ETag.');
}

export class AzureSdkBlobDataPlane implements StorageObjectClient {
  private readonly service: BlobServiceClient;

  constructor(account: string, access: string | TokenCredential, private readonly container: string, httpClient?: StoragePipelineOptions['httpClient']) {
    const credential = typeof access === 'string' ? new StorageSharedKeyCredential(account, access) : access;
    this.service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential, { ...(httpClient ? { httpClient } : {}) });
  }

  async list(options?: { prefix?: string; maxObjects?: number }): Promise<StorageObjectRecord[]> {
    const output: StorageObjectRecord[] = [];
    const tokens = new Set<string>();
    for await (const page of this.containerClient().listBlobsFlat(options).byPage()) {
      for (const blob of page.segment.blobItems) {
        if (typeof blob.name !== 'string' || !blob.name || !Number.isSafeInteger(blob.properties.contentLength)
          || blob.properties.contentLength! < 0) throw new Error('Azure object listing contains an incomplete object identity or size.');
        output.push({ key: blob.name, size: blob.properties.contentLength!, revision: {
          ...(blob.properties.etag ? { etag: azureEtag(blob.properties.etag) } : {}),
          ...(blob.properties.lastModified ? { lastModified: blob.properties.lastModified.toISOString() } : {}),
        } });
        if (options?.maxObjects !== undefined && output.length > options.maxObjects) throw new Error('Azure object listing exceeds its count limit.');
      }
      if (page.continuationToken) {
        if (tokens.has(page.continuationToken)) throw new Error('Azure object listing pagination did not advance.');
        tokens.add(page.continuationToken);
      }
    }
    return output;
  }

  async get(key: string, revision?: StorageObjectRevision): Promise<StorageObjectPayload> {
    if (revision?.generation || revision?.metageneration) throw new Error('Azure Blob reads require a native ETag or version.');
    const client = this.containerClient().getBlobClient(key);
    const response = await (revision?.versionId ? client.withVersion(revision.versionId) : client).download(0, undefined,
      { ...(revision?.etag ? { conditions: { ifMatch: azureEtag(revision.etag) } } : {}) });
    if (!response.readableStreamBody) throw new Error(`Azure Blob object ${key} returned no body.`);
    return {
      body: response.readableStreamBody as Readable,
      size: response.contentLength ?? 0,
      revision: { ...(response.etag ? { etag: azureEtag(response.etag) } : {}), ...(response.versionId ? { versionId: response.versionId } : {}),
        ...(response.lastModified ? { lastModified: response.lastModified.toISOString() } : {}) },
      contentType: response.contentType,
      contentEncoding: response.contentEncoding,
      cacheControl: response.cacheControl,
      contentDisposition: response.contentDisposition,
      metadata: response.metadata,
    };
  }

  async put(key: string, payload: StorageObjectPayload, options?: { ifAbsent?: boolean }): Promise<void> {
    await this.containerClient().getBlockBlobClient(key).uploadStream(
      readable(payload),
      4 * 1024 * 1024,
      2,
      {
        blobHTTPHeaders: {
          blobContentType: payload.contentType,
          blobContentEncoding: payload.contentEncoding,
          blobCacheControl: payload.cacheControl,
          blobContentDisposition: payload.contentDisposition,
        },
        metadata: payload.metadata,
        ...(options?.ifAbsent ? { conditions: { ifNoneMatch: '*' } } : {}),
      }
    );
  }

  async remove(key: string, revision?: StorageObjectRevision): Promise<void> {
    if (revision?.generation || revision?.metageneration) throw new Error('Azure Blob deletion requires a native ETag or version.');
    const client = this.containerClient().getBlobClient(key);
    await (revision?.versionId ? client.withVersion(revision.versionId) : client).delete({
      ...(revision?.etag ? { conditions: { ifMatch: azureEtag(revision.etag) } } : {}),
    });
  }

  async deleteAll(): Promise<void> {
    for await (const blob of this.containerClient().listBlobsFlat()) {
      await this.containerClient().deleteBlob(blob.name, { deleteSnapshots: 'include' });
    }
  }

  destroy(): void {}

  private containerClient() {
    return this.service.getContainerClient(this.container);
  }
}
