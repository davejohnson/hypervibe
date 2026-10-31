import { GetCallerIdentityCommand, STSClient, type STSClientConfig } from '@aws-sdk/client-sts';
import { z } from 'zod';
import type { CloudDeploymentAdapterInputV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { CloudDeploymentAccessError, validateCloudDeploymentAdapterInputV1 } from '../../../domain/services/cloud-deployment-authentication.js';
import { DestinationBudget } from '../secret-destination-http.js';
import { boundAwsSdkResponses } from './aws-secret-destination.js';

export const awsDeploymentScopeSchema = z.object({ accountId: z.string().regex(/^\d{12}$/), region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/) }).strict();
/** Callback-only credentials. Every refresh proves the actual native role lifetime. */
export function createAwsDeploymentCredentialProvider(input: CloudDeploymentAdapterInputV1, options: { requestHandler?: STSClientConfig['requestHandler'] } = {}) {
  const validated = validateCloudDeploymentAdapterInputV1(input, { provider: 'aws', hostingProvider: 'ecs', parseScope: value => awsDeploymentScopeSchema.parse(value) });
  if (validated.authentication.kind !== 'aws-sts' || validated.connection.deployment.region !== validated.connection.nativeScope.region)
    throw new CloudDeploymentAccessError('scope_mismatch');
  const auth = validated.authentication, region = validated.connection.nativeScope.region, principal = auth.principal;
  const roleName = principal.roleArn.split('/').at(-1)!;
  return async (signal: AbortSignal) => {
    const budget = new DestinationBudget({ signal }); let client: STSClient | undefined;
    try {
      const response = await budget.wait(auth.getCredentials(budget.signal));
      const credentials = { accessKeyId: response.accessKeyId, secretAccessKey: response.secretAccessKey, sessionToken: response.sessionToken, expiration: new Date(response.expiresAt) };
      client = new STSClient({ region, credentials, maxAttempts: 1, requestHandler: options.requestHandler }); boundAwsSdkResponses(client);
      const identity = await budget.wait(client.send(new GetCallerIdentityCommand({}), { abortSignal: budget.signal }));
      const suffix = identity.UserId?.slice(principal.roleId.length + 1);
      if (identity.Account !== principal.accountId || !identity.UserId?.startsWith(`${principal.roleId}:`) || !suffix || !/^[A-Za-z0-9+=,.@_-]{2,64}$/.test(suffix)
        || identity.Arn !== `arn:aws:sts::${principal.accountId}:assumed-role/${roleName}/${suffix}`) throw new CloudDeploymentAccessError('scope_mismatch');
      return credentials;
    } catch (error) { if (error instanceof CloudDeploymentAccessError) throw error; throw new CloudDeploymentAccessError('authorization_unavailable'); }
    finally { client?.destroy(); budget.close(); }
  };
}
