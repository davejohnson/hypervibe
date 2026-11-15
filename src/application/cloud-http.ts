import { HvError } from './results.js';

/** HTTP status is private control metadata, never an upstream response body. */
export class CloudHttpError extends HvError {
  constructor(public readonly status: number) {
    super(status < 500 ? 'VALIDATION' : 'PROVIDER_ERROR',
      status === 401 || status === 403
        ? 'Hypervibe access is expired, revoked, or not authorized. Start a new browser approval.'
        : 'Hypervibe rejected the request. Check connection status before retrying.');
  }
}

export function cloudAccessRejected(error: unknown): boolean {
  return error instanceof CloudHttpError && [401, 403].includes(error.status);
}

/** Callers validate the origin with normalizeHypervibeCloudBaseUrl. No upstream prose crosses this boundary. */
export function createCloudJsonClient(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000) {
  return async (pathname: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<unknown> => {
    if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\')
      || new URL(pathname, baseUrl).origin !== baseUrl) {
      throw new HvError('VALIDATION', 'Hypervibe requests require a relative API path on the approved origin.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(pathname, baseUrl), {
        method: options.method ?? 'POST',
        headers: {
          accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'hypervibe-cli',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new CloudHttpError(response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing body');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 64 * 1024) {
            await reader.cancel();
            throw new HvError('PROVIDER_ERROR', 'Hypervibe cloud returned an oversized response.');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof HvError) throw error;
      throw new HvError('PROVIDER_ERROR', 'Could not reach Hypervibe cloud.', {
        hint: 'Check connection status before retrying. No credential values are included in this error.',
      });
    } finally { clearTimeout(timeout); }
  };
}
