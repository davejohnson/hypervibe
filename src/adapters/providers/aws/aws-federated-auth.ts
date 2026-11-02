import { AssumeRoleWithWebIdentityCommand, GetCallerIdentityCommand, STSClient, type STSClientConfig } from '@aws-sdk/client-sts';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { boundAwsSdkResponses } from './aws-secret-destination.js';

export interface AwsFederatedAuthentication {
  accountId: string;
  region: string;
  roleArn: string;
  /** Required after native installation verification; omitted only during initial installation discovery. */
  roleId?: string;
  audience: string;
  hostSubject: string;
  secretArn?: string;
  getGoogleIdToken(audience: string, signal: AbortSignal): Promise<string>;
}
export interface AwsFederatedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
  roleId: string;
}

/** No customer key, ExternalId, ambient AWS chain, refresh credential or automatic replay. */
export function createAwsFederatedCredentialProvider(authentication: AwsFederatedAuthentication,
  options: { requestHandler?: STSClientConfig['requestHandler'] } = {}) {
  const role = /^arn:aws:iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(authentication.roleArn);
  if (!role || role[1] !== authentication.accountId || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(authentication.region)
    || !/^[1-9]\d{5,29}$/.test(authentication.hostSubject) || !authentication.audience.startsWith('https://')
    || authentication.audience.length > 2048 || (authentication.roleId && !/^[A-Z0-9]{16,128}$/.test(authentication.roleId)))
    throw new DestinationBoundaryError('invalid_input');
  if (authentication.secretArn && !authentication.secretArn.startsWith(`arn:aws:secretsmanager:${authentication.region}:${authentication.accountId}:secret:`))
    throw new DestinationBoundaryError('scope_mismatch');
  return async (signal: AbortSignal): Promise<AwsFederatedCredentials> => {
    const budget = new DestinationBudget({ signal });
    const sts = new STSClient({ region: authentication.region, maxAttempts: 1, requestHandler: options.requestHandler,
      // This operation is unsigned. Explicit failure prevents accidental SDK fallback to host keys.
      credentials: async () => { throw new DestinationBoundaryError('access_denied'); } });
    boundAwsSdkResponses(sts);
    try {
      const token = await budget.wait(authentication.getGoogleIdToken(authentication.audience, budget.signal));
      if (typeof token !== 'string' || token.length > 65536 || token.split('.').length !== 3) throw new DestinationBoundaryError('invalid_response');
      let claims: Record<string, unknown>;
      try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
      catch { throw new DestinationBoundaryError('invalid_response'); }
      if (claims.iss !== 'https://accounts.google.com' || claims.sub !== authentication.hostSubject || claims.azp !== authentication.hostSubject
        || claims.aud !== authentication.audience || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now())
        throw new DestinationBoundaryError('scope_mismatch');
      const response = await budget.wait(sts.send(new AssumeRoleWithWebIdentityCommand({ RoleArn: authentication.roleArn,
        RoleSessionName: 'hypervibe-cloud', DurationSeconds: 900, WebIdentityToken: token,
        ...(authentication.secretArn ? { Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow',
          Action: ['secretsmanager:DescribeSecret', 'secretsmanager:ListSecretVersionIds', 'secretsmanager:PutSecretValue'], Resource: authentication.secretArn }] }) } : {}),
      }), { abortSignal: budget.signal }));
      const value = response.Credentials;
      const roleId = response.AssumedRoleUser?.AssumedRoleId?.split(':')[0];
      const roleName = role[2].split('/').at(-1)!;
      if (!value?.AccessKeyId || !value.SecretAccessKey || !value.SessionToken || !(value.Expiration instanceof Date)
        || value.Expiration.getTime() <= Date.now() || value.Expiration.getTime() > Date.now() + 960000 || !roleId
        || response.SubjectFromWebIdentityToken !== authentication.hostSubject || response.Audience !== authentication.audience)
        throw new DestinationBoundaryError('invalid_response');
      if ((authentication.roleId && roleId !== authentication.roleId)
        || response.AssumedRoleUser?.Arn !== `arn:aws:sts::${authentication.accountId}:assumed-role/${roleName}/hypervibe-cloud`)
        throw new DestinationBoundaryError('scope_mismatch');
      const credentials = { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey, sessionToken: value.SessionToken, expiration: value.Expiration, roleId };
      const caller = new STSClient({ region: authentication.region, credentials, maxAttempts: 1, requestHandler: options.requestHandler });
      boundAwsSdkResponses(caller);
      try {
        const identity = await budget.wait(caller.send(new GetCallerIdentityCommand({}), { abortSignal: budget.signal }));
        if (identity.Account !== authentication.accountId || identity.UserId !== response.AssumedRoleUser!.AssumedRoleId
          || identity.Arn !== response.AssumedRoleUser!.Arn) throw new DestinationBoundaryError('scope_mismatch');
      } finally { caller.destroy(); }
      return credentials;
    } catch (error) {
      if (error instanceof DestinationBoundaryError) throw error;
      const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
      throw new DestinationBoundaryError(['AccessDenied', 'AccessDeniedException', 'InvalidIdentityToken', 'IDPRejectedClaim', 'ExpiredTokenException'].includes(String(name))
        ? 'access_denied' : 'provider_unavailable');
    } finally { sts.destroy(); budget.close(); }
  };
}
