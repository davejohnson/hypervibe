/** Resource Manager returns the subset held by the caller. An empty response object represents an empty set. */
export async function checkHmacCreateAccess(token: string, projectId: string): Promise<
  { state: 'granted' } | { state: 'missing' | 'unknown'; message: string }
> {
  const permission = 'storage.hmacKeys.create';
  const unknown = (detail: string) => ({ state: 'unknown' as const,
    message: `Google Cloud could not verify whether the deploy identity can create S3 access keys in ${projectId} (${detail}). Retry the permission check before changing access.` });
  try {
    const result = await fetch(`https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}:testIamPermissions`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: [permission] }),
    });
    if (!result.ok) return unknown(`HTTP ${result.status}`);
    const body = await result.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const permissions = 'permissions' in body ? body.permissions : undefined;
      if (Object.keys(body).length === 0 || Array.isArray(permissions) && permissions.length === 0) {
        return { state: 'missing', message: `The deploy identity lacks ${permission} on Google Cloud project ${projectId}.` };
      }
      if (Array.isArray(permissions) && permissions.length === 1 && permissions[0] === permission) return { state: 'granted' };
    }
    return unknown('unexpected response');
  } catch { return unknown('request or response could not be read'); }
}

const hmacKeyUrl = (gcpProjectId: string, accessId: string) => `https://storage.googleapis.com/storage/v1/projects/${gcpProjectId}/hmacKeys/${encodeURIComponent(accessId)}`;

/**
 * Deletes one exact Cloud Storage HMAC key. Cloud Storage only deletes an
 * INACTIVE key, so it is deactivated first. True when the key is confirmed gone.
 */
export async function retireStorageHmacKey(token: string, gcpProjectId: string, accessId: string): Promise<boolean> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const deactivated = await fetch(hmacKeyUrl(gcpProjectId, accessId), { method: 'PUT', headers, body: JSON.stringify({ state: 'INACTIVE' }) });
    if (deactivated.status === 404) return true;
    if (!deactivated.ok) return false;
    const deleted = await fetch(hmacKeyUrl(gcpProjectId, accessId), { method: 'DELETE', headers });
    return deleted.ok || deleted.status === 404;
  } catch {
    return false;
  }
}

export interface HmacKeyPublication {
  /** Creates the key. A thrown error means the outcome is unknown. */
  create(): Promise<Response>;
  /** Stores both halves; returns a failure message, or undefined when both are stored. */
  publish(accessId: string, secret: string): Promise<string | undefined>;
  retire(accessId: string): Promise<boolean>;
  /** Access IDs of keys created but not published, kept until each is confirmed deleted. */
  pending: { list(): string[]; add(accessId: string): void; remove(accessId: string): void };
}

/**
 * Creates an HMAC key and publishes it as one set. The key's access ID is recorded
 * before anything is stored, so a key that was created but not fully published is
 * always either deleted now or remembered and deleted before the next key is made.
 */
export async function publishNewHmacKey(deps: HmacKeyPublication): Promise<{ ok: true } | { ok: false; pending?: true; message: string }> {
  for (const accessId of deps.pending.list()) {
    if (!await deps.retire(accessId)) return { ok: false, message: 'An earlier S3 access key that was never put to use could not be deleted yet, so no new key was created. Run the same command again.' };
    deps.pending.remove(accessId);
  }
  let created: Response;
  try {
    created = await deps.create();
  } catch {
    return { ok: false, pending: true, message: 'Creating the S3 access key has an unknown outcome. Run the same command again.' };
  }
  if (!created.ok) return { ok: false, message: `Cloud Storage could not create an S3 access key (HTTP ${created.status}).` };
  const key = await created.json().catch(() => ({})) as { secret?: string; metadata?: { accessId?: string } };
  const accessId = key.metadata?.accessId;
  if (accessId) deps.pending.add(accessId);
  const failure = !key.secret || !accessId ? 'Cloud Storage returned an incomplete S3 access key.' : await deps.publish(accessId, key.secret).catch(() => 'The S3 access key could not be stored.');
  if (!failure) { deps.pending.remove(accessId!); return { ok: true }; }
  if (accessId && await deps.retire(accessId)) { deps.pending.remove(accessId); return { ok: false, message: `${failure} The new key was deleted; nothing was left behind.` }; }
  return { ok: false, message: `${failure}${accessId ? ' The new key could not be deleted yet; Hypervibe recorded it and deletes it before creating another.' : ''}` };
}
