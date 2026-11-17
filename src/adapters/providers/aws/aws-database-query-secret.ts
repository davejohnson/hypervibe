import { DescribeSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { AwsAccess } from './aws-engine.client.js';

interface Scope { accountId: string; region: string; environmentId: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function awsDatabaseQuerySecretName(environmentId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(environmentId)) throw new Error('Invalid database environment identity.');
  return `hypervibe/${environmentId.toLowerCase()}/database-query`;
}
export function isAwsDatabaseQuerySecretArn(arn: unknown, scope: Scope): arn is string {
  return typeof arn === 'string' && arn.startsWith(`arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:${awsDatabaseQuerySecretName(scope.environmentId)}-`)
    && /^[a-zA-Z0-9]{6}$/.test(arn.slice(`arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:${awsDatabaseQuerySecretName(scope.environmentId)}-`.length));
}
/** Project only the exact owned secret identity. Its value never enters engine state. */
export function projectAwsDatabaseQuerySecret(state: unknown, scope: Scope): string {
  const rows = object(object(object(state).values).root_module).resources;
  const matches = Array.isArray(rows) ? rows.map(object).filter(row => row.address === 'aws_secretsmanager_secret.database_query') : [];
  const row = matches[0]; const value = object(row?.values); const tags = object(value.tags_all);
  if (matches.length !== 1 || row?.mode !== 'managed' || row.type !== 'aws_secretsmanager_secret' || row.tainted === true
    || value.name !== awsDatabaseQuerySecretName(scope.environmentId) || !isAwsDatabaseQuerySecretArn(value.arn, scope)
    || tags['managed-by'] !== 'hypervibe' || tags['hv-environment'] !== scope.environmentId.toLowerCase()) throw new Error('The environment database query credential has no exact owned engine identity.');
  return value.arn;
}
export async function verifyAwsDatabaseQuerySecret(access: AwsAccess, arn: string, scope: Scope, requireCurrent = true): Promise<void> {
  if (!isAwsDatabaseQuerySecretArn(arn, scope)) throw new Error('Database query credential is outside its accepted environment.');
  const client = new SecretsManagerClient({ ...access, maxAttempts: 1 });
  try {
    const observed = await client.send(new DescribeSecretCommand({ SecretId: arn }), { abortSignal: AbortSignal.timeout(30_000) });
    const tags = Object.fromEntries((observed.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    if (observed.ARN !== arn || observed.Name !== awsDatabaseQuerySecretName(scope.environmentId) || observed.DeletedDate
      || tags['managed-by'] !== 'hypervibe' || tags['hv-environment'] !== scope.environmentId.toLowerCase()
      || requireCurrent && !Object.values(observed.VersionIdsToStages ?? {}).some(stages => stages.includes('AWSCURRENT'))) throw new Error('Database query credential ownership or current version could not be verified.');
  } finally { client.destroy(); }
}
