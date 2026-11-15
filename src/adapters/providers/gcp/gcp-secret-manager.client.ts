import { fetchWithRetry } from '../../../utils/fetch-retry.js';

/**
 * Google Secret Manager calls the engine makes. Each function is one API
 * operation; ownership checks, local metadata and receipts stay in the
 * application layer. Values are written and read here but never logged.
 */
const API = 'https://secretmanager.googleapis.com/v1';

/** Present, absent or unknown: only a confirmed 404 is absence. */
export type SecretObservation<T> = { state: 'present'; value: T } | { state: 'absent' } | { state: 'unknown'; reason: string };

export interface SecretContainer {
  /** Full resource name, `projects/<project>/secrets/<id>`. */
  resourceName: string;
  labels: Record<string, string>;
  /** False when the container has no version at all. */
  hasVersion: boolean;
  hasEnabledVersion: boolean;
  /** Last segment of the latest version's name, exactly as Secret Manager returned it. */
  latestVersionName?: string;
}

function request(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
}

const secretUrl = (gcpProjectId: string, secretId: string) => `${API}/projects/${gcpProjectId}/secrets/${secretId}`;

/** Reads a secret container and whether its latest version is enabled. */
export async function readSecretContainer(token: string, gcpProjectId: string, secretId: string): Promise<SecretObservation<SecretContainer>> {
  const base = secretUrl(gcpProjectId, secretId);
  const secret = await request(token, base);
  if (secret.status === 404) return { state: 'absent' };
  if (!secret.ok) return { state: 'unknown', reason: `Secret Manager returned HTTP ${secret.status} for ${secretId}.` };
  const body = await secret.json() as { name?: string; labels?: Record<string, string> };
  const resourceName = body.name ?? `projects/${gcpProjectId}/secrets/${secretId}`;
  const labels = body.labels ?? {};
  const version = await request(token, `${base}/versions/latest`);
  if (version.status === 404) return { state: 'present', value: { resourceName, labels, hasVersion: false, hasEnabledVersion: false } };
  if (!version.ok) return { state: 'unknown', reason: `Secret Manager returned HTTP ${version.status} for ${secretId} versions.` };
  const versionBody = await version.json() as { state?: string; name?: string };
  if (versionBody.name && !versionBody.name.startsWith(`${resourceName}/versions/`)) return { state: 'unknown', reason: `Secret Manager returned a version for a different secret than ${secretId}.` };
  const latestVersionName = versionBody.name?.split('/').pop();
  return { state: 'present', value: { resourceName, labels, hasVersion: true, hasEnabledVersion: versionBody.state === 'ENABLED',
    ...(latestVersionName ? { latestVersionName } : {}) } };
}

/** Ids of every secret matching a label filter, or unknown when the listing is incomplete. */
export async function listSecretIds(token: string, gcpProjectId: string, labelFilter: string): Promise<SecretObservation<string[]>> {
  const filter = encodeURIComponent(labelFilter);
  const ids: string[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const response = await request(token, `${API}/projects/${gcpProjectId}/secrets?filter=${filter}&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
    if (!response.ok) return { state: 'unknown', reason: `Listing Secret Manager secrets returned HTTP ${response.status}.` };
    const body = await response.json() as { secrets?: Array<{ name: string }>; nextPageToken?: string };
    ids.push(...(body.secrets ?? []).map((secret) => secret.name.split('/').pop()!));
    if (!body.nextPageToken) return { state: 'present', value: ids.sort() };
    pageToken = encodeURIComponent(body.nextPageToken);
  }
  return { state: 'unknown', reason: 'Secret Manager listing exceeded its page bound.' };
}

/** Adds a version holding `value`. Attempted once: a thrown error means the outcome is unknown. */
export function addSecretVersion(token: string, gcpProjectId: string, secretId: string, value: string): Promise<Response> {
  return request(token, `${secretUrl(gcpProjectId, secretId)}:addVersion`, {
    method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(value).toString('base64') } }),
  });
}

export function deleteSecret(token: string, gcpProjectId: string, secretId: string): Promise<Response> {
  return request(token, secretUrl(gcpProjectId, secretId), { method: 'DELETE' });
}

/** Metadata of the latest version (never its value). */
export function latestSecretVersion(token: string, gcpProjectId: string, secretId: string): Promise<Response> {
  return request(token, `${secretUrl(gcpProjectId, secretId)}/versions/latest`);
}

export function enabledSecretVersions(token: string, gcpProjectId: string, secretId: string): Promise<Response> {
  return request(token, `${secretUrl(gcpProjectId, secretId)}/versions?filter=state:ENABLED`);
}

/** Disables one version by its full resource name. */
export function disableSecretVersion(token: string, versionName: string): Promise<Response> {
  return request(token, `${API}/${versionName}:disable`, { method: 'POST', body: '{}' });
}

/** Reads the latest version's value. The caller must not log or return it. */
export function accessLatestSecretVersion(token: string, gcpProjectId: string, secretId: string): Promise<Response> {
  return fetch(`${secretUrl(gcpProjectId, secretId)}/versions/latest:access`, { headers: { Authorization: `Bearer ${token}` } });
}
