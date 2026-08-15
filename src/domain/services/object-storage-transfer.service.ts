import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
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

export function createS3ObjectClient(credentials: StorageCredentials): StorageObjectClient {
  const client = new S3Client({
    region: credentials.region,
    endpoint: credentials.endpoint,
    forcePathStyle: credentials.urlStyle === 'path',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  });
  return {
    async list(): Promise<StorageObjectRecord[]> {
      const objects: StorageObjectRecord[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: credentials.bucket,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }));
        for (const object of page.Contents ?? []) {
          if (typeof object.Key !== 'string') continue;
          objects.push({ key: object.Key, size: object.Size ?? 0 });
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
      return objects.sort((left, right) => left.key.localeCompare(right.key));
    },
    async get(key): Promise<StorageObjectPayload> {
      const object = await client.send(new GetObjectCommand({ Bucket: credentials.bucket, Key: key }));
      if (!object.Body) throw new Error('Object storage source returned an empty response body.');
      return {
        body: object.Body as Readable,
        size: object.ContentLength ?? 0,
        ...(object.ContentType ? { contentType: object.ContentType } : {}),
        ...(object.ContentEncoding ? { contentEncoding: object.ContentEncoding } : {}),
        ...(object.CacheControl ? { cacheControl: object.CacheControl } : {}),
        ...(object.ContentDisposition ? { contentDisposition: object.ContentDisposition } : {}),
        ...(object.Metadata ? { metadata: object.Metadata } : {}),
      };
    },
    async put(key, payload): Promise<void> {
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
      }));
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
