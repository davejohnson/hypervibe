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
    family: task.resourceName, requires_compatibilities: ['FARGATE'], network_mode: 'awsvpc',
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
      // The waker owns the task count of on-demand workers; the release path owns the task definition.
      lifecycle: [{ ignore_changes: worker.pendingWorkQuery ? ['desired_count', 'task_definition'] : ['task_definition'] }],
    };
    resources[`aws_ecs_task_definition.${key}`] = mapping;
    resources[`aws_ecs_service.${key}`] = mapping;
    if (!worker.pendingWorkQuery) continue;
    if (!input.database) throw new Error(`Worker ${worker.logicalName} counts pending work in the database, so it needs one.`);
    const desired = (count: number) => ({ Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:ecs:updateService', End: true,
      Parameters: { Cluster: '${aws_ecs_cluster.main.arn}', Service: worker.resourceName, DesiredCount: count } });
    machines[`${key}_waker`] = {
      name: `${worker.resourceName}-waker`, type: 'EXPRESS', role_arn: '${aws_iam_role.runtime.arn}',
      definition: literal(JSON.stringify({ StartAt: 'Count', States: {
        Count: { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:rdsdata:executeStatement', Next: 'Decide',
          Parameters: { ResourceArn: '${aws_rds_cluster.postgres.arn}', SecretArn: `\${aws_secretsmanager_secret.${key}_waker.arn}`, Database: 'app', Sql: worker.pendingWorkQuery },
          ResultSelector: { 'count.$': '$.Records[0][0].LongValue' }, Catch: [{ ErrorEquals: ['States.ALL'], Next: 'KeepOne' }] },
        Decide: { Type: 'Choice', Choices: [{ Variable: '$.count', NumericGreaterThan: 0, Next: 'One' }], Default: 'Zero' },
        One: desired(1), Zero: desired(0), KeepOne: desired(1),
      } })),
    };
    schedules[`${key}_waker`] = {
      name: `${worker.resourceName}-waker`, schedule_expression: 'rate(1 minute)', flexible_time_window: [{ mode: 'OFF' }],
      target: [{ arn: `\${aws_sfn_state_machine.${key}_waker.arn}`, role_arn: '${aws_iam_role.runtime.arn}' }],
    };
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
