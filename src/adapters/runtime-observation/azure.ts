import { ARM, AZURE_SCOPES } from '../providers/azure/azure-ops.client.js';
import { capacity, check, logHints, object, pages, readJson, timestamp } from './read.js';
import type { ReadContext, RuntimeAccess, RuntimeSource } from './types.js';

const version = 'api-version=2025-01-01';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function logs(ctx: ReadContext, name: string, environment: string, token: string): Promise<void> {
  const id = ctx.service.workspaceId;
  check(id && uuid.test(id), 'The workload has no exact Log Analytics workspace identity.');
  const url = `https://api.loganalytics.azure.com/v1/workspaces/${id}/query`;
  const column = ctx.service.workloadKind === 'cron' ? 'ContainerJobName_s' : 'ContainerAppName_s';
  const windows = [[Date.parse(ctx.window.since), Date.parse(ctx.window.until)]];
  let requests = 0;
  while (windows.length) {
    capacity(++requests <= 32, 'The Log Analytics time window exceeded the query limit.');
    const [start, end] = windows.pop()!;
    const since = new Date(start).toISOString();
    const until = new Date(end).toISOString();
    // No continuation cursor exists for the query API. Split a full time slice
    // and issue disjoint queries until every row fits, or explicitly report the gap.
    const query = [
      'ContainerAppConsoleLogs_CL',
      `where TimeGenerated >= datetime(${since}) and TimeGenerated < datetime(${until})`,
      `where EnvironmentName_s == '${environment}' and ${column} == '${name}'`,
      `project TimeGenerated, Environment=EnvironmentName_s, Workload=${column}, Message=Log_s, Severity=tostring(column_ifexists('LogLevel_s', '')), Item=tostring(column_ifexists('_ItemId', ''))`,
      "where Severity in~ ('ERROR','ERR','CRITICAL','ALERT','EMERGENCY','FATAL','50','60') or Message contains '{' or Message matches regex @'(?i)" + logHints.join('|') + "'",
      'take 501',
    ].join(' | ');
    const body = await readJson(url, token, { query, timespan: `${since}/${until}` }, ctx.signal);
    check(!body.error && Array.isArray(body.tables), 'Log Analytics returned an error or partial query results.');
    const table = body.tables.map(object).find(t => t.name === 'PrimaryResult');
    check(table && Array.isArray(table.columns) && Array.isArray(table.rows));
    const columns = table.columns.map(c => object(c).name);
    const indexes = ['TimeGenerated', 'Environment', 'Workload', 'Message', 'Severity', 'Item'].map(c => columns.indexOf(c));
    check(indexes.every(i => i >= 0));
    if (table.rows.length >= 501 && end - start > 1) {
      const midpoint = start + Math.floor((end - start) / 2);
      windows.push([midpoint, end], [start, midpoint]);
      continue;
    }
    for (const row of table.rows) {
      check(Array.isArray(row));
      const [at, env, workload, message, severity, item] = indexes.map(i => row[i]);
      check(env === environment && workload === name && typeof message === 'string' && typeof severity === 'string' && typeof item === 'string');
      ctx.log(timestamp(at), message, severity, item || undefined);
    }
    capacity(table.rows.length < 501, 'A single millisecond reached the Log Analytics row limit.');
  }
}

export async function readAzure(source: RuntimeSource, ctx: ReadContext, access: Extract<RuntimeAccess, {provider: 'azure'}>): Promise<void> {
  const service = ctx.service;
  const match = /^(\/subscriptions\/([a-f0-9-]+)\/resourceGroups\/[a-z0-9_.()-]+\/providers\/Microsoft\.App)\/(containerApps|jobs)\/([a-z0-9-]+)$/i.exec(service.serviceId);
  check(match && uuid.test(match[2]) && (match[3].toLowerCase() === 'jobs') === (service.workloadKind === 'cron'), 'The Container Apps binding has no exact workload identity.');
  const armToken = await access.getToken(AZURE_SCOPES.arm);
  check(armToken);
  ctx.redact.push(armToken);
  if (source === 'logs') {
    const managedId = service.managedEnvironmentId;
    const prefix = (match[1] + '/managedEnvironments/').toLowerCase();
    check(managedId && managedId.toLowerCase().startsWith(prefix) && /^[a-z0-9-]+$/i.test(managedId.slice(prefix.length)), 'The Container Apps environment identity is missing.');
    const workload = await readJson(`${ARM}${service.serviceId}?${version}`, armToken, undefined, ctx.signal);
    const properties = object(workload.properties);
    const actualEnvironment = properties.environmentId ?? properties.managedEnvironmentId;
    check(typeof workload.id === 'string' && workload.id.toLowerCase() === service.serviceId.toLowerCase() &&
      typeof actualEnvironment === 'string' && actualEnvironment.toLowerCase() === managedId.toLowerCase() &&
      typeof workload.location === 'string' && workload.location.toLowerCase() === service.region.toLowerCase(), 'Azure did not confirm the bound workload scope.');
    const env = await readJson(`${ARM}${managedId}?${version}`, armToken, undefined, ctx.signal);
    check(typeof env.id === 'string' && env.id.toLowerCase() === managedId.toLowerCase());
    const configuration = object(object(object(env.properties).appLogsConfiguration).logAnalyticsConfiguration);
    check(configuration.customerId === service.workspaceId, 'The Container Apps environment has a different log workspace.');
    const token = await access.getToken('https://api.loganalytics.io/.default');
    check(token);
    ctx.redact.push(token);
    await logs(ctx, match[4], managedId.slice(prefix.length), token);
    return;
  }
  const path = service.serviceId + '/executions';
  let count = 0;
  let earliest = Infinity;
  await pages(async continuation => {
    const url = new URL(continuation ?? `${ARM}${path}?${version}`);
    check(url.origin === ARM && url.pathname.toLowerCase() === path.toLowerCase() && !url.username && !url.password && !url.hash, 'Azure execution pagination left the bound job.');
    const data = await readJson(url.toString(), armToken, undefined, ctx.signal);
    check(Array.isArray(data.value));
    count += data.value.length;
    for (const item of data.value) {
      const execution = object(item);
      const id = execution.name;
      check(typeof id === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(id) &&
        (execution.id === undefined || typeof execution.id === 'string' && execution.id.toLowerCase() === (path + '/' + id).toLowerCase()));
      const properties = object(execution.properties);
      const start = timestamp(properties.startTime);
      earliest = Math.min(earliest, Date.parse(start));
      if (properties.status === 'Processing' || properties.status === 'Running') {
        ctx.execution(id, start, 'active');
        continue;
      }
      check(['Failed', 'Stopped', 'Succeeded', 'Degraded'].includes(String(properties.status)), 'Azure returned an unknown job execution state.');
      const end = timestamp(properties.endTime);
      ctx.execution(id, start, properties.status === 'Succeeded' ? 'succeeded' : 'failed', end,
        properties.status === 'Succeeded' ? undefined : `Container Apps reported ${properties.status}.`);
    }
    return data.nextLink;
  });
  check(count < 100 || earliest <= Date.parse(ctx.window.since), 'The requested window predates the 100 retained Azure job executions.');
}
