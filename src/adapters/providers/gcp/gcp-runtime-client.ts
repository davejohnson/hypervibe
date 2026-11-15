export class GcpRuntimeError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
export async function gcpRuntimeRequest(url: string, token: string, init: RequestInit = {}, request: typeof fetch = fetch): Promise<unknown | null> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['iam.googleapis.com', 'cloudresourcemanager.googleapis.com', 'run.googleapis.com', 'storage.googleapis.com', 'sqladmin.googleapis.com', 'secretmanager.googleapis.com', 'artifactregistry.googleapis.com', 'compute.googleapis.com', 'pubsub.googleapis.com'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.hash) throw new GcpRuntimeError('Invalid Google runtime API destination.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await request(url, { ...init, redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    if (response.status === 404 && (init.method === undefined || init.method === 'GET' || init.method === 'DELETE')) return null;
    if (!response.ok) throw new GcpRuntimeError(`Google runtime API returned HTTP ${response.status}; the selected resource remains unverified.`, response.status);
    if (!response.body) throw new GcpRuntimeError('Google runtime API response body is missing.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > 2_000_000) { await reader.cancel(); throw new GcpRuntimeError('Google runtime API response exceeds its bounded size.'); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof GcpRuntimeError) throw error;
    throw new GcpRuntimeError('Google runtime API request did not return verifiable evidence; reconcile this exact attempt before retrying a write.');
  } finally { clearTimeout(timer); }
}
