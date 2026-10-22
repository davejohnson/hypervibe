import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubRegistryCredentials } from '../registry-credentials.js';

// Documentation-based synthetic HTTP contract, not live GHCR acceptance.
// https://distribution.github.io/distribution/spec/auth/token/
// https://distribution.github.io/distribution/spec/api/#existing-manifests
const digest = `sha256:${'a'.repeat(64)}`;
const image = `ghcr.io/acme/app@${digest}`;
const credentials = { username: 'owner', token: 'synthetic-private-pull-token' };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('GHCR credential validation', () => {
  it.each([{ access_token: 'grant' }, { token: 'grant', access_token: 'grant' }])('accepts documented token response %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(body))
      .mockResolvedValueOnce(new Response(null, { headers: { 'docker-content-digest': digest } })));
    await expect(githubRegistryCredentials.validate(image, credentials)).resolves.toBeUndefined();
  });
  it('validates the exact manifest with a bounded scoped token exchange', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: 'ephemeral-grant' }))
      .mockResolvedValueOnce(new Response(null, { headers: { 'docker-content-digest': digest } }));
    vi.stubGlobal('fetch', fetch);
    await githubRegistryCredentials.validate(image, credentials);
    const [tokenUrl, auth] = fetch.mock.calls[0];
    expect(tokenUrl.origin).toBe('https://ghcr.io');
    expect(tokenUrl.pathname).toBe('/token');
    expect(tokenUrl.searchParams.get('scope')).toBe('repository:acme/app:pull');
    expect(auth).toMatchObject({ redirect: 'error', headers: { Authorization: `Basic ${Buffer.from('owner:synthetic-private-pull-token').toString('base64')}` } });
    expect(fetch.mock.calls[1]).toEqual([`https://ghcr.io/v2/acme/app/manifests/${digest}`, expect.objectContaining({
      method: 'HEAD', redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer ephemeral-grant' }),
    })]);
  });

  it.each([
    'ghcr.io.evil.test/acme/app:tag', 'https://ghcr.io/acme/app:tag', 'ghcr.io/acme/../app:tag',
    'ghcr.io/acme/app:tag?secret=value', 'ghcr.io/acme/app', 'ghcr.io/owner:password@acme/app:tag',
  ])('rejects unapproved image destination %s without sending credentials', async target => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(githubRegistryCredentials.validate(target, credentials)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['unauthorized', 'redirect', 'oversize', 'malformed', 'conflicting-token', 'manifest-denied', 'digest-mismatch', 'missing-digest', 'transport'])(
    'rejects %s evidence without leaking credentials', async kind => {
      const fetch = vi.fn(async (url: URL | string) => {
        if (kind === 'transport') throw new Error(credentials.token);
        if (String(url).includes('/token?')) {
          if (kind === 'unauthorized') return new Response(credentials.token, { status: 401 });
          if (kind === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.test/token' } });
          if (kind === 'oversize') return new Response('x'.repeat(65537));
          if (kind === 'malformed') return Response.json({ token: null });
          if (kind === 'conflicting-token') return Response.json({ token: 'one', access_token: 'two' });
          return Response.json({ token: 'grant' });
        }
        return new Response(null, { status: kind === 'manifest-denied' ? 403 : 200,
          headers: kind === 'missing-digest' ? {} : { 'docker-content-digest': `sha256:${'b'.repeat(64)}` } });
      });
      vi.stubGlobal('fetch', fetch);
      await expect(githubRegistryCredentials.validate(image, credentials)).rejects.toThrow('could not verify access');
      try { await githubRegistryCredentials.validate(image, credentials); } catch (error) {
        expect(String(error)).not.toContain(credentials.token);
      }
      expect(fetch.mock.calls.every(([url]) => new URL(String(url)).origin === 'https://ghcr.io')).toBe(true);
    });

  it('never substitutes an API token for the explicit package-read credential', () => {
    expect(() => githubRegistryCredentials.resolve({ login: 'owner', apiToken: 'api-only' })).toThrow();
    expect(githubRegistryCredentials.resolve({ login: 'owner', apiToken: 'api-only', packageReadToken: credentials.token })).toEqual(credentials);
  });

  it('bounds the complete token response, including a stalled body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new Error('body deadline')));
    } }))));
    const validation = expect(githubRegistryCredentials.validate(image, credentials)).rejects.toThrow('could not verify access');
    await vi.advanceTimersByTimeAsync(20_001);
    await validation;
  });
});
