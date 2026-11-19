import { registerCoreTools } from '../core.tools.js';
import { CommandRegistry } from '../../application/commands.js';
import { createToolContext } from '../../application/context.js';
import { registerHvObservabilityTools } from '../hv-observability.tools.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { fetchProviderLogs } from '../../domain/services/provider-logs.service.js';
import { collectProjectDeploymentHealth } from '../../domain/services/health.service.js';
import '../../adapters/providers/aws/aws-engine.adapter.js';
import '../../adapters/providers/azure/azure-engine.adapter.js';

const account = '111122223333';
const sub = '11111111-1111-4111-8111-111111111111';
const group = `/subscriptions/${sub}/resourceGroups/hv-app`;
const appId = `${group}/providers/Microsoft.App/containerApps/exact-staging-web`;
const managedEnvironmentId = `${group}/providers/Microsoft.App/managedEnvironments/exact-staging`;
const workspaceId = '22222222-2222-4222-8222-222222222222';
const webArn = `arn:aws:ecs:eu-west-1:${account}:service/exact-staging/exact-staging-web`; const webCluster = `arn:aws:ecs:eu-west-1:${account}:cluster/exact-staging`;
let dir: string;
beforeEach(() => { dir = mkdtempSync(`${tmpdir()}/hv-engine-diag-`); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(`${dir}/db`).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true }); });
function fixture(provider: 'aws' | 'azure') {
  const project = new ProjectRepository().create({ name: 'diag-app', gitRemoteUrl: 'https://github.com/example/diag-app', defaultPlatform: provider });
  const credentials = provider === 'aws' ? { accessKeyId: 'AKIASYNTHETIC00000', secretAccessKey: 'synthetic-secret-value-12345678901234567890', roleArn: `arn:aws:iam::${account}:role/hypervibe/hypervibe-deploy`, accountId: account, region: 'us-west-2' }
    : { tenantId: sub, subscriptionId: sub, clientId: sub, deployPrincipalId: sub, clientSecret: 'synthetic-azure-secret', clientSecretExpiresAt: '2030-01-01T00:00:00Z', resourceGroup: 'hv-app', location: 'westus2' };
  const connection = new ConnectionRepository().create({ provider, scope: 'example/diag-app', credentialsEncrypted: getSecretStore().encryptObject(credentials) });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: {
    provider, projectId: provider === 'aws' ? account : sub, environmentId: provider === 'aws' ? 'eu-west-1' : 'hv-app', engine: { kind: 'opentofu' }, services: { web: provider === 'aws'
      ? { serviceId: webArn, resourceType: 'ecs-express', workloadKind: 'web', region: 'eu-west-1', clusterArn: webCluster, logGroup: '/hypervibe/exact-staging/tasks', logStreamPrefix: 'exact-staging-web/Main/' }
      : { serviceId: appId, resourceType: 'container-app', workloadKind: 'web', region: 'northeurope', managedEnvironmentId, workspaceId } },
  } });
  return { project, environment };
}
function awsTransport(route?: (request: { host: string; path: string; body: any; target: string }) => { data: unknown; status?: number } | undefined) {
  const requests: Array<{ host: string; path: string; body: any; target: string }> = [];
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async (request: any) => {
    const body = request.body ? String(request.body) : '';
    requests.push({ host: request.hostname, path: request.path, body: body.startsWith('{') ? JSON.parse(body) : body, target: request.headers['x-amz-target'] ?? '' });
    let data: unknown;
    if (request.hostname.startsWith('sts.')) data = '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>AKIASYNTHETIC00000</AccessKeyId><SecretAccessKey>temporary-secret</SecretAccessKey><SessionToken>temporary-session</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>';
    else if (String(request.headers['x-amz-target'] ?? '').endsWith('DescribeServices')) data = { services: [{ serviceArn: webArn, clusterArn: webCluster, status: 'ACTIVE', desiredCount: 1, runningCount: 0, pendingCount: 0, deployments: [{ status: 'PRIMARY', rolloutState: 'FAILED' }] }] };
    else data = requests.filter((r) => r.target.endsWith('FilterLogEvents')).length === 1 ? { events: [], nextToken: 'page-two' } : { events: [{ timestamp: 1700000000000, message: 'ERROR temporary-session' }] };
    const custom = route?.(requests.at(-1)!); if (custom) data = custom.data;
    return { response: { statusCode: custom?.status ?? 200, headers: { 'content-type': typeof data === 'string' ? 'text/xml' : 'application/json' }, body: Readable.from([typeof data === 'string' ? data : JSON.stringify(data)]) } };
  });
  return requests;
}
it('reads exact AWS environment logs through serialized clients, follows empty pages, and distinguishes a failed rollout from a running web service', async () => {
  const { project, environment } = fixture('aws'); const requests = awsTransport();
  const result = await fetchProviderLogs('aws', project, environment, 'web', 1);
  expect(result.logs).toHaveLength(1); expect(result.logs[0]!.message).not.toContain('temporary-session');
  expect(requests.filter((r) => !r.host.startsWith('sts.')).every((r) => r.host.includes('eu-west-1'))).toBe(true);
  expect(requests.find((r) => r.target.endsWith('FilterLogEvents'))!.body).toMatchObject({ logGroupName: '/hypervibe/exact-staging/tasks', logStreamNamePrefix: 'exact-staging-web/Main/' });
  const health = await collectProjectDeploymentHealth({ project, environments: [environment], desiredServiceNamesByEnvironment: { staging: ['web'] } });
  expect(health.state).toBe('failed');
});
it('reads exact Azure native identity and scoped workspace logs, and rejects unhealthy current revisions', async () => {
  const { project, environment } = fixture('azure'); const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? String(init.body) : '' });
    if (url.includes('/token')) return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
    if (url.includes('api.loganalytics')) return Response.json({ tables: [{ name: 'PrimaryResult', columns: [{ name: 'TimeGenerated', type: 'datetime' }, { name: 'Message', type: 'string' }, { name: 'Severity', type: 'string' }], rows: [['2026-01-01T00:00:00Z', 'ERROR synthetic-token', 'error']] }] });
    if (url.includes('/managedEnvironments/')) return Response.json({ id: managedEnvironmentId, properties: { appLogsConfiguration: { logAnalyticsConfiguration: { customerId: workspaceId } } } });
    if (url.includes('/revisions/')) return Response.json({ id: `${appId}/revisions/exact-revision`, properties: { provisioningState: 'Provisioned', healthState: 'Unhealthy', runningState: 'Running' } });
    return Response.json({ id: appId, name: 'exact-staging-web', location: 'northeurope', properties: { environmentId: managedEnvironmentId, provisioningState: 'Succeeded', latestRevisionName: 'exact-revision', latestReadyRevisionName: 'older-revision' } });
  }));
  const result = await fetchProviderLogs('azure', project, environment, 'web', 1);
  expect(result.logs).toHaveLength(1); expect(result.logs[0]!.message).not.toContain('synthetic-token');
  expect(calls.find((r) => r.url.includes('api.loganalytics'))!.url).toContain(workspaceId);
  expect(JSON.parse(calls.find((r) => r.url.includes('api.loganalytics'))!.body).query).toContain("ContainerAppName_s == 'exact-staging-web'");
  const health = await collectProjectDeploymentHealth({ project, environments: [environment], desiredServiceNamesByEnvironment: { staging: ['web'] } });
  expect(health.state).toBe('failed');
});

it.each(['aws', 'azure'] as const)('shows observed workload counts and keeps unbound services unknown on %s', async provider => {
  const { project } = fixture(provider);
  const registry = new CommandRegistry();
  registerCoreTools(registry, createToolContext());
  new SpecStore().replace(project, projectSpecSchema.parse({ version: 1, project: project.name, environments: { staging: {
    hosting: { provider }, services: { web: {}, missing: { workloadKind: 'worker' } },
  } } }));
  if (provider === 'aws') awsTransport(r => r.target.endsWith('DescribeServices') ? { data: { services: [{
    serviceArn: webArn, clusterArn: webCluster, status: 'ACTIVE', runningCount: 0, pendingCount: 0, desiredCount: 0,
    deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
  }] } } : undefined);
  else azureTransport({ replicas: 0 });
  const result = await registry.execute('hv_status', { project: project.name, env: 'staging' });
  expect(result).toMatchObject({ ok: true, data: { workloads: expect.arrayContaining([
    expect.objectContaining({ service: 'web', presence: 'present', activity: 'idle', running: 0 }),
    expect.objectContaining({ service: 'missing', presence: 'unknown', activity: 'unknown' }),
  ]), workers: [expect.objectContaining({ service: 'missing', activity: 'unknown' })] } });
});

it('exposes engine logs through the public command and observes worker-only environments without an HTTP URL', async () => {
  const { project } = fixture('aws');
  const registry = new CommandRegistry(); registerHvObservabilityTools(registry, createToolContext());
  awsTransport();
  const logs = await registry.execute('hv_logs', { project: project.name, env: 'staging', source: 'service', limit: 1 });
  expect(logs).toMatchObject({ ok: true, data: { count: 1 } });
  expect(JSON.stringify(logs)).not.toContain('temporary-session');
  new SpecStore().replace(project, projectSpecSchema.parse({ version: 1, project: project.name, environments: { staging: { hosting: { provider: 'aws' }, services: { web: { workloadKind: 'worker' } } } } }));
  const health = await registry.execute('hv_health', { project: project.name, env: 'staging', service: 'web' });
  expect(health).toMatchObject({ ok: true, data: { deploymentHealth: { state: 'failed' }, httpCheck: 'not-applicable' } });
});

it('keeps repeated CloudWatch pages and provider read failures distinct from successful empty logs', async () => {
  const { project, environment } = fixture('aws');
  const requests = awsTransport((r) => r.target.endsWith('FilterLogEvents') ? { data: { events: [], nextToken: 'repeated' } } : undefined);
  await expect(fetchProviderLogs('aws', project, environment, 'web', 5)).rejects.toThrow(/incomplete/);
  expect(requests.filter((r) => r.target.endsWith('FilterLogEvents'))).toHaveLength(2);
  vi.restoreAllMocks();
  awsTransport((r) => r.target.endsWith('FilterLogEvents') ? { data: { events: [] } } : undefined);
  expect((await fetchProviderLogs('aws', project, environment, 'web', 5)).logs).toEqual([]);
  vi.restoreAllMocks();
  awsTransport((r) => r.target.endsWith('FilterLogEvents') ? { status: 403, data: { __type: 'AccessDeniedException', message: 'denied temporary-session' } } : undefined);
  await expect(fetchProviderLogs('aws', project, environment, 'web', 5)).rejects.toThrow(/denied \[redacted\]/);
});
it('does not use credentials for an AWS binding in another account', async () => {
  const { project, environment } = fixture('aws'); const requests = awsTransport();
  const bound = environment.platformBindings as any; bound.services.web.serviceId = webArn.replace(account, '444455556666');
  await expect(fetchProviderLogs('aws', project, environment, 'web', 1)).rejects.toThrow(/account/);
  expect(requests).toEqual([]);
});
it.each([['COMPLETED', 'healthy'], ['FAILED', 'failed'], [undefined, 'unknown']] as const)('observes an idle ECS worker deployment %s without claiming queue health', async (rolloutState, expected) => {
  const { project, environment } = fixture('aws'); const ecs = `arn:aws:ecs:eu-west-1:${account}`; const clusterArn = `${ecs}:cluster/exact`;
  const serviceId = `${ecs}:service/exact/worker`; const taskDefinitionArn = `${ecs}:task-definition/worker:7`;
  (environment.platformBindings as any).services.web = { serviceId, clusterArn, taskDefinitionArn, resourceType: 'ecs-service', workloadKind: 'worker', region: 'eu-west-1', logGroup: '/exact/tasks', logStreamPrefix: 'worker/app/' };
  const requests = awsTransport((r) => r.target.endsWith('DescribeServices') ? { data: { services: [{ serviceArn: serviceId, clusterArn, taskDefinition: taskDefinitionArn, status: 'ACTIVE', desiredCount: 0, runningCount: 0, pendingCount: 0, deployments: [{ status: 'PRIMARY', rolloutState, taskDefinition: taskDefinitionArn }] }] } } : undefined);
  const health = await collectProjectDeploymentHealth({ project, environments: [environment], desiredServiceNamesByEnvironment: { staging: ['web'] } });
  expect(health.state).toBe(expected); expect(requests.find((r) => r.target.endsWith('DescribeServices'))?.body).toEqual({ cluster: clusterArn, services: [serviceId] });
});
it('correlates a scheduled ECS execution to its exact cluster and current task definition', async () => {
  const { project, environment } = fixture('aws'); const ecs = `arn:aws:ecs:eu-west-1:${account}`; const clusterArn = `${ecs}:cluster/exact`;
  const taskDefinitionArn = `${ecs}:task-definition/nightly:4`; const taskArn = `${ecs}:task/exact/0123456789abcdef`;
  (environment.platformBindings as any).services.web = { serviceId: taskDefinitionArn, taskDefinitionArn, clusterArn, resourceType: 'ecs-task', workloadKind: 'cron', region: 'eu-west-1' };
  const requests = awsTransport((r) => {
    if (r.target.endsWith('DescribeTaskDefinition')) return { data: { taskDefinition: { taskDefinitionArn, family: 'nightly', status: 'ACTIVE' } } };
    if (r.target.endsWith('ListTasks')) return { data: { taskArns: r.body.desiredStatus === 'STOPPED' ? [taskArn] : [] } };
    if (r.target.endsWith('DescribeTasks')) return { data: { tasks: [{ taskArn, taskDefinitionArn, clusterArn, createdAt: 1700000000, lastStatus: 'STOPPED', containers: [{ name: 'app', exitCode: 1 }] }] } };
  });
  const health = await collectProjectDeploymentHealth({ project, environments: [environment], desiredServiceNamesByEnvironment: { staging: ['web'] } });
  expect(health.state).toBe('failed'); expect(requests.find((r) => r.target.endsWith('DescribeTasks'))?.body).toEqual({ cluster: clusterArn, tasks: [taskArn] });
});

function azureTransport(options: { replicas?: number; queryError?: boolean; resourceMissing?: boolean; readDenied?: boolean; mismatchedIdentity?: boolean; job?: boolean; jobStatus?: string; nextLink?: string } = {}) {
  const calls: string[] = []; const nativeId = options.job ? appId.replace('/containerApps/', '/jobs/') : appId;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('/token')) return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
    if (url.includes('api.loganalytics')) return Response.json(options.queryError ? { error: { code: 'PartialError' }, tables: [] } : { tables: [{ name: 'PrimaryResult', columns: [{ name: 'TimeGenerated' }, { name: 'Message' }, { name: 'Severity' }], rows: [] }] });
    if (url.includes('/managedEnvironments/')) return Response.json({ id: managedEnvironmentId, properties: { appLogsConfiguration: { logAnalyticsConfiguration: { customerId: workspaceId } } } });
    if (url.includes('/executions')) return Response.json({ value: [{ id: `${nativeId}/executions/exact-run`, properties: { status: options.jobStatus ?? 'Failed', startTime: '2026-11-01T00:00:00Z', template: { containers: [{ name: 'app', image: 'registry/app@sha256:exact' }] } } }], ...(options.nextLink ? { nextLink: options.nextLink } : {}) });
    if (options.readDenied) return Response.json({ error: { message: 'synthetic-token' } }, { status: 403 });
    if (options.resourceMissing) return Response.json({}, { status: 404 });
    if (url.includes('/revisions/')) return Response.json({ id: `${nativeId}/revisions/current`, properties: { replicas: options.replicas, active: true, provisioningState: 'Provisioned', healthState: 'Healthy', runningState: 'Running' } });
    return Response.json({ id: options.mismatchedIdentity ? `${nativeId}-other` : nativeId, location: 'northeurope', properties: { configuration: { activeRevisionsMode: 'Single' }, environmentId: managedEnvironmentId, template: { containers: [{ name: 'app', image: 'registry/app@sha256:exact' }] }, provisioningState: 'Succeeded', latestRevisionName: 'current', latestReadyRevisionName: 'current' } });
  }));
  return calls;
}
it('rejects partial Azure queries and wrong native identities instead of returning empty logs', async () => {
  const { project, environment } = fixture('azure'); azureTransport({ queryError: true });
  await expect(fetchProviderLogs('azure', project, environment, 'web', 1)).rejects.toThrow(/partial/);
  azureTransport({ mismatchedIdentity: true });
  await expect(fetchProviderLogs('azure', project, environment, 'web', 1)).rejects.toThrow(/identity/);
  azureTransport(); expect((await fetchProviderLogs('azure', project, environment, 'web', 1)).logs).toEqual([]);
});
it.each([[{ resourceMissing: true }, 'failed'], [{ readDenied: true }, 'unknown'], [{}, 'healthy']] as const)('preserves absent versus unknown Azure deployment evidence %o', async (options, expected) => {
  const { project, environment } = fixture('azure'); azureTransport(options);
  const health = await collectProjectDeploymentHealth({ project, environments: [environment], desiredServiceNamesByEnvironment: { staging: ['web'] } });
  expect(health.state).toBe(expected); expect(JSON.stringify(health)).not.toContain('synthetic-token');
});
it('reads Azure job execution failures and refuses pagination outside the exact native job', async () => {
  const { project, environment } = fixture('azure'); (environment.platformBindings as any).services.web = { ...(environment.platformBindings as any).services.web, serviceId: appId.replace('/containerApps/', '/jobs/'), resourceType: 'container-job', workloadKind: 'cron' };
  azureTransport({ job: true });
  const request = { project, environments: [environment], desiredServiceNamesByEnvironment: { staging: ['web'] } };
  expect((await collectProjectDeploymentHealth(request)).state).toBe('failed');
  const calls = azureTransport({ job: true, nextLink: 'https://untrusted.example/collect-token' });
  expect((await collectProjectDeploymentHealth(request)).state).toBe('unknown');
  expect(calls.some((url) => url.includes('untrusted'))).toBe(false);
});

it('retains the exact new scheduled-task revision returned by AWS for subsequent diagnostics', async () => {
  const { releaseTask } = await import('../../adapters/providers/aws/aws-release.client.js');
  const arn = `arn:aws:ecs:eu-west-1:${account}:task-definition/nightly:8`;
  awsTransport((r) => {
    if (r.target.endsWith('DescribeTaskDefinition')) return { data: { taskDefinition: { taskDefinitionArn: arn.replace(':8', ':7'), family: 'nightly', containerDefinitions: [{ name: 'app', image: 'old' }] } } };
    if (r.target.endsWith('RegisterTaskDefinition')) return { data: { taskDefinition: { taskDefinitionArn: arn } } };
  });
  const result = await releaseTask({ region: 'eu-west-1', accountId: account, prefix: 'exact', credentials: { accessKeyId: 'AKIASYNTHETIC00000', secretAccessKey: 'synthetic', sessionToken: 'synthetic' } }, 'nightly', 'nightly', 'new', false);
  expect(result).toMatchObject({ status: 'released', taskDefinitionArn: arn });
});

it('keeps equal logical service names isolated between AWS environment bindings', async () => {
  const { project, environment } = fixture('aws');
  const other = { ...environment, id: 'other', name: 'other', platformBindings: { ...environment.platformBindings, services: { web: {
    serviceId: webArn.replaceAll('staging', 'preview'), resourceType: 'ecs-express', workloadKind: 'web', region: 'eu-west-1', clusterArn: webCluster.replace('staging', 'preview'), logGroup: '/hypervibe/exact-preview/tasks', logStreamPrefix: 'exact-preview-web/Main/',
  } } } };
  const requests = awsTransport((r) => r.target.endsWith('FilterLogEvents') ? { data: { events: [] } } : undefined);
  await fetchProviderLogs('aws', project, environment, 'web', 1); await fetchProviderLogs('aws', project, other, 'web', 1);
  expect(requests.filter((r) => r.target.endsWith('FilterLogEvents')).map((r) => r.body.logGroupName)).toEqual(['/hypervibe/exact-staging/tasks', '/hypervibe/exact-preview/tasks']);
});
it('redacts a credential crossing a log truncation boundary before shortening the message', async () => {
  const { project, environment } = fixture('aws');
  awsTransport((r) => r.target.endsWith('FilterLogEvents') ? { data: { events: [{ timestamp: 1700000000000, message: `${'x'.repeat(4090)}temporary-session trailing` }] } } : undefined);
  const logs = await fetchProviderLogs('aws', project, environment, 'web', 1);
  expect(logs.logs[0]?.message).toHaveLength(4096); expect(logs.logs[0]?.truncated).toBe(true);
  expect(logs.logs[0]?.message).not.toContain('tempor'); expect(logs.window?.since).toBeDefined();
});
it('does not report a completed older ECS deployment as the newly bound release', async () => {
  const { project, environment } = fixture('aws'); const ecs = `arn:aws:ecs:eu-west-1:${account}`; const clusterArn = `${ecs}:cluster/exact`; const serviceId = `${ecs}:service/exact/worker`;
  (environment.platformBindings as any).services.web = { serviceId, clusterArn, taskDefinitionArn: `${ecs}:task-definition/worker:8`, resourceType: 'ecs-service', workloadKind: 'worker', region: 'eu-west-1' };
  awsTransport((r) => r.target.endsWith('DescribeServices') ? { data: { services: [{ serviceArn: serviceId, clusterArn, taskDefinition: `${ecs}:task-definition/worker:7`, status: 'ACTIVE', desiredCount: 0, runningCount: 0, pendingCount: 0, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: `${ecs}:task-definition/worker:7` }] }] } } : undefined);
  expect((await collectProjectDeploymentHealth({ project, environments: [environment], desiredServiceNamesByEnvironment: { staging: ['web'] } })).state).toBe('unknown');
});

it('observes a CI-created worker revision in the exact bound task family', async () => {
  const { project, environment } = fixture('aws'); const ecs = `arn:aws:ecs:eu-west-1:${account}`; const clusterArn = `${ecs}:cluster/exact`; const serviceId = `${ecs}:service/exact/worker`;
  const current = `${ecs}:task-definition/worker:2`;
  (environment.platformBindings as any).services.web = { serviceId, clusterArn, taskDefinitionArn: `${ecs}:task-definition/worker:1`, resourceType: 'ecs-service', workloadKind: 'worker', region: 'eu-west-1' };
  let definition = current;
  awsTransport((r) => r.target.endsWith('DescribeServices') ? { data: { services: [{ serviceArn: serviceId, clusterArn, taskDefinition: definition, status: 'ACTIVE', desiredCount: 1, runningCount: 1, pendingCount: 0, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: definition }] }] } } : undefined);
  const request = { project, environments: [environment], desiredServiceNamesByEnvironment: { staging: ['web'] } };
  expect((await collectProjectDeploymentHealth(request)).state).toBe('healthy');
  definition = `${ecs}:task-definition/unrelated:2`;
  expect((await collectProjectDeploymentHealth(request)).state).toBe('unknown');
});
it('matches cron history to the latest ACTIVE revision after CI without accepting an older successful execution', async () => {
  const { project, environment } = fixture('aws'); const ecs = `arn:aws:ecs:eu-west-1:${account}`; const clusterArn = `${ecs}:cluster/exact`;
  const recorded = `${ecs}:task-definition/nightly:1`; const current = `${ecs}:task-definition/nightly:2`; const taskOld = `${ecs}:task/exact/old`; const taskNew = `${ecs}:task/exact/new`;
  (environment.platformBindings as any).services.web = { serviceId: recorded, taskDefinitionArn: recorded, clusterArn, resourceType: 'ecs-task', workloadKind: 'cron', region: 'eu-west-1' };
  let active = current;
  const requests = awsTransport((r) => {
    if (r.target.endsWith('DescribeTaskDefinition')) return { data: { taskDefinition: { taskDefinitionArn: r.body.taskDefinition === recorded ? recorded : active, family: 'nightly', status: 'ACTIVE' } } };
    if (r.target.endsWith('ListTasks')) return { data: { taskArns: r.body.desiredStatus === 'STOPPED' ? [taskOld, taskNew] : [] } };
    if (r.target.endsWith('DescribeTasks')) return { data: { tasks: [{ taskArn: taskOld, taskDefinitionArn: recorded, clusterArn, createdAt: 1700000000, lastStatus: 'STOPPED', containers: [{ name: 'app', exitCode: 0 }] }, { taskArn: taskNew, taskDefinitionArn: current, clusterArn, createdAt: 1700000100, lastStatus: 'STOPPED', containers: [{ name: 'app', exitCode: 1 }] }] } };
  });
  const request = { project, environments: [environment], desiredServiceNamesByEnvironment: { staging: ['web'] } };
  expect((await collectProjectDeploymentHealth(request)).state).toBe('failed');
  expect(requests.find((r) => r.target.endsWith('DescribeTaskDefinition'))?.body.taskDefinition).toBe('nightly');
  active = `${ecs}:task-definition/unrelated:2`;
  expect((await collectProjectDeploymentHealth(request)).state).toBe('unknown');
});
