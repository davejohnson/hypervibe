import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { environmentRetirementMappings } from '../../../../engine/opentofu/environment-retirement.js';
import { configurationDigest } from '../../../../engine/opentofu/workspace.js';
import { expect, it } from 'vitest';
import { azureEngineLayout, azureTestingEnvironments, buildAzureEngineInput, buildAzureSharedInput } from '../../../../../application/infrastructure-engine-azure.js';
import { projectSpecSchema } from '../../../../../domain/spec/spec.schema.js';
import { parseEnginePlan, translateEnginePlan } from '../../../../engine/opentofu/plan-mapping.js';
import { reviewAzureSharedMonitoring } from '../azure-monitoring.config.js';
import { fullSharedInput } from './azure-fixtures.js';
import { azureSharedNames, buildAzureEnvironmentConfiguration, buildAzureSharedConfiguration } from '../azure-engine.config.js';

const conn = { tenantId: '11111111-2222-3333-4444-555555555555', subscriptionId: '66666666-7777-8888-9999-000000000000', resourceGroup: 'hv-shop',
  location: 'westus2', deployPrincipalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  clientSecret: 'synthetic-unit-test', clientSecretExpiresAt: '2027-11-12T00:00:00Z' };
const project = { id: 'p1', name: 'shop' };
const context = { connection: conn, project, environment: { id: 'E1', platformBindings: {} }, ...azureEngineLayout(project, 'test', 'E1', conn) };
const bucket = { provider: 'azureblob', region: 'westus2', type: 'bucket', injectInto: [] };
const database = { provider: 'azure-postgres', version: 17 };
const env = (options: Record<string, unknown>) => ({ hosting: { provider: 'azure', engine: 'opentofu' }, services: {}, ...options });
const obs = { branch: 'main' };
const spec = (test: Record<string, unknown>, sibling = env({})) => projectSpecSchema.parse({ version: 1, project: 'shop',
  gitRemoteUrl: 'https://github.com/example/shop', environments: { test, 'pr-12': sibling } });
const config = (source: ReturnType<typeof spec>) => buildAzureEnvironmentConfiguration(buildAzureEngineInput(source, 'test', context, { secretKeys: [] }));
const shared = (source: ReturnType<typeof spec>) => buildAzureSharedConfiguration(buildAzureSharedInput(source, context, azureTestingEnvironments(source)));
const native = (configuration: ReturnType<typeof config>) => (configuration.files['runtime-monitoring.tf.json'] as {resource: Record<string, Record<string, any>>} | undefined)?.resource;

it('monitors database and Blob Storage with zero workloads or GitHub identity and no hosted collector grant', () => {
  const source = spec(env({ database, storage: { uploads: bucket, exports: bucket }, runtimeObservation: obs }));
  delete source.gitRemoteUrl;
  const configured = config(projectSpecSchema.parse(source));
  const r = native(configured)!;
  expect(configured.files['observer.tf.json']).toBeUndefined();
  expect(r.azurerm_monitor_scheduled_query_rules_alert_v2).toBeUndefined();
  const dashboard = JSON.parse(r.azurerm_portal_dashboard.runtime.dashboard_properties);
  expect(JSON.stringify(dashboard)).toContain(context.shared.serverId);
  expect(JSON.stringify(dashboard)).toContain('${azurerm_storage_account.files.id}');
  expect(JSON.stringify(dashboard)).toContain('exports');
  expect(JSON.stringify(dashboard)).toContain('uploads');
  expect(r.azurerm_monitor_metric_alert.storage_availability).toMatchObject({ scopes: ['${azurerm_storage_account.files.id}'],
    criteria: [{ metric_namespace: 'Microsoft.Storage/storageAccounts', metric_name: 'Availability', aggregation: 'Average', operator: 'LessThan' }] });
  const group = shared(source);
  const alarm = native(group)?.azurerm_monitor_metric_alert.postgres_storage;
  expect(alarm).toMatchObject({ scopes: ['${azurerm_postgresql_flexible_server.postgres.id}'],
    criteria: [{ metric_namespace: 'Microsoft.DBforPostgreSQL/flexibleServers', metric_name: 'storage_percent', aggregation: 'Maximum', operator: 'GreaterThanOrEqual' }] });
  expect(configured.resources['azurerm_storage_container.uploads'].dataBearing).toBe(true);
  expect(group.resources['azurerm_postgresql_flexible_server.postgres'].dataBearing).toBe(true);
});

it('updates the monitored bucket membership on rename and retains one shared server alarm while any enrolled database remains', () => {
  const sibling = env({ database, runtimeObservation: obs });
  const original = spec(env({ database, storage: { uploads: bucket }, runtimeObservation: obs }), sibling);
  const renamed = spec(env({ storage: { documents: bucket }, runtimeObservation: obs }), sibling);
  const removed = spec(env({ storage: { documents: bucket } }), env({ database }));
  const tile = native(config(renamed))?.azurerm_portal_dashboard.runtime.dashboard_properties;
  expect(tile).toContain('documents'); expect(tile).not.toContain('uploads'); expect(tile).not.toContain(context.shared.serverId);
  expect(native(shared(original))?.azurerm_monitor_metric_alert).toEqual(native(shared(renamed))?.azurerm_monitor_metric_alert);
  expect(native(config(removed))).toBeUndefined();
  expect(native(shared(removed))).toBeUndefined();
  expect(shared(removed).resources['azurerm_postgresql_flexible_server.postgres'].dataBearing).toBe(true);
});


it('refuses shared-alarm removal if its refreshed identity, ownership or PostgreSQL scope differ, or a sibling teardown would change other resources', () => {
  const input = fullSharedInput;
  const { verifyPlannedChanges: verify } = reviewAzureSharedMonitoring(buildAzureSharedConfiguration(input), input, true);
  const prefix = '/subscriptions/' + input.subscriptionId + '/resourceGroups/' + input.resourceGroup + '/providers/';
  const before = { id: prefix + 'Microsoft.Insights/metricAlerts/' + input.prefix + '-postgres-storage', tags: { 'managed-by': 'hypervibe', 'hv-shared': input.label },
    scopes: [prefix + 'Microsoft.DBforPostgreSQL/flexibleServers/' + azureSharedNames(input).server] };
  const change = (values: typeof before, address = 'azurerm_monitor_metric_alert.postgres_storage') => ({ mode: 'managed', address, change: { actions: ['delete'], before: values } });
  expect(verify({ resource_changes: [change(before)] })).toBe(true);
  for (const foreign of [{ ...before, id: before.id + '-other' }, { ...before, scopes: [] }, { ...before, tags: { ...before.tags, 'hv-shared': 'other' } }]) {
    expect(verify({ resource_changes: [change(foreign)] })).toBe(false);
  }
  expect(verify({ resource_changes: [change(before), change(before, 'azurerm_postgresql_flexible_server.postgres')] })).toBe(false);
});

it('rebuilds Azure workload monitoring and log scopes from the current spec when a job is renamed and a worker is added', () => {
  const source = (job: string, worker: boolean) => spec(env({ services: {
    api: { public: true }, [job]: { workloadKind: 'cron', startCommand: 'node tasks.js', cronSchedule: '0 3 * * *' }, ...(worker ? { processor: { workloadKind: 'worker', startCommand: 'node worker.js' } } : {}),
  }, runtimeObservation: obs }));
  const graph = (source: ReturnType<typeof spec>) => native(buildAzureEnvironmentConfiguration(buildAzureEngineInput(source, 'test',
    { ...context, observerRepository: { repositoryId: '123', ownerId: '456' } }, { secretKeys: [], image: 'example.azurecr.io/app:abc' })))!;
  const initial = graph(source('nightly', false)), renamed = graph(source('reconcile', true));
  expect(Object.keys(initial.azurerm_monitor_metric_alert)).toEqual(['runtime_api', 'runtime_nightly']);
  expect(Object.keys(renamed.azurerm_monitor_metric_alert)).toEqual(['runtime_api', 'runtime_processor', 'runtime_reconcile']);
  expect(renamed.azurerm_monitor_scheduled_query_rules_alert_v2.runtime_errors.criteria[0].query).toContain('-reconcile');
  expect(JSON.stringify(renamed)).not.toContain('nightly');
});


it('keeps an omitted Blob container or entire storage account outside ordinary deletion authority', () => {
  for (const [source, addresses] of [
    [spec(env({ storage: { retained: bucket }, runtimeObservation: obs })), ['azurerm_storage_container.uploads']],
    [spec(env({ database, runtimeObservation: obs })), ['azurerm_storage_account.files', 'azurerm_storage_container.uploads']],
  ] as const) {
    const parsed = parseEnginePlan(JSON.stringify({ resource_changes: addresses.map(address =>
      ({ address, mode: 'managed', type: address.split('.')[0], change: { actions: ['delete'] } })) }));
    const review = translateEnginePlan({ provider: 'azure', configuration: config(source), parsed,
      segment: { id: 'test', engine: 'opentofu', planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: {} } });
    for (const address of addresses) expect(review.blockers.join(' ')).toContain(address);
    expect(review.actions.filter(action => action.type === 'destroy')).toEqual([]);
  }
});

it('recovers only the applied storage dashboard and alert at the verified Azure resource IDs on opt-out', () => {
  const previous = config(spec(env({ storage: { uploads: bucket }, runtimeObservation: obs })));
  const current = config(spec(env({ storage: { uploads: bucket } })));
  const scope = { provider: 'azure' as const, prefix: context.prefix, resourceGroup: conn.resourceGroup, subscriptionId: conn.subscriptionId };
  const root = '/subscriptions/' + conn.subscriptionId + '/resourceGroups/' + conn.resourceGroup + '/providers/';
  const targets = [['azurerm_portal_dashboard', 'runtime', 'Microsoft.Portal/dashboards/'],
    ['azurerm_monitor_metric_alert', 'storage_availability', 'Microsoft.Insights/metricAlerts/']];
  const changes = targets.map(([type, key, providerType]) => {
    const { name, tags } = native(previous)![type!][key!];
    return { address: type + '.' + key, type, mode: 'managed', change: { actions: ['delete'], before: { name, id: root + providerType + name, tags } } };
  });
  const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-azure-resource-removal-'));
  try {
    fs.writeFileSync(path.join(plans, 'prior.config.json'), JSON.stringify(previous));
    const recover = () => environmentRetirementMappings({ state: context.state, scope, plans, configuration: current,
      shown: JSON.stringify({ resource_changes: changes }), applied: () => changes.map(({ address }) => ({ address, planId: 'prior',
        configurationDigest: configurationDigest(previous), ...previous.resources[address]! })) });
    expect(Object.keys(recover()).sort()).toEqual(changes.map(row => row.address).sort());
    changes[0]!.change.before.id += '-foreign';
    expect(Object.keys(recover())).toEqual([changes[1]!.address]);
  } finally { fs.rmSync(plans, { recursive: true, force: true }); }
});
