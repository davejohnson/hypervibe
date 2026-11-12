import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { contextRows, type ConnectContext } from './local-connect-page.js';
import { escapeHtml, openInBrowser, pageShell } from './local-paste-page.js';
import { requestingAgent, servingMcpClient } from './requesting-agent.js';

/**
 * Hypervibe's own AWS browser sign-in (no AWS CLI): the documented AWS
 * Sign-In OAuth flow used by `aws login` (same-device client, PKCE, DPoP).
 * The person signs in on AWS's own page; Hypervibe receives short-lived
 * credentials for one-time setup and keeps them in memory only.
 */
export interface AwsSignInSession {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  accountId: string;
  /** The signed-in identity, for example arn:aws:iam::123456789012:root. */
  identityArn: string;
  expiresAt: string;
}

export type AwsSignInResult =
  | { status: 'signed_in'; session: AwsSignInSession; /** Set when the person approved the review on the page. */ applied?: { ok: boolean; message: string } }
  | { status: 'waiting'; url: string; message: string }
  | { status: 'failed'; message: string };

const CLIENT_ID = 'arn:aws:signin:::devtools/same-device';
/**
 * AWS sign-in returns HTTP 400 (no redirect back) when the browser holds
 * cookies from an expired AWS session (aws/aws-cli#10186); signing out clears them.
 */
const AWS_SIGN_OUT_URL = 'https://signin.aws.amazon.com/oauth?Action=logout&redirect_uri=https%3A%2F%2Faws.amazon.com';
const base64url = (value: Buffer) => value.toString('base64url');

/** A DPoP proof (RFC 9449) for one token request, signed with the sign-in's P-256 key. */
export function dpopProof(key: crypto.KeyObject, url: string): string {
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
  const header = base64url(Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } })));
  const payload = base64url(Buffer.from(JSON.stringify({ htm: 'POST', htu: url, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() })));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${base64url(signature)}`;
}

async function exchangeCode(params: { region: string; code: string; verifier: string; redirectUri: string; key: crypto.KeyObject }): Promise<AwsSignInSession> {
  const url = `https://${params.region}.signin.aws.amazon.com/v1/token`;
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', DPoP: dpopProof(params.key, url) },
    body: JSON.stringify({ clientId: CLIENT_ID, grantType: 'authorization_code', code: params.code, codeVerifier: params.verifier, redirectUri: params.redirectUri }),
    signal: AbortSignal.timeout(20_000),
  });
  type TokenOutput = { accessToken?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }; idToken?: string; expiresIn?: number };
  const raw = (await response.json().catch(() => ({}))) as TokenOutput & { tokenOutput?: TokenOutput; error?: string; message?: string };
  // The service wraps the token in tokenOutput; accept the bare shape too.
  const body = raw.tokenOutput ?? raw;
  const token = body.accessToken;
  if (!response.ok || !token?.accessKeyId || !token.secretAccessKey || !token.sessionToken || !body.idToken) {
    const reason = [raw.error, raw.message].filter(Boolean).join(': ');
    throw new Error(`AWS sign-in did not return credentials (HTTP ${response.status}${reason ? `, ${reason.slice(0, 200)}` : ''}).`);
  }
  // The ID token's subject is the signed-in identity; its account is ARN segment 4.
  const claims = JSON.parse(Buffer.from(body.idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string };
  const identityArn = claims.sub ?? '';
  return {
    accessKeyId: token.accessKeyId, secretAccessKey: token.secretAccessKey, sessionToken: token.sessionToken,
    accountId: identityArn.split(':')[4] ?? '', identityArn,
    expiresAt: new Date(Date.now() + (body.expiresIn ?? 900) * 1000).toISOString(),
  };
}


/** What the person approves on the page right after signing in, so setup needs one sign-in and one click. */
export interface AwsSignInReview {
  titleHtml: string;
  leadHtml: string;
  items: string[];
  approveLabel: string;
  apply: () => Promise<{ ok: boolean; message: string }>;
}

let current: AwsSignInSession | undefined;
let pending: { url: string; result: Promise<AwsSignInResult> } | undefined;

/**
 * Opens Hypervibe's sign-in page and waits for the person to sign in to AWS.
 * Reuses a live session from this process. Under MCP a later call picks up a
 * sign-in that finished after the wait.
 */
export async function signInToAws(params: { region: string; context?: Partial<ConnectContext>; waitMs?: number; openBrowser?: (url: string) => void; /** Skip Hypervibe's intro page and open AWS's sign-in directly. */ direct?: boolean;
  review?: (session: AwsSignInSession) => Promise<AwsSignInReview | undefined> }): Promise<AwsSignInResult> {
  if (current && Date.parse(current.expiresAt) - Date.now() > 60_000) return { status: 'signed_in', session: current };
  if (!pending) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    // A UUID, as the AWS CLI sends.
    const state = crypto.randomUUID();
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const context: ConnectContext = { agent: requestingAgent(), ...params.context };
    let settle!: (result: AwsSignInResult) => void;
    const result = new Promise<AwsSignInResult>((done) => { settle = done; });
    let finished: AwsSignInResult | undefined;
    let review: AwsSignInReview | undefined;
    let applying = false;
    const close = (outcome: AwsSignInResult) => { settle(outcome); setTimeout(() => { server.close(); pending = undefined; }, 2000).unref(); };
    const server = http.createServer(async (request, response) => {
      const port = (server.address() as AddressInfo).port;
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      const approving = request.method === 'POST' && url.pathname === `/approve/${nonce}`;
      if (request.headers.host !== `127.0.0.1:${port}` || (request.method !== 'GET' && !approving)) { response.writeHead(request.method === 'GET' ? 421 : 405).end(); return; }
      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
      const scriptNonce = crypto.randomBytes(16).toString('base64');
      const page = (status: number, body: string) => response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; base-uri 'none'; form-action 'self'`, 'Referrer-Policy': 'no-referrer',
      }).end(pageShell({ tabTitle: 'Sign in to AWS', body, agent: context.agent, storedWhere: 'Used once to set up Hypervibe\'s own limited access, kept in memory only and never saved', checkedAgainst: 'AWS', scriptNonce }));
      const authorize = `https://${params.region}.signin.aws.amazon.com/v1/authorize?${new URLSearchParams({
        response_type: 'code', client_id: CLIENT_ID, state, code_challenge_method: 'SHA-256', scope: 'openid', redirect_uri: redirectUri, code_challenge: challenge,
      })}`;
      if (url.pathname === `/start/${nonce}`) { response.writeHead(302, { Location: authorize, 'Cache-Control': 'no-store' }).end(); return; }
      if (url.pathname === `/connect/${nonce}`) {
        page(200, finished?.status === 'signed_in'
          ? `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>Signed in to AWS</h1><p class="muted">You can close this tab; ${escapeHtml(context.agent)} continues from here.</p></section>`
          : `<p class="eyebrow">Connect AWS</p><h1>Sign in to your AWS account</h1>
<p class="lead">${escapeHtml(context.agent)} needs one sign-in to ${escapeHtml(context.purpose ?? 'set up Hypervibe on your AWS account')}. Hypervibe then creates its own limited access and does not use this sign-in again.</p>
<dl class="context">${contextRows(context).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>
<p><a class="button" href="${escapeHtml(authorize)}">Sign in with AWS ↗</a></p>
<p class="muted small">Opens AWS's own sign-in page (signin.aws.amazon.com). Use the account you want your app to run in.</p>
<p class="muted small">AWS shows <em>400 Bad Request</em>? That is an AWS bug with an expired AWS session in this browser. <a href="${AWS_SIGN_OUT_URL}" target="_blank" rel="noopener noreferrer">Sign out of AWS ↗</a>, then click Sign in with AWS again.</p>`);
        return;
      }
      if (approving) {
        const sameOrigin = request.headers.origin === `http://127.0.0.1:${port}`
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
      if (url.pathname === '/oauth/callback' && !finished) {
        const awsError = url.searchParams.get('error');
        if (awsError || url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
          const reason = awsError
            ? `AWS said: ${awsError}${url.searchParams.get('error_description') ? ` (${url.searchParams.get('error_description')})` : ''}`
            : url.searchParams.get('state') !== state ? 'This sign-in came from an older Hypervibe page.' : 'AWS did not send a sign-in code.';
          process.stderr.write(`aws sign-in callback rejected: ${awsError ?? (url.searchParams.get('state') !== state ? 'state mismatch' : 'no code')}\n`);
          page(400, `<h1>AWS sign-in did not finish</h1><p>${escapeHtml(reason)}</p><p><a class="button" href="/connect/${nonce}">Try again</a></p>`);
          return;
        }
        try {
          current = await exchangeCode({ region: params.region, code: url.searchParams.get('code')!, verifier, redirectUri, key: privateKey });
          finished = { status: 'signed_in', session: current };
          review = params.review ? await params.review(current).catch(() => undefined) : undefined;
          if (review) {
            page(200, `<p class="eyebrow">Signed in to AWS · account ${escapeHtml(current.accountId)}</p><h1>${review.titleHtml}</h1><p class="lead">${review.leadHtml}</p>
<ol class="review">${review.items.map((item) => `<li>${item}</li>`).join('')}</ol>
<form method="post" action="/approve/${nonce}"><input type="hidden" name="nonce" value="${nonce}"><button type="submit" data-busy="Setting up… this takes about a minute">${escapeHtml(review.approveLabel)}</button></form>
<p class="muted small">Not right? Close this tab; nothing is changed until you approve.</p>`);
            return;
          }
          page(200, `<section class="done"><div class="tick" aria-hidden="true">✓</div><h1>Signed in to AWS</h1><p>Account ${escapeHtml(current.accountId)}</p><p class="muted">You can close this tab; ${escapeHtml(context.agent)} continues from here.</p></section>`);
        } catch (error) {
          // The code is single-use; leave the page open so the person can sign in again.
          const message = error instanceof Error ? error.message : 'AWS sign-in failed.';
          process.stderr.write(`aws sign-in token exchange failed: ${message}\n`);
          page(502, `<h1>AWS sign-in did not finish</h1><p>${escapeHtml(message)}</p><p><a class="button" href="/connect/${nonce}">Try again</a></p>`);
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
    setTimeout(() => { if (!finished || (review && !applying)) { server.close(); pending = undefined; settle(finished ?? { status: 'failed', message: 'The AWS sign-in page expired.' }); } }, 30 * 60 * 1000).unref();
    pending = { url, result };
    (params.openBrowser ?? openInBrowser)(params.direct ? url.replace('/connect/', '/start/') : url);
  }
  const waited = await Promise.race([pending.result, new Promise<undefined>((done) => setTimeout(() => done(undefined), params.waitMs ?? (servingMcpClient() ? 4 * 60 * 1000 : 30 * 60 * 1000)).unref())]);
  return waited ?? { status: 'waiting', url: pending.url, message: `An AWS sign-in page is open in your browser (${pending.url}). Sign in there, then ${requestingAgent()} continues.` };
}
