import { recoverEngineDatabaseBinding } from './engine-database-state.service.js';
import { randomUUID } from 'node:crypto';
import { DescribeDBClustersCommand, RDSClient } from '@aws-sdk/client-rds';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { AwsEngineCredentialsSchema } from '../../adapters/providers/aws/aws-engine.adapter.js';
import { awsEngineAuthentication } from '../../adapters/providers/aws/tofu/aws-engine.backend.js';
import { AuroraQueryClient } from '../../adapters/providers/aws/aurora-query.client.js';
import { AzureEngineCredentialsSchema } from '../../adapters/providers/azure/azure-engine.adapter.js';
import { ARM, AZURE_SCOPES, AzureTokens, azureRest } from '../../adapters/providers/azure/azure-ops.client.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { DatabaseAccessAcquireResult, DatabaseAccessLease } from './database-access.service.js';
import { getProjectScopeHints } from './project-scope.js';

export interface AwsDatabaseBinding { clusterArn: string; accountId: string; region: string; name: string; owner: string }
export interface AzureDatabaseBinding { serverId: string; subscriptionId: string; resourceGroup: string; host: string; name: string; owner: string; secretUrl: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sqlName = (value: unknown): value is string => typeof value === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(value);
const value = (record: Record<string, unknown>, key: string): string => typeof record[key] === 'string' ? record[key] as string : '';
const fail = (error: string, provider: string, connectionUnavailable = false): DatabaseAccessAcquireResult => ({ ok: false, code: 'provider_error', provider, error, connectionUnavailable,
  resourceCreated: false, cleanup: 'not_needed', hint: 'Restore the accepted database binding and verify its native identity with hv_inspect; do not recreate the database or derive its name from the project.' });

/** Native identities saved only after an accepted database login operation. Names never substitute for these IDs. */
export function engineDatabaseIdentity(environment: Environment): { provider: 'aws'; database: AwsDatabaseBinding } | { provider: 'azure'; database: AzureDatabaseBinding } | undefined {
  const bindings = environment.platformBindings;
  const aws = object(bindings.aws); const azure = object(bindings.azure);
  const provider = bindings.provider === 'aws' || aws.kind === 'opentofu' ? 'aws' : bindings.provider === 'azure' || azure.kind === 'opentofu' ? 'azure' : undefined;
  if (!provider) return;
  if (aws.kind === 'opentofu' && azure.kind === 'opentofu' || bindings.provider && bindings.provider !== provider) throw new Error('The environment has conflicting cloud database bindings.');
  const engine = provider === 'aws' ? aws : azure;
  if (engine.tornDownAt) throw new Error('The recorded engine environment was torn down; database access is unavailable.');
  const database = object(engine.database);
  if (!engine.databaseLoginAt || !sqlName(database.name) || !sqlName(database.owner)) throw new Error('The accepted engine database identity is incomplete. Database access remains blocked until its exact native identity is recovered.');
  if (provider === 'aws') {
    const arn = /^arn:aws:rds:([a-z0-9-]+):(\d{12}):cluster:([a-zA-Z0-9-]+)$/.exec(value(database, 'clusterArn'));
    if (!arn || arn[1] !== database.region || arn[2] !== database.accountId) throw new Error('The accepted Aurora cluster identity conflicts with its account or region.');
    return { provider, database: database as unknown as AwsDatabaseBinding };
  }
  const arm = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.DBforPostgreSQL\/flexibleServers\/([a-z0-9-]+)$/i.exec(value(database, 'serverId'));
  if (!arm || arm[1]!.toLowerCase() !== value(database, 'subscriptionId').toLowerCase() || arm[2]!.toLowerCase() !== value(database, 'resourceGroup').toLowerCase()
    || !/^[a-z0-9-]+\.postgres\.database\.azure\.com$/.test(value(database, 'host'))
    || !/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+$/.test(value(database, 'secretUrl'))) throw new Error('The accepted Azure database identity or credential reference is incomplete or conflicting.');
  return { provider, database: database as unknown as AzureDatabaseBinding };
}

export function isManagedEngineDatabase(environment: Environment): boolean {
  return ['aws', 'azure'].includes(String(environment.platformBindings.provider)) || object(environment.platformBindings.aws).kind === 'opentofu' || object(environment.platformBindings.azure).kind === 'opentofu';
}

async function resolve(project: Project, environment: Environment) {
  if (environment.projectId !== project.id) throw new Error('The database environment belongs to a different project.');
  const provider = environment.platformBindings.provider === 'aws' || object(environment.platformBindings.aws).kind === 'opentofu' ? 'aws' : 'azure';
  const binding = object(environment.platformBindings[provider]);
  if (object(environment.platformBindings.aws).kind === 'opentofu' && object(environment.platformBindings.azure).kind === 'opentofu'
    || environment.platformBindings.provider && environment.platformBindings.provider !== provider || binding.tornDownAt) throw new Error('Conflicting or retired engine database binding.');
  const stored = new ConnectionRepository().findBestVerifiedMatchFromHints(provider, getProjectScopeHints(project));
  if (!stored) return { missingConnection: provider } as const;
  const raw = getSecretStore().decryptObject(stored.credentialsEncrypted);
  if (binding.database === undefined && binding.kind === 'opentofu' && binding.databaseLoginAt && !binding.tornDownAt) {
    const database = await recoverEngineDatabaseBinding(project, environment, provider, raw);
    environment = { ...environment, platformBindings: { ...environment.platformBindings, [provider]: { ...binding, database } } };
  }
  const identity = engineDatabaseIdentity(environment);
  if (!identity) throw new Error('No accepted AWS or Azure database identity exists for this environment.');
  if (identity.provider === 'aws') {
    const connection = AwsEngineCredentialsSchema.parse(raw); const database = identity.database;
    if (connection.accountId !== database.accountId || connection.region !== database.region || connection.roleArn.split(':')[4] !== database.accountId) throw new Error('The selected AWS connection does not match the accepted database account and region.');
    const auth = await awsEngineAuthentication(connection);
    const access = { region: database.region, credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! } };
    const rds = new RDSClient({ ...access, maxAttempts: 1 });
    try {
      const response = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: database.clusterArn }), { abortSignal: AbortSignal.timeout(30_000) });
      const cluster = response.DBClusters?.length === 1 ? response.DBClusters[0] : undefined;
      if (!cluster || cluster.DBClusterArn !== database.clusterArn || cluster.Engine !== 'aurora-postgresql') throw new Error('The exact accepted Aurora cluster could not be verified.');
      const secretArn = cluster.MasterUserSecret?.SecretArn;
      if (!secretArn || !secretArn.startsWith(`arn:aws:secretsmanager:${database.region}:${database.accountId}:secret:`) || cluster.HttpEndpointEnabled !== true) throw new Error('The accepted Aurora cluster has no verified Data API access and in-scope credential reference.');
      return { provider: 'aws', database, access, secretArn, state: cluster.Status ?? 'unknown' } as const;
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
export async function observeManagedEngineDatabase(project: Project, environment: Environment): Promise<Record<string, unknown>> {
  try {
    const target = await resolve(project, environment);
    if (target.missingConnection) return { provider: target.missingConnection, state: 'unknown', authentication: 'unchecked', reason: 'A verified cloud connection for this repository is required.' };
    return { provider: target.provider, state: 'present', serverStatus: target.state, database: target.database.name,
      externalId: target.provider === 'aws' ? target.database.clusterArn : target.database.serverId, databasePresence: 'unchecked', authentication: 'unchecked' };
  } catch { return { state: 'unknown', authentication: 'unchecked', reason: 'The accepted database identity or its scoped provider observation could not be verified.' }; }
}

/** Engine access never creates a firewall rule, a credential, a resource, or a new local component. */
export async function acquireEngineDatabaseAccess(project: Project, environment: Environment): Promise<DatabaseAccessAcquireResult> {
  const provider = object(environment.platformBindings.aws).kind === 'opentofu' || environment.platformBindings.provider === 'aws' ? 'aws' : 'azure';
  let target: Awaited<ReturnType<typeof resolve>>;
  try { target = await resolve(project, environment); } catch { return fail('The accepted database identity, cloud connection or exact provider observation could not be verified. No database access was opened.', provider); }
  if (target.missingConnection) return fail(`A verified ${target.missingConnection} connection for this repository is required.`, target.missingConnection, true);
  let released = false;
  let releasedCleanup: Awaited<ReturnType<DatabaseAccessLease['release']>> | undefined;
  if (target.provider === 'aws') {
    const query = new AuroraQueryClient(target.access, { clusterArn: target.database.clusterArn, secretArn: target.secretArn, database: target.database.name, owner: target.database.owner });
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
