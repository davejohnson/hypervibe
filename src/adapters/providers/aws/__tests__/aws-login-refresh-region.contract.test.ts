import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { AwsConnectionAuthentication } from '../aws-authentication.js';
import { createAwsOperatorArtifactCapability } from '../aws-operator-artifacts.js';
import { AwsSecretsAdapter } from '../../secretmanagers/aws-secrets.adapter.js';

// Reconstructed SDK login cache and serialized Signin responses; only transport
// is replaced. The real default/profile chain, expiry, DPoP, refresh, cache write,
// signing and STS validation execute. No real user profile or cloud is accessed.
// https://docs.aws.amazon.com/sdkref/latest/guide/feature-login-credentials.html
// https://github.com/aws/aws-sdk-js-v3/blob/main/packages-internal/credential-provider-login/src/LoginCredentialsFetcher.ts
// https://github.com/aws/aws-sdk-js-v3/blob/main/packages-internal/types/src/identity/AwsCredentialIdentity.ts
const accountId = '123456789012', profile = 'hypervibe-login-refresh-contract', targetRegion = 'us-west-2';
const loginSession = `arn:aws:iam::${accountId}:user/Operator`;
const refreshedKey = 'ASIAREFRESHEDCONTRACT', refreshedSecret = 'synthetic-refreshed-secret', refreshedSession = 'synthetic-refreshed-session';
const paths = ['hosting-storage', 'operator-artifacts', 'secret-manager'] as const;
let directory: string, configFile: string, cacheFile: string;
let requests: Array<{ hostname: string; action: string }>;
let identityAccount: string;

function writeProfile(region?: string) {
  writeFileSync(configFile, `[profile ${profile}]\nlogin_session=${loginSession}\n${region ? `region=${region}\n` : ''}`, { mode: 0o600 });
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-login-region-'));
  configFile = path.join(directory, 'config');
  const credentialsFile = path.join(directory, 'credentials'), cache = path.join(directory, 'login-cache');
  mkdirSync(cache, { mode: 0o700 }); writeFileSync(credentialsFile, '', { mode: 0o600 }); writeProfile();
  cacheFile = path.join(cache, createHash('sha256').update(loginSession).digest('hex') + '.json');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(cacheFile, JSON.stringify({ clientId: 'arn:aws:signin:::devtools/same-device', refreshToken: 'synthetic-refresh-token',
    tokenType: 'aws_sigv4', idToken: 'synthetic-id-token', dpopKey: privateKey.export({ type: 'sec1', format: 'pem' }),
    accessToken: { accessKeyId: 'ASIAEXPIREDCONTRACT', secretAccessKey: 'synthetic-expired-secret', sessionToken: 'synthetic-expired-session',
      accountId, expiresAt: new Date(Date.now() - 60000).toISOString() } }), { mode: 0o600 });
  for (const [key, value] of Object.entries({ AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
    AWS_LOGIN_CACHE_DIRECTORY: cache, AWS_PROFILE: profile, AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1' })) vi.stubEnv(key, value);
  for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_DEFAULT_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME']) vi.stubEnv(key, undefined);
  requests = []; identityAccount = accountId;
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async request => {
    const serialized = typeof request.body === 'string' ? request.body : Buffer.from(request.body ?? []).toString('utf8');
    if (request.path === '/v1/token') {
      requests.push({ hostname: request.hostname, action: 'CreateOAuth2Token' });
      const body = JSON.parse(serialized);
      expect(body).toMatchObject({ grantType: 'refresh_token', refreshToken: 'synthetic-refresh-token' });
      expect(request.headers.DPoP ?? request.headers.dpop).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
      return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({
        accessToken: { accessKeyId: refreshedKey, secretAccessKey: refreshedSecret, sessionToken: refreshedSession },
        tokenType: 'aws_sigv4', expiresIn: 900, refreshToken: 'synthetic-next-refresh-token', idToken: 'synthetic-id-token',
      })) } };
    }
    const action = new URLSearchParams(serialized).get('Action');
    expect(action).toBe('GetCallerIdentity');
    requests.push({ hostname: request.hostname, action: action! });
    expect(request.headers.authorization).toContain(`Credential=${refreshedKey}/`);
    expect(request.headers['x-amz-security-token']).toBe(refreshedSession);
    return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(
      `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::${identityAccount}:user/Operator</Arn><Account>${identityAccount}</Account><UserId>AIDACKCEVSQ6C2EXAMPLE</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`) } };
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(String(url)).toBe(`https://secretsmanager.${targetRegion}.amazonaws.com/`);
    expect(new Headers(options?.headers).get('x-amz-security-token')).toBe(refreshedSession);
    requests.push({ hostname: new URL(String(url)).hostname, action: 'ListSecrets' });
    return new Response(JSON.stringify({ SecretList: [] }), { status: 200 });
  }));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); });

async function resolveThrough(kind: typeof paths[number]) {
  if (kind === 'hosting-storage') {
    const auth = new AwsConnectionAuthentication({ authMode: 'default', profile, accountId }, targetRegion);
    await auth.credentials(); expect(auth.identity()).toEqual({ accountId, profile }); return;
  }
  if (kind === 'operator-artifacts') {
    const capability = createAwsOperatorArtifactCapability();
    const scope = capability.parseDeclaration({ scopeKind: 's3-cloudformation-publication-v1', accountId, region: targetRegion }, ['aws-collection-template-v1'], {});
    const context = await capability.create(scope);
    const result = await context.authentication.awsSession!.getCredentials(AbortSignal.timeout(5000));
    expect(result.expiration.getTime()).toBeGreaterThan(Date.now()); return;
  }
  const adapter = new AwsSecretsAdapter(); await adapter.connect({ region: targetRegion });
  expect((await adapter.verify()).success).toBe(true);
}

describe('scoped native AWS login refresh region', () => {
  it.each(paths)('%s refreshes an expired regionless login using the selected target region', async kind => {
    await resolveThrough(kind);
    const refresh = requests.filter(item => item.action === 'CreateOAuth2Token');
    expect(refresh).toHaveLength(1); expect(refresh[0].hostname).toBe(`${targetRegion}.signin.aws.amazon.com`);
    expect(Date.parse(JSON.parse(readFileSync(cacheFile, 'utf8')).accessToken.expiresAt)).toBeGreaterThan(Date.now());
    expect(readFileSync(configFile, 'utf8')).not.toContain('region=');
  });
  it.each(paths)('%s preserves an explicitly configured login region', async kind => {
    writeProfile('us-east-2');
    await resolveThrough(kind);
    expect(requests.filter(item => item.action === 'CreateOAuth2Token')).toEqual([{ hostname: 'us-east-2.signin.aws.amazon.com', action: 'CreateOAuth2Token' }]);
    expect(requests.filter(item => item.action !== 'CreateOAuth2Token').every(item => item.hostname.includes(`.${targetRegion}.`))).toBe(true);
  });
  it('still verifies the pinned account after refresh before returning local deployment credentials', async () => {
    identityAccount = '999999999999';
    const auth = new AwsConnectionAuthentication({ authMode: 'default', profile, accountId }, targetRegion);
    await expect(auth.credentials()).rejects.toThrow(/different account/);
    expect(requests.map(item => item.action)).toEqual(['CreateOAuth2Token', 'GetCallerIdentity']);
    expect(auth.identity()).toEqual({});
  });
});
