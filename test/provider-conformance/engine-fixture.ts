import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DescribeNatGatewaysCommand, DescribeNetworkInterfacesCommand, DescribeSecurityGroupsCommand, DescribeVpcEndpointsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeRepositoriesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { EventBridgeClient, ListRulesCommand } from '@aws-sdk/client-eventbridge';
import { ListSchedulesCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { ListStateMachinesCommand, SFNClient } from '@aws-sdk/client-sfn';
import { DescribeParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeExpressGatewayServiceCommand, DescribeServiceDeploymentsCommand, DescribeServicesCommand, DescribeTasksCommand, ECSClient, ListClustersCommand, ListServicesCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { DescribeDBClusterSnapshotsCommand, DescribeDBClustersCommand, DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import type { AwsAccess } from '../../src/adapters/providers/aws/aws-engine.client.js';
import { ARM, AZURE_SCOPES, azureRest, type AzureTokenProvider } from '../../src/adapters/providers/azure/azure-ops.client.js';
import { resourceKey, type NativeFixtureResource } from './lifecycle-live-harness.js';

export type EngineFixtureCloud = 'aws' | 'azure' | 'gcp';

/** What the spec calls each cloud's hosting, database and file storage. */
const SPEC_NAMES = {
  aws: { hosting: { provider: 'aws', engine: 'opentofu' }, database: { provider: 'rds' }, storage: 's3' },
  azure: { hosting: { provider: 'azure', engine: 'opentofu' }, database: { provider: 'azure-postgres', version: 17 }, storage: 'azureblob' },
  gcp: { hosting: { provider: 'cloudrun' }, database: { provider: 'cloudsql' }, storage: 'gcs' },
} as const;

/**
 * The disposable environment: a public web service, an always-on worker, a worker
 * that runs only while it has work, a scheduled job and file storage, all using
 * one database.
 */
/** `webStart` is the web service's start command; null leaves the image's own startup in charge. */
export function engineFixtureEnvironment(cloud: EngineFixtureCloud, revision: 'create' | 'update', connectionRegion: string, region?: string, webStart: string | null = 'node server.mjs'): Record<string, unknown> {
  return {
    // A region is given only when the connection's default cannot be used, as when Azure refuses a new subscription a database there.
    hosting: { ...SPEC_NAMES[cloud].hosting, ...(region ? { region } : cloud === 'gcp' ? { region: connectionRegion } : {}) },
    database: SPEC_NAMES[cloud].database,
    storage: { files: { provider: SPEC_NAMES[cloud].storage, type: 'bucket', region: region ?? connectionRegion, injectInto: ['web'] } },
    services: {
      web: { workloadKind: 'web', ...(webStart ? { startCommand: webStart } : {}), healthCheckPath: '/health', public: true },
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
export function engineFixtureResponseProblem(status: number, value: unknown, revision: string, start?: { entrypoint: boolean; startedWith: string | null }): string | undefined {
  const body = value as { entrypoint?: boolean; startedWith?: string | null; service?: string; revision?: string; database?: boolean; worker?: boolean; onDemand?: boolean; scheduled?: boolean; storage?: boolean } | null;
  if (status !== 200 || body?.service !== 'hypervibe-provider-conformance') return `the web service did not answer as the fixture (HTTP ${status})`;
  if (body.revision !== revision) return `the web service is not serving the ${revision} revision`;
  if (start && (body.entrypoint !== start.entrypoint || (body.startedWith ?? null) !== start.startedWith)) {
    return `the web service was started ${body.entrypoint ? 'through' : 'without'} the image's entrypoint with ${JSON.stringify(body.startedWith ?? null)}, not ${start.entrypoint ? 'through' : 'without'} it with ${JSON.stringify(start.startedWith)}`;
  }
  if (body.database !== true) return 'the web service could not use its database';
  if (body.worker !== true) return 'the worker has not written to the database in the last two minutes';
  if (body.storage !== true) return 'the web service could not write a file to its storage and read it back';
  if (body.scheduled !== true) return 'the scheduled job has not run in the last five minutes';
  if (body.onDemand !== true) return 'the on-demand worker has not finished queued work in the last five minutes';
  return undefined;
}

/** An image with its own entrypoint: it marks the process and runs what it is given, as many real images do. */
export const ENGINE_FIXTURE_ENTRYPOINT = '#!/bin/sh\nexport CONFORMANCE_ENTRYPOINT=1\nexec "$@"\n';
export function engineFixtureEntrypointDockerfile(dockerfile: string): string {
  const start = 'CMD ["node", "server.mjs"]';
  if (!dockerfile.includes(start)) throw new Error('The fixture Dockerfile no longer ends in the expected start line.');
  return dockerfile.replace(start, `COPY entry.sh ./\nRUN chmod +x entry.sh\nENTRYPOINT ["/app/entry.sh"]\n${start}`);
}

/** A second environment for the same project: a web service and its own database, nothing else. */
export function engineFixtureSiblingEnvironment(cloud: EngineFixtureCloud, region?: string): Record<string, unknown> {
  return {
    hosting: { ...SPEC_NAMES[cloud].hosting, ...(region ? { region } : {}) },
    database: SPEC_NAMES[cloud].database,
    services: { web: { workloadKind: 'web', startCommand: 'node server.mjs', healthCheckPath: '/health', public: true } },
    email: { enabled: false }, envVars: { CONFORMANCE_APP_REVISION: 'sibling' }, deploy: { strategy: 'manual' },
  };
}

/**
 * The second environment must use a database, and it must not be the first one's: the first environment's
 * worker writes there every 15 seconds, so seeing a recent worker write here means the two share a database.
 */
export function engineFixtureSiblingResponseProblem(status: number, value: unknown): string | undefined {
  const body = value as { service?: string; revision?: string; database?: boolean; worker?: boolean } | null;
  if (status !== 200 || body?.service !== 'hypervibe-provider-conformance') return `the second environment's web service did not answer as the fixture (HTTP ${status})`;
  if (body.revision !== 'sibling') return "the second environment's web service is not serving its own settings";
  if (body.database !== true) return "the second environment's web service could not use its database";
  if (body.worker !== false) return "the second environment sees the first environment's worker writes, so they share a database";
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

export interface GcpFixtureAccess { projectId: string; region: string; token: () => Promise<string> }

async function gcpList(access: GcpFixtureAccess, url: string, key: string): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 200; page++) {
    const target = new URL(url);
    if (pageToken) target.searchParams.set('pageToken', pageToken);
    const response = await fetch(target, { headers: { authorization: `Bearer ${await access.token()}` }, signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) throw new Error(`Google Cloud could not list ${key} (HTTP ${response.status}); what exists is unknown.`);
    const body = await response.json() as Record<string, unknown>;
    all.push(...((body[key] ?? []) as Array<Record<string, unknown>>));
    if (typeof body.nextPageToken !== 'string' || !body.nextPageToken) return all;
    pageToken = body.nextPageToken;
  }
  throw new Error('Google Cloud inventory did not end; what exists is unknown.');
}

/**
 * What an environment can create in the fixture's Google project and region: Cloud Run
 * services, jobs and worker pools, database instances, buckets, secrets, schedules and
 * workflows. Images in the project's shared repository are not listed. A failed read throws.
 */
export async function readGcpInventory(access: GcpFixtureAccess): Promise<NativeFixtureResource[]> {
  const place = `projects/${access.projectId}/locations/${access.region}`;
  const kinds: Array<[type: string, url: string, key: string]> = [
    ['run-service', `https://run.googleapis.com/v2/${place}/services`, 'services'],
    ['run-job', `https://run.googleapis.com/v2/${place}/jobs`, 'jobs'],
    ['run-worker-pool', `https://run.googleapis.com/v2/${place}/workerPools`, 'workerPools'],
    ['sql-instance', `https://sqladmin.googleapis.com/v1/projects/${access.projectId}/instances`, 'items'],
    ['bucket', `https://storage.googleapis.com/storage/v1/b?project=${access.projectId}`, 'items'],
    ['secret', `https://secretmanager.googleapis.com/v1/projects/${access.projectId}/secrets`, 'secrets'],
    ['schedule', `https://cloudscheduler.googleapis.com/v1/${place}/jobs`, 'jobs'],
    ['workflow', `https://workflows.googleapis.com/v1/${place}/workflows`, 'workflows'],
  ];
  const found: NativeFixtureResource[] = [];
  for (const [type, url, key] of kinds) {
    for (const entry of await gcpList(access, url, key)) {
      if (typeof entry.name !== 'string' || !entry.name) throw new Error(`Google Cloud listed a ${type} without a name.`);
      found.push({ provider: 'gcp', type, id: entry.name, address: `${type}/${entry.name}` });
    }
  }
  return found;
}

/**
 * Google's database instances keep a public address; what closes them is an empty list of
 * networks allowed to connect, so only Google's own authenticated connector gets in.
 * Every instance the fixture created is checked; the address returned is the first environment's.
 */
export async function readGcpDatabaseExposure(access: GcpFixtureAccess, created: NativeFixtureResource[], environmentName: string): Promise<DatabaseExposure> {
  const names = created.filter((resource) => resource.type === 'sql-instance').map((resource) => resource.id);
  const own = names.filter((name) => name.startsWith(`hv-${environmentName}-db-`));
  if (own.length !== 1) throw new Error(`The fixture should have created exactly one database instance for ${environmentName}; found ${own.length}.`);
  const problems: string[] = []; let host: string | undefined;
  for (const name of names) {
    const response = await fetch(`https://sqladmin.googleapis.com/v1/projects/${access.projectId}/instances/${name}`, { headers: { authorization: `Bearer ${await access.token()}` }, signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) throw new Error('The Google database instance could not be read; its exposure is unknown.');
    const instance = await response.json() as { settings?: { ipConfiguration?: { authorizedNetworks?: Array<{ value?: string }> } }; ipAddresses?: Array<{ type?: string; ipAddress?: string }> };
    if (!instance.settings?.ipConfiguration) throw new Error('The Google database instance reported no network settings; its exposure is unknown.');
    const allowed = instance.settings.ipConfiguration.authorizedNetworks ?? [];
    if (allowed.length) problems.push(`instance ${name} allows connections from ${allowed.map((network) => network.value).join(', ')}`);
    if (name === own[0]) host = instance.ipAddresses?.find((address) => address.type === 'PRIMARY')?.ipAddress;
  }
  if (!host) throw new Error('The Google database instance reported no address to test.');
  return { host, problems };
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
 * What costs money, holds data or keeps running in the fixture's AWS region: networks, their
 * endpoints and NAT gateways, database clusters, instances and kept snapshots,
 * container clusters, image repositories and buckets, plus schedules, state machines,
 * event rules, parameters and log groups. A network cannot be
 * deleted while anything is attached to it, so a missing network also covers
 * load balancers, tasks and network interfaces. SDK errors throw.
 */
export async function readAwsInventory(access: AwsAccess): Promise<NativeFixtureResource[]> {
  const config = { region: access.region, credentials: access.credentials };
  const ec2 = new EC2Client(config); const rds = new RDSClient(config); const ecs = new ECSClient(config); const ecr = new ECRClient(config); const s3 = new S3Client(config);
  const scheduler = new SchedulerClient(config); const sfn = new SFNClient(config); const events = new EventBridgeClient(config);
  const logs = new CloudWatchLogsClient(config); const ssm = new SSMClient(config);
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
      // The fixture lives in the account's default network, which is always there. Anything still attached to it
      // (a load balancer, a container, a database) holds a network interface, and its firewall rules a security group.
      ...(await pages(async (NextToken) => { const r = await ec2.send(new DescribeNetworkInterfacesCommand({ NextToken })); return { items: r.NetworkInterfaces ?? [], next: r.NextToken }; })).map((entry) => item('network-interface', entry.NetworkInterfaceId)),
      ...(await pages(async (NextToken) => { const r = await ec2.send(new DescribeSecurityGroupsCommand({ NextToken })); return { items: r.SecurityGroups ?? [], next: r.NextToken }; })).map((entry) => item('security-group', entry.GroupId)),
      // What runs scheduled jobs and wakes on-demand workers, and what holds settings and logs.
      ...(await pages(async (NextToken) => { const r = await scheduler.send(new ListSchedulesCommand({ NextToken })); return { items: r.Schedules ?? [], next: r.NextToken }; })).map((entry) => item('schedule', entry.Arn)),
      ...(await pages(async (nextToken) => { const r = await sfn.send(new ListStateMachinesCommand({ nextToken })); return { items: r.stateMachines ?? [], next: r.nextToken }; })).map((entry) => item('state-machine', entry.stateMachineArn)),
      ...(await pages(async (NextToken) => { const r = await events.send(new ListRulesCommand({ NextToken })); return { items: r.Rules ?? [], next: r.NextToken }; })).map((entry) => item('event-rule', entry.Arn)),
      // Secrets are not listed: the deploy role may not list them, by design.
      ...(await pages(async (NextToken) => { const r = await ssm.send(new DescribeParametersCommand({ NextToken })); return { items: r.Parameters ?? [], next: r.NextToken }; })).map((entry) => item('parameter', entry.Name)),
      ...(await pages(async (nextToken) => { const r = await logs.send(new DescribeLogGroupsCommand({ nextToken })); return { items: r.logGroups ?? [], next: r.nextToken }; })).map((entry) => item('log-group', entry.logGroupName)),
    ];
  } finally { for (const client of [ec2, rds, ecs, ecr, s3, scheduler, sfn, events, logs, ssm]) client.destroy(); }
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

/**
 * Why AWS containers are not running, read while they still exist: each service's
 * latest events, why its stopped containers stopped, and the newest log lines.
 * Teardown deletes all of it, so a failed apply reads this first. Read-only; a
 * failed read is reported as text, never thrown, because this runs on the failure path.
 */
export async function readAwsContainerTrouble(access: AwsAccess, logGroupPrefix: string): Promise<string> {
  const config = { region: access.region, credentials: access.credentials };
  const ecs = new ECSClient(config); const logs = new CloudWatchLogsClient(config);
  const lines: string[] = [];
  try {
    for (const cluster of (await ecs.send(new ListClustersCommand({}))).clusterArns ?? []) {
      const services = (await ecs.send(new ListServicesCommand({ cluster }))).serviceArns ?? [];
      for (const service of services.length ? (await ecs.send(new DescribeServicesCommand({ cluster, services }))).services ?? [] : []) {
        lines.push(`service ${service.serviceName}: ${service.status}, ${service.runningCount}/${service.desiredCount} running`);
        for (const event of (service.events ?? []).slice(0, 6)) lines.push(`  event: ${event.message}`);
      }
      const stopped = (await ecs.send(new ListTasksCommand({ cluster, desiredStatus: 'STOPPED' }))).taskArns ?? [];
      for (const task of stopped.length ? (await ecs.send(new DescribeTasksCommand({ cluster, tasks: stopped.slice(0, 10) }))).tasks ?? [] : []) {
        lines.push(`stopped ${task.group}: ${task.stopCode} ${task.stoppedReason}`);
        for (const container of task.containers ?? []) lines.push(`  container ${container.name}: exit ${container.exitCode ?? 'none'} ${container.reason ?? ''}`);
      }
    }
    const events = (await logs.send(new FilterLogEventsCommand({ logGroupName: logGroupPrefix, limit: 40, startTime: Date.now() - 30 * 60_000 }))).events ?? [];
    // The fixture never logs its settings, but a crash can echo a connection address.
    for (const event of events) lines.push(`  log ${event.logStreamName}: ${(event.message ?? '').slice(0, 300).replace(/postgres(ql)?:\/\/\S+/g, '[database address]')}`);
  } catch (error) { lines.push(`could not read further: ${error instanceof Error ? error.message : String(error)}`); }
  finally { ecs.destroy(); logs.destroy(); }
  return lines.join('\n') || 'AWS reported no services, stopped containers or log lines.';
}

/**
 * What AWS says about a web service's release, sampled over a few minutes: its
 * status, the deployment it names as current and each configuration it lists as
 * active. Read after a release that did not report finished, to see whether AWS
 * settles later or describes the release differently from what Hypervibe expects.
 * Read-only; a failed read is reported as text.
 */
export async function sampleAwsWebRelease(access: AwsAccess, serviceArn: string, samples = 10, pauseMs = 30_000): Promise<string> {
  const ecs = new ECSClient({ region: access.region, credentials: access.credentials });
  const lines: string[] = [];
  try {
    for (let sample = 0; sample < samples; sample++) {
      if (sample) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      const service = (await ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn }))).service;
      const deployment = service?.currentDeployment
        ? (await ecs.send(new DescribeServiceDeploymentsCommand({ serviceDeploymentArns: [service.currentDeployment] }))).serviceDeployments?.[0] : undefined;
      lines.push(`sample ${sample}: service ${service?.status?.statusCode}; deployment ${service?.currentDeployment?.split('/').pop() ?? 'none'} ${deployment?.status ?? ''}; ${
        (service?.activeConfigurations ?? []).map((entry) => `[${entry.serviceRevisionArn?.split('/').pop()} ${entry.primaryContainer?.image?.split('/').pop()}]`).join(' ') || 'no active configuration'}`);
    }
  } catch (error) { lines.push(`could not read further: ${error instanceof Error ? error.message : String(error)}`); }
  finally { ecs.destroy(); }
  return lines.join('\n');
}
