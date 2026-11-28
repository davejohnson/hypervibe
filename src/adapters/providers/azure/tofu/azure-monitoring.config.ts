import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { azureKey, type AzureEngineInput } from './azure-engine.config.js';

export function addAzureMonitoring(input: AzureEngineInput, files: EngineConfiguration['files'], resources: EngineConfiguration['resources']): void {
  resources['azurerm_portal_dashboard.runtime'] = { kind: 'service', name: 'Azure Portal runtime dashboard', actionId: 'monitor:dashboard', requiresConfirm: true };
  resources['azurerm_monitor_scheduled_query_rules_alert_v2.runtime_errors'] = { kind: 'service', name: 'Azure Monitor application error alert',
    actionId: 'monitor:console-errors', billable: true, requiresConfirm: true, costAttributes: ['criteria', 'evaluation_frequency', 'window_duration', 'scopes'] };
  const workloads = [
    ...(input.services ?? []).map(w => ({ ...w, type: 'azurerm_container_app', metric: 'Requests' })),
    ...(input.workers ?? []).map(w => ({ ...w, type: 'azurerm_container_app', metric: 'Replicas' })),
    ...(input.jobs ?? []).map(w => ({ ...w, type: 'azurerm_container_app_job', metric: 'Executions' })),
  ];
  for (const name of new Set([...workloads.map(w => w.logicalName), ...(input.previousObserverServices ?? [])])) {
    const address = 'azurerm_monitor_metric_alert.runtime_' + azureKey(name);
    resources[address] = { kind: 'service', name: name + ' workload metric alert', actionId: 'monitor:metric:' + name, billable: true, requiresConfirm: true,
      costAttributes: ['criteria', 'frequency', 'window_size', 'scopes'] };
  }
  if (!input.observation || !workloads.length) return;
  const tags = { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() };
  const alerts: Record<string, unknown> = {};
  const parts = Object.fromEntries(workloads.map((w, index) => {
    const id = '${' + w.type + '.' + azureKey(w.logicalName) + '.id}';
    const web = w.metric === 'Requests';
    const namespace = 'Microsoft.App/' + (w.type === 'azurerm_container_app_job' ? 'jobs' : 'containerApps');
    alerts['runtime_' + azureKey(w.logicalName)] = { name: w.resourceName + (web ? '-request-timeouts' : '-restarts'),
      resource_group_name: input.resourceGroup, tags, scopes: [id], severity: 2, frequency: 'PT5M', window_size: 'PT5M',
      description: web ? 'Requests timed out waiting for a response. Inspect the Container App logs during this interval.'
        : 'A replica or job execution has restarted. Check its events and previous container logs.',
      criteria: [{ metric_namespace: namespace, metric_name: web ? 'ResiliencyRequestTimeouts' : 'RestartCount',
        aggregation: web ? 'Total' : 'Maximum', operator: 'GreaterThan', threshold: 0 }] };
    return [String(index), { position: { x: (index % 2) * 6, y: Math.floor(index / 2) * 4, colSpan: 6, rowSpan: 4 },
      metadata: { type: 'Extension/Microsoft_Azure_Monitoring/PartType/MetricsChartPart', inputs: [{ name: 'queryInputs',
        value: { timespan: { duration: 'PT6H' }, id, chartType: 0, metrics: [{ name: w.metric, resourceId: id }] } }] } }];
  }));
  // The workspace is shared. Both environment and exact workload are required.
  const names = (kind: string) => workloads.filter(w => w.type === kind).map(w => "'" + w.resourceName + "'").join(', ');
  const apps = names('azurerm_container_app');
  const jobs = names('azurerm_container_app_job');
  const workloadsFilter = [apps && `tostring(column_ifexists('ContainerAppName_s', '')) in (${apps})`, jobs && `tostring(column_ifexists('ContainerJobName_s', '')) in (${jobs})`].filter(Boolean).join(' or ');
  const environment = input.shared.appsEnvironmentId.split('/').at(-1)!;
  const query = ['ContainerAppConsoleLogs_CL', `where EnvironmentName_s == '${environment}'`, `where ${workloadsFilter}`,
    "extend payload=parse_json(Log_s)", "where tostring(payload.level) in~ ('error','fatal','critical','50','60') or tostring(payload.severity) in~ ('error','critical','alert','emergency') or Log_s has_any ('error', 'exception', 'fatal')",
    'project TimeGenerated'].join(' | ');
  files['runtime-monitoring.tf.json'] = { resource: {
    azurerm_monitor_metric_alert: alerts,
    azurerm_portal_dashboard: { runtime: { name: input.prefix + '-runtime', resource_group_name: input.resourceGroup, location: input.location,
      tags: { ...tags, 'hidden-title': input.observation.repository + ' / ' + input.environmentName + ' / Runtime' },
      dashboard_properties: JSON.stringify({ lenses: { '0': { order: 0, parts } }, metadata: {} }) } },
    azurerm_monitor_scheduled_query_rules_alert_v2: { runtime_errors: { name: input.prefix + '-application-errors',
      resource_group_name: input.resourceGroup, location: input.location, tags, enabled: true, severity: 2,
      description: 'Inspect the console logs for this environment around the alert time and check the corresponding workload or job execution.',
      scopes: [input.observation.workspaceResourceId], evaluation_frequency: 'PT5M', window_duration: 'PT5M',
      // A new workspace may have no console table until the first workload emits a line.
      skip_query_validation: true,
      criteria: [{ query, time_aggregation_method: 'Count', operator: 'GreaterThan', threshold: 0,
        failing_periods: [{ minimum_failing_periods_to_trigger_alert: 1, number_of_evaluation_periods: 1 }] }] } },
  } };
}
