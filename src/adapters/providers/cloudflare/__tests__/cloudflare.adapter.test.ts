import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareAdapter } from '../cloudflare.adapter.js';

function cfResponse<T>(result: T, init?: { success?: boolean; errors?: Array<{ code: number; message: string }>; status?: number }) {
  return Response.json({
    success: init?.success ?? true,
    errors: init?.errors ?? [],
    messages: [],
    result,
  }, { status: init?.status ?? 200 });
}

describe('CloudflareAdapter.verify', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verifies a valid token even when the scoped zone is not found yet', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse({ id: 'token-1' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([]);
      }
      if (href.includes('/zones?page=')) {
        return cfResponse([]);
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'valid-token' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.warning).toContain('could not find a Cloudflare zone');
  });

  it('normalizes copied Authorization header values before calling Cloudflare', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => cfResponse({ id: 'token-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: ' "Bearer cf-real-token" ' });

    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer cf-real-token');
  });

  it('verifies a valid token even when zone access cannot be confirmed', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse({ id: 'token-1' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([], {
          success: false,
          status: 403,
          errors: [{ code: 9109, message: 'Missing permission to list zones' }],
        });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'valid-token' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.warning).toContain('could not confirm Cloudflare zone access');
  });

  it('still rejects invalid API tokens', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse(null, {
          success: false,
          status: 401,
          errors: [{ code: 10000, message: 'Authentication error' }],
        });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'bad-token' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Token verification failed');
  });
});
