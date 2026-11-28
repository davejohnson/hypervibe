import { check, logHints, object, pages, readJson, timestamp } from './read.js';
import type { ReadContext, RuntimeSource } from './types.js';

const resources = {
  services: ['cloud_run_revision', 'service_name'],
  workerPools: ['cloud_run_worker_pool', 'worker_pool_name'],
  jobs: ['cloud_run_job', 'job_name'],
} as const;

export async function readGcp(source: RuntimeSource, ctx: ReadContext, token: string): Promise<void> {
  const id = ctx.service.serviceId;
  const match = /^projects\/([a-z][a-z0-9-]{4,61}[a-z0-9]|\d+)\/locations\/([a-z0-9-]+)\/(services|jobs|workerPools)\/([a-z][a-z0-9-]*)$/.exec(id);
  check(match && match[2] === ctx.service.region, 'The Cloud Run binding has no exact project, region and workload identity.');
  const [, project, region, kind, name] = match;
  check((ctx.service.workloadKind === 'cron') === (kind === 'jobs'));
  if (source === 'logs') {
    const [type, label] = resources[kind as keyof typeof resources];
    const candidates = '(severity >= ERROR OR jsonPayload:* OR textPayload =~ ' + JSON.stringify('(?i)' + logHints.join('|') + '|\\{') + ')';
    const filter = [candidates, `resource.type="${type}"`, `resource.labels.project_id="${project}"`, `resource.labels.location="${region}"`,
      `resource.labels.${label}="${name}"`, `timestamp >= "${ctx.window.since}"`, `timestamp < "${ctx.window.until}"`].join(' AND ');
    await pages(async pageToken => {
      const data = await readJson('https://logging.googleapis.com/v2/entries:list', token, {
        resourceNames: [`projects/${project}`], filter, pageSize: 500, orderBy: 'timestamp asc', ...(pageToken ? { pageToken } : {}),
      }, ctx.signal);
      // Repeated protobuf fields may be omitted, including an empty intermediate page.
      const entries = data.entries === undefined ? [] : data.entries;
      check(Array.isArray(entries));
      for (const value of entries) {
        const entry = object(value);
        const resource = object(entry.resource);
        const labels = object(resource.labels);
        check(resource.type === type && labels[label] === name && labels.project_id === project && labels.location === region);
        const at = timestamp(entry.timestamp);
        const payload = entry.jsonPayload == null ? {} : object(entry.jsonPayload);
        const http = entry.httpRequest == null ? {} : object(entry.httpRequest);
        const message = [entry.textPayload, payload.message, payload.msg].find((v): v is string => typeof v === 'string')
          ?? (typeof http.status === 'number' ? `HTTP ${http.status}` : 'Cloud Run log entry');
        const insertId = typeof entry.insertId === 'string' && typeof entry.logName === 'string'
          ? JSON.stringify([entry.logName, at, entry.insertId]) : undefined;
        // A logger can emit structured error levels at Cloud Logging DEFAULT severity.
        const level = entry.severity && entry.severity !== 'DEFAULT' ? entry.severity : payload.severity ?? payload.level;
        ctx.log(at, message, level, insertId);
      }
      return data.nextPageToken;
    });
    return;
  }
  check(kind === 'jobs');
  let count = 0;
  await pages(async pageToken => {
    const url = new URL(`https://run.googleapis.com/v2/${id}/executions`);
    url.searchParams.set('pageSize', '100');
    // The field mask excludes container environments, arguments and all other unrelated data.
    url.searchParams.set('fields', 'nextPageToken,executions(name,createTime,startTime,completionTime,conditions(type,state,message))');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await readJson(url.toString(), token, undefined, ctx.signal);
    const executions = data.executions === undefined ? [] : data.executions;
    check(Array.isArray(executions));
    count += executions.length;
    for (const raw of executions) {
      const e = object(raw);
      const prefix = id + '/executions/';
      check(typeof e.name === 'string' && e.name.startsWith(prefix) && /^[a-z0-9-]+$/.test(e.name.slice(prefix.length)));
      const started = timestamp(e.startTime ?? e.createTime);
      const conditions = e.conditions ?? [];
      check(Array.isArray(conditions));
      const terminal = conditions.map(object).find(c => c.type === 'Completed');
      const status = terminal?.state === 'CONDITION_SUCCEEDED' ? 'succeeded' : terminal?.state === 'CONDITION_FAILED' ? 'failed' : 'active';
      check(status === 'active' ? e.completionTime == null : e.completionTime != null, 'Cloud Run has not supplied a verifiable completion time and status.');
      ctx.execution(e.name.slice(prefix.length), started, status, e.completionTime == null ? undefined : timestamp(e.completionTime),
        status === 'failed' && typeof terminal?.message === 'string' ? terminal.message : undefined);
    }
    return data.nextPageToken;
  });
  check(count < 1000 || Date.parse(ctx.window.since) >= Date.now() - 7 * 86400_000,
    'The requested window may predate retained Cloud Run executions.');
}
