import { isAwsDatabaseQuerySecretArn, verifyAwsDatabaseQuerySecret } from '../aws/aws-database-query-secret.js';
import { recoverNativeEngineDatabaseBinding } from './engine-database-state.js';
import { engineDatabaseIdentity } from '../../../domain/services/engine-database-access.service.js';
import { randomUUID } from 'node:crypto';
import { DescribeDBClustersCommand, RDSClient } from '@aws-sdk/client-rds';
import { AwsEngineCredentialsSchema } from '../aws/aws-engine.adapter.js';
import { awsEngineAuthentication } from '../aws/tofu/aws-engine.backend.js';
import { AuroraQueryClient } from '../aws/aurora-query.client.js';
import { AzureEngineCredentialsSchema } from '../azure/azure-engine.adapter.js';
import { ARM, AZURE_SCOPES, AzureTokens, azureRest } from '../azure/azure-ops.client.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Project } from '../../../domain/entities/project.entity.js';
import type { DatabaseAccessAcquireResult, DatabaseAccessLease } from '../../../domain/services/database-access.service.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const value = (record: Record<string, unknown>, key: string): string => typeof record[key] === 'string' ? record[key] as string : '';
const fail = (error: string, provider: string, connectionUnavailable = false): DatabaseAccessAcquireResult => ({ ok: false, code: 'provider_error', provider, error, connectionUnavailable,
  resourceCreated: false, cleanup: 'not_needed', hint: 'Restore the accepted database binding and verify its native identity with hv_inspect; do not recreate the database or derive its name from the project.' });

type NativeConnection = { provider: 'aws' | 'azure'; credentials: unknown };

async function resolve(project: Project, environment: Environment, connected: NativeConnection, queryAccess = false) {
  if (environment.projectId !== project.id) throw new Error('The database environment belongs to a different project.');
  const provider = environment.platformBindings.provider === 'aws' || object(environment.platformBindings.aws).kind === 'opentofu' ? 'aws' : 'azure';
  const binding = object(environment.platformBindings[provider]);
  if (object(environment.platformBindings.aws).kind === 'opentofu' && object(environment.platformBindings.azure).kind === 'opentofu'
    || environment.platformBindings.provider && environment.platformBindings.provider !== provider || binding.tornDownAt) throw new Error('Conflicting or retired engine database binding.');
  if (provider !== connected.provider) throw new Error('The connected adapter differs from the accepted database provider.');
  const raw = connected.credentials;
  if ((binding.database === undefined || queryAccess && provider === 'aws' && !object(binding.database).querySecretArn) && binding.kind === 'opentofu' && binding.databaseLoginAt && !binding.tornDownAt) {
    const database = await recoverNativeEngineDatabaseBinding(project, environment, provider, raw);
    const accepted = object(binding.database);
    if (provider === 'aws' && Object.keys(accepted).length && ['clusterArn', 'accountId', 'region', 'name', 'owner'].some(key => accepted[key] !== (database as unknown as Record<string, unknown>)[key])) throw new Error('Recovered database evidence conflicts with its accepted binding.');
    environment = { ...environment, platformBindings: { ...environment.platformBindings, [provider]: { ...binding, database } } };
  }
  const identity = engineDatabaseIdentity(environment);
  if (!identity) throw new Error('No accepted AWS or Azure database identity exists for this environment.');
  if (identity.provider === 'aws') {
    const database = identity.database;
    const connection = { ...AwsEngineCredentialsSchema.parse(raw), region: database.region };
    if (connection.accountId !== database.accountId || connection.roleArn.split(':')[4] !== database.accountId) throw new Error('The selected AWS connection does not match the accepted database account and region.');
    if (queryAccess && !isAwsDatabaseQuerySecretArn(database.querySecretArn, { ...connection, environmentId: environment.id })) throw new Error('Run hv_plan and hv_apply to provision the environment application credential for database access.');
    const policy = { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['rds:DescribeDBClusters', ...(queryAccess ? ['rds-data:BeginTransaction', 'rds-data:ExecuteStatement', 'rds-data:CommitTransaction', 'rds-data:RollbackTransaction'] : [])], Resource: database.clusterArn },
      ...(queryAccess ? [{ Effect: 'Allow', Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'], Resource: database.querySecretArn }] : []),
    ] };
    const auth = await awsEngineAuthentication(connection, policy);
    const access = { region: database.region, credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! } };
    const rds = new RDSClient({ ...access, maxAttempts: 1 });
    try {
      const response = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: database.clusterArn }), { abortSignal: AbortSignal.timeout(30_000) });
      const cluster = response.DBClusters?.length === 1 ? response.DBClusters[0] : undefined;
      if (!cluster || cluster.DBClusterArn !== database.clusterArn || cluster.Engine !== 'aurora-postgresql') throw new Error('The exact accepted Aurora cluster could not be verified.');
      if (queryAccess && cluster.HttpEndpointEnabled !== true) throw new Error('The accepted Aurora cluster has no verified Data API access.');
      if (queryAccess) await verifyAwsDatabaseQuerySecret(access, database.querySecretArn!, { ...connection, environmentId: environment.id });
      return { provider: 'aws', database, access, secretArn: database.querySecretArn, state: cluster.Status ?? 'unknown' } as const;
    } finally { rds.destroy(); }
  }
  const connection = AzureEngineCredentialsSchema.parse(raw); const database = identity.database;
  if (connection.subscriptionId.toLowerCase() !== database.subscriptionId.toLowerCase() || connection.resourceGroup.toLowerCase() !== database.resourceGroup.toLowerCase()) throw new Error('The selected Azure connection does not match the accepted database subscription and resource group.');
  const tokens = new AzureTokens(connection);
  const response = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${database.serverId}?api-version=2024-08-01`);
  const properties = object(response.body.properties);
  if (response.status !== 200 || value(response.body, 'id').toLowerCase() !== database.serverId.toLowerCase() || properties.fullyQualifiedDomainName !== database.host) throw new Error('The exact accepted Azure database server could not be verified.');
  return { provider: 'azure', database, tokens, state: typeof properties.state === 'string' ? properties.state : 'unknown', publicAccess: properties.network && object(properties.network).publicNetworkAccess } as const;
}

/** Server observation never claims SQL authentication, database existence or running-workload credential alignment. */
export async function observeNativeEngineDatabase(project: Project, environment: Environment, connected: NativeConnection): Promise<Record<string, unknown>> {
  try {
    const target = await resolve(project, environment, connected);
    return { provider: target.provider, state: 'present', serverStatus: target.state, database: target.database.name,
      externalId: target.provider === 'aws' ? target.database.clusterArn : target.database.serverId, databasePresence: 'unchecked', authentication: 'unchecked' };
  } catch { return { state: 'unknown', authentication: 'unchecked', reason: 'The accepted database identity or its scoped provider observation could not be verified.' }; }
}

/** Engine access never creates a firewall rule, a credential, a resource, or a new local component. */
export async function acquireNativeEngineDatabaseAccess(project: Project, environment: Environment, connected: NativeConnection): Promise<DatabaseAccessAcquireResult> {
  const provider = object(environment.platformBindings.aws).kind === 'opentofu' || environment.platformBindings.provider === 'aws' ? 'aws' : 'azure';
  let target: Awaited<ReturnType<typeof resolve>>;
  try { target = await resolve(project, environment, connected, true); } catch { return fail('The accepted database identity, cloud connection or exact provider observation could not be verified. No database access was opened. Run hv_plan and hv_apply to apply the environment-owned query credential before retrying.', provider); }
  let released = false;
  let releasedCleanup: Awaited<ReturnType<DatabaseAccessLease['release']>> | undefined;
  if (target.provider === 'aws') {
    const query = new AuroraQueryClient(target.access, { clusterArn: target.database.clusterArn, secretArn: target.secretArn!, database: target.database.name, owner: target.database.owner });
    const lease: DatabaseAccessLease = { id: randomUUID(), provider: 'aws', mode: 'data_api', createdByInvocation: false,
      query: (sql, params, options) => { if (released) throw new Error('Database access lease has already been released.'); return query.query(sql, params, options); },
      async withConnection() { throw new Error('This Aurora database uses the Data API. PostgreSQL socket transfers and URL-only operations require a managed private connector, which Hypervibe does not yet provide.'); },
      async release() { if (releasedCleanup) return releasedCleanup; released = true; releasedCleanup = await query.release() ? { status: 'completed' } : { status: 'failed', warning: 'The exact Aurora transaction cleanup could not be verified. PostgreSQL and Data API transaction timeouts remain in force.' }; return releasedCleanup; } };
    return { ok: true, lease };
  }
  try {
    if (target.publicAccess !== 'Enabled') return fail('Azure public access is disabled or unknown. A managed private connector or an approved engine network-access change is required; query does not change firewall rules.', 'azure');
    const secret = await azureRest(target.tokens, AZURE_SCOPES.vault, 'GET', `${target.database.secretUrl}?api-version=7.4`);
    if (secret.status !== 200 || typeof secret.body.value !== 'string' || typeof secret.body.id !== 'string' || !secret.body.id.startsWith(`${target.database.secretUrl}/`)) throw new Error();
    const url = new URL(secret.body.value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== target.database.host || decodeURIComponent(url.pathname.slice(1)) !== target.database.name
      || decodeURIComponent(url.username) !== target.database.owner || !url.password || url.port && url.port !== '5432') throw new Error();
    // Ignore any unreviewed connection options in the private stored URL; enforce certificate and hostname verification.
    url.search = '?sslmode=verify-full';
    let connectionUrl = url.toString();
    return { ok: true, lease: { id: randomUUID(), provider: 'azure', mode: 'existing', createdByInvocation: false,
      async withConnection(operation) { if (released) throw new Error('Database access lease has already been released.'); return operation(connectionUrl); },
      async release() { released = true; connectionUrl = ''; return { status: 'no_op' }; } } };
  } catch { return fail('The environment-owned Azure database credential could not be resolved and matched to its accepted server, database and login.', 'azure'); }
}
