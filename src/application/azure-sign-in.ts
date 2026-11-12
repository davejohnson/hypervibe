import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { contextRows, type ConnectContext } from './local-connect-page.js';
import { escapeHtml, openInBrowser, pageShell } from './local-paste-page.js';
import { requestingAgent, servingMcpClient } from './requesting-agent.js';

/**
 * Hypervibe's own Azure browser sign-in (no Azure CLI): the OAuth 2.0
 * authorization-code flow with PKCE against Microsoft Entra ID, using the
 * Azure CLI's public client and a loopback redirect, which is what `az login`
 * does. The person signs in on Microsoft's own page; Hypervibe keeps the
 * tokens in memory only and uses them once for setup.
 */
export const AZURE_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const AUTHORITY = 'https://login.microsoftonline.com';
export const ARM_SCOPE = 'https://management.core.windows.net//.default';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export interface AzureSignInSession {
  /** Resource Manager token for the home tenant. */
  accessToken: string;
  /** Exchanged for tokens in other tenants and for Microsoft Graph; in memory only. */
  refreshToken: string;
  tenantId: string;
  userObjectId: string;
  /** For example someone@example.com. */
  username: string;
  expiresAt: string;
}

export type AzureSignInResult =
  | { status: 'signed_in'; session: AzureSignInSession; /** Set when the person approved the review on the page. */ applied?: { ok: boolean; message: string } }
  | { status: 'waiting'; url: string; message: string }
  | { status: 'failed'; message: string };

type Fetch = typeof fetch;
const base64url = (value: Buffer) => value.toString('base64url');

export function azureAuthorizeUrl(params: { redirectUri: string; state: string; challenge: string }): string {
  return `${AUTHORITY}/organizations/oauth2/v2.0/authorize?${new URLSearchParams({
    client_id: AZURE_CLI_CLIENT_ID, response_type: 'code', response_mode: 'query', redirect_uri: params.redirectUri,
    scope: `${ARM_SCOPE} offline_access openid profile`, state: params.state, code_challenge: params.challenge, code_challenge_method: 'S256',
    prompt: 'select_account',
  })}`;
}

type TokenResponse = { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; error?: string; error_description?: string; error_codes?: number[] };

async function tokenRequest(tenant: string, form: Record<string, string>, fetchImpl: Fetch): Promise<TokenResponse & { status: number }> {
  const response = await fetchImpl(`${AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: AZURE_CLI_CLIENT_ID, ...form }).toString(), signal: AbortSignal.timeout(20_000),
  });
  return { ...((await response.json().catch(() => ({}))) as TokenResponse), status: response.status };
}

/** Entra's reason without its trace and correlation ids. */
function entraReason(body: TokenResponse): string {
  return (body.error_description ?? body.error ?? '').split(/\r?\n/)[0]!.replace(/\s*Trace ID:.*$/i, '').slice(0, 240);
}

export async function exchangeAzureCode(params: { code: string; verifier: string; redirectUri: string }, fetchImpl: Fetch = fetch): Promise<AzureSignInSession> {
  const body = await tokenRequest('organizations', {
    grant_type: 'authorization_code', code: params.code, redirect_uri: params.redirectUri, code_verifier: params.verifier,
    scope: `${ARM_SCOPE} offline_access openid profile`,
  }, fetchImpl);
  if (body.status !== 200 || !body.access_token || !body.refresh_token || !body.id_token) {
    const reason = entraReason(body);
    throw new Error(`Microsoft sign-in did not return tokens (HTTP ${body.status}${reason ? `, ${reason}` : ''}).`);
  }
  const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { tid?: string; oid?: string; preferred_username?: string; email?: string };
  if (!claims.tid || !claims.oid) throw new Error('Microsoft sign-in returned an ID token without a tenant or user.');
  return {
    accessToken: body.access_token, refreshToken: body.refresh_token, tenantId: claims.tid, userObjectId: claims.oid,
    username: claims.preferred_username ?? claims.email ?? claims.oid, expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
  };
}

/**
 * A token for one resource in one tenant, from the sign-in's refresh token (the
 * way the Azure CLI reaches subscriptions in other directories and Microsoft Graph).
 * Entra rotates the refresh token; the session keeps the newest.
 */
export async function azureTokenFor(session: AzureSignInSession, params: { tenantId: string; scope: string }, fetchImpl: Fetch = fetch): Promise<string> {
  const body = await tokenRequest(params.tenantId, { grant_type: 'refresh_token', refresh_token: session.refreshToken, scope: `${params.scope} offline_access` }, fetchImpl);
  if (body.status !== 200 || !body.access_token) {
    const reason = entraReason(body);
    if (body.error === 'interaction_required' || body.error === 'invalid_grant') {
      throw new Error(`Microsoft needs you to sign in to directory ${params.tenantId} again (often multi-factor authentication)${reason ? `: ${reason}` : '.'}`);
    }
    throw new Error(`Microsoft did not issue a token for directory ${params.tenantId} (HTTP ${body.status}${reason ? `, ${reason}` : ''}).`);
  }
  if (body.refresh_token) session.refreshToken = body.refresh_token;
  return body.access_token;
}

/** What the person approves on the page right after signing in, so setup needs one sign-in and one click. */
export interface AzureSignInReview {
  titleHtml: string;
  leadHtml: string;
  items: string[];
  approveLabel: string;
  apply: () => Promise<{ ok: boolean; message: string }>;
}

let current: AzureSignInSession | undefined;
let pending: { url: string; result: Promise<AzureSignInResult> } | undefined;

/** Forgets the in-memory sign-in (tests, or after setup finished). */
export function resetAzureSignIn(): void {
  current = undefined;
  pending = undefined;
}

/**
 * Opens Hypervibe's sign-in page and waits for the person to sign in to Azure.
 * Reuses a live session from this process. Under MCP a later call picks up a
 * sign-in that finished after the wait.
 */
export async function signInToAzure(params: {
  context?: Partial<ConnectContext>;
  waitMs?: number;
  openBrowser?: (url: string) => void;
  review?: (session: AzureSignInSession) => Promise<AzureSignInReview | undefined>;
  fetchImpl?: Fetch;
}): Promise<AzureSignInResult> {
  if (current && Date.parse(current.expiresAt) - Date.now() > 5 * 60_000) return { status: 'signed_in', session: current };
  if (!pending) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const context: ConnectContext = { agent: requestingAgent(), ...params.context };
    let settle!: (result: AzureSignInResult) => void;
    const result = new Promise<AzureSignInResult>((done) => { settle = done; });
    let finished: AzureSignInResult | undefined;
    let review: AzureSignInReview | undefined;
    let applying = false;
    const close = (outcome: AzureSignInResult) => { settle(outcome); setTimeout(() => { server.close(); pending = undefined; }, 2000).unref(); };
    const server = http.createServer(async (request, response) => {
      const port = (server.address() as AddressInfo).port;
      // Entra registers the Azure CLI's redirect as http://localhost (any port), so the callback arrives on that host.
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      const approving = request.method === 'POST' && url.pathname === `/approve/${nonce}`;
      if (!origins.includes(`http://${request.headers.host ?? ''}`) || (request.method !== 'GET' && !approving)) { response.writeHead(request.method === 'GET' ? 421 : 405).end(); return; }
      const redirectUri = `http://localhost:${port}`;
      const scriptNonce = crypto.randomBytes(16).toString('base64');
      const page = (status: number, body: string) => response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; base-uri 'none'; form-action 'self'`, 'Referrer-Policy': 'no-referrer',
      }).end(pageShell({ tabTitle: 'Sign in to Azure', body, agent: context.agent, storedWhere: 'Used once to set up Hypervibe\'s own limited access, kept in memory only and never saved', checkedAgainst: 'Microsoft', scriptNonce }));
      const authorize = azureAuthorizeUrl({ redirectUri, state, challenge });
      if (url.pathname === `/start/${nonce}`) { response.writeHead(302, { Location: authorize, 'Cache-Control': 'no-store' }).end(); return; }
      if (url.pathname === `/connect/${nonce}`) {
        page(200, finished?.status === 'signed_in'
          ? `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>Signed in to Azure</h1><p class="muted">You can close this tab; ${escapeHtml(context.agent)} continues from here.</p></section>`
          : `<p class="eyebrow">Connect Azure</p><h1>Sign in to your Azure account</h1>
<p class="lead">${escapeHtml(context.agent)} needs one sign-in to ${escapeHtml(context.purpose ?? 'set up Hypervibe on your Azure subscription')}. Hypervibe then creates its own limited access and does not use this sign-in again.</p>
<dl class="context">${contextRows(context).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>
<p><a class="button" href="/start/${nonce}">Sign in with Microsoft ↗</a></p>
<p class="muted small">Opens Microsoft's own sign-in page (login.microsoftonline.com). Use the account that owns the subscription your app should run in. Microsoft names the app "Microsoft Azure CLI"; Hypervibe uses that sign-in so you have nothing to install.</p>`);
        return;
      }
      if (approving) {
        const sameOrigin = origins.includes(request.headers.origin ?? '')
          || ((request.headers.origin === undefined || request.headers.origin === 'null') && request.headers['sec-fetch-site'] === 'same-origin');
        let raw = '';
        for await (const chunk of request) { raw += String(chunk); if (raw.length > 4096) break; }
        if (!sameOrigin || new URLSearchParams(raw).get('nonce') !== nonce || !review || !current || applying) { response.writeHead(403).end(); return; }
        applying = true;
        const applied = await review.apply().catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : 'Setup failed.' }));
        page(applied.ok ? 200 : 502, applied.ok
          ? `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>Done</h1><p>${escapeHtml(applied.message)}</p><p class="muted">You can close this tab; ${escapeHtml(context.agent)} continues from here.</p></section>`
          : `<h1>Setup did not finish</h1><p>${escapeHtml(applied.message)}</p><p class="muted">${escapeHtml(context.agent)} has the details and can run it again; what was created is reused.</p>`);
        close({ status: 'signed_in', session: current, applied });
        return;
      }
      if (url.pathname === '/' && !finished && (url.searchParams.has('code') || url.searchParams.has('error'))) {
        const entraError = url.searchParams.get('error');
        if (entraError || url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
          const reason = entraError
            ? `Microsoft said: ${entraError}${url.searchParams.get('error_description') ? ` (${url.searchParams.get('error_description')!.split(/\r?\n/)[0]})` : ''}`
            : url.searchParams.get('state') !== state ? 'This sign-in came from an older Hypervibe page.' : 'Microsoft did not send a sign-in code.';
          process.stderr.write(`azure sign-in callback rejected: ${entraError ?? (url.searchParams.get('state') !== state ? 'state mismatch' : 'no code')}\n`);
          page(400, `<h1>Azure sign-in did not finish</h1><p>${escapeHtml(reason)}</p><p><a class="button" href="/start/${nonce}">Try again</a></p>`);
          return;
        }
        try {
          current = await exchangeAzureCode({ code: url.searchParams.get('code')!, verifier, redirectUri }, params.fetchImpl);
          finished = { status: 'signed_in', session: current };
          review = params.review ? await params.review(current).catch((error: unknown) => {
            process.stderr.write(`azure setup preview failed: ${error instanceof Error ? error.message : String(error)}\n`);
            return undefined;
          }) : undefined;
          if (review) {
            page(200, `<p class="eyebrow">Signed in to Azure · ${escapeHtml(current.username)}</p><h1>${review.titleHtml}</h1><p class="lead">${review.leadHtml}</p>
<ol class="review">${review.items.map((item) => `<li>${item}</li>`).join('')}</ol>
<form method="post" action="/approve/${nonce}"><input type="hidden" name="nonce" value="${nonce}"><button type="submit" data-busy="Setting up… this takes about a minute">${escapeHtml(review.approveLabel)}</button></form>
<p class="muted small">Not right? Close this tab; nothing is changed until you approve.</p>`);
            return;
          }
          page(200, `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>Signed in to Azure</h1><p>${escapeHtml(current.username)}</p><p class="muted">You can close this tab; ${escapeHtml(context.agent)} continues from here.</p></section>`);
        } catch (error) {
          // The code is single-use; leave the page open so the person can sign in again.
          const message = error instanceof Error ? error.message : 'Azure sign-in failed.';
          process.stderr.write(`azure sign-in token exchange failed: ${message}\n`);
          page(502, `<h1>Azure sign-in did not finish</h1><p>${escapeHtml(message)}</p><p><a class="button" href="/start/${nonce}">Try again</a></p>`);
          return;
        }
        close(finished);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connect/${nonce}`;
    // Unapproved after sign-in: report the session so the agent can ask in chat instead.
    setTimeout(() => { if (!finished || (review && !applying)) { server.close(); pending = undefined; settle(finished ?? { status: 'failed', message: 'The Azure sign-in page expired.' }); } }, 30 * 60 * 1000).unref();
    pending = { url, result };
    (params.openBrowser ?? openInBrowser)(url);
  }
  const waited = await Promise.race([pending.result, new Promise<undefined>((done) => setTimeout(() => done(undefined), params.waitMs ?? (servingMcpClient() ? 4 * 60 * 1000 : 30 * 60 * 1000)).unref())]);
  return waited ?? { status: 'waiting', url: pending.url, message: `An Azure sign-in page is open in your browser (${pending.url}). Sign in there, then ${requestingAgent()} continues.` };
}
