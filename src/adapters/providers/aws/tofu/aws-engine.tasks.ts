import type { EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { awsKey, schedulerCron, type AwsEngineInput, type AwsTaskInput } from './aws-engine.config.js';

/** Escapes `${` so OpenTofu leaves Step Functions/JSONPath text alone, keeping `${aws_...}` references. */
const literal = (text: string) => text.replace(/\$\{(?!aws_)/g, () => '$${');

/**
 * Workers and scheduled jobs on Fargate in the default VPC's public subnets:
 * a public IP while a task runs instead of a NAT gateway. On-demand workers
 * sit at zero tasks; every minute a Step Functions Express check counts
 * pending work through the Data API with a read-only login and sets 0 or 1
 * tasks. A failed count keeps one task running (fails open, like GCP).
 */
export function addTasks(input: AwsEngineInput, files: Record<string, unknown>, resources: Record<string, EngineResourceMapping>): void {
  const workers = input.workers ?? [];
  const jobs = input.jobs ?? [];
  if (!workers.length && !jobs.length) return;
  const shared: EngineResourceMapping = { actionId: 'tasks:cluster', kind: 'service', name: 'tasks' };
  for (const address of ['aws_ecs_cluster.main', 'aws_security_group.tasks', 'aws_cloudwatch_log_group.tasks']) resources[address] = shared;
  const parameterArn = (key: string) => `arn:aws:ssm:${input.region}:${input.accountId}:parameter${input.parameterPath}${key}`;
  const taskDefinition = (task: AwsTaskInput) => ({
    // Releases register new revisions; tracking the latest keeps them from reading as drift.
    family: task.resourceName, track_latest: true, requires_compatibilities: ['FARGATE'], network_mode: 'awsvpc',
    cpu: String(task.cpu ?? 256), memory: String(task.memory ?? 512),
    execution_role_arn: '${aws_iam_role.runtime.arn}', task_role_arn: '${aws_iam_role.runtime.arn}',
    runtime_platform: [{ operating_system_family: 'LINUX', cpu_architecture: 'X86_64' }],
    container_definitions: JSON.stringify([{
      name: 'app', image: task.initialImageUri, essential: true, ...(task.command ? { command: task.command } : {}),
      environment: Object.entries({ ...task.env, HYPERVIBE_PARAMETER_PATH: input.parameterPath }).map(([name, value]) => ({ name, value })),
      // Fargate reads each secret from Parameter Store at start; values never enter engine state.
      secrets: (input.secretKeys ?? []).map((key) => ({ name: key, valueFrom: parameterArn(key) })),
      logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': `/hypervibe/${input.prefix}/tasks`, 'awslogs-region': input.region, 'awslogs-stream-prefix': task.resourceName } },
    }]),
  });
  const network = [{ subnets: '${data.aws_subnets.default.ids}', security_groups: ['${aws_security_group.tasks.id}'], assign_public_ip: true }];
  const definitions: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  const machines: Record<string, unknown> = {};
  const schedules: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};

  for (const worker of workers) {
    const key = awsKey(worker.logicalName);
    const mapping: EngineResourceMapping = { actionId: `service:${worker.logicalName}`, kind: 'service', name: worker.logicalName, billable: true };
    definitions[key] = taskDefinition(worker);
    services[key] = {
      name: worker.resourceName, cluster: '${aws_ecs_cluster.main.id}', task_definition: `\${aws_ecs_task_definition.${key}.arn}`, launch_type: 'FARGATE',
      desired_count: worker.pendingWorkQuery ? 0 : 1, network_configuration: network,
      // The waker owns the task count of on-demand workers.
      ...(worker.pendingWorkQuery ? { lifecycle: [{ ignore_changes: ['desired_count'] }] } : {}),
    };
    resources[`aws_ecs_task_definition.${key}`] = mapping;
    resources[`aws_ecs_service.${key}`] = mapping;
    if (!worker.pendingWorkQuery) continue;
    if (!input.database) throw new Error(`Worker ${worker.logicalName} counts pending work in the database, so it needs one.`);
    const wakerName = `${worker.resourceName}-waker`;
    machines[`${key}_waker`] = {
      name: wakerName, type: 'EXPRESS', role_arn: '${aws_iam_role.runtime.arn}',
      definition: literal(JSON.stringify(wakerDefinition({
        cluster: '${aws_ecs_cluster.main.arn}', service: worker.resourceName,
        databaseArn: '${aws_rds_cluster.postgres.arn}', databaseId: '${aws_rds_cluster.postgres.cluster_identifier}',
        secretArn: `\${aws_secretsmanager_secret.${key}_waker.arn}`, pendingWorkQuery: worker.pendingWorkQuery,
        ...(worker.nextWorkAtQuery ? { nextWorkAtQuery: worker.nextWorkAtQuery,
          timer: { name: `${wakerName}-next`, roleArn: '${aws_iam_role.runtime.arn}', machineArn: `arn:aws:states:${input.region}:${input.accountId}:stateMachine:${wakerName}` } } : {}),
      }))),
    };
    schedules[`${key}_waker`] = {
      name: wakerName, schedule_expression: 'rate(1 minute)', flexible_time_window: [{ mode: 'OFF' }],
      target: [{ arn: `\${aws_sfn_state_machine.${key}_waker.arn}`, role_arn: '${aws_iam_role.runtime.arn}', input: '{}' }],
    };
    if (worker.nextWorkAtQuery) {
      // The waker moves this one-time wake to the next due time; the engine only creates it.
      schedules[`${key}_waker_next`] = {
        name: `${wakerName}-next`, schedule_expression: 'at(2099-01-01T00:00:00)', state: 'DISABLED', flexible_time_window: [{ mode: 'OFF' }],
        action_after_completion: 'NONE',
        target: [{ arn: `\${aws_sfn_state_machine.${key}_waker.arn}`, role_arn: '${aws_iam_role.runtime.arn}', input: JSON.stringify({ force: true }) }],
        lifecycle: [{ ignore_changes: ['schedule_expression', 'state'] }],
      };
      resources[`aws_scheduler_schedule.${key}_waker_next`] = mapping;
    }
    // Hypervibe writes the read-only login after creating it; the value never enters engine state.
    secrets[`${key}_waker`] = { name: `hypervibe/${input.prefix}/${worker.resourceName}-waker`, recovery_window_in_days: 0 };
    for (const address of [`aws_sfn_state_machine.${key}_waker`, `aws_scheduler_schedule.${key}_waker`, `aws_secretsmanager_secret.${key}_waker`]) resources[address] = mapping;
  }

  for (const job of jobs) {
    const key = awsKey(job.logicalName);
    const mapping: EngineResourceMapping = { actionId: `service:${job.logicalName}`, kind: 'service', name: job.logicalName, billable: true };
    definitions[key] = taskDefinition(job);
    schedules[key] = {
      name: job.resourceName, schedule_expression: schedulerCron(job.schedule), schedule_expression_timezone: job.timeZone ?? 'UTC', flexible_time_window: [{ mode: 'OFF' }],
      target: [{ arn: '${aws_ecs_cluster.main.arn}', role_arn: '${aws_iam_role.runtime.arn}',
        ecs_parameters: [{ task_definition_arn: `\${aws_ecs_task_definition.${key}.arn_without_revision}`, launch_type: 'FARGATE', network_configuration: network }] }],
    };
    resources[`aws_ecs_task_definition.${key}`] = mapping;
    resources[`aws_scheduler_schedule.${key}`] = mapping;
  }

  files['tasks.tf.json'] = {
    resource: {
      aws_ecs_cluster: { main: { name: input.prefix } },
      aws_cloudwatch_log_group: { tasks: { name: `/hypervibe/${input.prefix}/tasks`, retention_in_days: 30 } },
      aws_security_group: { tasks: { name: `${input.prefix}-tasks`, description: 'Hypervibe: outbound only', vpc_id: '${data.aws_vpc.default.id}', ingress: [],
        egress: [{ description: 'Outbound', from_port: 0, to_port: 0, protocol: '-1', cidr_blocks: ['0.0.0.0/0'], ipv6_cidr_blocks: ['::/0'], prefix_list_ids: [], security_groups: [], self: false }] } },
      aws_ecs_task_definition: definitions,
      ...(Object.keys(services).length ? { aws_ecs_service: services } : {}),
      ...(Object.keys(machines).length ? { aws_sfn_state_machine: machines } : {}),
      ...(Object.keys(schedules).length ? { aws_scheduler_schedule: schedules } : {}),
      ...(Object.keys(secrets).length ? { aws_secretsmanager_secret: secrets } : {}),
    },
  };
}

interface WakerParams {
  cluster: string; service: string; databaseArn: string; databaseId: string; secretArn: string; pendingWorkQuery: string;
  nextWorkAtQuery?: string; timer?: { name: string; roleArn: string; machineArn: string };
}

/**
 * The on-demand worker waker (Step Functions, JSONata). Every minute it counts
 * pending work, but only while the database is awake: a paused database has
 * no new work, and querying it would wake it. With nothing pending it sets a
 * one-time wake at the next due time, which counts even while paused. Any
 * failure keeps one worker running (fails open).
 */
export function wakerDefinition(params: WakerParams): Record<string, unknown> {
  const desired = (count: number) => ({ Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:ecs:updateService', End: true,
    Arguments: { Cluster: params.cluster, Service: params.service, DesiredCount: count } });
  const statement = (sql: string) => ({ ResourceArn: params.databaseArn, SecretArn: params.secretArn, Database: 'app', Sql: sql });
  const keepOne = [{ ErrorEquals: ['States.ALL'], Next: 'KeepOne' }];
  const states: Record<string, unknown> = {
    Route: { Type: 'Choice', Choices: [{ Condition: '{% $states.input.force = true %}', Next: 'Count' }], Default: params.timer ? 'Awake' : 'Count' },
    Count: { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:rdsdata:executeStatement', Arguments: statement(params.pendingWorkQuery),
      Output: '{% {"count": $states.result.Records[0][0].LongValue} %}', Next: 'Decide', Catch: keepOne },
    Decide: { Type: 'Choice', Choices: [{ Condition: '{% $states.input.count > 0 %}', Next: 'One' }], Default: params.timer ? 'NextAt' : 'Zero' },
    One: desired(1), Zero: desired(0), KeepOne: desired(1),
  };
  if (params.timer && params.nextWorkAtQuery) {
    Object.assign(states, {
      // Capacity is reported as 0 while paused; missing data counts as awake, so work is never skipped.
      Awake: { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:cloudwatch:getMetricData', Next: 'Asleep',
        Arguments: {
          StartTime: '{% $fromMillis($toMillis($now()) - 180000) %}', EndTime: '{% $now() %}',
          MetricDataQueries: [{ Id: 'capacity', MetricStat: { Period: 60, Stat: 'Maximum', Metric: { Namespace: 'AWS/RDS', MetricName: 'ServerlessDatabaseCapacity',
            Dimensions: [{ Name: 'DBClusterIdentifier', Value: params.databaseId }] } } }],
        },
        Output: '{% ($v := $states.result.MetricDataResults[0].Values; {"asleep": $count($v) > 0 and $max($v) = 0}) %}',
        Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Count' }] },
      Asleep: { Type: 'Choice', Choices: [{ Condition: '{% $states.input.asleep = true %}', Next: 'Zero' }], Default: 'Count' },
      NextAt: { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:rdsdata:executeStatement', Next: 'HasNext', Catch: keepOne,
        Arguments: statement(`SELECT to_char(greatest(min(t)::timestamptz, now() + interval '1 minute') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') FROM (SELECT min(t) AS t FROM (${params.nextWorkAtQuery.trim().replace(/;$/, '')}) AS next_work(t)) AS due HAVING min(t) IS NOT NULL`),
        Output: '{% {"at": $states.result.Records[0][0].StringValue} %}' },
      HasNext: { Type: 'Choice', Choices: [{ Condition: '{% $exists($states.input.at) %}', Next: 'Timer' }], Default: 'Zero' },
      Timer: { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:scheduler:updateSchedule', Next: 'Zero', Catch: keepOne,
        Arguments: {
          Name: params.timer.name, ScheduleExpression: '{% "at(" & $states.input.at & ")" %}', ScheduleExpressionTimezone: 'UTC',
          FlexibleTimeWindow: { Mode: 'OFF' }, State: 'ENABLED', ActionAfterCompletion: 'NONE',
          Target: { Arn: params.timer.machineArn, RoleArn: params.timer.roleArn, Input: JSON.stringify({ force: true }) },
        } },
    });
  }
  return { QueryLanguage: 'JSONata', StartAt: 'Route', States: states };
}
