import crypto from 'crypto';
import { CloudWatchLogsClient, DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DeleteTaskDefinitionsCommand, DeregisterTaskDefinitionCommand, ECSClient, ListTaskDefinitionsCommand } from '@aws-sdk/client-ecs';
import { IAMClient, ListRolesCommand } from '@aws-sdk/client-iam';
import { DeleteDBClusterSnapshotCommand, DescribeDBClusterSnapshotsCommand, DescribeDBClustersCommand, DescribeDBEngineVersionsCommand, DescribeEngineDefaultClusterParametersCommand, RDSClient } from '@aws-sdk/client-rds';
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

/** Whether a manual cluster snapshot with this name exists; AWS reuses no names, so a teardown's final snapshot needs it free. */
export async function clusterSnapshotState(access: AwsAccess, identifier: string): Promise<{ state: 'present'; createdAt?: string } | { state: 'absent' } | { state: 'unknown'; error: string }> {
  const rds = new RDSClient({ region: access.region, credentials: access.credentials });
  try {
    const found = await rds.send(new DescribeDBClusterSnapshotsCommand({ DBClusterSnapshotIdentifier: identifier }));
    const snapshot = found.DBClusterSnapshots?.find((entry) => entry.DBClusterSnapshotIdentifier === identifier);
    if (!snapshot) return { state: 'unknown', error: `AWS returned no snapshot ${identifier} and no not-found error.` };
    return { state: 'present', ...(snapshot.SnapshotCreateTime ? { createdAt: snapshot.SnapshotCreateTime.toISOString() } : {}) };
  } catch (error) {
    if (error instanceof Error && error.name === 'DBClusterSnapshotNotFoundFault') return { state: 'absent' };
    return { state: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }
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

/** Reads one generated value for the owner's local page; never forwards provider error contents. */
export async function readParameter(access: AwsAccess, name: string): Promise<{ value: string } | { error: string }> {
  try {
    const { Parameter: parameter } = await new SSMClient(access).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    if (parameter?.Name !== name || parameter.Type !== 'SecureString' || typeof parameter.Value !== 'string' || !parameter.Value) {
      return { error: 'Parameter Store did not return the requested secret value.' };
    }
    return { value: parameter.Value };
  } catch {
    return { error: 'Parameter Store could not read the secret value.' };
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

/** An environment's database on the shared testing cluster and its two logins. */
export interface AwsEnvironmentDatabase { name: string; owner: string; waker: string }

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

function checkedDatabase(database: AwsEnvironmentDatabase): AwsEnvironmentDatabase {
  for (const name of [database.name, database.owner, database.waker]) if (!IDENTIFIER.test(name)) throw new Error(`Database name ${name} is invalid.`);
  return database;
}

/** Runs master statements on the cluster through the Data API, waiting for a paused cluster to resume. */
async function masterSql(access: AwsAccess, params: { clusterArn: string; masterSecretArn: string }) {
  const data = new RDSDataClient(access);
  const sql = async (statement: string, database = 'postgres') => data.send(new ExecuteStatementCommand({ resourceArn: params.clusterArn, secretArn: params.masterSecretArn, database, sql: statement }));
  // A paused Aurora cluster wakes on the first statement; give it time.
  for (let attempt = 0; ; attempt++) {
    try { await sql('SELECT 1'); break; } catch (error) {
      if (attempt >= 8 || !/DatabaseResumingException|resum/i.test(error instanceof Error ? `${error.name} ${error.message}` : '')) throw error;
      await new Promise((done) => setTimeout(done, 10_000));
    }
  }
  return sql;
}

/**
 * Creates the environment's database on the shared cluster, its owner login (the
 * app's) and the worker waker's read-only login, and stores the connection URL.
 * No other login can connect to the database, so testing environments stay apart.
 */
export async function ensureDatabaseLogin(access: AwsAccess, params: {
  parameter: string; wakerSecrets: string[]; appLogin?: boolean; clusterArn: string; masterSecretArn: string; endpoint: string; databaseUrlKey: string;
  database: AwsEnvironmentDatabase;
}): Promise<ActionResult> {
  const { name, owner, waker } = checkedDatabase(params.database);
  const sql = await masterSql(access, params);
  const role = async (login: string, password: string) => {
    const exists = await sql(`SELECT 1 FROM pg_roles WHERE rolname = '${login}'`);
    await sql(`${exists.records?.length ? 'ALTER' : 'CREATE'} ROLE ${login} LOGIN PASSWORD '${scramVerifier(password)}'`);
  };
  if (params.appLogin !== false) {
    const password = crypto.randomBytes(24).toString('base64url');
    await role(owner, password);
    // Membership lets the master hand the database over now and drop it at teardown.
    await sql(`GRANT ${owner} TO CURRENT_USER`);
    if (!(await sql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`)).records?.length) await sql(`CREATE DATABASE ${name} OWNER ${owner}`);
    await sql(`ALTER DATABASE ${name} OWNER TO ${owner}`);
    await sql(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await sql(`ALTER SCHEMA public OWNER TO ${owner}`, name);
    await putParameter(access, params.parameter, `postgresql://${owner}:${password}@${params.endpoint}:5432/${name}?sslmode=require`);
  }
  // The waker reads pending work with its own login; pg_read_all_data survives table re-creation by a data copy,
  // and CONNECT on this database alone keeps it out of the other environments'.
  if (params.wakerSecrets.length) {
    const wakerPassword = crypto.randomBytes(24).toString('base64url');
    await role(waker, wakerPassword);
    await sql(`GRANT pg_read_all_data TO ${waker}`);
    await sql(`GRANT CONNECT ON DATABASE ${name} TO ${waker}`);
    const secrets = new SecretsManagerClient(access);
    for (const secretId of params.wakerSecrets) {
      await secrets.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify({ username: waker, password: wakerPassword }) }));
    }
  }
  return { success: true, message: params.appLogin !== false
    ? `Created database ${name} and its login, and stored ${params.databaseUrlKey} in Parameter Store.`
    : 'Created the worker waker\'s read-only database login.' };
}

/** Drops an environment's database and logins from the shared cluster; the other environments' databases stay. */
export async function dropAuroraEnvironmentDatabase(access: AwsAccess, params: { clusterArn: string; masterSecretArn: string; database: AwsEnvironmentDatabase }): Promise<ActionResult> {
  const { name, owner, waker } = checkedDatabase(params.database);
  const sql = await masterSql(access, params);
  await sql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  for (const login of [waker, owner]) {
    if ((await sql(`SELECT 1 FROM pg_roles WHERE rolname = '${login}'`)).records?.length) await sql(`DROP ROLE ${login}`);
  }
  return { success: true, message: `Dropped database ${name} and its logins; the shared cluster stays for the other testing environments.` };
}

/** The regional S3 endpoint an app's S3 client is pointed at. */
export const s3Endpoint = (region: string): string => `https://s3.${region}.amazonaws.com`;
