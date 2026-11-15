import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { EngineAuthentication, InfrastructureEngineBackend } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { AwsEngineCredentials } from '../aws-engine.adapter.js';
import { buildAwsConfiguration, type AwsEngineInput } from './aws-engine.config.js';

/** Pinned hashicorp/aws provider (at least two weeks old when pinned) and its lock hashes. */
export const AWS_PROVIDER_VERSION = '6.70.0';
const AWS_PROVIDER_LOCK_HASHES = [
  'h1:0ppSZxnkr2mXy+OT2fE6FDY8B84U5l77bpAIDyIzxq0=',
  'h1:8B3+vezC72MHmr3u5F5UWjCG4OrpjfKMLnPDyxjvrSo=',
  'h1:GMjGoPo8GZ5iafPgiBK2TVZ6uiwaDrPdIb8hrNGceus=',
  'h1:GOgheaNYt+Q3RnZEl0aIQjp/fYLEZHlWkXvmLk+12EU=',
  'h1:JtwMUJT134sVjOaDFY9FJh1Mpdd5rgTEfeP3+PvezxA=',
  'h1:K2u8xN6vPcBA24fwoyh4glebpIXprMzf9Q+omP0ditA=',
  'h1:Oua4xmevWH4nSpBpLNo3SYHFSMorAZtYYI0cndQPHDA=',
  'h1:RCdEQN76x2oY6wsOWxMuD1/aL++bSEWnVbHAB+vAZa4=',
  'h1:WPSxowy+7ffZgsKexf9VNGXL/SfoAEiB8oSfQ/BWr+s=',
  'h1:YwOjwe/o7JFnVz9H/xyAEEgHMVCYFtuX0/97iYAZmsc=',
  'h1:e3kiK7jos0/EN/Dc6U+vbKBU53knKU6ILErBv0zdGec=',
  'h1:f/fWBs1fWquPmk03fimTUDc4d871DeMA29TTa8dyjXA=',
  'h1:iSpEapMJUOzrewKXUa0FJICuC2cKmy6H1PNSHH4L1Hc=',
  'h1:kMw0FvF0bvj1L7fCSPlg6BApfzkBbTITDBtplJ1Vtek=',
  'h1:lPMlFm5WfsjVFaDOzMYxnfwcDqfRuHeesiIXUca9oJQ=',
];

/**
 * OpenTofu runs as the project's deploy role: Hypervibe's stored key assumes
 * it for one hour and passes only those short-lived credentials to the engine.
 */
export async function awsEngineAuthentication(connection: AwsEngineCredentials): Promise<EngineAuthentication> {
  const sts = new STSClient({ region: connection.region, credentials: { accessKeyId: connection.accessKeyId, secretAccessKey: connection.secretAccessKey } });
  const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: connection.roleArn, RoleSessionName: 'hypervibe-engine', DurationSeconds: 3600 }));
  const credentials = assumed.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) throw new Error('AWS did not return deploy role credentials.');
  return {
    env: { AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken, AWS_REGION: connection.region },
    redact: [credentials.SecretAccessKey, credentials.SessionToken, connection.secretAccessKey],
  };
}

export const awsEngineBackend: InfrastructureEngineBackend<AwsEngineInput> = {
  provider: 'aws',
  engine: 'opentofu',
  capabilities: ['hosting'],
  providerRequirements: {
    aws: { source: 'hashicorp/aws', version: AWS_PROVIDER_VERSION, lockHashes: AWS_PROVIDER_LOCK_HASHES },
  },
  buildConfiguration: buildAwsConfiguration,
  // projectId is the AWS account; the probe proves the identity and the account it can reach.
  buildAuthenticationProbe: ({ projectId }) => ({
    files: {
      'provider.tf.json': { provider: { aws: [{ allowed_account_ids: [projectId] }] } },
      'probe.tf.json': {
        data: { aws_caller_identity: { current: {} }, aws_region: { current: {} } },
        output: {
          identity: { value: '${data.aws_caller_identity.current.arn}' },
          project_id: { value: '${data.aws_caller_identity.current.account_id}' },
          region: { value: '${data.aws_region.current.region}' },
        },
      },
    },
    resources: {},
  }),
};
