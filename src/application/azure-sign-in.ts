import crypto from 'crypto';
import { browserSignIn, type BrowserSignInResult, type BrowserSignInReview, type BrowserSignInState } from './browser-sign-in.js';
import type { ConnectContext } from './local-connect-page.js';

/**
 * Hypervibe's own Azure browser sign-in (no Azure CLI): the OAuth 2.0
 * authorization-code flow with PKCE against Microsoft Entra ID, using the
 * Azure CLI's public client and a loopback redirect, which is what `az login`
 * does. The person signs in on Microsoft's own page; Hypervibe keeps the
 * tokens in memory only and uses them once for setup.
 */
import { azureAuthorizeUrl, exchangeAzureCode, type AzureSignInSession } from '../adapters/providers/azure/azure-entra.client.js';
export { ARM_SCOPE, AZURE_CLI_CLIENT_ID, GRAPH_SCOPE, azureAuthorizeUrl, azureTokenFor, exchangeAzureCode, type AzureSignInSession } from '../adapters/providers/azure/azure-entra.client.js';

export type AzureSignInResult = BrowserSignInResult<AzureSignInSession>;

type Fetch = typeof fetch;

/** What the person approves on the page right after signing in, so setup needs one sign-in and one click. */
export type AzureSignInReview = BrowserSignInReview;

const held: BrowserSignInState<AzureSignInSession> = {};

/** Forgets the in-memory sign-in (tests, or after setup finished). */
export function resetAzureSignIn(): void {
  held.current = undefined;
  held.pending = undefined;
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
  return browserSignIn<AzureSignInSession>({
    cloud: 'Azure', identityProvider: 'Microsoft', logName: 'azure', reuseMarginMs: 5 * 60_000,
    newState: () => crypto.randomBytes(24).toString('base64url'),
    // Entra registers the Azure CLI's redirect as http://localhost (any port), so the callback arrives on that host.
    origins: (port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    redirectUri: (port) => `http://localhost:${port}`,
    authorizeUrl: azureAuthorizeUrl,
    isCallback: (url) => url.pathname === '/' && (url.searchParams.has('code') || url.searchParams.has('error')),
    exchange: (exchange) => exchangeAzureCode(exchange, params.fetchImpl),
    defaultPurpose: 'set up Hypervibe on your Azure subscription',
    signInLink: 'start', retryLink: 'start',
    connectNotesHtml: '<p class="muted small">Opens Microsoft\'s own sign-in page (login.microsoftonline.com). Use the account that owns the subscription your app should run in. Microsoft names the app "Microsoft Azure CLI"; Hypervibe uses that sign-in so you have nothing to install.</p>',
    errorDescription: (description) => description.split(/\r?\n/)[0]!,
    sessionLabel: (session) => session.username,
    sessionSummary: (session) => session.username,
    logReviewFailure: true,
  }, held, { ...(params.context ? { context: params.context } : {}), ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}),
    ...(params.openBrowser ? { openBrowser: params.openBrowser } : {}), ...(params.review ? { review: params.review } : {}) });
}
