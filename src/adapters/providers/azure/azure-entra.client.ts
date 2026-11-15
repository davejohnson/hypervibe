/**
 * Microsoft Entra ID token calls for Hypervibe's Azure sign-in: the OAuth 2.0
 * authorization-code flow with PKCE, using the Azure CLI's public client, which
 * is what `az login` does. Tokens stay in memory only.
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
  /** Absent for personal Microsoft accounts in a directory; nothing depends on it. */
  userObjectId?: string;
  /** For example someone@example.com. */
  username: string;
  expiresAt: string;
}

type Fetch = typeof fetch;

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
  type Claims = { tid?: string; oid?: string; preferred_username?: string; email?: string; upn?: string; unique_name?: string };
  const decode = (token: string): Claims => {
    try { return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Claims; } catch { return {}; }
  };
  // The Azure Resource Manager access token always names the tenant and user; the ID token may not.
  const idClaims = decode(body.id_token);
  const accessClaims = decode(body.access_token);
  const claims: Claims = { ...accessClaims, ...Object.fromEntries(Object.entries(idClaims).filter(([, value]) => value)) };
  claims.tid ??= accessClaims.tid;
  claims.oid ??= accessClaims.oid;
  // Personal Microsoft accounts in a directory carry no oid; only the tenant is needed.
  if (!claims.tid) {
    throw new Error(`Microsoft sign-in returned tokens without a tenant (ID token fields: ${Object.keys(idClaims).sort().join(', ') || 'none'}; access token fields: ${Object.keys(accessClaims).sort().join(', ') || 'none'}).`);
  }
  return {
    accessToken: body.access_token, refreshToken: body.refresh_token, tenantId: claims.tid, ...(claims.oid ? { userObjectId: claims.oid } : {}),
    username: claims.preferred_username ?? claims.email ?? claims.upn ?? claims.unique_name ?? claims.oid ?? 'your Microsoft account', expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
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
