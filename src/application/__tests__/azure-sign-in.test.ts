import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { AZURE_CLI_CLIENT_ID, azureAuthorizeUrl, azureTokenFor, exchangeAzureCode, resetAzureSignIn, signInToAzure, type AzureSignInSession } from '../azure-sign-in.js';

const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function request(port: number, path: string, options: { method?: string; host?: string; body?: string; origin?: string } = {}): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {
      host: options.host ?? `127.0.0.1:${port}`, ...(options.origin ? { origin: options.origin } : {}),
      ...(options.body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(options.body) } : {}),
    } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ...(res.headers.location ? { location: res.headers.location } : {}), body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

afterEach(() => resetAzureSignIn());

describe('Azure sign-in', () => {
  it('asks Entra for a PKCE code with the Azure CLI public client and a localhost redirect', () => {
    const url = new URL(azureAuthorizeUrl({ redirectUri: 'http://localhost:51234', state: 's', challenge: 'c' }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: AZURE_CLI_CLIENT_ID, response_type: 'code', redirect_uri: 'http://localhost:51234', code_challenge: 'c', code_challenge_method: 'S256', state: 's',
    });
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('exchanges the code with the verifier and reads tenant and user from the ID token', async () => {
    let form: URLSearchParams | undefined;
    const session = await exchangeAzureCode({ code: 'abc', verifier: 'v', redirectUri: 'http://localhost:1' }, async (_url, init) => {
      form = new URLSearchParams(String(init?.body));
      return json(200, { access_token: 'arm', refresh_token: 'rt', id_token: idToken({ tid: 't1', oid: 'u1', preferred_username: 'me@example.com' }), expires_in: 3600 });
    });
    expect(form?.get('code_verifier')).toBe('v');
    expect(form?.get('client_secret')).toBeNull();
    expect(session).toMatchObject({ accessToken: 'arm', refreshToken: 'rt', tenantId: 't1', userObjectId: 'u1', username: 'me@example.com' });
  });

  it('keeps the newest refresh token and explains a directory that needs another sign-in', async () => {
    const session: AzureSignInSession = { accessToken: 'a', refreshToken: 'old', tenantId: 't1', userObjectId: 'u', username: 'u', expiresAt: new Date().toISOString() };
    await expect(azureTokenFor(session, { tenantId: 't2', scope: 'x' }, async () => json(200, { access_token: 'graph', refresh_token: 'new' }))).resolves.toBe('graph');
    expect(session.refreshToken).toBe('new');
    await expect(azureTokenFor(session, { tenantId: 't3', scope: 'x' }, async () => json(400, { error: 'interaction_required', error_description: 'AADSTS50076: MFA required.\r\nTrace ID: 123' })))
      .rejects.toThrow(/sign in to directory t3 again.*AADSTS50076: MFA required\.$/);
  });

  it('accepts only its own state on the localhost callback, then applies the setup the person approves', async () => {
    let opened = '';
    let applied = 0;
    const result = signInToAzure({
      waitMs: 10_000, openBrowser: (url) => { opened = url; },
      fetchImpl: async () => json(200, { access_token: 'arm', refresh_token: 'rt', id_token: idToken({ tid: 't1', oid: 'u1', preferred_username: 'me@example.com' }) }),
      review: async () => ({ titleHtml: 'Set up', leadHtml: 'Lead', items: ['one'], approveLabel: 'Approve', apply: async () => { applied++; return { ok: true, message: 'All set.' }; } }),
    });
    while (!opened) await new Promise((done) => setTimeout(done, 10));
    const page = new URL(opened);
    const port = Number(page.port);
    const nonce = page.pathname.split('/').pop()!;
    const start = await request(port, `/start/${nonce}`);
    const authorize = new URL(start.location!);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`http://localhost:${port}`);
    // Other hosts are refused (DNS rebinding), and so is a callback without this page's state.
    expect((await request(port, `/connect/${nonce}`, { host: `evil.example:${port}` })).status).toBe(421);
    expect((await request(port, '/?code=x&state=forged', { host: `localhost:${port}` })).status).toBe(400);
    const review = await request(port, `/?code=x&state=${authorize.searchParams.get('state')}`, { host: `localhost:${port}` });
    expect(review.status).toBe(200);
    expect(review.body).toContain('Approve');
    // A cross-site post cannot approve.
    expect((await request(port, `/approve/${nonce}`, { method: 'POST', host: `localhost:${port}`, origin: 'https://evil.example', body: `nonce=${nonce}` })).status).toBe(403);
    const done = await request(port, `/approve/${nonce}`, { method: 'POST', host: `localhost:${port}`, origin: `http://localhost:${port}`, body: `nonce=${nonce}` });
    expect(done.body).toContain('All set.');
    expect(applied).toBe(1);
    await expect(result).resolves.toMatchObject({ status: 'signed_in', session: { tenantId: 't1' }, applied: { ok: true } });
  });
});

describe('personal Microsoft accounts', () => {
  it('signs in a personal account that is a member of a directory, whose tokens carry no object id', async () => {
    const { exchangeAzureCode } = await import('../azure-sign-in.js');
    const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
    const fetchImpl = (async () => new Response(JSON.stringify({
      access_token: jwt({ tid: 'tenant-1', idp: 'live.com', altsecid: '1:live.com:abc', email: 'person@outlook.com' }),
      refresh_token: 'r', id_token: jwt({ tid: 'tenant-1', idp: 'live.com', preferred_username: 'person@outlook.com' }), expires_in: 3600,
    }), { status: 200 })) as typeof fetch;
    const session = await exchangeAzureCode({ code: 'c', verifier: 'v', redirectUri: 'http://localhost:1/' }, fetchImpl);
    expect(session).toMatchObject({ tenantId: 'tenant-1', username: 'person@outlook.com' });
    expect(session.userObjectId).toBeUndefined();
  });
});
