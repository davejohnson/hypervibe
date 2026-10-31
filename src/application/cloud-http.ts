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

function discard(body: { cancel(): Promise<unknown> } | null | undefined): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* Cleanup cannot extend the deadline. */ }
}

function withinDeadline<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Request deadline reached'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('Request deadline reached');
      return work();
    }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Callers validate the origin with normalizeHypervibeCloudBaseUrl. No upstream prose crosses this boundary. */
export function createCloudJsonClient(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000) {
  return async (pathname: string, options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {}): Promise<unknown> => {
    if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\')
      || new URL(pathname, baseUrl).origin !== baseUrl) {
      throw new HvError('VALIDATION', 'Hypervibe requests require a relative API path on the approved origin.');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await withinDeadline(() => fetchImpl(new URL(pathname, baseUrl), {
        method: options.method ?? 'POST',
        headers: {
          accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'hypervibe-cli',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: 'error', signal: controller.signal,
      }).then(response => {
        // An injected transport can resolve after its caller already timed out.
        if (controller.signal.aborted) { discard(response.body); throw new Error('Request deadline reached'); }
        return response;
      }), controller.signal);
      if (!response.ok) {
        discard(response.body);
        throw new CloudHttpError(response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing body');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await withinDeadline(() => reader.read(), controller.signal);
          if (done) break;
          size += value.byteLength;
          if (size > 64 * 1024) {
            throw new HvError('PROVIDER_ERROR', 'Hypervibe cloud returned an oversized response.');
          }
          chunks.push(value);
        }
      } catch (error) {
        discard(reader);
        throw error;
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof HvError) throw error;
      throw new HvError('PROVIDER_ERROR', 'Could not reach Hypervibe cloud.', {
        hint: 'Check connection status before retrying. No credential values are included in this error.',
      });
    } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
  };
}
