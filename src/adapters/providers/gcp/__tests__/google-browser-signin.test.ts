import { describe, expect, it, vi } from 'vitest';
import { signInWithGoogle } from '../google-browser-signin.js';

function callbackFrom(url: string, overrides: Record<string, string | null> = {}): string {
  const auth = new URL(url);
  const callback = new URL(auth.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', auth.searchParams.get('state')!);
  callback.searchParams.set('code', 'auth-code');
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) callback.searchParams.delete(key); else callback.searchParams.set(key, value);
  }
  return callback.toString();
}

describe('Google browser sign-in', () => {
  it('exchanges the code with PKCE over a loopback redirect and keeps only an in-memory access token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      return Response.json({ access_token: 'admin-token' });
    });
    let authUrl = '';
    const token = await signInWithGoogle({
      client: { clientId: 'client.apps.googleusercontent.com' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openBrowser: (url) => { authUrl = url; void fetch(callbackFrom(url)); },
    });
    expect(token).toBe('admin-token');
    const params = new URL(authUrl).searchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('access_type')).toBe('online');
  });

  it('ignores a callback with the wrong state and fails cleanly when the user cancels', async () => {
    const fetchImpl = vi.fn();
    await expect(signInWithGoogle({
      client: { clientId: 'client' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openBrowser: async (url) => {
        const forged = await fetch(callbackFrom(url, { state: 'forged' }));
        expect(forged.status).toBe(400);
        await fetch(callbackFrom(url, { code: null, error: 'access_denied' }));
      },
    })).rejects.toThrow(/cancelled/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
