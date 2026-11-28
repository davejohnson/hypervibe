import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { azureKey, azureSharedNames, type AzureEngineInput, type AzureSharedInput } from './azure-engine.config.js';

const alertCost = ['criteria', 'frequency', 'window_size', 'scopes'];
const serverAlert = 'azurerm_monitor_metric_alert.postgres_storage';
const serverMapping = { kind: 'service' as const, name: 'shared PostgreSQL storage alert', actionId: 'monitor:postgres-storage', billable: true, requiresConfirm: true, costAttributes: alertCost };

export function addAzureSharedDatabaseMonitoring(input: AzureSharedInput, files: EngineConfiguration['files'], resources: EngineConfiguration['resources']) {
  resources[serverAlert] = serverMapping;
  files['runtime-monitoring.tf.json'] = { resource: { azurerm_monitor_metric_alert: { postgres_storage: {
    name: input.prefix + '-postgres-storage', resource_group_name: input.resourceGroup, tags: { 'managed-by': 'hypervibe', 'hv-shared': input.label },
    scopes: ['${azurerm_postgresql_flexible_server.postgres.id}'], severity: 2, frequency: 'PT5M', window_size: 'PT15M',
    description: 'Shared PostgreSQL storage reached 85%. Check growth across all databases and provision capacity before the server fills.',
    criteria: [{ metric_namespace: 'Microsoft.DBforPostgreSQL/flexibleServers', metric_name: 'storage_percent', aggregation: 'Maximum', operator: 'GreaterThanOrEqual', threshold: 85 }],
  } } } };
}

/** Verify the target in the refreshed private plan. The saved plan is the only artifact authorized for apply. */
export function reviewAzureSharedMonitoring(config: EngineConfiguration, input: AzureSharedInput, onlyAlertRemoval = false) {
  config.resources[serverAlert] = serverMapping;
  const group = '/subscriptions/' + input.subscriptionId + '/resourceGroups/' + input.resourceGroup + '/providers/';
  const same = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
  const verifyPlannedChanges = (document: unknown): boolean => {
    const changes = (document as { resource_changes?: { address: string; mode: string; change?: { actions?: string[]; before?: Record<string, unknown> } }[] })?.resource_changes;
    if (changes === undefined) return true; // OpenTofu omits this field for an empty plan.
    return Array.isArray(changes) && changes.every(row => {
      const actions = row.change?.actions, previous = row.change?.before;
      if (row.mode === 'data' || actions?.length === 1 && actions[0] === 'no-op') return true;
      if (row.address !== serverAlert) return !onlyAlertRemoval;
      if (!actions?.includes('delete')) return !onlyAlertRemoval;
      const tags = previous?.tags as Record<string, unknown> | undefined;
      return actions.length === 1 && same(previous?.id, group + 'Microsoft.Insights/metricAlerts/' + input.prefix + '-postgres-storage')
        && tags?.['managed-by'] === 'hypervibe' && tags?.['hv-shared'] === input.label
        && Array.isArray(previous?.scopes) && previous.scopes.length === 1
        && same(previous.scopes[0], group + 'Microsoft.DBforPostgreSQL/flexibleServers/' + azureSharedNames(input).server);
    });
  };
  return { configuration: config, verifyPlannedChanges };
}

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
  if (input.storage?.length) {
    resources['azurerm_monitor_metric_alert.storage_availability'] = { kind: 'service', name: 'Blob storage account availability alert',
      actionId: 'monitor:storage-availability', billable: true, requiresConfirm: true, costAttributes: alertCost };
  }
  const dashboardProject = input.monitoring?.project ?? input.observation?.repository;
  const postgres = input.monitoring?.postgresServerId;
  if (!dashboardProject || !(workloads.length || input.storage?.length || postgres)) return;
  const tags = { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() };
  const alerts: Record<string, unknown> = {};
  const tiles: Array<{ id: string; metric: string }> = [];
  for (const w of workloads) {
    const id = '${' + w.type + '.' + azureKey(w.logicalName) + '.id}';
    const web = w.metric === 'Requests';
    const namespace = 'Microsoft.App/' + (w.type === 'azurerm_container_app_job' ? 'jobs' : 'containerApps');
    alerts['runtime_' + azureKey(w.logicalName)] = { name: w.resourceName + (web ? '-request-timeouts' : '-restarts'),
      resource_group_name: input.resourceGroup, tags, scopes: [id], severity: 2, frequency: 'PT5M', window_size: 'PT5M',
      description: web ? 'Requests timed out waiting for a response. Inspect the Container App logs during this interval.'
        : 'A replica or job execution has restarted. Check its events and previous container logs.',
      criteria: [{ metric_namespace: namespace, metric_name: web ? 'ResiliencyRequestTimeouts' : 'RestartCount',
        aggregation: web ? 'Total' : 'Maximum', operator: 'GreaterThan', threshold: 0 }] };
    tiles.push({ id, metric: w.metric });
  }
  const scopeNotes: string[] = [];
  if (input.storage?.length) {
    const id = '${azurerm_storage_account.files.id}';
    tiles.push({ id, metric: 'Availability' });
    scopeNotes.push('Storage account availability covers these Blob containers: ' + input.storage.map(bucket => bucket.container).sort().join(', ') + '.');
    alerts.storage_availability = { name: input.prefix + '-storage-availability', resource_group_name: input.resourceGroup, tags, scopes: [id],
      severity: 2, frequency: 'PT5M', window_size: 'PT15M',
      description: 'Average availability fell below 99% on the storage account. Inspect Azure Storage availability and transaction errors by API and response type.',
      criteria: [{ metric_namespace: 'Microsoft.Storage/storageAccounts', metric_name: 'Availability', aggregation: 'Average', operator: 'LessThan', threshold: 99 }] };
  }
  if (postgres) {
    tiles.push({ id: postgres, metric: 'storage_percent' });
    scopeNotes.push('PostgreSQL storage usage covers all databases on the shared testing server.');
  }
  const position = (index: number) => ({ x: (index % 2) * 6, y: Math.floor(index / 2) * 4, colSpan: 6, rowSpan: 4 });
  const parts: Record<string, unknown> = Object.fromEntries(tiles.map(({ id, metric }, index) => [String(index), { position: position(index),
    metadata: { type: 'Extension/Microsoft_Azure_Monitoring/PartType/MetricsChartPart', inputs: [{ name: 'queryInputs',
      value: { timespan: { duration: 'PT6H' }, id, chartType: 0, metrics: [{ name: metric, resourceId: id }] } }] } }]));
  if (scopeNotes.length) parts[String(tiles.length)] = { position: position(tiles.length), metadata: {
    type: 'Extension/HubsExtension/PartType/MarkdownPart', inputs: [], settings: { content: { settings: { title: 'Resource coverage', content: scopeNotes.join('\n\n') } } },
  } };
  const resource: Record<string, unknown> = {
    ...(Object.keys(alerts).length ? { azurerm_monitor_metric_alert: alerts } : {}),
    azurerm_portal_dashboard: { runtime: { name: input.prefix + '-runtime', resource_group_name: input.resourceGroup, location: input.location,
      tags: { ...tags, 'hidden-title': dashboardProject + ' / ' + input.environmentName + ' / Runtime' },
      dashboard_properties: JSON.stringify({ lenses: { '0': { order: 0, parts } }, metadata: {} }) } },
  };
  files['runtime-monitoring.tf.json'] = { resource };
  if (!input.observation || !workloads.length) return;
  // The workspace is shared. Both environment and exact workload are required.
  const names = (kind: string) => workloads.filter(w => w.type === kind).map(w => "'" + w.resourceName + "'").join(', ');
  const apps = names('azurerm_container_app');
  const jobs = names('azurerm_container_app_job');
  const workloadsFilter = [apps && `tostring(column_ifexists('ContainerAppName_s', '')) in (${apps})`, jobs && `tostring(column_ifexists('ContainerJobName_s', '')) in (${jobs})`].filter(Boolean).join(' or ');
  const environment = input.shared.appsEnvironmentId.split('/').at(-1)!;
  const query = ['ContainerAppConsoleLogs_CL', `where EnvironmentName_s == '${environment}'`, `where ${workloadsFilter}`,
    "extend payload=parse_json(Log_s)", "where tostring(payload.level) in~ ('error','fatal','critical','50','60') or tostring(payload.severity) in~ ('error','critical','alert','emergency') or Log_s has_any ('error', 'exception', 'fatal')",
    'project TimeGenerated'].join(' | ');
  resource.azurerm_monitor_scheduled_query_rules_alert_v2 = { runtime_errors: { name: input.prefix + '-application-errors',
      resource_group_name: input.resourceGroup, location: input.location, tags, enabled: true, severity: 2,
      description: 'Inspect the console logs for this environment around the alert time and check the corresponding workload or job execution.',
      scopes: [input.observation.workspaceResourceId], evaluation_frequency: 'PT5M', window_duration: 'PT5M',
      // A new workspace may have no console table until the first workload emits a line.
      skip_query_validation: true,
      criteria: [{ query, time_aggregation_method: 'Count', operator: 'GreaterThan', threshold: 0,
        failing_periods: [{ minimum_failing_periods_to_trigger_alert: 1, number_of_evaluation_periods: 1 }] }] } };
}
