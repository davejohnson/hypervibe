import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { readRuntimeObservations, type RuntimeBinding, type RuntimeExecution } from '../index.js';

// Reconstructed API responses. Only the actual HTTP transport is replaced.
const since = '2026-11-27T10:00:00.000Z';
const until = '2026-11-27T10:30:00.000Z';
const window = { since, until };
const start = '2026-11-27T10:01:00.000Z';
const end = '2026-11-27T10:10:00.000Z';
const gcpId = 'projects/acme-app/locations/us-west1/jobs/prod-nightly';
const gcp: RuntimeBinding = { environmentName: 'prod', provider: 'gcp', services: {
  nightly: { region: 'us-west1', serviceId: gcpId, workloadKind: 'cron' },
} };
const token = 'this-is-a-sensitive-cloud-token';
const gcpAccess = { provider: 'gcp', token } as const;

type FetchRequest = { url: URL; body: Record<string, unknown>; init: RequestInit };
function transport(route: (call: FetchRequest) => Response) {
  const calls: FetchRequest[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const call = { url: new URL(input), body: init.body ? JSON.parse(String(init.body)) : {}, init };
    calls.push(call);
    return route(call);
  });
  return calls;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reads all Cloud Run job and log pages in the exact project, region and window; reports terminal completions and redacts secrets', async () => {
  const condition = (state: string) => ({ type: 'Completed', state, message: 'failed password="example password" ' + token });
  const execution = (id: string, state: string, time?: string) => ({
    name: gcpId + '/executions/' + id, startTime: start, conditions: [condition(state)], completionTime: time,
  });
  const log = { resource: { type: 'cloud_run_job', labels: { location: 'us-west1', project_id: 'acme-app', job_name: 'prod-nightly' } },
    timestamp: end, insertId: 'row-1', logName: 'projects/acme-app/logs/run.googleapis.com%2Fstdout', severity: 'DEFAULT',
    jsonPayload: { level: 50, msg: 'Connection refused token=example-secret ' + token } };
  const calls = transport(({ url, body }) => {
    if (url.hostname === 'logging.googleapis.com') return Response.json(body.pageToken ? { entries: [log, log, { ...log, severity: 'INFO', textPayload: '0 errors', jsonPayload: {} }] } : { nextPageToken: 'log-next' });
    return Response.json(url.searchParams.has('pageToken') ? { executions: [execution('failed-run', 'CONDITION_FAILED', end),
      execution('good-run', 'CONDITION_SUCCEEDED', end), execution('out-of-window', 'CONDITION_FAILED', until)] }
      : { nextPageToken: 'exec-next', executions: [execution('running', 'CONDITION_RECONCILING')] });
  });
  const runs: RuntimeExecution[] = [];
  const report = await readRuntimeObservations(gcp, window, gcpAccess, { onExecution: run => runs.push(run) });
  expect(report.sources.filter(s => s.status === 'ok').map(s => s.kind).sort()).toEqual(['jobs', 'logs']);
  expect(report.observations).toHaveLength(3);
  expect(report.observations).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'job', id: 'failed-run', status: 'failed', at: end }),
    expect.objectContaining({ kind: 'job', id: 'good-run', status: 'succeeded', at: end }),
    expect.objectContaining({ kind: 'log', id: expect.stringMatching(/^[a-f0-9]{64}$/), severity: 'ERROR', message: expect.stringContaining('Connection refused') }),
  ]));
  expect(runs.map(r => r.status)).toContain('active');
  expect(JSON.stringify(report)).not.toMatch(/example-secret|example password|this-is-a-sensitive/);
  expect(calls.map(c => c.url.pathname)).toEqual(['/v2/' + gcpId + '/executions', '/v2/' + gcpId + '/executions', '/v2/entries:list', '/v2/entries:list']);
  const logBody = calls.at(-1)!.body;
  expect(logBody.resourceNames).toEqual(['projects/acme-app']);
  for (const field of ['resource.labels.location="us-west1"', 'resource.labels.job_name="prod-nightly"', since, until]) expect(logBody.filter).toContain(field);
});

it.each([['services', 'web', 'cloud_run_revision', 'service_name'], ['workerPools', 'worker', 'cloud_run_worker_pool', 'worker_pool_name']] as const)(
  'queries the exact %s logging identity, marks repeated pages and wrong identities incomplete', async (collection, kind, type, label) => {
    let mismatch = false;
    const calls = transport(() => Response.json(mismatch ? { entries: [{ resource: { type, labels: { project_id: 'acme-app', location: 'wrong-place', [label]: 'app' } } }] } : { nextPageToken: 'loop' }));
    const binding = { ...gcp, services: { web: { ...gcp.services.nightly, serviceId: 'projects/acme-app/locations/us-west1/' + collection + '/app', workloadKind: kind } } };
    for (const bad of [false, true]) {
      mismatch = bad;
      const report = await readRuntimeObservations(binding, window, gcpAccess, { sources: ['logs'] });
      expect(report.sources).toContainEqual(expect.objectContaining({ kind: 'logs', status: 'failed' }));
    }
    expect(calls).toHaveLength(3);
    expect(calls[0].body.filter).toContain(`resource.type="${type}"`);
    expect(calls[0].body.filter).toContain(`resource.labels.${label}="app"`);
  });

const ecs = 'arn:aws:ecs:us-east-1:123456789012';
const clusterArn = ecs + ':cluster/acme-prod';
const taskDefinitionArn = ecs + ':task-definition/acme-prod-nightly:3';
const logGroup = '/hypervibe/acme-prod/tasks';
const logStreamPrefix = 'acme-prod-nightly/app/';
const taskArn = ecs + ':task/acme-prod/abcdef';
const aws: RuntimeBinding = { provider: 'aws', environmentName: 'prod', services: {
  nightly: { serviceId: taskDefinitionArn, region: 'us-east-1', workloadKind: 'cron', clusterArn, taskDefinitionArn, logGroup, logStreamPrefix },
} };
const awsAccess = { provider: 'aws', credentials: { accessKeyId: 'AKIASYNTHETICXYZ', secretAccessKey: 'synthetic-cloud-secret', sessionToken: token } } as const;
function awsWire(route: (action: string, params: Record<string, unknown>) => unknown) {
  const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async req => {
    const action = req.headers['x-amz-target'].split('.').at(-1)!;
    const params = JSON.parse(String(req.body));
    requests.push({ action, params });
    return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify(route(action, params))]) } };
  });
  return requests;
}

it('follows empty CloudWatch pages and describes exact current/prior-revision ECS executions in the window', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(until));
  const requests = awsWire((action, params) => {
    if (action === 'FilterLogEvents') return params.nextToken ? { events: [
      { logStreamName: logStreamPrefix + 'abc', timestamp: Date.parse(since), eventId: 'id-1', message: '{"level":50,"msg":"database busy"}' },
      { logStreamName: logStreamPrefix + 'abc', timestamp: Date.parse(end), eventId: 'id-2', message: 'ready' },
    ] } : { events: [], nextToken: 'more' };
    if (action === 'ListTasks') return { taskArns: params.desiredStatus === 'STOPPED' ? [taskArn] : [] };
    return { tasks: [{ taskArn, clusterArn, taskDefinitionArn: taskDefinitionArn.replace(':3', ':1'), lastStatus: 'STOPPED',
      createdAt: Date.parse(start) / 1000, stoppedAt: Date.parse(end) / 1000, stopCode: 'TaskFailedToStart', stoppedReason: 'start failed ' + token }], failures: [] };
  });
  const report = await readRuntimeObservations(aws, window, awsAccess);
  expect(report.sources.filter(s => s.status === 'ok').map(s => s.kind).sort()).toEqual(['jobs', 'logs']);
  expect(report.observations).toHaveLength(2);
  expect(report.observations).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'job', status: 'failed', id: 'abcdef', at: end }),
    expect.objectContaining({ kind: 'log', message: 'database busy', at: since, id: expect.any(String) }),
  ]));
  expect(JSON.stringify(report)).not.toContain(token);
  expect(requests.filter(r => r.action === 'ListTasks').map(r => r.params)).toEqual(expect.arrayContaining([
    expect.objectContaining({ cluster: clusterArn, family: 'acme-prod-nightly', desiredStatus: 'RUNNING' }),
    expect.objectContaining({ cluster: clusterArn, family: 'acme-prod-nightly', desiredStatus: 'STOPPED' }),
  ]));
  expect(requests.at(-1)!.params).toMatchObject({ logGroupName: logGroup, logStreamNamePrefix: logStreamPrefix, startTime: Date.parse(since), endTime: Date.parse(until) - 1, nextToken: 'more' });
});

it('distinguishes expired ECS history, missing task details and unscoped CloudWatch pages from healthy empty windows', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(until) + 86400_000);
  let missing = false;
  awsWire((action) => action === 'ListTasks' ? { taskArns: missing ? [taskArn] : [] } : action === 'DescribeTasks' ? { tasks: [], failures: [{ reason: 'MISSING' }] } :
    { events: [{ logStreamName: 'staging/app/id', timestamp: Date.parse(end), message: 'ERROR wrong env' }] });
  const expired = await readRuntimeObservations(aws, window, awsAccess);
  expect(expired.sources).toContainEqual(expect.objectContaining({ kind: 'jobs', status: 'failed', message: expect.stringContaining('retention') }));
  expect(expired.sources).toContainEqual(expect.objectContaining({ kind: 'logs', status: 'failed' }));
  expect(expired.observations).toEqual([]);
  missing = true;
  const partial = await readRuntimeObservations(aws, window, awsAccess, { sources: ['jobs'] });
  expect(partial.sources).toContainEqual(expect.objectContaining({ kind: 'jobs', status: 'failed', message: expect.stringContaining('describe every') }));
});

const azureRoot = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/hv-app/providers/Microsoft.App';
const managedEnvironmentId = azureRoot + '/managedEnvironments/acme-apps';
const jobId = azureRoot + '/jobs/acme-prod-nightly';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const azure: RuntimeBinding = { provider: 'azure', environmentName: 'prod', services: {
  nightly: { region: 'westus2', serviceId: jobId, workloadKind: 'cron', managedEnvironmentId, workspaceId },
} };
const azureAccess = { provider: 'azure', getToken: async (scope: string) => scope.includes('loganalytics') ? 'logs-' + token : 'arm-' + token } as const;
function azureLogTable(rows: unknown[]) {
  return { tables: [{ name: 'PrimaryResult', columns: ['TimeGenerated', 'Environment', 'Workload', 'Message', 'Severity', 'Item'].map(name => ({ name })), rows }] };
}
function azureResource(path: string) {
  if (path === jobId) return { id: jobId, location: 'westus2', properties: { environmentId: managedEnvironmentId } };
  if (path === managedEnvironmentId) return { id: managedEnvironmentId, properties: { appLogsConfiguration: { logAnalyticsConfiguration: { customerId: workspaceId } } } };
  throw new Error('unexpected resource');
}

it('reads scoped Azure execution pages and queries the verified shared workspace in bounded disjoint time slices', async () => {
  const calls = transport(({ url, body }) => {
    if (url.pathname === jobId + '/executions') {
      if (url.searchParams.has('page')) return Response.json({ value: [{ name: 'completed', id: jobId + '/executions/completed',
        properties: { startTime: start, endTime: end, status: 'Succeeded' } }] });
      return Response.json({ value: [{ name: 'active', properties: { startTime: since, status: 'Processing' } }],
        nextLink: 'https://management.azure.com' + jobId + '/executions?page=2' });
    }
    if (url.hostname !== 'api.loganalytics.azure.com') return Response.json(azureResource(url.pathname));
    if (body.timespan === since + '/' + until) return Response.json(azureLogTable(Array(501).fill([])));
    return Response.json(azureLogTable(body.timespan?.toString().startsWith(since) ? [
      [end, 'acme-apps', 'acme-prod-nightly', 'Error: Authorization: Bearer logs-' + token, '', 'native-item'],
    ] : []));
  });
  const runs: RuntimeExecution[] = [];
  const report = await readRuntimeObservations(azure, window, azureAccess, { onExecution: event => runs.push(event) });
  expect(report.sources.filter(s => s.status === 'ok').map(s => s.kind).sort()).toEqual(['jobs', 'logs']);
  expect(report.observations).toHaveLength(2);
  expect(runs.map(r => r.status)).toEqual(['active', 'succeeded']);
  expect(JSON.stringify(report)).not.toContain(token);
  expect(calls.filter(c => c.url.hostname === 'api.loganalytics.azure.com').map(c => c.body.timespan)).toEqual([
    since + '/' + until, since + '/2026-11-27T10:15:00.000Z', '2026-11-27T10:15:00.000Z/' + until,
  ]);
  const query = calls.find(c => c.url.hostname === 'api.loganalytics.azure.com')!;
  expect(query.url.pathname).toBe('/v1/workspaces/' + workspaceId + '/query');
  expect(query.body.query).toContain("EnvironmentName_s == 'acme-apps' and ContainerJobName_s == 'acme-prod-nightly'");
  expect(query.init.headers).toMatchObject({ authorization: 'Bearer logs-' + token });
});

it('rejects cross-job execution pagination before making a request, partial Log Analytics responses and wrong workspace bindings', async () => {
  let wrongWorkspace = false;
  const calls = transport(({ url }) => {
    if (url.hostname === 'api.loganalytics.azure.com') return Response.json({ ...azureLogTable([]), error: { code: 'PartialError', message: token } });
    if (url.pathname.endsWith('/executions')) return Response.json({ value: [], nextLink: 'https://other.example/' });
    if (wrongWorkspace && url.pathname === managedEnvironmentId) return Response.json({ id: managedEnvironmentId, properties: { appLogsConfiguration: { logAnalyticsConfiguration: { customerId: 'another' } } } });
    return Response.json(azureResource(url.pathname));
  });
  const report = await readRuntimeObservations(azure, window, azureAccess);
  expect(report.sources.filter(s => s.status === 'failed').map(s => s.kind).sort()).toEqual(['jobs', 'logs']);
  expect(report.observations).toEqual([]);
  expect(JSON.stringify(report)).not.toContain(token);
  expect(calls.some(c => c.url.hostname === 'other.example')).toBe(false);
  wrongWorkspace = true;
  const second = await readRuntimeObservations(azure, window, azureAccess, { sources: ['logs'] });
  expect(second.sources).toContainEqual(expect.objectContaining({ kind: 'logs', message: expect.stringContaining('different log workspace') }));
  expect(calls.filter(c => c.url.hostname === 'api.loganalytics.azure.com')).toHaveLength(1);
});

it('preserves another workload’s observations when one read is denied, without including the provider error body', async () => {
  const services = { ...gcp.services, other: { ...gcp.services.nightly, serviceId: gcpId.replace('prod-nightly', 'other-cron') } };
  transport(({ url }) => url.pathname.includes('other-cron') ? Response.json({ error: { message: token } }, { status: 403 })
    : Response.json({ executions: [{ name: gcpId + '/executions/nightly-ok', startTime: since, completionTime: end,
      conditions: [{ type: 'Completed', state: 'CONDITION_SUCCEEDED' }] }] }));
  const report = await readRuntimeObservations({ ...gcp, services }, window, gcpAccess, { sources: ['jobs'] });
  expect(report.sources).toContainEqual({ kind: 'jobs', status: 'failed', message: 'other: Provider read returned HTTP 403.' });
  expect(report.observations).toEqual([{ kind: 'job', job: 'nightly', id: 'nightly-ok', at: end, status: 'succeeded' }]);
});

it('collects an error beyond the first 20 pages of a busy interval and advances through the new interval even when the overlap is busy', async () => {
  const { pollRuntime } = await import('../../../application/runtime-observation-poll.js');
  const binding: RuntimeBinding = { ...gcp, services: { app: { region: 'us-west1', workloadKind: 'web',
    serviceId: 'projects/acme-app/locations/us-west1/services/prod-app' } } };
  const events = Array.from({ length: 92 }, (_, i) => ({ timestamp: new Date(Date.parse(since) + i * 5000).toISOString(),
    severity: i === 91 ? 'ERROR' : 'INFO', textPayload: i === 91 ? 'Database unavailable' : 'ready', logName: 'projects/acme-app/logs/app', insertId: 'id' + i,
    resource: { type: 'cloud_run_revision', labels: { service_name: 'prod-app', project_id: 'acme-app', location: 'us-west1' } } }));
  transport(({ body }) => {
    const [, from, to] = /timestamp >= "([^"]+)" AND timestamp < "([^"]+)"/.exec(String(body.filter))!;
    const selected = events.filter(event => event.timestamp >= from && event.timestamp < to);
    const offset = Number(body.pageToken ?? 0);
    return Response.json({ entries: selected.slice(offset, offset + 1), ...(offset + 1 < selected.length ? { nextPageToken: String(offset + 1) } : {}) });
  });
  const previous = { version: 1 as const, repositoryId: '27', environment: 'prod', provider: 'gcp' as const, jobs: start, logs: start, starts: {}, schedules: {} };
  let cursor: import('../../../ci/observation-history.js').ObserverCursor = previous;
  const observed: string[] = [];
  const now = new Date(Date.parse(since) + 10 * 60_000);
  for (let i = 0; i < 4 && cursor.logs < now.toISOString(); i++) {
    const result = await pollRuntime({ binding, repositoryId: '27', previous: cursor, now, schedules: {},
      read: (w, options) => readRuntimeObservations(binding, w, gcpAccess, options) });
    observed.push(...result.report.observations.flatMap(e => e.kind === 'log' ? [e.message] : []));
    expect(Date.parse(result.cursor.logs)).toBeGreaterThan(Date.parse(cursor.logs));
    cursor = result.cursor;
  }
  expect(cursor.logs).toBe(now.toISOString());
  expect(observed).toContain('Database unavailable');
});

it('keeps all application severity formats and local error markers in native candidate queries', async () => {
  const entries = ['Unhandled rejection', 'Connection refused', 'failure', 'Crashed worker', 'Fatal signal', 'an Exception',
    'SequelizeConnectionError: unreachable', '{"level":50,"msg":"database busy"}', '{"severity":"ALERT","message":"database busy"}',
    '{"lev\\u0065l":60,"msg":"database busy"}'];
  const awsCalls = awsWire(() => ({ events: [] }));
  await readRuntimeObservations(aws, window, awsAccess, { sources: ['logs'] });
  const pattern = String(awsCalls[0].params.filterPattern);
  // This subset of AWS filter syntax uses alternation, ASCII classes and a hex escape.
  const candidates = new RegExp(pattern.slice(1, -1));
  expect(entries.every(e => candidates.test(e))).toBe(true);
  expect(candidates.test('healthy')).toBe(false);
  const requests = transport(({ url }) => url.hostname === 'logging.googleapis.com' ? Response.json({})
    : url.hostname === 'api.loganalytics.azure.com' ? Response.json(azureLogTable([])) : Response.json(azureResource(url.pathname)));
  await readRuntimeObservations(gcp, window, gcpAccess, { sources: ['logs'] });
  await readRuntimeObservations(azure, window, azureAccess, { sources: ['logs'] });
  expect(String(requests[0].body.filter)).toContain('severity >= ERROR OR jsonPayload:* OR textPayload =~');
  const kql = String(requests.at(-1)!.body.query);
  expect(kql.indexOf('where Severity')).toBeLessThan(kql.indexOf('take 501'));
  expect(kql).toContain("Message contains '{'");
});

it('reports an unpageable dense Azure millisecond, retains visible errors and continues to the next error', async () => {
  const { pollRuntime } = await import('../../../application/runtime-observation-poll.js');
  const one = new Date(Date.parse(start) + 1).toISOString();
  const later = new Date(Date.parse(start) + 3000).toISOString();
  transport(({ url, body }) => {
    if (url.pathname.endsWith('/executions')) return Response.json({ value: [] });
    if (url.hostname !== 'api.loganalytics.azure.com') return Response.json(azureResource(url.pathname));
    const [from, to] = String(body.timespan).split('/');
    if (from <= start && start < to) return Response.json(azureLogTable(Array.from({ length: 501 }, (_, i) =>
      [start, 'acme-apps', 'acme-prod-nightly', 'failure ' + i, 'ERROR', String(i)])));
    return Response.json(azureLogTable(from <= later && later < to ? [[later, 'acme-apps', 'acme-prod-nightly', 'next failure', 'ERROR', 'later']] : []));
  });
  const now = new Date(Date.parse(start) + 6000);
  const result = await pollRuntime({ binding: azure, repositoryId: '27', previous: {
    version: 1, repositoryId: '27', environment: 'prod', provider: 'azure', logs: start, jobs: start, starts: {}, schedules: {},
  }, now, schedules: {}, read: (w, opts) => readRuntimeObservations(azure, w, azureAccess, opts) });
  expect(result.cursor.logs).toBe(now.toISOString());
  expect(result.report.sources).toContainEqual({ kind: 'logs', status: 'failed', message: expect.stringContaining('[' + start + ', ' + one + ')') });
  expect(result.report.observations).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'failure 0' }), expect.objectContaining({ message: 'next failure' })]));
});

it('does not infer a missed execution or advance the job checkpoint from unreadable inventory', async () => {
  const { pollRuntime } = await import('../../../application/runtime-observation-poll.js');
  transport(({ url }) => url.hostname === 'run.googleapis.com' ? Response.json({ error: 'permission denied' }, { status: 403 }) : Response.json({}));
  const result = await pollRuntime({ binding: gcp, repositoryId: '27', now: new Date(until), schedules: { nightly: { cronSchedule: '* * * * *' } },
    previous: { version: 1, repositoryId: '27', provider: 'gcp', environment: 'prod', logs: since, jobs: since, starts: {},
      schedules: { nightly: { definition: JSON.stringify([gcpId, '* * * * *', 'UTC']), since } } },
    read: (w, opts) => readRuntimeObservations(gcp, w, gcpAccess, opts) });
  expect(result.cursor.jobs).toBe(since);
  expect(result.report.sources.find(s => s.kind === 'jobs')?.status).toBe('failed');
  expect(result.report.observations.some(e => e.kind === 'health' && e.check === 'scheduled execution')).toBe(false);
});

it('reaches a structured CloudWatch error after a capped batch of unrelated structured entries', async () => {
  const { pollRuntime } = await import('../../../application/runtime-observation-poll.js');
  const messages = Array.from({ length: 51 }, (_, i) => ({
    logStreamName: logStreamPrefix + 'abcdef', timestamp: Date.parse(since) + i * 4000, eventId: 'e-' + i,
    message: JSON.stringify({ level: i === 50 ? 50 : 30, msg: i === 50 ? 'database saturated' : 'ready' }),
  }));
  awsWire((action, params) => {
    if (action === 'ListTasks') return { taskArns: [] };
    const filtered = messages.filter(e => e.timestamp >= Number(params.startTime) && e.timestamp <= Number(params.endTime));
    const i = Number(params.nextToken ?? 0);
    return { events: filtered.slice(i, i + 1), ...(i + 1 < filtered.length ? { nextToken: String(i + 1) } : {}) };
  });
  const now = new Date(Date.parse(since) + 5 * 60_000);
  vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
  const result = await pollRuntime({ binding: aws, now, repositoryId: '27', schedules: {},
    read: (w, opts) => readRuntimeObservations(aws, w, awsAccess, opts) });
  expect(result.cursor.logs).toBe(now.toISOString());
  expect(result.report.sources).toContainEqual({ kind: 'logs', status: 'ok' });
  expect(result.report.observations).toHaveLength(1);
  expect(result.report.observations[0]).toMatchObject({ kind: 'log', message: 'database saturated' });
});
