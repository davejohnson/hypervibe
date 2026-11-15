import crypto from 'crypto';

/**
 * AWS Sign-In calls for Hypervibe's browser sign-in: the documented OAuth flow
 * `aws login` uses (same-device client, PKCE, DPoP). Credentials are short-lived
 * and stay in memory only.
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

const CLIENT_ID = 'arn:aws:signin:::devtools/same-device';
/**
 * AWS sign-in returns HTTP 400 (no redirect back) when the browser holds
 * cookies from an expired AWS session (aws/aws-cli#10186); signing out clears them.
 */
export const AWS_SIGN_OUT_URL = 'https://signin.aws.amazon.com/oauth?Action=logout&redirect_uri=https%3A%2F%2Faws.amazon.com';
const base64url = (value: Buffer) => value.toString('base64url');

/** A DPoP proof (RFC 9449) for one token request, signed with the sign-in's P-256 key. */
export function dpopProof(key: crypto.KeyObject, url: string): string {
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
  const header = base64url(Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } })));
  const payload = base64url(Buffer.from(JSON.stringify({ htm: 'POST', htu: url, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() })));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${base64url(signature)}`;
}

export async function exchangeAwsCode(params: { region: string; code: string; verifier: string; redirectUri: string; key: crypto.KeyObject }): Promise<AwsSignInSession> {
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

/** AWS's own sign-in page for a region, for one PKCE authorization request. */
export function awsAuthorizeUrl(region: string, params: { redirectUri: string; state: string; challenge: string }): string {
  return `https://${region}.signin.aws.amazon.com/v1/authorize?${new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, state: params.state, code_challenge_method: 'SHA-256', scope: 'openid', redirect_uri: params.redirectUri, code_challenge: params.challenge,
  })}`;
}
