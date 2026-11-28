import { expect, it } from 'vitest';
import { buildAwsConfiguration, type AwsEngineInput } from '../../providers/aws/tofu/aws-engine.config.js';
import { buildAzureEnvironmentConfiguration } from '../../providers/azure/tofu/azure-engine.config.js';
import { fullEnvironmentInput } from '../../providers/azure/tofu/__tests__/azure-fixtures.js';
import { buildGcpObserverConfiguration, disableGcpObserverConfiguration, googleObserverBinding, observerKey, retainObserverRemovals } from '../../providers/gcp/tofu/gcp-observer.config.js';
import { parseEnginePlan, translateEnginePlan } from '../../engine/opentofu/plan-mapping.js';
import type { EngineConfiguration } from '../../../domain/ports/infrastructure-engine.port.js';

const observation = { repository: 'acme/shop', branch: 'main', environmentName: 'prod', ownerId: '12', repositoryId: '34' };
const awsInput: AwsEngineInput = { region: 'us-east-1', accountId: '123456789012', environmentId: 'PROD', prefix: 'hv-shop-prod', parameterPath: '/hypervibe/PROD/',
  services: [{ logicalName: 'web', resourceName: 'hv-shop-prod-web', initialImageUri: 'example/web', public: true }],
  jobs: [{ logicalName: 'nightly', resourceName: 'hv-shop-prod-nightly', initialImageUri: 'example/job', schedule: '0 0 * * *' }] };
const azureObservation = { ...observation, workspaceResourceId: '/subscriptions/' + fullEnvironmentInput.subscriptionId + '/resourceGroups/hv-billforge/providers/Microsoft.OperationalInsights/workspaces/shared' };
const key = observerKey('demo-project', observation.environmentName);
const google = googleObserverBinding({ key, project: 'demo-project', number: '123456789', environmentId: 'PROD', intent: observation, services: {
  nightly: { workloadKind: 'cron', region: 'europe-west1', serviceId: 'projects/demo-project/locations/europe-west1/jobs/prod-nightly' },
  web: { workloadKind: 'web', region: 'europe-west1', serviceId: 'projects/demo-project/locations/europe-west1/services/prod-web' },
  queue: { workloadKind: 'worker', region: 'europe-west1', serviceId: 'projects/demo-project/locations/europe-west1/workerPools/prod-queue' },
} });
const file = 'runtime-monitoring.tf.json';
const googleFile = 'observer-dashboard-' + key.replaceAll('_', '-') + '.tf.json';
function native(config: EngineConfiguration, name = file) {
  return (config.files[name] as { resource: Record<string, Record<string, any>> }).resource;
}

it('charts ECS services and bound job logs; failed-task rules match only terminal failures in the recorded families and cluster', () => {
  const r = native(buildAwsConfiguration({ ...awsInput, observation }));
  const dashboard = JSON.parse(r.aws_cloudwatch_dashboard.runtime.dashboard_body);
  expect(dashboard.widgets).toEqual(expect.arrayContaining([
    expect.objectContaining({ properties: expect.objectContaining({ metrics: expect.arrayContaining([
      ['AWS/ECS', 'MemoryUtilization', 'ClusterName', 'hv-shop-prod', 'ServiceName', 'hv-shop-prod-web'],
    ]) }) }),
    expect.objectContaining({ type: 'log', properties: expect.objectContaining({ query: expect.stringContaining("SOURCE '/hypervibe/hv-shop-prod/tasks'") }) }),
  ]));
  const event = JSON.parse(r.aws_cloudwatch_event_rule.runtime_failed_jobs.event_pattern);
  expect(event).toMatchObject({ source: ['aws.ecs'], 'detail-type': ['ECS Task State Change'], detail: { clusterArn: ['${aws_ecs_cluster.main.arn}'], lastStatus: ['STOPPED'],
    taskDefinitionArn: [{ prefix: 'arn:aws:ecs:us-east-1:123456789012:task-definition/hv-shop-prod-nightly:' }],
    $or: [{ stopCode: ['TaskFailedToStart'] }, { containers: { exitCode: [{ numeric: ['>', 0] }] } }] } });
  expect(r.aws_cloudwatch_metric_alarm.runtime_failed_jobs).toMatchObject({ namespace: 'AWS/Events', metric_name: 'MatchedEvents', dimensions: { RuleName: '${aws_cloudwatch_event_rule.runtime_failed_jobs.name}' }, treat_missing_data: 'notBreaching' });
  const noJobs = native(buildAwsConfiguration({ ...awsInput, jobs: [], observation }));
  expect(noJobs.aws_cloudwatch_event_rule).toBeUndefined();
  expect(noJobs.aws_cloudwatch_metric_alarm.runtime_failed_jobs).toBeUndefined();
});

it('uses the bound Azure resources in each tile and metric alert; the scheduled console alert excludes sibling environments sharing the workspace', () => {
  const r = native(buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, observation: azureObservation }));
  const dashboard = JSON.parse(r.azurerm_portal_dashboard.runtime.dashboard_properties);
  const tiles = Object.values(dashboard.lenses['0'].parts).map((part: any) => part.metadata.inputs[0].value.metrics[0]);
  expect(tiles).toEqual([{ name: 'Requests', resourceId: '${azurerm_container_app.web.id}' }, { name: 'Replicas', resourceId: '${azurerm_container_app.worker.id}' }, { name: 'Executions', resourceId: '${azurerm_container_app_job.nightly.id}' }]);
  const query = r.azurerm_monitor_scheduled_query_rules_alert_v2.runtime_errors;
  expect(query.scopes).toEqual([azureObservation.workspaceResourceId]);
  for (const scope of ['hv-billforge-shared-apps','hv-billforge-test-web','hv-billforge-test-worker','hv-billforge-test-nightly']) expect(query.criteria[0].query).toContain("'" + scope + "'");
  expect(r.azurerm_monitor_metric_alert.runtime_nightly).toMatchObject({ scopes: ['${azurerm_container_app_job.nightly.id}'], criteria: [{ metric_namespace: 'Microsoft.App/jobs', metric_name: 'RestartCount', threshold: 0 }] });
  expect(r.azurerm_monitor_metric_alert.runtime_web.criteria[0].metric_name).toEqual('ResiliencyRequestTimeouts');
});

it('charts the Cloud Run job result, request status and worker instances with an alert scoped to each exact native resource', () => {
  const r = native(buildGcpObserverConfiguration(google, key, observation.repositoryId), googleFile);
  const dashboard = JSON.parse(r.google_monitoring_dashboard[key].dashboard_json);
  const filters: string[] = dashboard.gridLayout.widgets.map((w: any) => w.xyChart.dataSets[0].timeSeriesQuery.timeSeriesFilter.filter);
  expect(filters).toHaveLength(3);
  for (const [metric, label, name] of [['job/completed_execution_count', 'job_name', 'prod-nightly'], ['container/instance_count', 'worker_pool_name', 'prod-queue'], ['request_count', 'service_name', 'prod-web']]) {
    expect(filters).toContainEqual(expect.stringContaining(`resource.labels.${label} = "${name}"`));
    expect(filters.find(filter => filter.includes(`/${metric}"`))).toContain('resource.labels.location = "europe-west1"');
  }
  const alarms = Object.values(r.google_monitoring_alert_policy).map(v => v.conditions[0].condition_threshold[0].filter);
  expect(alarms.filter(v => v.includes('prod-nightly') && v.includes('metric.labels.result'))).toHaveLength(1);
  expect(alarms.filter(v => v.includes('prod-queue') && v.includes('is_healthy'))).toHaveLength(1);
  expect(alarms.filter(v => v.includes('prod-web') && v.includes('5xx'))).toHaveLength(1);
});

it('leaves a never-enrolled AWS or Azure plan free of observer ownership mappings', () => {
  for (const config of [buildAwsConfiguration(awsInput), buildAzureEnvironmentConfiguration(fullEnvironmentInput)]) {
    expect(Object.values(config.resources).filter(mapping => mapping.actionId === 'identity:runtime-observer' || mapping.actionId.startsWith('monitor:'))).toEqual([]);
    expect(config.files['observer.tf.json']).toBeUndefined();
    expect(config.files[file]).toBeUndefined();
  }
});

it('keeps an unchanged app free of monitoring resources and routes opt-in costs and opt-out deletes through exact plan review', () => {
  const gcp = buildGcpObserverConfiguration(google, key, observation.repositoryId);
  const disabledGcp = disableGcpObserverConfiguration(gcp, key);
  retainObserverRemovals(disabledGcp, gcp);
  const cases: Array<[string, EngineConfiguration, EngineConfiguration, string]> = [
    ['aws', buildAwsConfiguration({ ...awsInput, observation }), buildAwsConfiguration({ ...awsInput, previousObserverServices: ['web', 'nightly'] }), file],
    ['azure', buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, observation: azureObservation }), buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, previousObserverServices: [...fullEnvironmentInput.services ?? [], ...fullEnvironmentInput.workers ?? [], ...fullEnvironmentInput.jobs ?? []].map(w => w.logicalName) }), file],
    ['gcp', gcp, disabledGcp, googleFile],
  ];
  for (const [provider, enabled, disabled, name] of cases) {
    expect(disabled.files[name]).toBeUndefined();
    if (enabled.files['observer.tf.json']) {
      expect(disabled.files['observer.tf.json']).toBeUndefined();
      for (const [address, mapping] of Object.entries(enabled.resources)) {
        if (mapping.actionId === 'identity:runtime-observer') expect(disabled.resources[address]).toEqual(mapping);
      }
    }
    const addresses = Object.entries(native(enabled, name)).flatMap(([type, entries]) => Object.keys(entries).map(key => type + '.' + key));
    for (const change of ['create', 'delete']) {
      const configuration = change === 'create' ? enabled : disabled;
      const parsed = parseEnginePlan(JSON.stringify({ resource_changes: addresses.map(address => ({ address, mode: 'managed', type: address.split('.')[0], change: { actions: [change] } })) }));
      const result = translateEnginePlan({ provider, configuration, parsed, segment: { id: 'app', engine: 'opentofu', configurationDigest: 'c'.repeat(64), planDigest: 'a'.repeat(64), engineVersion: '1.13.9', providerVersions: {} } });
      expect(result.blockers).toEqual([]);
      expect(result.actions).toHaveLength(addresses.length);
      for (const action of result.actions) {
        expect(action.requiresConfirm).toBe(true);
        if (change === 'create' && /alarm|alert|log_metric_filter/.test(action.id)) expect(action.billable).toBe(true);
      }
    }
  }
});
