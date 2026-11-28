import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { awsKey, type AwsEngineInput } from './aws-engine.config.js';

export function addAwsMonitoring(input: AwsEngineInput, files: EngineConfiguration['files'], resources: EngineConfiguration['resources']): void {
  const map = (address: string, name: string) => {
    resources[address] = { kind: 'service', name, actionId: 'monitor:' + address, billable: true, requiresConfirm: true,
      costAttributes: ['dashboard_body', 'metric_transformation', 'period', 'evaluation_periods'] };
  };
  for (const [address, name] of [
    ['aws_cloudwatch_event_rule.runtime_failed_jobs', 'EventBridge failed task rule'],
    ['aws_cloudwatch_metric_alarm.runtime_failed_jobs', 'CloudWatch failed task alarm'],
    ['aws_cloudwatch_dashboard.runtime', 'CloudWatch runtime dashboard'],
    ['aws_cloudwatch_log_metric_filter.runtime_errors', 'CloudWatch application error metric'],
    ['aws_cloudwatch_metric_alarm.runtime_errors', 'CloudWatch application error alarm'],
    ['aws_cloudwatch_metric_alarm.runtime_database_capacity', 'CloudWatch shared Aurora writer capacity alarm'],
  ]) map(address, name);

  const services = [...input.services ?? [], ...input.workers ?? []];
  const jobs = input.jobs ?? [];
  const buckets = input.storage ?? [];
  const hasWorkloads = Boolean(services.length || jobs.length);
  if (!(input.nativeMonitoring || input.observation) || !(hasWorkloads || buckets.length || input.database)) return;

  const widgets: unknown[] = [];
  const addWidget = (properties: Record<string, unknown>, type = 'metric') => {
    const n = widgets.length - (hasWorkloads ? 1 : 0);
    widgets.push({ type, x: n % 2 * 12, y: (hasWorkloads ? 5 : 0) + Math.floor(n / 2) * 6, width: 12, height: 6, properties: { ...properties, region: input.region } });
  };
  const alarms: Record<string, unknown> = {};
  const resource: Record<string, Record<string, unknown>> = { aws_cloudwatch_metric_alarm: alarms };
  const alarm = { comparison_operator: 'GreaterThanThreshold', period: 300, evaluation_periods: 1, treat_missing_data: 'notBreaching' };

  if (hasWorkloads) {
    const namespace = 'Hypervibe/' + input.prefix;
    const metric = 'ApplicationErrorLogs';
    const alarmName = input.prefix + '-application-errors';
    widgets.push({ type: 'metric', x: 0, y: 0, width: 24, height: 5, properties: {
      title: 'Application log entries with an uppercase error level', region: input.region,
      metrics: [[namespace, metric]], stat: 'Sum', period: 300, view: 'timeSeries',
    } });
    resource.aws_cloudwatch_log_metric_filter = { runtime_errors: { name: alarmName, log_group_name: '${aws_cloudwatch_log_group.tasks.name}',
      pattern: '?ERROR ?FATAL ?CRITICAL ?EMERGENCY', metric_transformation: [{ name: metric, namespace, value: '1' }] } };
    alarms.runtime_errors = { ...alarm, alarm_name: alarmName, alarm_description: 'Check the runtime dashboard and matching application logs in this environment.',
      namespace, metric_name: metric, statistic: 'Sum', threshold: 0, depends_on: ['aws_cloudwatch_log_metric_filter.runtime_errors'] };
    for (const service of services) {
      addWidget({ title: service.logicalName + ' — CPU and memory utilization (%)', stat: 'Average', period: 300, view: 'timeSeries',
        metrics: ['CPUUtilization', 'MemoryUtilization'].map(name => ['AWS/ECS', name, 'ClusterName', input.prefix, 'ServiceName', service.resourceName]) });
    }
  }
  for (const job of jobs) {
    addWidget({ title: job.logicalName + ' — recent job logs', view: 'table',
      query: `SOURCE '/hypervibe/${input.prefix}/tasks' | filter strcontains(@logStream, '${job.resourceName}/app/') > 0 | fields @timestamp, @message | sort @timestamp desc | limit 20` }, 'log');
  }
  if (jobs.length) {
    const failedJobsRule = input.prefix + '-failed-jobs';
    addWidget({ title: 'Scheduled tasks that failed to start or exited nonzero', stat: 'Sum', period: 300, view: 'timeSeries',
      metrics: [['AWS/Events', 'MatchedEvents', 'RuleName', failedJobsRule]] });
    resource.aws_cloudwatch_event_rule = { runtime_failed_jobs: { name: failedJobsRule, event_pattern: JSON.stringify({
      source: ['aws.ecs'], 'detail-type': ['ECS Task State Change'], detail: { lastStatus: ['STOPPED'], clusterArn: ['${aws_ecs_cluster.main.arn}'],
        taskDefinitionArn: jobs.map(job => ({ prefix: `arn:aws:ecs:${input.region}:${input.accountId}:task-definition/${job.resourceName}:` })),
        $or: [{ stopCode: ['TaskFailedToStart'] }, { containers: { exitCode: [{ numeric: ['>', 0] }] } }] } }),
    } };
    alarms.runtime_failed_jobs = { ...alarm, namespace: 'AWS/Events', metric_name: 'MatchedEvents', dimensions: { RuleName: '${aws_cloudwatch_event_rule.runtime_failed_jobs.name}' },
      alarm_name: failedJobsRule, alarm_description: 'Inspect stopped ECS tasks in the bound cluster and task-definition family for the failed execution.', statistic: 'Sum', threshold: 0 };
  }

  for (const bucket of buckets) {
    const key = awsKey(bucket.name);
    const label = 'runtime_' + key;
    const filter = 'HypervibeRuntime';
    const bucketId = '${aws_s3_bucket.' + key + '.id}';
    (resource.aws_s3_bucket_metric ??= {})[label] = { name: filter, bucket: bucketId };
    map('aws_s3_bucket_metric.' + label, bucket.name + ' S3 request metrics');
    const alert = 'runtime_bucket_' + key;
    alarms[alert] = { ...alarm, alarm_name: input.prefix + '-' + bucket.name + '-s3-errors', alarm_description: 'S3 returned a server error for a request to ' + bucket.bucket + '.',
      namespace: 'AWS/S3', metric_name: '5xxErrors', dimensions: { BucketName: bucketId, FilterId: '${aws_s3_bucket_metric.' + label + '.name}' }, statistic: 'Sum', threshold: 0 };
    map('aws_cloudwatch_metric_alarm.' + alert, bucket.name + ' S3 server error alarm');
    addWidget({ title: bucket.name + ' — S3 requests and server errors', stat: 'Sum', period: 300, view: 'timeSeries',
      metrics: ['AllRequests', '5xxErrors'].map(name => ['AWS/S3', name, 'BucketName', bucket.bucket, 'FilterId', filter]) });
    addWidget({ title: bucket.name + ' — daily S3 object count, including versions and delete markers', stat: 'Average', period: 86400, view: 'timeSeries',
      metrics: [['AWS/S3', 'NumberOfObjects', 'BucketName', bucket.bucket, 'StorageType', 'AllStorageTypes']] });
  }

  if (input.database) {
    // Hypervibe provisions one Aurora Serverless v2 writer for a shared testing cluster.
    // AWS publishes capacity for the instance, shared by all logical databases on it.
    const clusterScope = `arn:aws:rds:${input.region}:${input.accountId}:cluster:`;
    const identifier = input.database.clusterArn.slice(clusterScope.length);
    if (!input.database.clusterArn.startsWith(clusterScope) || !/^[a-z][a-z0-9-]*$/.test(identifier)) throw new Error('Invalid managed Aurora cluster identity for runtime monitoring.');
    const writer = identifier + '-1';
    addWidget({ title: 'Shared Aurora writer — capacity and CPU utilization (%)', stat: 'Average', period: 300, view: 'timeSeries',
      metrics: ['ACUUtilization', 'CPUUtilization'].map(name => ['AWS/RDS', name, 'DBInstanceIdentifier', writer]) });
    alarms.runtime_database_capacity = { ...alarm, alarm_name: input.prefix + '-shared-db-capacity', alarm_description: 'The shared Aurora writer has sustained high capacity use across its databases.',
      namespace: 'AWS/RDS', metric_name: 'ACUUtilization', dimensions: { DBInstanceIdentifier: writer }, statistic: 'Average', threshold: 90, evaluation_periods: 3 };
  }

  resource.aws_cloudwatch_dashboard = { runtime: { dashboard_name: input.prefix + '-' + input.region + '-runtime', dashboard_body: JSON.stringify({ widgets }) } };
  files['runtime-monitoring.tf.json'] = { resource };
}
