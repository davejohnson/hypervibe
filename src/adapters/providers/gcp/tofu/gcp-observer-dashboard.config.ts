import { createHash } from 'node:crypto';
import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { RuntimeObserverBinding } from '../../../../domain/spec/runtime-observation.js';

export interface GcpMetricTarget {
  kind: 'database' | 'cache' | 'queue' | 'storage';
  name: string;
  native: string;
  region: string;
  /** Bound tenant name on a shared Cloud SQL instance. */
  tenantDatabase?: string;
}

type DashboardScope = Pick<Extract<RuntimeObserverBinding, { provider: 'gcp' }>, 'repository' | 'environmentName' | 'services'> & { gcp: { projectId: string } };

/** Project-owner-reviewed charts and alert policies for one environment’s applied resource identities. */
export function buildGcpObservationDashboard(binding: DashboardScope, key: string, targets: GcpMetricTarget[] = []): EngineConfiguration {
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
  // Metric filters follow Google's metric descriptors and monitored-resource labels. Only applied native IDs enter them.
  const types = {
    database: { type: 'cloudsql_database', label: 'database_id', metric: 'cloudsql.googleapis.com/database/cpu/utilization', problem: 'high CPU utilization', threshold: 0.85 },
    cache: { type: 'redis_instance', label: 'instance_id', metric: 'redis.googleapis.com/stats/memory/usage_ratio', problem: 'high memory usage', threshold: 0.80 },
    queue: { type: 'pubsub_subscription', label: 'subscription_id', metric: 'pubsub.googleapis.com/subscription/oldest_unacked_message_age_by_region', problem: 'oldest unacknowledged message age', threshold: 600 },
    storage: { type: 'gcs_bucket', label: 'bucket_name', metric: 'storage.googleapis.com/api/request_count', problem: 'server errors', threshold: 0 },
  };
  for (const target of targets) {
    const shared = target.kind === 'database' && target.tenantDatabase;
    const { type, label } = types[target.kind];
    const { metric, problem, threshold } = shared
      ? { metric: 'cloudsql.googleapis.com/database/postgresql/deadlock_count', problem: 'detected deadlocks', threshold: 0 }
      : types[target.kind];
    const id = target.kind === 'database' ? project + ':' + target.native : target.native;
    const base = [`metric.type = "${metric}"`, `resource.type = "${type}"`, 'resource.labels.project_id = ' + JSON.stringify(project),
      'resource.labels.' + label + ' = ' + JSON.stringify(id),
      ...(shared ? ['metric.labels.database = ' + JSON.stringify(target.tenantDatabase)] : []),
      ...(['cache', 'database'].includes(target.kind) ? ['resource.labels.region = ' + JSON.stringify(target.region)] : [])].join(' AND ');
    const count = target.kind === 'storage' || Boolean(shared);
    const filter = target.kind === 'storage' ? base + ' AND metric.labels.response_code = monitoring.regex.full_match("(?i)(INTERNAL|UNAVAILABLE|DEADLINE_EXCEEDED)")' : base;
    const aligner = count ? 'ALIGN_SUM' : target.kind === 'queue' ? 'ALIGN_MAX' : 'ALIGN_MEAN';
    const reducer = count ? 'REDUCE_SUM' : 'REDUCE_MAX';
    const labelText = target.kind + ' ' + target.name + ' — ' + problem;
    widgets.push({ title: labelText, xyChart: { dataSets: [{ plotType: 'LINE', timeSeriesQuery: { timeSeriesFilter: {
      filter, aggregation: { alignmentPeriod: '300s', perSeriesAligner: aligner, crossSeriesReducer: reducer },
    } } }] } });
    // Keep the logical address stable across native replacement; the monitored resource filter changes in place.
    const alertKey = key + '_' + createHash('sha256').update(JSON.stringify([target.kind, target.name])).digest('hex').slice(0, 16);
    alerts[alertKey] = { project, display_name: title + ' / ' + labelText, enabled: true, combiner: 'OR', conditions: [{
      display_name: labelText, condition_threshold: [{ filter, comparison: 'COMPARISON_GT', threshold_value: threshold,
        duration: count ? '0s' : '300s', aggregations: [{ alignment_period: '300s', per_series_aligner: aligner, cross_series_reducer: reducer }] }],
    }], depends_on };
    resources['google_monitoring_alert_policy.' + alertKey] = { kind: target.kind, actionId: 'monitor:alert:' + alertKey, name: labelText + ' alert', billable: true, requiresConfirm: true, costAttributes: ['conditions'] };
  }
  if (!widgets.length) return { files: {}, resources: {} };
  dashboard[key] = { project, dashboard_json: JSON.stringify({ displayName: title + ' / Runtime', gridLayout: { columns: '2', widgets } }), depends_on };
  resources['google_monitoring_dashboard.' + key] = { kind: 'service', actionId: 'monitor:dashboard:' + key, name: title + ' Cloud Monitoring dashboard', requiresConfirm: true };
  return { files: { ['observer-dashboard-' + key.replaceAll('_', '-') + '.tf.json']: { resource: { google_monitoring_dashboard: dashboard, google_monitoring_alert_policy: alerts } } }, resources };
}
