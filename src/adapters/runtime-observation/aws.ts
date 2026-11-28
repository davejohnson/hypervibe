import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTasksCommand, ECSClient, ListTasksCommand, type DescribeTasksCommandOutput } from '@aws-sdk/client-ecs';
import { matchesTaskDefinitionFamily, taskDefinitionIdentity } from '../providers/aws/aws-task-identity.js';
import { check, inWindow, logHints, pages } from './read.js';
import type { ReadContext, RuntimeAccess, RuntimeSource } from './types.js';

// CloudWatch filter regex supports character classes and hex escapes, but no groups or /i.
const filterPattern = '%' + [...logHints.map(hint => [...hint].map(c => '[' + c + c.toUpperCase() + ']').join('')), '\\x7B'].join('|') + '%';

export async function readAws(source: RuntimeSource, ctx: ReadContext, access: Extract<RuntimeAccess, {provider: 'aws'}>): Promise<void> {
  const b = ctx.service;
  const scope = /^(arn:aws:ecs:([a-z0-9-]+):\d{12}):/.exec(b.serviceId);
  check(scope && scope[2] === b.region && /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(b.region), 'The ECS workload has no scoped region and account.');
  check(access.credentials.accessKeyId && access.credentials.secretAccessKey && access.credentials.sessionToken);
  const options = { region: b.region, credentials: access.credentials, maxAttempts: 2, requestHandler: { connectionTimeout: 5000, requestTimeout: 30_000 } };
  if (source === 'logs') {
    const { logGroup, logStreamPrefix } = b;
    const family = taskDefinitionIdentity(b.serviceId)?.family ?? b.serviceId.split('/').at(-1);
    const cluster = b.clusterArn?.split('/').at(-1);
    check(family && cluster && b.clusterArn === scope[1] + ':cluster/' + cluster && logGroup === '/hypervibe/' + cluster + '/tasks' &&
      (logStreamPrefix === family + '/app/' || logStreamPrefix === family + '/Main/'), 'The exact ECS workload log group or stream prefix is missing.');
    const client = new CloudWatchLogsClient(options);
    try {
      await pages(async nextToken => {
        const r = await client.send(new FilterLogEventsCommand({
          filterPattern, logGroupName: logGroup, logStreamNamePrefix: logStreamPrefix, startTime: Date.parse(ctx.window.since),
          endTime: Date.parse(ctx.window.until) - 1, limit: 500, ...(nextToken ? { nextToken } : {}),
        }), { abortSignal: ctx.signal });
        check(Array.isArray(r.events));
        for (const e of r.events) {
          check(e.logStreamName?.startsWith(logStreamPrefix) && Number.isSafeInteger(e.timestamp) && typeof e.message === 'string');
          ctx.log(new Date(e.timestamp!).toISOString(), e.message, undefined, e.eventId);
        }
        return r.nextToken;
      });
    } finally { client.destroy(); }
    return;
  }
  const task = taskDefinitionIdentity(b.taskDefinitionArn);
  const clusterArn = b.clusterArn;
  check(task && matchesTaskDefinitionFamily(b.serviceId, b.taskDefinitionArn!) && clusterArn && clusterArn.startsWith(scope[1] + ':cluster/'),
    'The scheduled ECS task has no exact cluster and task family.');
  const taskPrefix = scope[1] + ':task/' + clusterArn.split('/').at(-1) + '/';
  const client = new ECSClient(options);
  try {
    const arns = new Set<string>();
    for (const desiredStatus of ['RUNNING', 'STOPPED'] as const) {
      await pages(async nextToken => {
        const r = await client.send(new ListTasksCommand({ cluster: clusterArn, family: task.family, desiredStatus, maxResults: 100, ...(nextToken ? { nextToken } : {}) }), { abortSignal: ctx.signal });
        check(Array.isArray(r.taskArns));
        for (const arn of r.taskArns) {
          check(arn.startsWith(taskPrefix) && /^[a-f0-9-]+$/i.test(arn.slice(taskPrefix.length)));
          arns.add(arn);
        }
        return r.nextToken;
      });
    }
    const listed = [...arns];
    for (let i = 0; i < listed.length; i += 100) {
      const requested = new Set(listed.slice(i, i + 100));
      const r: DescribeTasksCommandOutput = await client.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: [...requested] }), { abortSignal: ctx.signal });
      check(!r.failures?.length && Array.isArray(r.tasks), 'ECS could not describe every listed task.');
      for (const execution of r.tasks) {
        const id = execution.taskArn;
        check(id && requested.delete(id) && execution.clusterArn === clusterArn && matchesTaskDefinitionFamily(execution.taskDefinitionArn, b.taskDefinitionArn!));
        const start = execution.startedAt ?? execution.createdAt;
        check(start && Number.isFinite(start.getTime()));
        if (execution.lastStatus !== 'STOPPED') {
          check(['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING', 'DEACTIVATING', 'STOPPING', 'DEPROVISIONING'].includes(execution.lastStatus ?? ''));
          ctx.execution(id.slice(taskPrefix.length), start.toISOString(), 'active');
          continue;
        }
        const end = execution.stoppedAt?.toISOString();
        check(end);
        if (!inWindow(end, ctx.window) && !inWindow(start.toISOString(), ctx.window)) continue;
        const app = execution.containers?.find(c => c.name === 'app');
        const failed = execution.stopCode === 'TaskFailedToStart' || (typeof app?.exitCode === 'number' && app.exitCode !== 0);
        check(failed || app?.exitCode === 0 && execution.stopCode === 'EssentialContainerExited', 'ECS returned a stopped task with no verifiable application exit outcome.');
        ctx.execution(id.slice(taskPrefix.length), start.toISOString(), failed ? 'failed' : 'succeeded', end, failed ? execution.stoppedReason : undefined);
      }
      check(requested.size === 0, 'ECS omitted a listed task from its response.');
    }
    check(Date.parse(ctx.window.since) >= Date.now() - 3600_000, 'The requested window extends beyond guaranteed ECS stopped-task retention (one hour).');
  } finally { client.destroy(); }
}
