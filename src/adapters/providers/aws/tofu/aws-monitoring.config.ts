import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { AwsEngineInput } from './aws-engine.config.js';

/** The environment already writes all service and scheduled-task console output to its own log group. */
export function addAwsMonitoring(input: AwsEngineInput, files: EngineConfiguration['files'], resources: EngineConfiguration['resources']): void {
  for (const [address, name] of [
    ['aws_cloudwatch_event_rule.runtime_failed_jobs', 'EventBridge failed task rule'],
    ['aws_cloudwatch_metric_alarm.runtime_failed_jobs', 'CloudWatch failed task alarm'],
    ['aws_cloudwatch_dashboard.runtime', 'CloudWatch runtime dashboard'],
    ['aws_cloudwatch_log_metric_filter.runtime_errors', 'CloudWatch application error metric'],
    ['aws_cloudwatch_metric_alarm.runtime_errors', 'CloudWatch application error alarm'],
  ]) resources[address] = { kind: 'service', name, actionId: 'monitor:' + address, billable: true, requiresConfirm: true,
    costAttributes: ['dashboard_body', 'metric_transformation', 'period', 'evaluation_periods'] };
  if (!input.observation || !input.services?.length && !input.workers?.length && !input.jobs?.length) return;
  const namespace = 'Hypervibe/' + input.prefix;
  const metric = 'ApplicationErrorLogs';
  const widgets: unknown[] = [{
    type: 'metric', x: 0, y: 0, width: 24, height: 5,
    properties: { title: 'Application log entries with an uppercase error level', region: input.region,
      metrics: [[namespace, metric]], stat: 'Sum', period: 300, view: 'timeSeries' },
  }];
  const addWidget = (properties: Record<string, unknown>, type = 'metric') => {
    const n = widgets.length - 1;
    widgets.push({ type, x: n % 2 * 12, y: 5 + Math.floor(n / 2) * 6, width: 12, height: 6, properties: { ...properties, region: input.region } });
  };
  const workloads = [...input.services ?? [], ...input.workers ?? []];
  for (const w of workloads) {
    addWidget({ title: w.logicalName + ' — CPU and memory utilization (%)', stat: 'Average', period: 300, view: 'timeSeries',
      metrics: ['CPUUtilization', 'MemoryUtilization'].map(name => ['AWS/ECS', name, 'ClusterName', input.prefix, 'ServiceName', w.resourceName]) });
  }
  for (const job of input.jobs ?? []) {
    addWidget({ title: job.logicalName + ' — recent job logs', view: 'table',
      query: `SOURCE '/hypervibe/${input.prefix}/tasks' | filter strcontains(@logStream, '${job.resourceName}/app/') > 0 | fields @timestamp, @message | sort @timestamp desc | limit 20` }, 'log');
  }
  const failedJobsRule = input.prefix + '-failed-jobs';
  const failedJobsMetric = { namespace: 'AWS/Events', metric_name: 'MatchedEvents', dimensions: { RuleName: '${aws_cloudwatch_event_rule.runtime_failed_jobs.name}' } };
  const hasJobs = Boolean(input.jobs?.length);
  if (hasJobs) addWidget({ title: 'Scheduled tasks that failed to start or exited nonzero', stat: 'Sum', period: 300, view: 'timeSeries',
    metrics: [['AWS/Events', 'MatchedEvents', 'RuleName', failedJobsRule]] });
  const alarmName = input.prefix + '-application-errors';
  files['runtime-monitoring.tf.json'] = { resource: {
    aws_cloudwatch_log_metric_filter: { runtime_errors: { name: alarmName, log_group_name: '${aws_cloudwatch_log_group.tasks.name}',
      pattern: '?ERROR ?FATAL ?CRITICAL ?EMERGENCY', metric_transformation: [{ name: metric, namespace, value: '1' }] } },
    ...(hasJobs ? { aws_cloudwatch_event_rule: { runtime_failed_jobs: { name: failedJobsRule, event_pattern: JSON.stringify({
      source: ['aws.ecs'], 'detail-type': ['ECS Task State Change'], detail: { lastStatus: ['STOPPED'], clusterArn: ['${aws_ecs_cluster.main.arn}'],
        taskDefinitionArn: input.jobs!.map(job => ({ prefix: `arn:aws:ecs:${input.region}:${input.accountId}:task-definition/${job.resourceName}:` })),
        $or: [{ stopCode: ['TaskFailedToStart'] }, { containers: { exitCode: [{ numeric: ['>', 0] }] } }] } }),
    } } } : {}),
    aws_cloudwatch_metric_alarm: { ...(hasJobs ? { runtime_failed_jobs: { ...failedJobsMetric, alarm_name: failedJobsRule,
      alarm_description: 'Inspect stopped ECS tasks in the bound cluster and task-definition family for the failed execution.',
      statistic: 'Sum', comparison_operator: 'GreaterThanThreshold', threshold: 0, period: 300, evaluation_periods: 1, treat_missing_data: 'notBreaching' } } : {}),
    runtime_errors: { alarm_name: alarmName, alarm_description: 'Check the runtime dashboard and matching application logs in this environment.',
      namespace, metric_name: metric, statistic: 'Sum', period: 300, evaluation_periods: 1, comparison_operator: 'GreaterThanThreshold', threshold: 0,
      treat_missing_data: 'notBreaching', depends_on: ['aws_cloudwatch_log_metric_filter.runtime_errors'] } },
    aws_cloudwatch_dashboard: { runtime: { dashboard_name: input.prefix + '-' + input.region + '-runtime', dashboard_body: JSON.stringify({ widgets }) } },
  } };
}
