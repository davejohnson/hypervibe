import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, DescribeTasksCommand, ListTasksCommand, ECSClient, type Task } from '@aws-sdk/client-ecs';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ProviderRuntimeLogsRequest, ProviderRuntimeLogsResult } from '../../../domain/ports/provider-logs.port.js';
import { stateResources, stateString, workloadBinding, type EngineWorkloadBinding, type WorkloadDeploymentObservation } from '../../../domain/ports/workload-diagnostics.port.js';
import { redactEngineOutput } from '../../engine/opentofu/runner.js';
import type { AwsEngineCredentials } from './aws-engine.adapter.js';
import { awsEngineAuthentication } from './tofu/aws-engine.backend.js';
import { awsKey } from './tofu/aws-engine.config.js';
import { taskDefinitionIdentity, matchesTaskDefinitionFamily } from './aws-task-identity.js';

/** Parses an ECS service ARN into its cluster ARN. */
const clusterOfService = (serviceArn: string): string | undefined => {
  const match = /^(arn:aws:ecs:[^:]+:\d{12}):service\/([^/]+)\/[^/]+$/.exec(serviceArn);
  return match ? `${match[1]}:cluster/${match[2]}` : undefined;
};

export function projectAwsWorkloadBindings(state: unknown, services: Record<string, { workloadKind?: string }>, scope: { accountId: string; region: string }): Record<string, EngineWorkloadBinding> {
  const resources = stateResources(state); const result: Record<string, EngineWorkloadBinding> = {};
  for (const [name, spec] of Object.entries(services)) {
    const key = awsKey(name); const kind = spec.workloadKind ?? 'web';
    // A public web service is an Express Mode service; a private one is an ordinary ECS service, like a worker.
    const express = kind === 'web' ? resources.get(`aws_ecs_express_gateway_service.${key}`) : undefined;
    const resource = express ?? resources.get(`${kind === 'cron' ? 'aws_ecs_task_definition' : 'aws_ecs_service'}.${key}`);
    const serviceId = stateString(express?.service_arn) ?? stateString(resource?.arn) ?? stateString(resource?.id);
    if (!serviceId) continue;
    if (!serviceId.startsWith(`arn:aws:ecs:${scope.region}:${scope.accountId}:`)) throw new Error('Engine workload identity is outside the reviewed account or region.');
    const binding: EngineWorkloadBinding = { serviceId, workloadKind: kind, resourceType: express ? 'ecs-express' : kind === 'cron' ? 'ecs-task' : 'ecs-service', region: scope.region };
    if (express) {
      const container = (Array.isArray(express.primary_container) ? express.primary_container[0] : undefined) as { aws_logs_configuration?: Array<{ log_group?: string; log_stream_prefix?: string }> } | undefined;
      const logs = container?.aws_logs_configuration?.[0];
      binding.clusterArn = clusterOfService(serviceId);
      binding.logGroup = logs?.log_group;
      // Express Mode names its container Main.
      binding.logStreamPrefix = logs?.log_stream_prefix ? `${logs.log_stream_prefix}/Main/` : undefined;
      const endpoint = (Array.isArray(express.ingress_paths) ? express.ingress_paths as Array<{ access_type?: string; endpoint?: string }> : []).find((path) => path.endpoint && path.access_type !== 'PRIVATE')?.endpoint;
      binding.url = endpoint ? (/^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`) : undefined;
    } else {
      binding.clusterArn = stateString(resources.get('aws_ecs_cluster.main')?.arn);
      const task = resources.get(`aws_ecs_task_definition.${key}`);
      binding.taskDefinitionArn = stateString(task?.arn);
      const containers = JSON.parse(String(task?.container_definitions ?? '[]')) as Array<{ name?: string; logConfiguration?: { options?: Record<string, string> } }>;
      const logs = containers.find((c) => c.name === 'app')?.logConfiguration?.options;
      binding.logGroup = logs?.['awslogs-group'];
      binding.logStreamPrefix = logs?.['awslogs-stream-prefix'] ? `${logs['awslogs-stream-prefix']}/app/` : undefined;
    }
    result[name] = binding;
  }
  return result;
}

export class AwsWorkloadDiagnostics {
  constructor(private readonly connection: AwsEngineCredentials) {}
  private binding(environment: Environment, name: string): EngineWorkloadBinding {
    const b = workloadBinding(environment, name);
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(b.region) || !b.serviceId.startsWith(`arn:aws:ecs:${b.region}:${this.connection.accountId}:`)
      || !['ecs-express', 'ecs-service', 'ecs-task'].includes(b.resourceType)) throw new Error('The workload binding does not match the connected AWS account and recorded environment region.');
    for (const arn of [b.clusterArn, b.taskDefinitionArn]) if (arn && !arn.startsWith(`arn:aws:ecs:${b.region}:${this.connection.accountId}:`)) throw new Error('ECS binding scope is inconsistent.');
    return b;
  }
  private async access(region: string) {
    const auth = await awsEngineAuthentication({ ...this.connection, region }).catch(() => { throw new Error('AWS deploy-role authentication failed; no workload observation was made.'); });
    return { options: { region, maxAttempts: 1, credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! } }, redact: [...auth.redact, auth.env.AWS_ACCESS_KEY_ID!, this.connection.accessKeyId] };
  }
  async readProviderLogs(request: ProviderRuntimeLogsRequest): Promise<ProviderRuntimeLogsResult> {
    const b = this.binding(request.environment, request.serviceName); const access = await this.access(b.region);
    try {
      if (!b.logGroup || !b.logStreamPrefix) throw new Error('The exact workload log destination is missing from engine state.');
      const client = new CloudWatchLogsClient(access.options); const logs: ProviderRuntimeLogsResult['logs'] = []; const seen = new Set<string>(); let nextToken: string | undefined;
      const limit = Math.max(1, Math.min(500, request.limit));
      // A fixed 24-hour window and page budget bound even empty CloudWatch pages.
      const endTime = Date.now(); const startTime = endTime - 24 * 60 * 60_000;
      for (let page = 0; page < 20; page++) {
        const result = await client.send(new FilterLogEventsCommand({ logGroupName: b.logGroup, ...(b.logStreamPrefix ? { logStreamNamePrefix: b.logStreamPrefix } : {}), startTime, endTime, limit: 500, ...(nextToken ? { nextToken } : {}) }));
        if (!Array.isArray(result.events)) throw new Error('CloudWatch did not return a readable log event list.');
        for (const event of result.events) {
          if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp) || typeof event.message !== 'string') throw new Error('CloudWatch returned a malformed log event.');
          const message = redactEngineOutput(event.message, access.redact);
          logs.push({ timestamp: new Date(event.timestamp).toISOString(), severity: '', message: message.slice(0, 4096), ...(message.length > 4096 ? { truncated: true as const } : {}) });
        }
        // FilterLogEvents sorts oldest first; never silently present the first page as a tail.
        logs.splice(0, Math.max(0, logs.length - limit));
        if (!result.nextToken) return { logs, window: { since: new Date(startTime).toISOString(), until: new Date(endTime).toISOString() } };
        if (seen.has(result.nextToken)) throw new Error('CloudWatch repeated a pagination token; the log read is incomplete.');
        seen.add(result.nextToken); nextToken = result.nextToken;
      }
      throw new Error('CloudWatch log read exceeded 20 pages within the last 24 hours; the result is incomplete.');
    } catch (error) { throw new Error(redactEngineOutput(error instanceof Error ? error.message : String(error), access.redact)); }
  }
  async readDeployment(environment: Environment, serviceName: string): Promise<WorkloadDeploymentObservation> {
    const b = this.binding(environment, serviceName); const access = await this.access(b.region);
    try {
      const ecs = new ECSClient(access.options);
      if (b.resourceType === 'ecs-express') {
        // Express Mode owns the task definition, so the service's own rollout is the evidence.
        if (!b.clusterArn) throw new Error('The exact ECS cluster is missing.');
        const r = await ecs.send(new DescribeServicesCommand({ cluster: b.clusterArn, services: [b.serviceId] }));
        if (r.failures?.some((f) => f.arn === b.serviceId && f.reason === 'MISSING') && !r.services?.length) return { presence: 'absent', status: 'failed', reason: 'AWS reports that the bound web service is missing.' };
        if (r.failures?.length || r.services?.length !== 1 || r.services[0]?.serviceArn !== b.serviceId || r.services[0].clusterArn !== b.clusterArn) throw new Error('AWS did not confirm the exact web service identity.');
        const service = r.services[0]; const primary = service.deployments?.filter((d) => d.status === 'PRIMARY');
        if (primary?.length !== 1) return { presence: 'present', status: 'unknown', reason: 'No unique primary deployment was observed.' };
        const settled = service.status === 'ACTIVE' && service.pendingCount === 0 && typeof service.desiredCount === 'number' && service.desiredCount > 0 && service.runningCount === service.desiredCount;
        return { presence: 'present', status: primary[0]!.rolloutState === 'FAILED' ? 'failed' : settled && service.deployments?.length === 1 && primary[0]!.rolloutState !== 'IN_PROGRESS' ? 'ready' : 'unknown' };
      }
      if (!b.clusterArn || !b.taskDefinitionArn) throw new Error('The exact ECS cluster or task definition is missing.');
      const recorded = taskDefinitionIdentity(b.taskDefinitionArn);
      if (!recorded) throw new Error('The recorded task definition is not an exact native ARN.');
      if (b.resourceType === 'ecs-task') {
        if (!matchesTaskDefinitionFamily(b.serviceId, b.taskDefinitionArn)) throw new Error('The scheduled task identity has inconsistent native families.');
        // CI creates new revisions without editing the local state binding. ECS resolves
        // the latest ACTIVE revision from the family extracted from that exact ARN.
        const r = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: recorded.family }));
        const currentArn = r.taskDefinition?.taskDefinitionArn; const current = taskDefinitionIdentity(currentArn);
        if (!current || current.familyArn !== recorded.familyArn || current.revision < recorded.revision || r.taskDefinition?.status !== 'ACTIVE' || r.taskDefinition.family !== recorded.family) throw new Error('AWS did not confirm the current active revision of the bound task family.');
        const family = recorded.family;
        const arns = new Set<string>();
        for (const desiredStatus of ['RUNNING', 'STOPPED'] as const) {
          let nextToken: string | undefined; const seen = new Set<string>();
          for (let page = 0; page < 10; page++) {
            const listed = await ecs.send(new ListTasksCommand({ cluster: b.clusterArn, family, desiredStatus, maxResults: 100, ...(nextToken ? { nextToken } : {}) }));
            if (!Array.isArray(listed.taskArns)) throw new Error('AWS did not return a readable scheduled task list.');
            for (const arn of listed.taskArns) {
              if (!arn.startsWith(`arn:aws:ecs:${b.region}:${this.connection.accountId}:task/`)) throw new Error('AWS returned a task outside the recorded account and region.');
              arns.add(arn);
            }
            if (arns.size > 1000) throw new Error('AWS scheduled task observation exceeded its bounded read.');
            nextToken = listed.nextToken;
            if (!nextToken) break;
            if (seen.has(nextToken) || page === 9) throw new Error('AWS scheduled task pagination is incomplete.');
            seen.add(nextToken);
          }
        }
        const tasks: Task[] = []; const ids = [...arns];
        for (let offset = 0; offset < ids.length; offset += 100) {
          const chunk = ids.slice(offset, offset + 100);
          const described = await ecs.send(new DescribeTasksCommand({ cluster: b.clusterArn, tasks: chunk }));
          if (described.failures?.length || described.tasks?.length !== chunk.length || new Set(described.tasks.map((task) => task.taskArn)).size !== chunk.length || described.tasks.some((task) => !task.taskArn || !chunk.includes(task.taskArn) || task.clusterArn !== b.clusterArn)) throw new Error('AWS did not confirm every exact scheduled task identity.');
          tasks.push(...described.tasks.filter((task) => task.taskDefinitionArn === currentArn));
        }
        if (tasks.some((task) => !task.createdAt || !Number.isFinite(task.createdAt.getTime()))) throw new Error('AWS task history has no reliable ordering.');
        tasks.sort((a, b) => b.createdAt!.getTime() - a.createdAt!.getTime());
        const latest = tasks[0];
        if (!latest) return { presence: 'present', status: 'unknown', reason: 'No retained execution for the current task definition was observed. ECS keeps stopped task history for a limited time.' };
        if (tasks[1]?.createdAt?.getTime() === latest.createdAt!.getTime()) return { presence: 'present', status: 'unknown', reason: 'Current task executions have an ambiguous latest timestamp.' };
        const containers = latest.containers ?? [];
        const failed = latest.stopCode === 'TaskFailedToStart' || containers.some((c) => typeof c.exitCode === 'number' && c.exitCode !== 0);
        return { presence: 'present', status: failed ? 'failed' : latest.lastStatus === 'STOPPED' && containers.length > 0 && containers.every((c) => c.exitCode === 0) ? 'succeeded' : 'unknown', reason: 'Observes the latest retained execution of the exact task definition; it does not prove schedule delivery or older execution history.' };
      }
      const r = await ecs.send(new DescribeServicesCommand({ cluster: b.clusterArn, services: [b.serviceId] }));
      if (r.failures?.some((f) => f.arn === b.serviceId && f.reason === 'MISSING') && !r.services?.length) return { presence: 'absent', status: 'failed', reason: 'AWS reports that the bound ECS service is missing.' };
      if (r.failures?.length || r.services?.length !== 1 || r.services[0]?.serviceArn !== b.serviceId || r.services[0].clusterArn !== b.clusterArn) throw new Error('AWS did not confirm the exact ECS service identity.');
      const service = r.services[0]; const primary = service.deployments?.filter((d) => d.status === 'PRIMARY');
      if (primary?.length !== 1) return { presence: 'present', status: 'unknown', reason: 'No unique primary ECS deployment was observed.' };
      const latest = primary[0]!;
      const current = taskDefinitionIdentity(service.taskDefinition);
      if (!current || current.familyArn !== recorded.familyArn || current.revision < recorded.revision || latest.taskDefinition !== service.taskDefinition) return { presence: 'present', status: 'unknown', reason: 'The current service and primary revision do not confirm the bound task family release.' };
      return { presence: 'present', status: latest.rolloutState === 'FAILED' ? 'failed' : latest.rolloutState === 'COMPLETED' && service.status === 'ACTIVE' && service.pendingCount === 0 && typeof service.desiredCount === 'number' && service.runningCount === service.desiredCount ? 'ready' : 'unknown' };
    } catch (error) {
      throw new Error(redactEngineOutput(error instanceof Error ? error.message : String(error), access.redact));
    }
  }
}
