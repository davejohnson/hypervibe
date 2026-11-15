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
