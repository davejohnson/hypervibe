import { expect, it, vi } from 'vitest';
import { projectAwsWorkloadBindings } from '../../adapters/providers/aws/aws-diagnostics.client.js';
import { projectAzureWorkloadBindings } from '../../adapters/providers/azure/azure-diagnostics.client.js';
import { recordEngineWorkloadBindings } from '../engine-workload-bindings.js';
const state = (entries: Record<string, Record<string, unknown>>) => ({ format_version: '1.0', values: { root_module: { resources: Object.entries(entries).map(([address, values]) => ({ address, values })) } } });
const accountId = '111122223333'; const region = 'eu-west-1'; const ecs = `arn:aws:ecs:${region}:${accountId}`;
it('projects exact retained AWS native identities and log destinations for web, worker, and job, excluding private state', () => {
  const native = state({
    'aws_ecs_express_gateway_service.web': { service_arn: `${ecs}:service/historical/historical-native-web`, ingress_paths: [{ access_type: 'PUBLIC', endpoint: 'historical-native-web.ecs.eu-west-1.on.aws' }],
      primary_container: [{ aws_logs_configuration: [{ log_group: '/exact/logs', log_stream_prefix: 'native-web' }], secret: [{ name: 'SECRET', value_from: 'private-state-secret' }] }] },
    'aws_ecs_cluster.main': { arn: `${ecs}:cluster/historical` },
    'aws_ecs_service.worker': { id: `${ecs}:service/historical/worker` },
    'aws_ecs_task_definition.worker': { arn: `${ecs}:task-definition/worker:5`, container_definitions: JSON.stringify([{ name: 'app', secrets: [{ valueFrom: 'private-state-secret' }], logConfiguration: { options: { 'awslogs-group': '/exact/logs', 'awslogs-stream-prefix': 'native-worker' } } }]) },
    'aws_ecs_task_definition.nightly': { arn: `${ecs}:task-definition/job:3`, container_definitions: '[]' },
  });
  const result = projectAwsWorkloadBindings(native, { web: {}, worker: { workloadKind: 'worker' }, nightly: { workloadKind: 'cron' } }, { accountId, region });
  expect(result.worker).toMatchObject({ serviceId: `${ecs}:service/historical/worker`, clusterArn: `${ecs}:cluster/historical`, taskDefinitionArn: `${ecs}:task-definition/worker:5`, logGroup: '/exact/logs', logStreamPrefix: 'native-worker/app/' });
  expect(result.nightly!.resourceType).toBe('ecs-task'); expect(result.web).toEqual({ serviceId: `${ecs}:service/historical/historical-native-web`, workloadKind: 'web', resourceType: 'ecs-express', region, clusterArn: `${ecs}:cluster/historical`,
    logGroup: '/exact/logs', logStreamPrefix: 'native-web/Main/', url: 'https://historical-native-web.ecs.eu-west-1.on.aws' });
  expect(JSON.stringify(result)).not.toContain('private-state-secret');
  expect(() => projectAwsWorkloadBindings(native, { web: {} }, { accountId, region: 'us-west-2' })).toThrow(/outside/);
});
it('projects Azure app, worker, and job ARM identities and workspace UUID without leaking state secrets', () => {
  const subscriptionId = '11111111-1111-4111-8111-111111111111'; const resourceGroup = 'hv-demo'; const group = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  const native = state({
    'azurerm_container_app_environment.main': { id: `${group}/providers/Microsoft.App/managedEnvironments/exact` },
    'azurerm_log_analytics_workspace.logs': { workspace_id: '22222222-2222-4222-8222-222222222222', primary_shared_key: 'private-state-secret' },
    'azurerm_container_app.web': { id: `${group}/providers/Microsoft.App/containerApps/historical-web`, ingress: [{ fqdn: 'web.example' }], secret: [{ value: 'private-state-secret' }] },
    'azurerm_container_app.worker': { id: `${group}/providers/Microsoft.App/containerApps/historical-worker` },
    'azurerm_container_app_job.nightly': { id: `${group}/providers/Microsoft.App/jobs/historical-job` },
  });
  const result = projectAzureWorkloadBindings(native, { web: {}, worker: { workloadKind: 'worker' }, nightly: { workloadKind: 'cron' } }, { subscriptionId, resourceGroup, location: 'northeurope' });
  expect(result.web).toMatchObject({ url: 'https://web.example', workspaceId: '22222222-2222-4222-8222-222222222222', region: 'northeurope' });
  expect(result.nightly!.resourceType).toBe('container-job'); expect(JSON.stringify(result)).not.toContain('private-state-secret');
  expect(() => projectAzureWorkloadBindings(native, { web: {} }, { subscriptionId, resourceGroup: 'hv-other', location: 'northeurope' })).toThrow(/outside/);
});
it('repairs bindings from existing state and preserves recovery identities on unavailable state', async () => {
  const environment = { id: 'env', platformBindings: { services: { retained: { serviceId: 'old' } }, engine: { existing: true } } };
  const update = vi.fn(); const ctx = { repos: { environments: { findById: () => environment, updatePlatformBindings: update } } } as never;
  const engine = { inspectState: vi.fn(async () => ({ ok: true, present: true, value: { web: { serviceId: 'native', resourceType: 'ecs-express', workloadKind: 'web', region: 'eu-west-1' } } })) };
  const params = { environment, backend: {}, auth: { env: {}, redact: [] }, state: {}, provider: 'aws', projectId: accountId, environmentId: region, project: () => ({}) } as never;
  expect(await recordEngineWorkloadBindings(ctx, engine as never, params)).toEqual({ ok: true });
  expect(update).toHaveBeenCalledWith('env', expect.objectContaining({ services: { retained: { serviceId: 'old' }, web: expect.objectContaining({ serviceId: 'native' }) }, engine: { existing: true, kind: 'opentofu' } }));
  update.mockClear(); engine.inspectState.mockResolvedValue({ ok: false, error: 'secret' } as never);
  expect(await recordEngineWorkloadBindings(ctx, engine as never, params)).toMatchObject({ ok: false }); expect(update).not.toHaveBeenCalled();
});
