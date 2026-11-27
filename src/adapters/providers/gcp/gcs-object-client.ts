import { Readable } from 'node:stream';
import { request as httpsRequest } from 'node:https';
import type { StorageObjectClient, StorageObjectPayload, StorageObjectRevision } from '../../../domain/ports/storage.port.js';

export const STORAGE_API = 'https://storage.googleapis.com';

interface GcsObject {
  name?: string;
  size?: string;
  generation?: string;
  metageneration?: string;
  contentType?: string;
  contentEncoding?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
}

/** JSON API gzip objects must retain their stored representation. Global fetch
 * decodes Content-Encoding, so object bodies use an undecoded HTTPS stream. */
export const rawGcsMediaFetch: typeof fetch = async (input, init) => new Promise((resolve, reject) => {
  const request = httpsRequest(String(input), { method: 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()) }, response => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 500, headers }));
  });
  request.once('error', reject); request.end();
});

export async function gcsResponseError(response: Response): Promise<Error> {
  const text = await response.text();
  const detail = `Google Cloud Storage API ${response.status}: ${text.slice(0, 1_000)}`;
  if (response.status === 403) {
    return new Error(
      `${detail}. When GCS reuses the Cloud Run connection, preview hv_connections provider="cloudrun" action="prepare" gcsAccess="inspect" for read-only inventory; `
      + 'for GCS create, transfer, or teardown, preview it with gcsAccess="lifecycle". Both paths require explicit confirmation and may use existing Google Application Default Credentials through adminAuth="default". A standalone GCS connection must grant the equivalent role to its own identity.'
    );
  }
  return new Error(detail);
}

function requestBody(payload: StorageObjectPayload): RequestInit['body'] {
  if (payload.body instanceof Blob) return payload.body;
  if (payload.body instanceof Readable) return Readable.toWeb(payload.body) as ReadableStream;
  return payload.body;
}

export class GcsObjectClient implements StorageObjectClient {
  constructor(
    private readonly bucket: string,
    private readonly request: typeof fetch,
    private readonly getToken: () => Promise<string>,
    private readonly mediaRequest: typeof fetch = request,
  ) {}

  async list(options?: { prefix?: string; maxObjects?: number }) {
    const objects: Array<{ key: string; size: number; revision?: StorageObjectRevision }> = [];
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams();
      if (options?.prefix) params.set('prefix', options.prefix);
      if (options?.maxObjects !== undefined) params.set('maxResults', String(Math.min(1000, options.maxObjects + 1)));
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params}`);
      if (!response.ok) throw await gcsResponseError(response);
      const body = await response.json() as { items?: GcsObject[]; nextPageToken?: string };
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || (body.items !== undefined && !Array.isArray(body.items))
        || (body.nextPageToken !== undefined && (typeof body.nextPageToken !== 'string' || !body.nextPageToken))) {
        throw new Error('GCS object listing completeness is unknown.');
      }
      for (const object of body.items ?? []) {
        if (!object || typeof object.name !== 'string' || !object.name || typeof object.size !== 'string'
          || !/^\d+$/.test(object.size) || !Number.isSafeInteger(Number(object.size))) {
          throw new Error('GCS object listing contains an incomplete object identity or size.');
        }
        objects.push({ key: object.name, size: Number(object.size),
          ...(object.generation ? { revision: { generation: object.generation,
            ...(object.metageneration ? { metageneration: object.metageneration } : {}) } } : {}) });
        if (options?.maxObjects !== undefined && objects.length > options.maxObjects) throw new Error('GCS object listing exceeds its count limit.');
      }
      pageToken = body.nextPageToken;
      if (pageToken && tokens.has(pageToken)) throw new Error('GCS object listing pagination did not advance.');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    return objects;
  }

  async get(key: string, expected?: StorageObjectRevision): Promise<StorageObjectPayload> {
    if (expected?.etag || expected?.versionId || expected?.lastModified) throw new Error('GCS recovery reads require a native generation.');
    const base = `${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`;
    const conditions = new URLSearchParams();
    if (expected?.generation) conditions.set('ifGenerationMatch', expected.generation);
    if (expected?.metageneration) conditions.set('ifMetagenerationMatch', expected.metageneration);
    const metadataResponse = await this.authorized(`${base}?${conditions}`);
    if (!metadataResponse.ok) throw await gcsResponseError(metadataResponse);
    const object = await metadataResponse.json() as GcsObject;
    if (!object.generation || !object.metageneration || object.size === undefined
      || (expected?.generation && object.generation !== expected.generation)
      || (expected?.metageneration && object.metageneration !== expected.metageneration)) throw new Error('GCS did not identify the exact object generation.');
    conditions.set('generation', object.generation); conditions.set('ifGenerationMatch', object.generation);
    conditions.set('ifMetagenerationMatch', object.metageneration); conditions.set('alt', 'media');
    const response = await this.mediaRequest(`${base}?${conditions}`, { headers: {
      Authorization: `Bearer ${await this.getToken()}`, 'Accept-Encoding': 'gzip',
    } });
    if (!response.ok) throw await gcsResponseError(response);
    if (!response.body) throw new Error(`Google Cloud Storage object ${key} returned no body.`);
    if (response.headers.get('x-goog-generation') !== object.generation
      || response.headers.get('x-goog-metageneration') !== object.metageneration
      || Number(response.headers.get('content-length')) !== Number(object.size)) {
      await response.body.cancel(); throw new Error('GCS media response does not match the reviewed stored representation.');
    }
    return {
      body: response.body,
      size: Number(object.size), revision: { generation: object.generation, metageneration: object.metageneration },
      contentType: object.contentType, contentEncoding: object.contentEncoding,
      cacheControl: object.cacheControl, contentDisposition: object.contentDisposition, metadata: object.metadata,
    };
  }

  async put(key: string, payload: StorageObjectPayload, options?: { ifAbsent?: boolean }): Promise<void> {
    const params = new URLSearchParams({ uploadType: 'media', name: key });
    if (options?.ifAbsent) params.set('ifGenerationMatch', '0');
    const headers: Record<string, string> = {};
    if (payload.contentType) headers['content-type'] = payload.contentType;
    const response = await this.authorized(
      `${STORAGE_API}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params}`,
      { method: 'POST', body: requestBody(payload), headers, duplex: 'half' } as RequestInit
    );
    if (!response.ok) throw await gcsResponseError(response);
    const uploaded = await response.json() as GcsObject;
    if (options?.ifAbsent && !uploaded.generation) throw new Error('GCS did not acknowledge the exact new object generation.');
    if (
      payload.contentType
      || payload.contentEncoding
      || payload.cacheControl
      || payload.contentDisposition
      || Object.keys(payload.metadata ?? {}).length > 0
    ) {
      const metadataResponse = await this.authorized(
        `${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}${uploaded.generation
          ? `?ifGenerationMatch=${encodeURIComponent(uploaded.generation)}${uploaded.metageneration ? `&ifMetagenerationMatch=${encodeURIComponent(uploaded.metageneration)}` : ''}` : ''}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(payload.contentType ? { contentType: payload.contentType } : {}),
            ...(payload.contentEncoding ? { contentEncoding: payload.contentEncoding } : {}),
            ...(payload.cacheControl ? { cacheControl: payload.cacheControl } : {}),
            ...(payload.contentDisposition ? { contentDisposition: payload.contentDisposition } : {}),
            ...(payload.metadata ? { metadata: payload.metadata } : {}),
          }),
        }
      );
      if (!metadataResponse.ok) throw await gcsResponseError(metadataResponse);
    }
  }

  async remove(key: string, revision?: StorageObjectRevision): Promise<void> {
    if (revision?.etag || revision?.versionId || revision?.lastModified) throw new Error('GCS deletion requires a native generation.');
    const conditions = new URLSearchParams();
    if (revision?.generation) conditions.set('ifGenerationMatch', revision.generation);
    if (revision?.metageneration) conditions.set('ifMetagenerationMatch', revision.metageneration);
    const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}?${conditions}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw await gcsResponseError(response);
  }

  destroy(): void {}

  private async authorized(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getToken();
    return this.request(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...Object.fromEntries(new Headers(init.headers).entries()) },
    });
  }
}
