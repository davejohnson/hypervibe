import { AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { GitHubOidcContext } from '../../../domain/ports/engine-ci.port.js';
import type { EngineCiBinding } from '../../../domain/spec/engine-ci-binding.js';
import { githubOidcToken } from '../github/github-oidc.js';

/** The session can assume only the exact engine-managed release role. */
export async function awsCiAccess(binding: EngineCiBinding, context: GitHubOidcContext) {
  if (!binding.aws) throw new Error('AWS CI identity is missing.');
  const assertion = await githubOidcToken(context, 'sts.amazonaws.com');
  const sessionName = `hv-ci-${context.runId}-${context.runAttempt}`.slice(0, 64);
  // This API is intentionally unsigned. Never construct a default credential chain.
  const response = await new STSClient({ region: binding.region, maxAttempts: 1, requestHandler: { requestTimeout: 30_000, connectionTimeout: 5000 }, credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' } })
    .send(new AssumeRoleWithWebIdentityCommand({ RoleArn: binding.aws.roleArn, RoleSessionName: sessionName, WebIdentityToken: assertion, DurationSeconds: 3600 }));
  const c = response.Credentials;
  const expectedArn = `arn:aws:sts::${binding.aws.accountId}:assumed-role/${binding.aws.roleArn.split('/').at(-1)}/${sessionName}`;
  if (response.AssumedRoleUser?.Arn !== expectedArn || !c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration || c.Expiration.getTime() <= Date.now()) throw new Error('AWS did not confirm the exact release role and temporary credentials.');
  return { credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
    redact: [context.requestToken, assertion, c.AccessKeyId, c.SecretAccessKey, c.SessionToken] };
}
