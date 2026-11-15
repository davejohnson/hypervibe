/**
 * fetch for unreliable networks. Read-only requests (GET/HEAD) are retried a
 * few times when the connection itself fails; anything that changes state is
 * attempted once, because a dropped connection leaves its outcome unknown and
 * callers must observe before retrying.
 */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EADDRNOTAVAIL|socket hang up|network/i.test(`${error.message} ${(error as { cause?: { code?: string } }).cause?.code ?? ''}`));
}

/** `safeToRetry` marks a non-GET request that changes nothing (for example an OAuth token exchange). */
export async function fetchWithRetry(input: string | URL | Request, init: RequestInit = {}, attempts = 4, safeToRetry = false): Promise<Response> {
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const idempotent = safeToRetry || method === 'GET' || method === 'HEAD';
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (!idempotent || attempt >= attempts || !isNetworkError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
}
