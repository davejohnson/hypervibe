import { createHash } from 'node:crypto';
import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { RuntimeObserverBinding } from '../../../../domain/spec/runtime-observation.js';

/** Owner-reviewed setup for the known Cloud Run resources of one environment. */
export function buildGcpObservationDashboard(binding: Extract<RuntimeObserverBinding, { provider: 'gcp' }>, key: string): EngineConfiguration {
  const project = binding.gcp.projectId;
  const title = binding.repository + ' / ' + binding.environmentName;
  const depends_on = ['google_project_service.monitoring_googleapis_com'];
  const dashboard: Record<string, unknown> = {};
  const alerts: Record<string, unknown> = {};
  const widgets: unknown[] = [];
  const resources: EngineConfiguration['resources'] = {};
  for (const [name, service] of Object.entries(binding.services).sort(([a], [b]) => a.localeCompare(b))) {
    const job = service.workloadKind === 'cron';
    const worker = service.workloadKind === 'worker';
    const type = job ? 'cloud_run_job' : worker ? 'cloud_run_worker_pool' : 'cloud_run_revision';
    const label = job ? 'job_name' : worker ? 'worker_pool_name' : 'service_name';
    const nativeName = service.serviceId.split('/').at(-1)!;
    const scope = `resource.type = "${type}" AND resource.labels.project_id = "${project}" AND resource.labels.location = "${service.region}" AND resource.labels.${label} = "${nativeName}"`;
    const metric = (value: string) => `metric.type = "run.googleapis.com/${value}" AND ${scope}`;
    const base = metric(job ? 'job/completed_execution_count' : worker ? 'container/instance_count' : 'request_count');
    widgets.push({
      title: name + (job ? ' — completed executions by result' : worker ? ' — instances' : ' — requests by status class'),
      xyChart: { dataSets: [{ plotType: 'LINE', timeSeriesQuery: { timeSeriesFilter: { filter: base, aggregation: {
        alignmentPeriod: '300s', perSeriesAligner: worker ? 'ALIGN_MEAN' : 'ALIGN_SUM', crossSeriesReducer: 'REDUCE_SUM',
        ...(!worker ? { groupByFields: [job ? 'metric.label.result' : 'metric.label.response_code_class'] } : {}),
      } } } }] },
    });
    const signal = job ? 'failed execution' : worker ? 'failed health probe' : 'HTTP 5xx response';
    const filter = job ? base + ' AND metric.labels.result = monitoring.regex.full_match("(?i)(fail(ed|ure)?|cancel(l)?ed)")'
      : worker ? metric('container/completed_probe_count') + ' AND metric.labels.is_healthy = "false"'
      : base + ' AND metric.labels.response_code_class = "5xx"';
    const alertKey = key + '_' + createHash('sha256').update(name).digest('hex').slice(0, 16);
    const alertTitle = name + ' — ' + signal;
    alerts[alertKey] = { project, display_name: title + ' / ' + alertTitle, enabled: true, combiner: 'OR',
      conditions: [{ display_name: alertTitle, condition_threshold: [{ filter, comparison: 'COMPARISON_GT', threshold_value: 0, duration: '0s',
        aggregations: [{ alignment_period: '300s', per_series_aligner: 'ALIGN_SUM', cross_series_reducer: 'REDUCE_SUM' }] }] }],
      documentation: [{ mime_type: 'text/markdown', content: `Review the Cloud Run ${job ? 'executions' : 'logs'} for **${nativeName}** in **${service.region}** around the incident time.` }],
      depends_on };
    resources['google_monitoring_alert_policy.' + alertKey] = { kind: 'service', actionId: 'monitor:alert:' + alertKey, name: alertTitle + ' alert', billable: true, requiresConfirm: true, costAttributes: ['conditions'] };
  }
  dashboard[key] = { project, dashboard_json: JSON.stringify({ displayName: title + ' / Runtime', gridLayout: { columns: '2', widgets } }), depends_on };
  resources['google_monitoring_dashboard.' + key] = { kind: 'service', actionId: 'monitor:dashboard:' + key, name: title + ' Cloud Monitoring dashboard', requiresConfirm: true };
  return { files: { ['observer-dashboard-' + key.replaceAll('_', '-') + '.tf.json']: { resource: { google_monitoring_dashboard: dashboard, google_monitoring_alert_policy: alerts } } }, resources };
}
