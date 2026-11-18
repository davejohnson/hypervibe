import crypto from 'crypto';
import { fetchWithRetry } from '../../../utils/fetch-retry.js';

/**
 * Cloud SQL Admin, Memorystore and Cloud Storage calls the engine makes beside
 * OpenTofu. Each function is one API operation and returns the raw response;
 * ownership checks and receipts stay in the application layer.
 */
export async function sqlAdmin(token: string, gcpProjectId: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(`https://sqladmin.googleapis.com/v1/projects/${gcpProjectId}/${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

export async function waitForSqlOperation(token: string, gcpProjectId: string, operation: { name?: string; status?: string; error?: unknown }): Promise<'done' | 'failed' | 'unknown'> {
  if (operation.status === 'DONE') return operation.error ? 'failed' : 'done';
  if (!operation.name) return 'unknown';
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await sqlAdmin(token, gcpProjectId, `operations/${operation.name}`);
    if (!response.ok) continue;
    const body = await response.json() as { status?: string; error?: unknown };
    if (body.status === 'DONE') return body.error ? 'failed' : 'done';
  }
  return 'unknown';
}

const redisInstance = (gcpProjectId: string, region: string, instanceName: string) => `https://redis.googleapis.com/v1/projects/${gcpProjectId}/locations/${region}/instances/${instanceName}`;

export function readRedisInstance(token: string, gcpProjectId: string, region: string, instanceName: string): Promise<Response> {
  return fetchWithRetry(redisInstance(gcpProjectId, region, instanceName), { headers: { Authorization: `Bearer ${token}` } });
}

/** Reads the instance's Google-generated AUTH string. The caller must not log or return it. */
export function readRedisAuthString(token: string, gcpProjectId: string, region: string, instanceName: string): Promise<Response> {
  return fetchWithRetry(`${redisInstance(gcpProjectId, region, instanceName)}/authString`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Creates an S3-compatible HMAC key for a service account. Attempted once: a thrown error means the outcome is unknown. */
export function createStorageHmacKey(token: string, gcpProjectId: string, serviceAccountEmail: string): Promise<Response> {
  return fetch(`https://storage.googleapis.com/storage/v1/projects/${gcpProjectId}/hmacKeys?serviceAccountEmail=${encodeURIComponent(serviceAccountEmail)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
}

export function readBucket(token: string, bucket: string): Promise<Response> {
  return fetchWithRetry(`https://storage.googleapis.com/storage/v1/b/${bucket}`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Reads a project by id; its `name` carries the project number. */
export function readGcpProject(token: string, gcpProjectId: string): Promise<Response> {
  return fetchWithRetry(`https://cloudresourcemanager.googleapis.com/v3/projects/${gcpProjectId}`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Lists Cloud Logging entries matching a filter. */
export function listLogEntries(token: string, body: Record<string, unknown>): Promise<Response> {
  return fetchWithRetry('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

/**
 * V4 signed URL for one Cloud Storage object, signed locally with the
 * deployment identity's key. It grants exactly one method on one object and
 * expires; it carries no reusable credential.
 */
export function signedObjectUrl(params: { clientEmail: string; privateKey: string; bucket: string; object: string; method: 'PUT' | 'GET'; expiresSeconds: number; now?: Date }): string {
  const now = params.now ?? new Date();
  const datetime = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = datetime.slice(0, 8);
  const scope = `${date}/auto/storage/goog4_request`;
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const path = `/${params.bucket}/${params.object.split('/').map(encode).join('/')}`;
  const query = Object.entries({
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${params.clientEmail}/${scope}`,
    'X-Goog-Date': datetime,
    'X-Goog-Expires': String(params.expiresSeconds),
    'X-Goog-SignedHeaders': 'host',
  }).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
  const canonical = [params.method, path, query, 'host:storage.googleapis.com', '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', datetime, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const signature = crypto.createSign('RSA-SHA256').update(toSign).sign(params.privateKey, 'hex');
  return `https://storage.googleapis.com${path}?${query}&X-Goog-Signature=${signature}`;
}

/** Native identities retained until the temporary transfer job and its credentials are confirmed gone. */
export interface TransferResources {
  gcpProjectId: string;
  region: string;
  jobId: string;
  secretIds: string[];
  ownershipToken?: string;
  jobUid?: string;
}
