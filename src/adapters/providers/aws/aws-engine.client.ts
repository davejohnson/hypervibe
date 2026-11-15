import crypto from 'crypto';
import { CloudWatchLogsClient, DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DeleteTaskDefinitionsCommand, DeregisterTaskDefinitionCommand, ECSClient, ListTaskDefinitionsCommand } from '@aws-sdk/client-ecs';
import { IAMClient, ListRolesCommand } from '@aws-sdk/client-iam';
import { DeleteDBClusterSnapshotCommand, DescribeDBClustersCommand, DescribeDBEngineVersionsCommand, DescribeEngineDefaultClusterParametersCommand, RDSClient } from '@aws-sdk/client-rds';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteParametersCommand, GetParameterCommand, GetParametersByPathCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { ActionResult } from '../../../domain/plan/converge.executor.js';
import { scramVerifier } from '../../../utils/scram.js';

/**
 * AWS calls the engine makes beside OpenTofu: Parameter Store secrets, the
 * database logins through the Data API, and teardown cleanup. Planning,
 * approval, receipts and bindings stay in the application layer.
 */
export interface AwsAccess {
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

const APP_DATABASE = 'app';
const APP_LOGIN = 'app_owner';
const WAKER_LOGIN = 'hv_waker';

export async function newestAuroraVersion(access: AwsAccess, major: number): Promise<string | undefined> {
  const rds = new RDSClient({ region: access.region, credentials: access.credentials });
  let marker: string | undefined;
  const versions: string[] = [];
  do {
    const page = await rds.send(new DescribeDBEngineVersionsCommand({ Engine: 'aurora-postgresql', Marker: marker }));
    versions.push(...(page.DBEngineVersions ?? []).map((entry) => entry.EngineVersion ?? '').filter((version) => version.startsWith(`${major}.`)));
    marker = page.Marker;
  } while (marker);
  return versions.sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1])).pop();
}

/** Whether Aurora PostgreSQL of this major already requires TLS by default; undefined when it cannot be read. */
export async function tlsRequiredByDefault(access: AwsAccess, major: string): Promise<boolean | undefined> {
  const rds = new RDSClient({ region: access.region, credentials: access.credentials });
  let marker: string | undefined;
  do {
    const page = await rds.send(new DescribeEngineDefaultClusterParametersCommand({ DBParameterGroupFamily: `aurora-postgresql${major}`, Marker: marker }));
    const forceSsl = page.EngineDefaults?.Parameters?.find((parameter) => parameter.ParameterName === 'rds.force_ssl');
    if (forceSsl) return forceSsl.ParameterValue === '1';
    marker = page.EngineDefaults?.Marker;
  } while (marker);
  return undefined;
}

export async function deleteFinalSnapshot(access: AwsAccess, identifier: string): Promise<ActionResult> {
  const rds = new RDSClient({ region: access.region, credentials: access.credentials });
  try {
    await rds.send(new DeleteDBClusterSnapshotCommand({ DBClusterSnapshotIdentifier: identifier }));
  } catch (error) {
    if (!(error instanceof Error && error.name === 'DBClusterSnapshotNotFoundFault')) throw error;
    return { success: true, message: `Snapshot ${identifier} no longer exists.` };
  }
  return { success: true, message: `Deleted the final database snapshot ${identifier}.` };
}

export async function emptyBucket(access: AwsAccess, bucket: string): Promise<ActionResult> {
  const s3 = new S3Client({ region: access.region, credentials: access.credentials });
  let deleted = 0;
  for (;;) {
    let listed;
    try {
      listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }));
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchBucket') return { success: true, message: `${bucket} no longer exists.` };
      throw error;
    }
    const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].map((entry) => ({ Key: entry.Key!, ...(entry.VersionId ? { VersionId: entry.VersionId } : {}) }));
    if (!objects.length) return { success: true, message: `Deleted ${deleted} file version(s) from ${bucket}.` };
    const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    if (result.Errors?.length) return { success: false, message: `${result.Errors.length} file(s) in ${bucket} could not be deleted (${result.Errors[0]!.Code ?? 'error'}).` };
    deleted += objects.length;
  }
}

export async function removeLeftovers(access: AwsAccess, metadata: { parameterPath: string; families: string[]; logGroups: string[]; prefix: string }): Promise<ActionResult> {
  const { region, credentials } = access;
  const ssm = new SSMClient({ region, credentials });
  const names: string[] = [];
  let token: string | undefined;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: metadata.parameterPath, Recursive: true, WithDecryption: false, NextToken: token }));
    names.push(...(page.Parameters ?? []).map((parameter) => parameter.Name!));
    token = page.NextToken;
  } while (token);
  for (let index = 0; index < names.length; index += 10) await ssm.send(new DeleteParametersCommand({ Names: names.slice(index, index + 10) }));
  const ecs = new ECSClient({ region, credentials });
  let revisions = 0;
  for (const family of metadata.families) {
    for (const status of ['ACTIVE', 'INACTIVE'] as const) {
      const arns: string[] = [];
      let next: string | undefined;
      do {
        const page = await ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: family, status, nextToken: next }));
        // familyPrefix also matches longer family names; keep only this exact family.
        arns.push(...(page.taskDefinitionArns ?? []).filter((arn) => arn.split('/').pop()!.replace(/:\d+$/, '') === family));
        next = page.nextToken;
      } while (next);
      if (status === 'ACTIVE') for (const arn of arns) await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }));
      const deletable = arns;
      for (let index = 0; index < deletable.length; index += 10) await ecs.send(new DeleteTaskDefinitionsCommand({ taskDefinitions: deletable.slice(index, index + 10) }));
      revisions += status === 'ACTIVE' ? arns.length : 0;
    }
  }
  const logs = new CloudWatchLogsClient({ region, credentials });
  for (const logGroupName of metadata.logGroups) {
    try { await logs.send(new DeleteLogGroupCommand({ logGroupName })); } catch (error) {
      if (!(error instanceof Error && error.name === 'ResourceNotFoundException')) throw error;
    }
  }
  // OpenTofu reported the roles deleted; confirm it, since a leftover role keeps the environment's access alive.
  const iam = new IAMClient({ region: 'us-east-1', credentials });
  const remaining: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListRolesCommand({ PathPrefix: '/hypervibe/app/', Marker: marker }));
    remaining.push(...(page.Roles ?? []).map((role) => role.RoleName!).filter((name) => name.startsWith(`${metadata.prefix}-`)));
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  if (remaining.length) return { success: false, message: `These roles of the environment still exist: ${remaining.join(', ')}. Run the teardown plan again.` };
  return { success: true, message: `Deleted ${names.length} setting(s) from Parameter Store, ${revisions} released task revision(s) and the build logs, and confirmed the environment's roles are gone.` };
}

/** Present, absent or unknown: only a confirmed ParameterNotFound is absence. */
export async function parameterExists(access: AwsAccess, name: string): Promise<'present' | 'absent' | { unknown: string }> {
  try { await new SSMClient(access).send(new GetParameterCommand({ Name: name })); return 'present'; } catch (error) {
    if (error instanceof ParameterNotFound) return 'absent';
    return { unknown: `Parameter Store could not be read (${error instanceof Error ? error.name : 'error'}).` };
  }
}

/** Saves a value, replacing any existing one. Throws when Parameter Store rejects it. */
export async function putParameter(access: AwsAccess, name: string, value: string): Promise<void> {
  await new SSMClient(access).send(new PutParameterCommand({ Name: name, Type: 'SecureString', Value: value, Overwrite: true }));
}

/** Stores a generated value unless the parameter already exists. */
export async function ensureGeneratedParameter(access: AwsAccess, name: string): Promise<ActionResult> {
  const existing = await parameterExists(access, name);
  if (existing === 'present') return { success: true, message: `${name} already exists.` };
  if (typeof existing === 'object') return { success: false, status: 'blocked', message: existing.unknown };
  await new SSMClient(access).send(new PutParameterCommand({ Name: name, Type: 'SecureString', Value: crypto.randomBytes(32).toString('base64url'), Overwrite: false,
    Tags: [{ Key: 'managed-by', Value: 'hypervibe' }] }));
  return { success: true, message: `Stored a generated value in ${name}.` };
}

/** The cluster OpenTofu created, read from RDS: its ARN, endpoint and RDS-managed master secret. */
export async function describeDatabaseCluster(access: AwsAccess, identifier: string): Promise<{ clusterArn?: string; secretArn?: string; endpoint?: string }> {
  const cluster = (await new RDSClient(access).send(new DescribeDBClustersCommand({ DBClusterIdentifier: identifier }))).DBClusters?.[0];
  return { ...(cluster?.DBClusterArn ? { clusterArn: cluster.DBClusterArn } : {}), ...(cluster?.MasterUserSecret?.SecretArn ? { secretArn: cluster.MasterUserSecret.SecretArn } : {}),
    ...(cluster?.Endpoint ? { endpoint: cluster.Endpoint } : {}) };
}

/** Creates the app's database login (and the worker waker's read-only login) and stores the connection URL. */
export async function ensureDatabaseLogin(access: AwsAccess, params: {
  parameter: string; wakerSecrets: string[]; appLogin?: boolean; clusterArn: string; masterSecretArn: string; endpoint: string; databaseUrlKey: string;
}): Promise<ActionResult> {
  const data = new RDSDataClient(access);
  const sql = async (statement: string) => data.send(new ExecuteStatementCommand({ resourceArn: params.clusterArn, secretArn: params.masterSecretArn, database: APP_DATABASE, sql: statement }));
  // A paused Aurora cluster wakes on the first statement; give it time.
  for (let attempt = 0; ; attempt++) {
    try { await sql('SELECT 1'); break; } catch (error) {
      if (attempt >= 8 || !/DatabaseResumingException|resum/i.test(error instanceof Error ? `${error.name} ${error.message}` : '')) throw error;
      await new Promise((done) => setTimeout(done, 10_000));
    }
  }
  if (params.appLogin !== false) {
    const password = crypto.randomBytes(24).toString('base64url');
    const exists = await sql(`SELECT 1 FROM pg_roles WHERE rolname = '${APP_LOGIN}'`);
    await sql(`${exists.records?.length ? 'ALTER' : 'CREATE'} ROLE ${APP_LOGIN} LOGIN PASSWORD '${scramVerifier(password)}'`);
    await sql(`GRANT ${APP_LOGIN} TO CURRENT_USER`);
    await sql(`ALTER DATABASE ${APP_DATABASE} OWNER TO ${APP_LOGIN}`);
    await sql(`ALTER SCHEMA public OWNER TO ${APP_LOGIN}`);
    await putParameter(access, params.parameter, `postgresql://${APP_LOGIN}:${password}@${params.endpoint}:5432/${APP_DATABASE}?sslmode=require`);
  }
  // The waker reads pending work with its own login; pg_read_all_data survives table re-creation by a data copy.
  if (params.wakerSecrets.length) {
    const wakerPassword = crypto.randomBytes(24).toString('base64url');
    const waker = await sql(`SELECT 1 FROM pg_roles WHERE rolname = '${WAKER_LOGIN}'`);
    await sql(`${waker.records?.length ? 'ALTER' : 'CREATE'} ROLE ${WAKER_LOGIN} LOGIN PASSWORD '${scramVerifier(wakerPassword)}'`);
    await sql(`GRANT pg_read_all_data TO ${WAKER_LOGIN}`);
    const secrets = new SecretsManagerClient(access);
    for (const secretId of params.wakerSecrets) {
      await secrets.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify({ username: WAKER_LOGIN, password: wakerPassword }) }));
    }
  }
  return { success: true, message: params.appLogin !== false
    ? `Created the app's database login and stored ${params.databaseUrlKey} in Parameter Store.`
    : 'Created the worker waker\'s read-only database login.' };
}

/** The regional S3 endpoint an app's S3 client is pointed at. */
export const s3Endpoint = (region: string): string => `https://s3.${region}.amazonaws.com`;
