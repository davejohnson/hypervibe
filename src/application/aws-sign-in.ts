import crypto from 'crypto';
import { browserSignIn, type BrowserSignInResult, type BrowserSignInReview, type BrowserSignInState } from './browser-sign-in.js';
import { AWS_SIGN_OUT_URL, awsAuthorizeUrl, exchangeAwsCode, type AwsSignInSession } from '../adapters/providers/aws/aws-signin.client.js';
export { dpopProof, type AwsSignInSession } from '../adapters/providers/aws/aws-signin.client.js';
import type { ConnectContext } from './local-connect-page.js';

/**
 * Hypervibe's own AWS browser sign-in (no AWS CLI): the documented AWS
 * Sign-In OAuth flow used by `aws login` (same-device client, PKCE, DPoP).
 * The person signs in on AWS's own page; Hypervibe receives short-lived
 * credentials for one-time setup and keeps them in memory only.
 */
export type AwsSignInResult = BrowserSignInResult<AwsSignInSession>;

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
    authorizeUrl: (request) => awsAuthorizeUrl(params.region, request),
    isCallback: (url) => url.pathname === '/oauth/callback',
    exchange: ({ code, verifier, redirectUri }) => exchangeAwsCode({ region: params.region, code, verifier, redirectUri, key: privateKey }),
    defaultPurpose: 'set up Hypervibe on your AWS account',
    signInLink: 'authorize', retryLink: 'connect',
    connectNotesHtml: `<p class="muted small">Opens AWS's own sign-in page. Use the account you want your app to run in.</p>
<p class="muted small">AWS shows <em>400 Bad Request</em>? That is an AWS bug with an expired AWS session in this browser. <a href="${AWS_SIGN_OUT_URL}" target="_blank" rel="noopener noreferrer">Sign out of AWS ↗</a>, then click Sign in with AWS again.</p>`,
    sessionLabel: (session) => `account ${session.accountId}`,
    sessionSummary: (session) => `Account ${session.accountId}`,
  }, held, params);
}
