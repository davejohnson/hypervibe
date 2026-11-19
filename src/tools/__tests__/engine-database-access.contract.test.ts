import '../../application/providers.js';
import { registerLifecycleTools } from '../lifecycle.tools.js';
import { runCli } from '../../interfaces/cli/run.js';
import { registerCoreTools } from '../core.tools.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngineDatabasePgPeer } from './engine-database-pg-peer.js';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { createToolContext } from '../../application/context.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { registerHvDbTools } from '../hv-db.tools.js';
import { parseToolEnvelope } from './tool-result.js';

const wire = vi.hoisted(() => ({ sql: [] as string[], password: undefined as string | undefined, startup: undefined as string | undefined, ended: false, configuredUrl: '' }));
vi.mock('pg', async original => {
  const module = await original<typeof import('pg')>();
  return { ...module, default: { ...module.default, Client: class extends module.default.Client {
    constructor(config: any) {
      // Replace only the transport. Assert real production TLS configuration separately; this peer has no TLS engine.
      wire.configuredUrl = config.connectionString;
      super({ ...config, connectionString: config.connectionString.replace('?sslmode=verify-full', ''), ssl: false, stream: () => new EngineDatabasePgPeer(wire) } as any);
    }
  } } };
});

// Reconstructed offline fixtures from AWS RDS/Data API official wire contracts.
const clusterArn = 'arn:aws:rds:us-west-2:111122223333:cluster:accepted-cluster';
const secretArn = 'arn:aws:secretsmanager:us-west-2:111122223333:secret:accepted-master-abcdef';
let temp: string;
let calls: Array<{ host: string; path: string; body: Record<string, any> }>;
let failQuery = false;
let wrongCluster = false;
let wrongSecret = false;
let wrongLogin = false;
let queryArn = '';
let queryEnvironmentId = '';
let resuming = 0;
let resumeUntil = 0;
let beginFailure: { name: string; status: number } | 'transport' | 'missing-id' | undefined;
let beginDelayMs = 0;
let failRollback = false;
let rows: unknown[] = [{ answer: 42 }];
beforeEach(() => {
  SqliteAdapter.resetInstance(); temp = mkdtempSync(path.join(tmpdir(), 'hv-engine-db-'));
  SqliteAdapter.getInstance(path.join(temp, 'db.sqlite')).migrate(); calls = []; wire.sql = []; wire.password = undefined; wire.startup = undefined; wire.ended = false; wire.configuredUrl = ''; failQuery = false; wrongCluster = false; wrongSecret = false; wrongLogin = false; queryArn = ''; queryEnvironmentId = ''; resuming = 0; failRollback = false; rows = [{ answer: 42 }];
  resumeUntil = 0; beginFailure = undefined; beginDelayMs = 0;
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async (req: any) => {
    const wireBody = Buffer.isBuffer(req.body) || req.body instanceof Uint8Array ? Buffer.from(req.body).toString('utf8') : String(req.body);
    const body = wireBody.startsWith('{') ? JSON.parse(wireBody) : Object.fromEntries(new URLSearchParams(wireBody));
    calls.push({ host: req.hostname, path: req.path, body });
    let statusCode = 200;
    let payload: string;
    if (req.hostname.startsWith('sts.')) payload = '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASSUMEDACCESSKEY123</AccessKeyId><SecretAccessKey>private-assumed-secret</SecretAccessKey><SessionToken>private-session-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>';
    else if (req.hostname.startsWith('rds.')) payload = `<DescribeDBClustersResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><DescribeDBClustersResult><DBClusters><DBCluster><DBClusterIdentifier>accepted-cluster</DBClusterIdentifier><DBClusterArn>${wrongCluster ? clusterArn.replace('111122223333', '444455556666') : clusterArn}</DBClusterArn><Engine>aurora-postgresql</Engine><Status>available</Status><HttpEndpointEnabled>true</HttpEndpointEnabled><Endpoint>accepted.cluster.us-west-2.rds.amazonaws.com</Endpoint><MasterUserSecret><SecretArn>${wrongSecret ? secretArn.replace('111122223333', '444455556666') : secretArn}</SecretArn><SecretStatus>active</SecretStatus></MasterUserSecret></DBCluster></DBClusters></DescribeDBClustersResult></DescribeDBClustersResponse>`;
    else if (req.hostname.startsWith('secretsmanager.')) payload = JSON.stringify({ ARN: wrongSecret ? secretArn : queryArn, Name: `hypervibe/${queryEnvironmentId}/database-query`,
      Tags: [{ Key: 'managed-by', Value: 'hypervibe' }, { Key: 'hv-environment', Value: queryEnvironmentId }], VersionIdsToStages: { current: ['AWSCURRENT'] } });
    else if (req.path === '/BeginTransaction') {
      if (beginDelayMs) await new Promise(resolve => setTimeout(resolve, beginDelayMs));
      if (beginFailure === 'transport') throw new Error('private connection reset after sending BeginTransaction');
      if (beginFailure === 'missing-id') payload = '{}';
      else if (beginFailure) { statusCode = beginFailure.status; payload = JSON.stringify({ __type: beginFailure.name, message: 'private denied access' }); }
      else if (resuming-- > 0 || Date.now() < resumeUntil) { statusCode = 400; payload = JSON.stringify({ __type: 'DatabaseResumingException', message: 'Resuming' }); }
      else payload = JSON.stringify({ transactionId: 'private-transaction' });
    }
    else if (req.path === '/RollbackTransaction') {
      statusCode = failRollback ? 500 : 200; payload = JSON.stringify(failRollback ? { message: 'private-cleanup-error' } : { transactionStatus: 'Rollback Complete' });
    }
    else if (req.path === '/CommitTransaction') payload = JSON.stringify({ transactionStatus: 'Transaction Committed' });
    else if (req.path === '/Execute') {
      if (body.sql.startsWith('SELECT session_user')) payload = JSON.stringify({ formattedRecords: JSON.stringify([{ session_user: wrongLogin ? 'hvadmin' : 'app_accepted_owner', current_user: wrongLogin ? 'hvadmin' : 'app_accepted_owner', database: 'app_accepted' }]) });
      else if (failQuery && body.sql.startsWith('SELECT')) { statusCode = 400; payload = JSON.stringify({ message: 'private SQL/private-assumed-secret/private-session-token' }); }
      else payload = JSON.stringify(body.sql.startsWith('SELECT') || body.sql.includes(' RETURNING ') ? { formattedRecords: JSON.stringify(rows), numberOfRecordsUpdated: 0 } : {});
    } else throw new Error(`Unexpected synthetic request ${req.hostname}${req.path}`);
    return { response: { statusCode, headers: { 'content-type': req.hostname.startsWith('rds-data.') || req.hostname.startsWith('secretsmanager.') ? 'application/json' : 'text/xml' }, body: Readable.from([payload]) } };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(temp, { recursive: true, force: true }); });
function seed() {
  const project = new ProjectRepository().create({ name: 'renamed-app', defaultPlatform: 'aws' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'renamed-preview', platformBindings: { provider: 'aws', aws: { kind: 'opentofu', databaseLoginAt: '2026-01-01T00:00:00Z', sharedDatabase: true,
    database: { clusterArn, name: 'app_accepted', owner: 'app_accepted_owner', accountId: '111122223333', region: 'us-west-2' } } } });
  queryEnvironmentId = environment.id.toLowerCase();
  queryArn = `arn:aws:secretsmanager:us-west-2:111122223333:secret:hypervibe/${queryEnvironmentId}/database-query-AbCd12`;
  const aws = environment.platformBindings.aws as { database: object };
  new EnvironmentRepository().updatePlatformBindings(environment.id, { aws: { ...aws, database: { ...aws.database, querySecretArn: queryArn } } });
  const connection = new ConnectionRepository().create({ provider: 'aws', credentialsEncrypted: getSecretStore().encryptObject({ accessKeyId: 'LOCALACCESSKEY1234', secretAccessKey: 'private-local-secret-value-32-characters', roleArn: 'arn:aws:iam::111122223333:role/hypervibe/hypervibe-deploy', accountId: '111122223333', region: 'us-west-2' }) });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  return { project, environment };
}
async function query(args: Record<string, unknown>, name = 'hv_db_query') {
  const server = new McpServer({ name: 'engine-db', version: '1' });
  const registrar = createMcpCommandRegistrar(server); const ctx = createToolContext();
  registerHvDbTools(registrar, ctx); registerLifecycleTools(registrar, ctx); registerCoreTools(registrar, ctx);
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try { return parseToolEnvelope(await client.callTool({ name, arguments: args })) as any; }
  finally { await client.close(); await server.close(); }
}
it('queries the accepted per-environment Aurora database through the public command with server-enforced readonly and cleanup', async () => {
  const { project, environment } = seed();
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 42 AS answer' });
  expect(result.ok, JSON.stringify({ result, calls })).toBe(true);
  expect(result.data.rows).toEqual([{ answer: 42 }]);
  const data = calls.filter(call => call.host.startsWith('rds-data.'));
  expect(data.map(call => call.path)).toEqual(['/BeginTransaction', '/Execute', '/Execute', '/Execute', '/Execute', '/RollbackTransaction']);
  expect(data[0]!.body).toMatchObject({ resourceArn: clusterArn, secretArn: queryArn, database: 'app_accepted' });
  expect(data[1]!.body.sql).toBe('SET TRANSACTION READ ONLY');
  expect(data[2]!.body.sql).toBe('SELECT session_user AS session_user, current_user AS current_user, current_database() AS database');
  expect(data[3]!.body.sql).toBe('SET LOCAL statement_timeout = 30000');
  expect(data.slice(1).every(call => call.body.transactionId === 'private-transaction')).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private-|accepted-master/);
});
it('fails closed before SQL for contradictory native scope', async () => {
  const { project, environment } = seed(); wrongCluster = true;
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 1' });
  expect(result.ok).toBe(false);
  expect(calls.some(call => call.host.startsWith('rds-data.'))).toBe(false);
});
it('rejects an out-of-scope application secret before SQL', async () => {
  const { project, environment } = seed(); wrongSecret = true;
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 1' });
  expect(result.ok).toBe(false); expect(calls.some(call => call.host.startsWith('rds-data.'))).toBe(false);
});
it('rolls back a failed query and excludes provider errors and session credentials from the command', async () => {
  const { project, environment } = seed(); failQuery = true;
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 1' });
  expect(result.ok).toBe(false);
  expect(calls.at(-1)?.path).toBe('/RollbackTransaction');
  expect(JSON.stringify(result)).not.toMatch(/private-/);
});
it('blocks oversized results and rolls back', async () => {
  const { project, environment } = seed(); rows = Array.from({ length: 501 }, () => ({ answer: 42 }));
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 42' });
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).toMatch(/500-row/);
  expect(calls.at(-1)?.path).toBe('/RollbackTransaction');
});

const azureSubscription = '11111111-1111-4111-8111-111111111111';
const azureServer = `/subscriptions/${azureSubscription}/resourceGroups/hv-accepted/providers/Microsoft.DBforPostgreSQL/flexibleServers/accepted-server`;
const azureSecretUrl = 'https://accepted-vault.vault.azure.net/secrets/accepted-preview-database-url';
function azureSeed(options: { publicAccess?: string; secretDatabase?: string; wrongId?: boolean } = {}) {
  const project = new ProjectRepository().create({ name: 'renamed-azure', defaultPlatform: 'azure' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'renamed-preview', platformBindings: { provider: 'azure', azure: { kind: 'opentofu', databaseLoginAt: '2026-01-01T00:00:00Z', database: {
    serverId: azureServer, subscriptionId: azureSubscription, resourceGroup: 'hv-accepted', host: 'accepted-server.postgres.database.azure.com', name: 'accepted_db', owner: 'accepted_login', secretUrl: azureSecretUrl,
  } } } });
  const connection = new ConnectionRepository().create({ provider: 'azure', credentialsEncrypted: getSecretStore().encryptObject({ tenantId: azureSubscription, subscriptionId: azureSubscription, clientId: azureSubscription, deployPrincipalId: azureSubscription,
    clientSecret: 'private-client-secret-32-characters', clientSecretExpiresAt: '2099-01-01T00:00:00Z', resourceGroup: 'hv-accepted', location: 'westus2' }) });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  const requests: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = String(input); const method = init?.method ?? 'GET'; requests.push({ url, method });
    if (url.includes('login.microsoftonline.com')) return Response.json({ access_token: 'private-azure-token', expires_in: 3600 });
    if (url.startsWith('https://management.azure.com/')) return Response.json({ id: options.wrongId ? azureServer.replace('hv-accepted', 'other') : azureServer,
      properties: { fullyQualifiedDomainName: 'accepted-server.postgres.database.azure.com', state: 'Ready', network: { publicNetworkAccess: options.publicAccess ?? 'Enabled' } } });
    if (url === `${azureSecretUrl}?api-version=7.4`) return Response.json({ id: `${azureSecretUrl}/version`, value: `postgresql://accepted_login:private-db-password@accepted-server.postgres.database.azure.com:5432/${options.secretDatabase ?? 'accepted_db'}?sslmode=require` });
    throw new Error('Unexpected Azure request.');
  }));
  return { project, environment, requests };
}
it('queries Azure through its project-shared ARM server and exact environment Key Vault credential with PostgreSQL readonly and cleanup', async () => {
  const { project, environment, requests } = azureSeed();
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 42 AS answer' });
  expect(result.ok, JSON.stringify(result)).toBe(true); expect(result.data.rows).toEqual([{ answer: 42 }]);
  expect(wire.sql).toEqual(['BEGIN READ ONLY', 'SELECT 42 AS answer', 'COMMIT']); expect(wire.ended).toBe(true);
  expect(wire.startup).toContain('accepted_db'); expect(wire.startup).toContain('accepted_login'); expect(wire.password).toBe('private-db-password');
  expect(wire.configuredUrl).toContain('sslmode=verify-full');
  expect(requests.filter(request => !request.url.includes('login.microsoftonline.com')).every(request => request.method === 'GET')).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private-/);
});
it.each([{ publicAccess: 'Disabled' }, { wrongId: true }, { secretDatabase: 'other_environment' }])('blocks conflicting/private Azure access without opening SQL or changing firewall rules: %s', async options => {
  const { project, environment, requests } = azureSeed(options);
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 42' });
  expect(result.ok).toBe(false); expect(wire.sql).toEqual([]);
  expect(requests.filter(request => !request.url.includes('login.microsoftonline.com')).every(request => request.method === 'GET')).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private-/);
});

it.each([['mcp', 'azure'], ['cli', 'azure'], ['mcp', 'railway'], ['cli', 'railway']])('reports exact retained cloud database and backup evidence through %s on %s without creating a plan', async (transport, hosting) => {
  const { project, environment, requests } = azureSeed();
  const ctx = createToolContext();
  const retainedServer = azureServer.replace('accepted-server', 'retained-server');
  new SpecStore().replace(project, { version: 1, project: project.name, environments: { [environment.name]: {
    hosting: { provider: hosting }, services: { web: {} }, database: { provider: 'azure-postgres', engine: 'postgres' }, backups: { mode: 'daily' },
  } } });
  ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: retainedServer, bindings: {
    provider: 'azure-postgres', providerScope: { subscriptionId: azureSubscription, resourceGroup: 'hv-accepted' },
  } });
  const call = async (command: 'status' | 'plan') => {
    const input = { project: project.name, env: environment.name, ...(command === 'plan' ? { scope: 'backups' } : {}) };
    if (transport === 'mcp') return query(input, `hv_${command}`);
    let out = '';
    await runCli([command, '--input', '-', '--json'], { initialize: false, io: {
      readStdin: async () => JSON.stringify(input), writeOut: text => { out += text; }, writeErr: () => {}, stdinIsTTY: false, confirm: async () => false,
    } });
    return JSON.parse(out);
  };
  const changes = () => SqliteAdapter.getInstance().getDb().prepare('select total_changes() as n').get();
  const before = changes();
  const status = await call('status');
  expect(status).toMatchObject({ ok: true, data: { retainedDatabases: [{ externalId: retainedServer, provider: 'azure-postgres', observation: 'unknown' }] } });
  expect(requests.some(r => r.url.includes(retainedServer))).toBe(true);
  const report = await call('plan');
  expect(report).toMatchObject({ ok: true, data: { scope: 'backups', backupCoverage: { resources: [{ state: 'unsupported' }] } } });
  expect(report.data).not.toHaveProperty('planId');
  expect(requests.filter(r => !r.url.includes('login.microsoftonline.com')).every(r => r.method === 'GET')).toBe(true);
  expect(changes()).toEqual(before);
});

it('retains native RDS operational clients using the verified AWS engine connection', async () => {
  const { project } = seed();
  const result = await adapterFactory.getDatabaseOperations('rds', project);
  expect(result.success, result.error).toBe(true); expect(result.connectionProvider).toBe('aws');
  expect(calls.some(call => call.body.Action === 'AssumeRole')).toBe(true);
});
it('retains native Azure PostgreSQL operational clients using the verified Azure engine connection', async () => {
  const { project } = azureSeed();
  const result = await adapterFactory.getDatabaseOperations('azure-postgres', project);
  expect(result.success, result.error).toBe(true); expect(result.connectionProvider).toBe('azure');
});

it('waits for AWS-confirmed cluster resume and starts only one successful transaction', async () => {
  const { project, environment } = seed(); resuming = 1;
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 42' });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(calls.filter(call => call.path === '/BeginTransaction')).toHaveLength(2);
  expect(calls.filter(call => call.path === '/Execute' && call.body.sql === 'SELECT 42')).toHaveLength(1);
});
// AWS documents ~15 seconds for a normal resume and 30+ seconds after a long pause.
// Exercise the SDK's real serialized rejection responses through the public command.
it.each([16_000, 32_000])('queries once after an Aurora resume lasting %i ms', async wakeMs => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const { project, environment } = seed(); resumeUntil = Date.now() + wakeMs;
  const pending = query({ project: project.name, env: environment.name, sql: 'SELECT 42' });
  await vi.advanceTimersByTimeAsync(40_000);
  const result = await pending;
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(calls.filter(call => call.path === '/Execute' && call.body.sql === 'SELECT 42')).toHaveLength(1);
  expect(calls.filter(call => call.path === '/RollbackTransaction')).toHaveLength(1);
});
it.each([0, 12_000])('bounds the total resume wait, including %i ms native responses, with actionable guidance', async delayMs => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const { project, environment } = seed(); resumeUntil = Infinity; beginDelayMs = delayMs;
  let result: any;
  const pending = query({ project: project.name, env: environment.name, sql: 'SELECT 42' }).then(value => { result = value; });
  await vi.advanceTimersByTimeAsync(40_000);
  expect(result, 'The wake-up budget includes provider response time').toBeDefined();
  await pending;
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toMatch(/still waking up/i);
  expect(JSON.stringify(result)).not.toMatch(/Check access and SQL|cleanup could not be verified|private-/);
  expect(calls.some(call => call.path === '/Execute' || call.path === '/RollbackTransaction')).toBe(false);
});
it.each(['AccessDeniedException', 'ForbiddenException'])('does not retry or claim uncertain cleanup after a confirmed %s rejection', async name => {
  const { project, environment } = seed(); beginFailure = { name, status: 403 };
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 42' });
  expect(result.ok).toBe(false);
  expect(calls.filter(call => call.host.startsWith('rds-data.')).map(call => call.path)).toEqual(['/BeginTransaction']);
  expect(JSON.stringify(result)).not.toMatch(/cleanup could not be verified|private-/);
  expect(result.error.details.access.cleanup).toBe('completed');
});
it.each(['transport', 'missing-id'] as const)('preserves unknown cleanup without retrying an ambiguous transaction start: %s', async failure => {
  const { project, environment } = seed(); beginFailure = failure;
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 42' });
  expect(result.ok).toBe(false);
  expect(calls.filter(call => call.host.startsWith('rds-data.')).map(call => call.path)).toEqual(['/BeginTransaction']);
  expect(result.error.details.access.cleanup).toBe('failed');
  expect(JSON.stringify(result)).toMatch(/cleanup could not be verified/);
  expect(JSON.stringify(result)).not.toMatch(/private-/);
});
it.each(['rows', 'bytes'] as const)('reports confirmed rollback when mutation results exceed the %s limit', async limit => {
  const { project, environment } = seed();
  rows = limit === 'rows' ? Array.from({ length: 501 }, () => ({ answer: 42 })) : [{ answer: 'x'.repeat(512 * 1024) }];
  const result = await query({ project: project.name, env: environment.name, sql: 'UPDATE notes SET label = $1 RETURNING label', params: ['changed'], allowMutations: true });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toMatch(/mutation was rolled back/i);
  expect(result.error.details.mutationOutcome).toBe('rolled_back');
  expect(calls.some(call => call.path === '/CommitTransaction')).toBe(false);
  expect(calls.filter(call => call.path === '/RollbackTransaction')).toHaveLength(1);
});
it('does not promise rollback when the oversized mutation cleanup cannot be confirmed', async () => {
  const { project, environment } = seed(); rows = Array.from({ length: 501 }, () => ({ answer: 42 })); failRollback = true;
  const result = await query({ project: project.name, env: environment.name, sql: 'UPDATE notes SET label = $1 RETURNING label', params: ['changed'], allowMutations: true });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/mutation was rolled back/i);
  expect(result.error.details.mutationOutcome).toBe('unknown');
  expect(JSON.stringify(result)).toMatch(/rollback could not be verified/i);
  expect(calls.some(call => call.path === '/CommitTransaction')).toBe(false);
  expect(calls.filter(call => call.path === '/RollbackTransaction')).toHaveLength(2);
});
it('preserves failed transaction cleanup in the public command without leaking provider errors', async () => {
  const { project, environment } = seed(); failRollback = true;
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 42' });
  expect(result.ok).toBe(true); expect(result.data.access.cleanup).toBe('failed');
  expect(result.hint).not.toContain('public access');
  expect(calls.filter(call => call.path === '/RollbackTransaction')).toHaveLength(2);
  expect(JSON.stringify(result)).not.toMatch(/private-/);
});
it('keeps parameters bound rather than interpolated into executable SQL', async () => {
  const { project, environment } = seed();
  const result = await query({ project: project.name, env: environment.name, sql: "SELECT $1::text AS answer, '$2' AS literal /* $3 */", params: ["private-value'; DROP TABLE t --"] });
  expect(result.ok).toBe(true);
  const statement = calls.find(call => call.path === '/Execute' && call.body.sql.startsWith('SELECT :hv1'))!;
  expect(statement.body.sql).toBe("SELECT :hv1::text AS answer, '$2' AS literal /* $3 */");
  expect(statement.body.parameters).toEqual([{ name: 'hv1', value: { stringValue: "private-value'; DROP TABLE t --" } }]);
});

it.each(['aws', 'rds'])('inspects an engine database through the public %s selector without creating a legacy component or claiming SQL authentication', async provider => {
  const { project, environment } = seed();
  const result = await query({ provider, project: project.name, env: environment.name, resource: 'database' }, 'hv_inspect');
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.data).toMatchObject({ state: 'present', database: 'app_accepted', externalId: clusterArn, authentication: 'unchecked', databasePresence: 'unchecked' });
  expect(calls.some(call => call.host.startsWith('rds-data.'))).toBe(false);
});
it('includes safe database observation in engine status without executing SQL', async () => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  const { project, environment } = seed();
  new SpecStore().replace(project, { version: 1, project: project.name, environments: { [environment.name]: { hosting: { provider: 'aws', engine: 'opentofu' }, database: { provider: 'rds' }, services: { web: { public: true } } } } });
  const result = await query({ project: project.name, env: environment.name }, 'hv_status');
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.data.database).toMatchObject({ state: 'present', authentication: 'unchecked', database: 'app_accepted' });
  expect(calls.some(call => call.host.startsWith('rds-data.'))).toBe(false);
});

it('blocks mutation before cloud access unless explicitly allowed, then commits the exact scoped transaction once', async () => {
  const { project, environment } = seed();
  const args = { project: project.name, env: environment.name, sql: 'UPDATE notes SET label = $1', params: ['changed'] };
  const blocked = await query(args); expect(blocked.ok).toBe(false); expect(calls).toEqual([]);
  const allowed = await query({ ...args, allowMutations: true });
  expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
  expect(calls.filter(call => call.path === '/CommitTransaction')).toHaveLength(1);
  expect(calls.some(call => call.path === '/Execute' && call.body.sql === 'SET TRANSACTION READ ONLY')).toBe(false);
  expect(calls.some(call => call.path === '/Execute' && call.body.sql?.startsWith('SET LOCAL ROLE'))).toBe(false);
});


it('never authenticates caller SQL using the control-plane database secret', async () => {
  const { project, environment } = seed();
  const scopedArn = `arn:aws:secretsmanager:us-west-2:111122223333:secret:hypervibe/${environment.id.toLowerCase()}/database-query-AbCd12`;
  const aws = environment.platformBindings.aws as { database: object };
  new EnvironmentRepository().updatePlatformBindings(environment.id, { aws: { ...aws, database: { ...aws.database, querySecretArn: scopedArn } } });
  await query({ project: project.name, env: environment.name, sql: "WITH elevate AS MATERIALIZED (SELECT set_config('role','none',true)) SELECT current_user FROM elevate" });
  const requests = calls.filter(call => call.host.startsWith('rds-data.'));
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(call => call.body.secretArn === scopedArn)).toBe(true);
  expect(requests.some(call => call.body.sql?.startsWith('SET LOCAL ROLE'))).toBe(false);
  const policy = JSON.parse(calls.find(call => call.host.startsWith('sts.'))!.body.Policy);
  expect(JSON.stringify(policy)).toContain(scopedArn);
  expect(JSON.stringify(policy)).not.toContain('rds!');
});


it('checks the actual SQL session identity before executing any supplied statement', async () => {
  const { project, environment } = seed(); wrongLogin = true;
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT 42 AS answer' });
  expect(result.ok).toBe(false);
  expect(calls.some(call => call.body.sql === 'SELECT 42 AS answer')).toBe(false);
  expect(calls.at(-1)?.path).toBe('/RollbackTransaction');
});
it('preserves database bigint precision with the documented Data API string option', async () => {
  const { project, environment } = seed(); rows = [{ id: '9007199254740993' }];
  const result = await query({ project: project.name, env: environment.name, sql: 'SELECT id FROM counters' });
  expect(result.data.rows).toEqual([{ id: '9007199254740993' }]);
  expect(calls.find(call => call.body.sql === 'SELECT id FROM counters')?.body.resultSetOptions).toEqual({ longReturnType: 'STRING', decimalReturnType: 'STRING' });
});
