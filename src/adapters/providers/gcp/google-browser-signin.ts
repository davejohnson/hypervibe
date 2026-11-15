import { execFile } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * One-time Google sign-in for GCP setup without gcloud: the OAuth 2.0
 * installed-app flow with a loopback redirect and PKCE (RFC 8252). The user
 * signs in in their own browser; Hypervibe receives a short-lived access
 * token in memory and never stores it or a refresh token.
 *
 * Requires Hypervibe's registered "Desktop app" OAuth client. Google treats
 * desktop client secrets as non-confidential; PKCE protects the exchange.
 */
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret?: string;
}

export const GOOGLE_ADMIN_SCOPES = ['https://www.googleapis.com/auth/cloud-platform', 'openid', 'email'];

export function configuredGoogleOAuthClient(env: NodeJS.ProcessEnv = process.env): GoogleOAuthClient | undefined {
  const clientId = env.HYPERVIBE_GOOGLE_OAUTH_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  const clientSecret = env.HYPERVIBE_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

export function buildAuthorizationUrl(params: { client: GoogleOAuthClient; redirectUri: string; state: string; codeChallenge: string; loginHint?: string }): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', params.client.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_ADMIN_SCOPES.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Online access: no refresh token is issued, so nothing long-lived exists to protect.
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'select_account');
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  return url.toString();
}

function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(command, [url], () => { /* the URL is also returned for manual opening */ });
}

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h1>${title}</h1><p>${body}</p></body>`;

export interface BrowserSignInOptions {
  client: GoogleOAuthClient;
  /** Called with the sign-in URL so callers can also show it as a link. */
  onUrl?: (url: string) => void;
  openBrowser?: (url: string) => void;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Runs the sign-in and resolves with an access token held only in memory. */
export async function signInWithGoogle(options: BrowserSignInOptions): Promise<string> {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const fetchImpl = options.fetchImpl ?? fetch;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, token?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error); else resolve(token!);
    };
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/html' }).end(PAGE('Sign-in not accepted', 'This response did not come from the sign-in Hypervibe started. You can close this tab.'));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Sign-in cancelled', 'Nothing was changed. You can close this tab and ask your assistant to try again.'));
        finish(new Error('Google sign-in was cancelled.'));
        return;
      }
      try {
        const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
        const exchange = await fetchImpl('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri,
            client_id: options.client.clientId,
            ...(options.client.clientSecret ? { client_secret: options.client.clientSecret } : {}),
          }),
        });
        const body = await exchange.json() as { access_token?: string; error?: string };
        if (!exchange.ok || !body.access_token) throw new Error(`Google did not complete sign-in (${body.error ?? exchange.status}).`);
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Signed in', 'Hypervibe can now set up Google Cloud. You can close this tab and return to your assistant.'));
        finish(null, body.access_token);
      } catch (error) {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Sign-in failed', 'Nothing was changed. You can close this tab and ask your assistant to try again.'));
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const timer = setTimeout(() => finish(new Error('Google sign-in timed out. Ask your assistant to try again.')), options.timeoutMs ?? 5 * 60 * 1000);
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      const url = buildAuthorizationUrl({ client: options.client, redirectUri, state, codeChallenge: challenge });
      options.onUrl?.(url);
      (options.openBrowser ?? openInBrowser)(url);
    });
  });
}
