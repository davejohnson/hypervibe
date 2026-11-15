import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { contextRows, type ConnectContext } from './local-connect-page.js';
import { escapeHtml, openInBrowser, pageShell } from './local-paste-page.js';
import { requestingAgent, servingMcpClient } from './requesting-agent.js';

/**
 * The loopback browser sign-in every cloud shares: an OAuth authorization-code
 * flow with PKCE, served from 127.0.0.1 on a random port behind an unguessable
 * path. The person signs in on the cloud's own page; Hypervibe keeps the session
 * in memory only. A cloud supplies its authorize URL, code exchange and wording.
 */
export type BrowserSignInResult<TSession> =
  | { status: 'signed_in'; session: TSession; /** Set when the person approved the review on the page. */ applied?: { ok: boolean; message: string } }
  | { status: 'waiting'; url: string; message: string }
  | { status: 'failed'; message: string };

/** What the person approves on the page right after signing in, so setup needs one sign-in and one click. */
export interface BrowserSignInReview {
  titleHtml: string;
  leadHtml: string;
  items: string[];
  approveLabel: string;
  apply: () => Promise<{ ok: boolean; message: string }>;
}

/** One cloud's live sign-in, held by that cloud's module for the life of the process. */
export interface BrowserSignInState<TSession> {
  current?: TSession | undefined;
  pending?: { url: string; result: Promise<BrowserSignInResult<TSession>> } | undefined;
}

export interface BrowserSignInCloud<TSession extends { expiresAt: string }> {
  /** Shown to the person: "AWS", "Azure". */
  cloud: string;
  /** Who runs the sign-in page: "AWS", "Microsoft". */
  identityProvider: string;
  /** Prefix for diagnostics on stderr: "aws", "azure". */
  logName: string;
  /** A session this close to expiry is not reused. */
  reuseMarginMs: number;
  newState: () => string;
  /** Origins the local page answers to, for a port. */
  origins: (port: number) => string[];
  redirectUri: (port: number) => string;
  authorizeUrl: (params: { redirectUri: string; state: string; challenge: string }) => string;
  isCallback: (url: URL) => boolean;
  exchange: (params: { code: string; verifier: string; redirectUri: string }) => Promise<TSession>;
  /** Completes "needs one sign-in to ...". */
  defaultPurpose: string;
  /** 'authorize' links the button straight to the cloud; 'start' goes through the local redirect. */
  signInLink: 'authorize' | 'start';
  /** Where "Try again" returns after a failed sign-in. */
  retryLink: 'connect' | 'start';
  /** Extra paragraphs under the sign-in button (trusted HTML). */
  connectNotesHtml: string;
  /** Trims the provider's error description for display. */
  errorDescription?: (description: string) => string;
  /** Identifies the signed-in session on the review page, for example "account 123456789012". */
  sessionLabel: (session: TSession) => string;
  /** Shown alone on the confirmation page, for example "Account 123456789012". */
  sessionSummary: (session: TSession) => string;
  logReviewFailure?: boolean;
}

const base64url = (value: Buffer) => value.toString('base64url');

/**
 * Opens Hypervibe's sign-in page and waits for the person to sign in. Reuses a
 * live session from this process. Under MCP a later call picks up a sign-in that
 * finished after the wait.
 */
export async function browserSignIn<TSession extends { expiresAt: string }>(cloud: BrowserSignInCloud<TSession>, held: BrowserSignInState<TSession>, params: {
  context?: Partial<ConnectContext>;
  waitMs?: number;
  openBrowser?: (url: string) => void;
  /** Skip Hypervibe's intro page and open the cloud's sign-in directly. */
  direct?: boolean;
  review?: (session: TSession) => Promise<BrowserSignInReview | undefined>;
}): Promise<BrowserSignInResult<TSession>> {
  type Result = BrowserSignInResult<TSession>;
  if (held.current && Date.parse(held.current.expiresAt) - Date.now() > cloud.reuseMarginMs) return { status: 'signed_in', session: held.current };
  if (!held.pending) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    const state = cloud.newState();
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const context: ConnectContext = { agent: requestingAgent(), ...params.context };
    let settle!: (result: Result) => void;
    const result = new Promise<Result>((done) => { settle = done; });
    let finished: Result | undefined;
    let review: BrowserSignInReview | undefined;
    let applying = false;
    const close = (outcome: Result) => { settle(outcome); setTimeout(() => { server.close(); held.pending = undefined; }, 2000).unref(); };
    const server = http.createServer(async (request, response) => {
      const port = (server.address() as AddressInfo).port;
      const origins = cloud.origins(port);
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      const approving = request.method === 'POST' && url.pathname === `/approve/${nonce}`;
      if (!origins.includes(`http://${request.headers.host ?? ''}`) || (request.method !== 'GET' && !approving)) { response.writeHead(request.method === 'GET' ? 421 : 405).end(); return; }
      const redirectUri = cloud.redirectUri(port);
      const scriptNonce = crypto.randomBytes(16).toString('base64');
      const page = (status: number, body: string) => response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; base-uri 'none'; form-action 'self'`, 'Referrer-Policy': 'no-referrer',
      }).end(pageShell({ tabTitle: `Sign in to ${cloud.cloud}`, body, agent: context.agent, storedWhere: 'Used once to set up Hypervibe\'s own limited access, kept in memory only and never saved', checkedAgainst: cloud.identityProvider, scriptNonce }));
      const authorize = cloud.authorizeUrl({ redirectUri, state, challenge });
      const closeTab = `<p class="muted">You can close this tab; ${escapeHtml(context.agent)} continues from here.</p>`;
      if (url.pathname === `/start/${nonce}`) { response.writeHead(302, { Location: authorize, 'Cache-Control': 'no-store' }).end(); return; }
      if (url.pathname === `/connect/${nonce}`) {
        page(200, finished?.status === 'signed_in'
          ? `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>Signed in to ${cloud.cloud}</h1>${closeTab}</section>`
          : `<p class="eyebrow">Connect ${cloud.cloud}</p><h1>Sign in to your ${cloud.cloud} account</h1>
<p class="lead">${escapeHtml(context.agent)} needs one sign-in to ${escapeHtml(context.purpose ?? cloud.defaultPurpose)}. Hypervibe then creates its own limited access and does not use this sign-in again.</p>
<dl class="context">${contextRows(context).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>
<p><a class="button" href="${cloud.signInLink === 'authorize' ? escapeHtml(authorize) : `/start/${nonce}`}">Sign in with ${cloud.identityProvider} ↗</a></p>
${cloud.connectNotesHtml}`);
        return;
      }
      if (approving) {
        const sameOrigin = origins.includes(request.headers.origin ?? '')
          || ((request.headers.origin === undefined || request.headers.origin === 'null') && request.headers['sec-fetch-site'] === 'same-origin');
        let raw = '';
        for await (const chunk of request) { raw += String(chunk); if (raw.length > 4096) break; }
        if (!sameOrigin || new URLSearchParams(raw).get('nonce') !== nonce || !review || !held.current || applying) { response.writeHead(403).end(); return; }
        applying = true;
        const applied = await review.apply().catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : 'Setup failed.' }));
        page(applied.ok ? 200 : 502, applied.ok
          ? `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>Done</h1><p>${escapeHtml(applied.message)}</p>${closeTab}</section>`
          : `<h1>Setup did not finish</h1><p>${escapeHtml(applied.message)}</p><p class="muted">${escapeHtml(context.agent)} has the details and can run it again; what was created is reused.</p>`);
        close({ status: 'signed_in', session: held.current, applied });
        return;
      }
      if (!finished && cloud.isCallback(url)) {
        const retry = `<p><a class="button" href="/${cloud.retryLink}/${nonce}">Try again</a></p>`;
        const providerError = url.searchParams.get('error');
        const stale = url.searchParams.get('state') !== state;
        if (providerError || stale || !url.searchParams.get('code')) {
          const description = url.searchParams.get('error_description');
          const reason = providerError
            ? `${cloud.identityProvider} said: ${providerError}${description ? ` (${cloud.errorDescription ? cloud.errorDescription(description) : description})` : ''}`
            : stale ? 'This sign-in came from an older Hypervibe page.' : `${cloud.identityProvider} did not send a sign-in code.`;
          process.stderr.write(`${cloud.logName} sign-in callback rejected: ${providerError ?? (stale ? 'state mismatch' : 'no code')}\n`);
          page(400, `<h1>${cloud.cloud} sign-in did not finish</h1><p>${escapeHtml(reason)}</p>${retry}`);
          return;
        }
        try {
          const session = await cloud.exchange({ code: url.searchParams.get('code')!, verifier, redirectUri });
          held.current = session;
          finished = { status: 'signed_in', session };
          review = params.review ? await params.review(session).catch((error: unknown) => {
            if (cloud.logReviewFailure) process.stderr.write(`${cloud.logName} setup preview failed: ${error instanceof Error ? error.message : String(error)}\n`);
            return undefined;
          }) : undefined;
          if (review) {
            page(200, `<p class="eyebrow">Signed in to ${cloud.cloud} · ${escapeHtml(cloud.sessionLabel(session))}</p><h1>${review.titleHtml}</h1><p class="lead">${review.leadHtml}</p>
<ol class="review">${review.items.map((item) => `<li>${item}</li>`).join('')}</ol>
<form method="post" action="/approve/${nonce}"><input type="hidden" name="nonce" value="${nonce}"><button type="submit" data-busy="Setting up… this takes about a minute">${escapeHtml(review.approveLabel)}</button></form>
<p class="muted small">Not right? Close this tab; nothing is changed until you approve.</p>`);
            return;
          }
          page(200, `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>Signed in to ${cloud.cloud}</h1><p>${escapeHtml(cloud.sessionSummary(session))}</p>${closeTab}</section>`);
        } catch (error) {
          // The code is single-use; leave the page open so the person can sign in again.
          const message = error instanceof Error ? error.message : `${cloud.cloud} sign-in failed.`;
          process.stderr.write(`${cloud.logName} sign-in token exchange failed: ${message}\n`);
          page(502, `<h1>${cloud.cloud} sign-in did not finish</h1><p>${escapeHtml(message)}</p>${retry}`);
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
    setTimeout(() => { if (!finished || (review && !applying)) { server.close(); held.pending = undefined; settle(finished ?? { status: 'failed', message: `The ${cloud.cloud} sign-in page expired.` }); } }, 30 * 60 * 1000).unref();
    held.pending = { url, result };
    (params.openBrowser ?? openInBrowser)(params.direct ? url.replace('/connect/', '/start/') : url);
  }
  const pending = held.pending;
  const waited = await Promise.race([pending.result, new Promise<undefined>((done) => setTimeout(() => done(undefined), params.waitMs ?? (servingMcpClient() ? 4 * 60 * 1000 : 30 * 60 * 1000)).unref())]);
  return waited ?? { status: 'waiting', url: pending.url, message: `${/^[AEIOU]/.test(cloud.cloud) ? 'An' : 'A'} ${cloud.cloud} sign-in page is open in your browser (${pending.url}). Sign in there, then ${requestingAgent()} continues.` };
}
