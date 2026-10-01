import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type {
  StorageCredentials,
  StorageObjectClient,
  StorageObjectPayload,
  StorageObjectRecord,
} from '../ports/storage.port.js';
export type { StorageObjectClient } from '../ports/storage.port.js';

export interface ObjectStorageTransferDependencies {
  createClient?: (credentials: StorageCredentials) => StorageObjectClient;
}

export interface ObjectStorageTransferResult {
  objectCount: number;
  totalBytes: string;
  manifestHash: string;
}

export function createS3ObjectClient(credentials: StorageCredentials, dependencies: { requestHandler?: S3ClientConfig['requestHandler'] } = {}): StorageObjectClient {
  const client = new S3Client({
    region: credentials.region,
    endpoint: credentials.endpoint,
    forcePathStyle: credentials.urlStyle === 'path',
    ...(dependencies.requestHandler ? { requestHandler: dependencies.requestHandler } : {}),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  });
  return {
    async list(options): Promise<StorageObjectRecord[]> {
      const objects: StorageObjectRecord[] = [];
      const tokens = new Set<string>();
      let continuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: credentials.bucket,
          ...(options?.prefix ? { Prefix: options.prefix } : {}),
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }));
        if (typeof page.IsTruncated !== 'boolean' || (page.Contents !== undefined && !Array.isArray(page.Contents))) {
          throw new Error('Object listing completeness is unknown.');
        }
        for (const object of page.Contents ?? []) {
          if (typeof object.Key !== 'string' || !object.Key || !Number.isSafeInteger(object.Size) || object.Size! < 0) {
            throw new Error('Object listing contains an incomplete object identity or size.');
          }
          objects.push({ key: object.Key, size: object.Size!, revision: {
            ...(object.ETag ? { etag: object.ETag } : {}),
            ...(object.LastModified ? { lastModified: object.LastModified.toISOString() } : {}),
          } });
          if (options?.maxObjects !== undefined && objects.length > options.maxObjects) throw new Error('Object listing exceeds its count limit.');
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!continuationToken || tokens.has(continuationToken))) throw new Error('Object listing pagination did not advance.');
        if (continuationToken) tokens.add(continuationToken);
      } while (continuationToken);
      return objects.sort((left, right) => left.key.localeCompare(right.key));
    },
    async get(key, revision): Promise<StorageObjectPayload> {
      if (revision?.generation || revision?.metageneration) throw new Error('S3 does not accept a different provider revision format.');
      const object = await client.send(new GetObjectCommand({ Bucket: credentials.bucket, Key: key,
        ...(revision?.etag ? { IfMatch: revision.etag } : {}),
        ...(revision?.versionId ? { VersionId: revision.versionId } : {}),
      }));
      if (!object.Body) throw new Error('Object storage source returned an empty response body.');
      return {
        body: object.Body as Readable,
        size: object.ContentLength ?? 0,
        revision: { ...(object.ETag ? { etag: object.ETag } : {}), ...(object.VersionId ? { versionId: object.VersionId } : {}),
          ...(object.LastModified ? { lastModified: object.LastModified.toISOString() } : {}) },
        ...(object.ContentType ? { contentType: object.ContentType } : {}),
        ...(object.ContentEncoding ? { contentEncoding: object.ContentEncoding } : {}),
        ...(object.CacheControl ? { cacheControl: object.CacheControl } : {}),
        ...(object.ContentDisposition ? { contentDisposition: object.ContentDisposition } : {}),
        ...(object.Metadata ? { metadata: object.Metadata } : {}),
      };
    },
    async put(key, payload, options): Promise<void> {
      if (!Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > 5 * 1024 ** 3) throw new Error('The S3 object stream exceeds the supported single-request size.');
      await client.send(new PutObjectCommand({
        Bucket: credentials.bucket,
        Key: key,
        Body: payload.body,
        ContentLength: payload.size,
        ContentType: payload.contentType,
        ContentEncoding: payload.contentEncoding,
        CacheControl: payload.cacheControl,
        ContentDisposition: payload.contentDisposition,
        Metadata: payload.metadata,
        ...(options?.ifAbsent ? { IfNoneMatch: '*' } : {}),
      }));
    },
    async remove(key, revision) {
      if (revision?.generation || revision?.metageneration) throw new Error('S3 does not accept a different provider revision format.');
      await client.send(new DeleteObjectCommand({ Bucket: credentials.bucket, Key: key,
        ...(revision?.etag ? { IfMatch: revision.etag } : {}), ...(revision?.versionId ? { VersionId: revision.versionId } : {}) }));
    },
    destroy: () => client.destroy(),
  };
}

function manifest(objects: StorageObjectRecord[]): ObjectStorageTransferResult {
  let totalBytes = 0n;
  const digest = createHash('sha256');
  for (const object of [...objects].sort((left, right) => left.key.localeCompare(right.key))) {
    totalBytes += BigInt(object.size);
    digest.update(object.key);
    digest.update('\0');
    digest.update(String(object.size));
    digest.update('\n');
  }
  return {
    objectCount: objects.length,
    totalBytes: totalBytes.toString(),
    manifestHash: digest.digest('hex'),
  };
}

/** Stream a stopped-write source bucket into a fresh target and verify the
 * complete key/size manifest. Credentials and object keys never enter the
 * returned receipt. */
export async function transferObjectStorage(
  sourceCredentials: StorageCredentials,
  targetCredentials: StorageCredentials,
  dependencies: ObjectStorageTransferDependencies = {}
): Promise<ObjectStorageTransferResult> {
  const createClient = dependencies.createClient ?? createS3ObjectClient;
  return transferObjectStorageClients(
    createClient(sourceCredentials),
    createClient(targetCredentials)
  );
}

/** Provider-neutral transfer once adapters have opened their native streams. */
export async function transferObjectStorageClients(
  source: StorageObjectClient,
  target: StorageObjectClient
): Promise<ObjectStorageTransferResult> {
  try {
    const sourceObjects = await source.list();
    for (const object of sourceObjects) {
      const payload = await source.get(object.key);
      if (payload.size !== object.size) {
        throw new Error('Object storage source changed while it was being copied. Stop writes and retry with a new migration id.');
      }
      await target.put(object.key, payload);
    }
    const targetObjects = await target.list();
    const sourceManifest = manifest(sourceObjects);
    const targetManifest = manifest(targetObjects);
    if (
      sourceManifest.objectCount !== targetManifest.objectCount
      || sourceManifest.totalBytes !== targetManifest.totalBytes
      || sourceManifest.manifestHash !== targetManifest.manifestHash
    ) {
      throw new Error('Object storage transfer verification failed: target keys or object sizes differ from the source.');
    }
    return sourceManifest;
  } finally {
    source.destroy();
    target.destroy();
  }
}
