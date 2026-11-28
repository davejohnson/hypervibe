import { AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { GitHubOidcContext } from '../domain/ports/engine-ci.port.js';
import type { RuntimeObserverBinding } from '../domain/spec/runtime-observation.js';
import { awsObserverReadPolicy } from './providers/aws/tofu/aws-observer.config.js';
import { githubOidcToken } from './providers/github/github-oidc.js';

async function postToken(url: string, body: URLSearchParams | Record<string, unknown>, authorization?: string) {
  const form = body instanceof URLSearchParams;
  const result = await fetch(url, {
    method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      ...(authorization ? { authorization: 'Bearer ' + authorization } : {}) },
    body: form ? body : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!result.ok) throw new Error('The cloud did not issue temporary observer access (HTTP ' + result.status + ').');
  const parsed = await result.json() as Record<string, unknown>;
  const token = parsed.access_token ?? parsed.accessToken;
  if (typeof token !== 'string' || !token || token.length > 32_768) throw new Error('The cloud returned an invalid observer token.');
  return token;
}

/** Only federated short-lived tokens, with no fallback to workstation or application credentials. */
export async function runtimeObserverAccess(binding: RuntimeObserverBinding, context: GitHubOidcContext) {
  if (context.repository !== binding.repository || context.ref !== 'refs/heads/' + binding.branch) throw new Error('Wrong observer repository or branch.');
  const redact = [context.requestToken];
  const assertionFor = async (audience: string) => {
    const assertion = await githubOidcToken(context, audience, fetch, { environmentName: binding.environmentName });
    redact.push(assertion);
    return assertion;
  };
  if (binding.provider === 'aws') {
    const assertion = await assertionFor('sts.amazonaws.com');
    const session = 'hv-observe-' + context.runId + '-' + context.runAttempt;
    const sts = new STSClient({ region: binding.aws.region, maxAttempts: 1, requestHandler: { requestTimeout: 30_000, connectionTimeout: 5000 },
      credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' } });
    try {
      const result = await sts.send(new AssumeRoleWithWebIdentityCommand({ RoleArn: binding.aws.roleArn, RoleSessionName: session, WebIdentityToken: assertion, DurationSeconds: 900, Policy: JSON.stringify(awsObserverReadPolicy(binding.aws)) }));
      const c = result.Credentials;
      if (result.AssumedRoleUser?.Arn !== `arn:aws:sts::${binding.aws.accountId}:assumed-role/${binding.aws.prefix}-observer/${session}`
        || !c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration || c.Expiration.getTime() <= Date.now()) throw new Error('AWS did not confirm the observer role.');
      redact.push(c.AccessKeyId, c.SecretAccessKey, c.SessionToken);
      return { provider: 'aws' as const, credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken }, redact };
    } finally { sts.destroy(); }
  }
  if (binding.provider === 'gcp') {
    const audience = '//iam.googleapis.com/' + binding.gcp.provider;
    const assertion = await assertionFor('https:' + audience);
    const scope = 'https://www.googleapis.com/auth/cloud-platform';
    const access = await postToken('https://sts.googleapis.com/v1/token', new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', audience, scope, subject_token: assertion,
    }));
    const token = await postToken('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + binding.gcp.serviceAccount + ':generateAccessToken',
      { scope: [scope], lifetime: '900s' }, access);
    redact.push(access, token);
    return { provider: 'gcp' as const, token, redact };
  }
  const assertion = await assertionFor('api://AzureADTokenExchange');
  const cache = new Map<string, string>();
  return { provider: 'azure' as const, redact, getToken: async (scope: string) => {
    if (!['https://management.azure.com/.default', 'https://api.loganalytics.io/.default'].includes(scope)) throw new Error('Unsupported observer token scope.');
    const cached = cache.get(scope);
    if (cached) return cached;
    const token = await postToken('https://login.microsoftonline.com/' + binding.azure.tenantId + '/oauth2/v2.0/token', new URLSearchParams({
      client_id: binding.azure.clientId, scope, grant_type: 'client_credentials', client_assertion: assertion,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    }));
    cache.set(scope, token); redact.push(token);
    return token;
  } };
}
