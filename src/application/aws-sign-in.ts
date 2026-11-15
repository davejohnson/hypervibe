import crypto from 'crypto';
import { browserSignIn, type BrowserSignInResult, type BrowserSignInReview, type BrowserSignInState } from './browser-sign-in.js';
import type { ConnectContext } from './local-connect-page.js';

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

export type AwsSignInResult = BrowserSignInResult<AwsSignInSession>;

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
export type AwsSignInReview = BrowserSignInReview;

const held: BrowserSignInState<AwsSignInSession> = {};

/**
 * Opens Hypervibe's sign-in page and waits for the person to sign in to AWS.
 * Reuses a live session from this process. Under MCP a later call picks up a
 * sign-in that finished after the wait.
 */
export async function signInToAws(params: { region: string; context?: Partial<ConnectContext>; waitMs?: number; openBrowser?: (url: string) => void; /** Skip Hypervibe's intro page and open AWS's sign-in directly. */ direct?: boolean;
  review?: (session: AwsSignInSession) => Promise<AwsSignInReview | undefined> }): Promise<AwsSignInResult> {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return browserSignIn<AwsSignInSession>({
    cloud: 'AWS', identityProvider: 'AWS', logName: 'aws', reuseMarginMs: 60_000,
    // A UUID, as the AWS CLI sends.
    newState: () => crypto.randomUUID(),
    origins: (port) => [`http://127.0.0.1:${port}`],
    redirectUri: (port) => `http://127.0.0.1:${port}/oauth/callback`,
    authorizeUrl: ({ redirectUri, state, challenge }) => `https://${params.region}.signin.aws.amazon.com/v1/authorize?${new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, state, code_challenge_method: 'SHA-256', scope: 'openid', redirect_uri: redirectUri, code_challenge: challenge,
    })}`,
    isCallback: (url) => url.pathname === '/oauth/callback',
    exchange: ({ code, verifier, redirectUri }) => exchangeCode({ region: params.region, code, verifier, redirectUri, key: privateKey }),
    defaultPurpose: 'set up Hypervibe on your AWS account',
    signInLink: 'authorize', retryLink: 'connect',
    connectNotesHtml: `<p class="muted small">Opens AWS's own sign-in page (signin.aws.amazon.com). Use the account you want your app to run in.</p>
<p class="muted small">AWS shows <em>400 Bad Request</em>? That is an AWS bug with an expired AWS session in this browser. <a href="${AWS_SIGN_OUT_URL}" target="_blank" rel="noopener noreferrer">Sign out of AWS ↗</a>, then click Sign in with AWS again.</p>`,
    sessionLabel: (session) => `account ${session.accountId}`,
    sessionSummary: (session) => `Account ${session.accountId}`,
  }, held, params);
}
