import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DescribeNatGatewaysCommand, DescribeVpcEndpointsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeRepositoriesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { ECSClient, ListClustersCommand } from '@aws-sdk/client-ecs';
import { DescribeDBClusterSnapshotsCommand, DescribeDBClustersCommand, DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import type { AwsAccess } from '../../src/adapters/providers/aws/aws-engine.client.js';
import { ARM, AZURE_SCOPES, azureRest, type AzureTokenProvider } from '../../src/adapters/providers/azure/azure-ops.client.js';
import { resourceKey, type NativeFixtureResource } from './lifecycle-live-harness.js';

export type EngineFixtureCloud = 'aws' | 'azure';

/**
 * The disposable environment: a public web service, an always-on worker, a worker
 * that runs only while it has work, a scheduled job and file storage, all using
 * one database.
 */
export function engineFixtureEnvironment(cloud: EngineFixtureCloud, revision: 'create' | 'update', connectionRegion: string, region?: string): Record<string, unknown> {
  return {
    // A region is given only when the connection's default cannot be used, as when Azure refuses a new subscription a database there.
    hosting: { provider: cloud, engine: 'opentofu', ...(region ? { region } : {}) },
    database: cloud === 'aws' ? { provider: 'rds' } : { provider: 'azure-postgres', version: 17 },
    storage: { files: { provider: cloud === 'aws' ? 's3' : 'azureblob', type: 'bucket', region: region ?? connectionRegion, injectInto: ['web'] } },
    services: {
      web: { workloadKind: 'web', startCommand: 'node server.mjs', healthCheckPath: '/health', public: true },
      worker: { workloadKind: 'worker', startCommand: 'node server.mjs worker' },
      ondemand: { workloadKind: 'worker', startCommand: 'node server.mjs ondemand', onDemand: {
        pendingWorkQuery: "SELECT count(*) FROM conformance_jobs WHERE status = 'queued'",
        nextWorkAtQuery: "SELECT min(run_at) FROM conformance_jobs WHERE status = 'queued'",
      } },
      scheduled: { workloadKind: 'cron', cronSchedule: '*/2 * * * *', startCommand: 'node server.mjs scheduled' },
    },
    email: { enabled: false }, envVars: { CONFORMANCE_APP_REVISION: revision }, deploy: { strategy: 'manual' },
  };
}

/** The app's answer must show the revision and recent proof from every workload and from storage. */
export function engineFixtureResponseProblem(status: number, value: unknown, revision: string): string | undefined {
  const body = value as { service?: string; revision?: string; database?: boolean; worker?: boolean; onDemand?: boolean; scheduled?: boolean; storage?: boolean } | null;
  if (status !== 200 || body?.service !== 'hypervibe-provider-conformance') return `the web service did not answer as the fixture (HTTP ${status})`;
  if (body.revision !== revision) return `the web service is not serving the ${revision} revision`;
  if (body.database !== true) return 'the web service could not use its database';
  if (body.worker !== true) return 'the worker has not written to the database in the last two minutes';
  if (body.storage !== true) return 'the web service could not write a file to its storage and read it back';
  if (body.scheduled !== true) return 'the scheduled job has not run in the last five minutes';
  if (body.onDemand !== true) return 'the on-demand worker has not finished queued work in the last five minutes';
  return undefined;
}

/**
 * What a connection attempt with made-up credentials says about exposure. A server
 * that gets as far as checking the password is open to this computer; anything
 * earlier (no route, refused, timed out, turned away by a firewall) is closed.
 */
export function classifyDatabaseProbe(error: unknown): 'reachable' | 'closed' {
  if (error === undefined) return 'reachable';
  return (error as { code?: unknown } | null)?.code === '28P01' ? 'reachable' : 'closed';
}

/** One real PostgreSQL connection attempt from this computer, over TLS, with credentials that cannot be valid. */
export async function probeDatabaseFromHere(host: string, connect: (host: string) => Promise<void> = connectWithMadeUpLogin): Promise<'reachable' | 'closed'> {
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('The database address is not a host name.');
  try { await connect(host); return classifyDatabaseProbe(undefined); } catch (error) { return classifyDatabaseProbe(error); }
}

async function connectWithMadeUpLogin(host: string): Promise<void> {
  const client = new pg.Client({ host, port: 5432, user: 'hypervibe_conformance_probe', password: randomUUID(), database: 'postgres',
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
  client.on('error', () => undefined);
  try { await client.connect(); } finally { await client.end().catch(() => undefined); }
}

/** Resources that were not there before the fixture started. */
export function sinceBaseline(current: NativeFixtureResource[], baseline: string[]): NativeFixtureResource[] {
  const before = new Set(baseline);
  return current.filter((resource) => !before.has(resourceKey(resource)));
}

/** Everything in the project's resource group, whatever its tags. An unreadable page throws; it is never "empty". */
export async function readAzureInventory(tokens: AzureTokenProvider, subscriptionId: string, resourceGroup: string): Promise<NativeFixtureResource[]> {
  let next: string | undefined = `${ARM}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/resources?api-version=2021-04-01`;
  const found: NativeFixtureResource[] = [];
  while (next) {
    if (!next.startsWith(`${ARM}/`)) throw new Error('Azure returned a next page outside Resource Manager.');
    const page = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', next);
    if (page.status !== 200 || !Array.isArray(page.body.value)) throw new Error(`The Azure resource group could not be listed (HTTP ${page.status}); what exists is unknown.`);
    for (const entry of page.body.value as Array<{ id?: unknown; type?: unknown }>) {
      if (typeof entry.id !== 'string' || typeof entry.type !== 'string') throw new Error('Azure listed a resource without an id.');
      const id = entry.id.toLowerCase(); // Resource Manager ids are case-insensitive.
      found.push({ provider: 'azure', type: entry.type.toLowerCase(), id, address: id });
    }
    next = typeof page.body.nextLink === 'string' ? page.body.nextLink : undefined;
  }
  return found;
}

export interface DatabaseExposure { host: string; problems: string[] }

/** The server's own settings: public access must be off and no firewall rule may remain. */
export async function readAzureDatabaseExposure(tokens: AzureTokenProvider, serverId: string): Promise<DatabaseExposure> {
  const server = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${serverId}?api-version=2024-08-01`);
  const rules = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${serverId}/firewallRules?api-version=2024-08-01`);
  const properties = (server.body.properties ?? {}) as { fullyQualifiedDomainName?: unknown; network?: { publicNetworkAccess?: unknown } };
  if (server.status !== 200 || rules.status !== 200 || typeof properties.fullyQualifiedDomainName !== 'string' || !Array.isArray(rules.body.value)) {
    throw new Error('The Azure database server could not be read; its exposure is unknown.');
  }
  const problems: string[] = [];
  if (properties.network?.publicNetworkAccess !== 'Disabled') problems.push(`public network access is ${String(properties.network?.publicNetworkAccess)}`);
  const names = (rules.body.value as Array<{ name?: unknown }>).map((rule) => String(rule.name));
  if (names.length) problems.push(`firewall rules remain: ${names.join(', ')}`);
  return { host: properties.fullyQualifiedDomainName, problems };
}

async function pages<T>(read: (token?: string) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const all: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < 200; page++) {
    const result = await read(token);
    all.push(...result.items);
    if (!result.next) return all;
    token = result.next;
  }
  throw new Error('AWS inventory did not end; what exists is unknown.');
}

/**
 * What costs money or holds data in the fixture's AWS region: networks, their
 * endpoints and NAT gateways, database clusters, instances and kept snapshots,
 * container clusters, image repositories and buckets. A network cannot be
 * deleted while anything is attached to it, so a missing network also covers
 * load balancers, tasks and network interfaces. SDK errors throw.
 */
export async function readAwsInventory(access: AwsAccess): Promise<NativeFixtureResource[]> {
  const config = { region: access.region, credentials: access.credentials };
  const ec2 = new EC2Client(config); const rds = new RDSClient(config); const ecs = new ECSClient(config); const ecr = new ECRClient(config); const s3 = new S3Client(config);
  const item = (type: string, id: string | undefined): NativeFixtureResource => {
    if (!id) throw new Error(`AWS listed a ${type} without an id.`);
    return { provider: 'aws', type, id, address: `${type}/${id}` };
  };
  try {
    const gone = (state: string | undefined) => state === 'deleted' || state === 'Deleted';
    return [
      ...(await pages(async (NextToken) => { const r = await ec2.send(new DescribeVpcsCommand({ NextToken })); return { items: r.Vpcs ?? [], next: r.NextToken }; })).map((v) => item('vpc', v.VpcId)),
      ...(await pages(async (NextToken) => { const r = await ec2.send(new DescribeVpcEndpointsCommand({ NextToken })); return { items: r.VpcEndpoints ?? [], next: r.NextToken }; }))
        .filter((e) => !gone(e.State)).map((e) => item('vpc-endpoint', e.VpcEndpointId)),
      ...(await pages(async (NextToken) => { const r = await ec2.send(new DescribeNatGatewaysCommand({ NextToken })); return { items: r.NatGateways ?? [], next: r.NextToken }; }))
        .filter((n) => !gone(n.State)).map((n) => item('nat-gateway', n.NatGatewayId)),
      ...(await pages(async (Marker) => { const r = await rds.send(new DescribeDBClustersCommand({ Marker })); return { items: r.DBClusters ?? [], next: r.Marker }; })).map((c) => item('db-cluster', c.DBClusterArn)),
      ...(await pages(async (Marker) => { const r = await rds.send(new DescribeDBInstancesCommand({ Marker })); return { items: r.DBInstances ?? [], next: r.Marker }; })).map((i) => item('db-instance', i.DBInstanceArn)),
      ...(await pages(async (Marker) => { const r = await rds.send(new DescribeDBClusterSnapshotsCommand({ Marker, SnapshotType: 'manual' })); return { items: r.DBClusterSnapshots ?? [], next: r.Marker }; }))
        .map((s) => item('db-cluster-snapshot', s.DBClusterSnapshotArn)),
      ...(await pages(async (nextToken) => { const r = await ecs.send(new ListClustersCommand({ nextToken })); return { items: r.clusterArns ?? [], next: r.nextToken }; })).map((arn) => item('ecs-cluster', arn)),
      ...(await pages(async (nextToken) => { const r = await ecr.send(new DescribeRepositoriesCommand({ nextToken })); return { items: r.repositories ?? [], next: r.nextToken }; })).map((r) => item('ecr-repository', r.repositoryArn)),
      ...(await pages(async (ContinuationToken) => { const r = await s3.send(new ListBucketsCommand({ ContinuationToken, BucketRegion: access.region })); return { items: r.Buckets ?? [], next: r.ContinuationToken }; }))
        .map((b) => item('s3-bucket', b.Name)),
    ];
  } finally { for (const client of [ec2, rds, ecs, ecr, s3]) client.destroy(); }
}

/** The fixture's cluster address, and whether any of its instances asks for a public address. */
export async function readAwsDatabaseExposure(access: AwsAccess, created: NativeFixtureResource[]): Promise<DatabaseExposure> {
  const arns = new Set(created.filter((resource) => resource.type === 'db-cluster').map((resource) => resource.id));
  if (arns.size !== 1) throw new Error(`The fixture should have created exactly one database cluster; found ${arns.size}.`);
  const rds = new RDSClient({ region: access.region, credentials: access.credentials });
  try {
    const cluster = (await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: [...arns][0] }))).DBClusters?.[0];
    if (!cluster?.Endpoint || !cluster.DBClusterIdentifier) throw new Error('The AWS database cluster could not be read; its exposure is unknown.');
    const instances = (await rds.send(new DescribeDBInstancesCommand({ Filters: [{ Name: 'db-cluster-id', Values: [cluster.DBClusterIdentifier] }] }))).DBInstances ?? [];
    return { host: cluster.Endpoint, problems: instances.filter((instance) => instance.PubliclyAccessible).map((instance) => `instance ${instance.DBInstanceIdentifier} is publicly accessible`) };
  } finally { rds.destroy(); }
}
