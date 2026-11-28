import fs from 'node:fs';
import path from 'node:path';
import type { AppliedEngineDeclaration, EngineConfiguration, EngineRetirementScope, EngineStateIdentity } from '../../../domain/ports/infrastructure-engine.port.js';
import { configurationDigest } from './workspace.js';

type Attributes = Record<string, unknown>;
function object(value: unknown): Attributes {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Attributes : {};
}

function declaration(config: EngineConfiguration, address: string): Attributes | undefined {
  const match = /^(data\.)?([a-z0-9_]+)\.([a-zA-Z0-9_-]+)$/.exec(address);
  if (!match) return;
  const [, data, type, key] = match;
  for (const file of Object.values(config.files)) {
    const value = object(object(object(file)[data ? 'data' : 'resource'])[type!])[key!];
    if (value && typeof value === 'object') return object(value);
  }
}

function eligible(proof: AppliedEngineDeclaration, scope: EngineRetirementScope) {
  if (proof.kind !== 'service') return false;
  const [type, key] = proof.address.split('.');
  if (scope.provider === 'aws' && !type?.startsWith('aws_')) return false;
  if (scope.provider === 'azure' && !type?.startsWith('azurerm_') && type !== 'time_sleep') return false;
  if (proof.actionId.startsWith('monitor:')) return /^(aws_cloudwatch_(dashboard|event_rule|metric_alarm|log_metric_filter)|aws_s3_bucket_metric|azurerm_(monitor_metric_alert|monitor_scheduled_query_rules_alert_v2|portal_dashboard))$/.test(type!);
  if (proof.actionId.startsWith('service:')) return /^(aws_(ecs_(task_definition|express_gateway_service|service)|scheduler_schedule|sfn_state_machine|cloudwatch_event_target)|azurerm_container_app(_job)?)$/.test(type!)
    || (type === 'aws_secretsmanager_secret' && key?.endsWith('_waker'));
  if (proof.actionId === 'tasks:cluster') return ['aws_ecs_cluster.main', 'aws_ecs_cluster_capacity_providers.main', 'aws_security_group.tasks',
    'aws_cloudwatch_log_group.tasks', 'aws_cloudwatch_event_rule.jobs_finished'].includes(proof.address);
  if (proof.actionId === 'identity:runtime' || proof.actionId === 'identity:runtime-observer' || proof.actionId.startsWith('identity:service:')) {
    return /^(aws_iam_role(_policy|_policies_exclusive|_policy_attachments_exclusive)?|azurerm_(user_assigned_identity|role_assignment|federated_identity_credential)|time_sleep)$/.test(type!);
  }
  return false;
}

/** Check literal native identifiers as well as references whose physical name is in the reviewed graph. */
function matchesNative(address: string, config: EngineConfiguration, block: Attributes, before: Attributes, state: EngineStateIdentity, scope: EngineRetirementScope, priorValues: Map<string, Attributes>) {
  const tags = { ...object(before.tags_all), ...object(before.tags) };
  if (tags['managed-by'] !== undefined && tags['managed-by'] !== 'hypervibe') return false;
  if (tags['hv-environment'] !== undefined && tags['hv-environment'] !== state.environmentId.toLowerCase()) return false;
  const type = address.split('.')[0]!;
  const ownTagsRequired = Object.hasOwn(object(block.tags), 'hv-environment') || (scope.provider === 'aws'
    && Boolean(config.files['provider.tf.json']) && [
      'aws_ecs_cluster', 'aws_ecs_service', 'aws_ecs_express_gateway_service', 'aws_ecs_task_definition', 'aws_security_group',
      'aws_cloudwatch_log_group', 'aws_cloudwatch_metric_alarm', 'aws_cloudwatch_event_rule', 'aws_iam_role', 'aws_sfn_state_machine', 'aws_secretsmanager_secret',
    ].includes(type));
  if (ownTagsRequired && (tags['managed-by'] !== 'hypervibe' || tags['hv-environment'] !== state.environmentId.toLowerCase())) return false;
  if (scope.provider === 'azure') {
    const armTypes: Record<string, string> = {
      azurerm_container_app: 'Microsoft.App/containerApps', azurerm_container_app_job: 'Microsoft.App/jobs',
      azurerm_user_assigned_identity: 'Microsoft.ManagedIdentity/userAssignedIdentities',
      azurerm_monitor_metric_alert: 'Microsoft.Insights/metricAlerts', azurerm_portal_dashboard: 'Microsoft.Portal/dashboards',
      azurerm_monitor_scheduled_query_rules_alert_v2: 'Microsoft.Insights/scheduledQueryRules',
    };
    const armType = armTypes[address.split('.')[0]!];
    if (armType) {
      const expected = `/subscriptions/${scope.subscriptionId}/resourceGroups/${scope.resourceGroup}/providers/${armType}/${block.name}`;
      if (typeof before.id !== 'string' || before.id.toLowerCase() !== expected.toLowerCase()) return false;
    }
    if (typeof before.resource_group_name === 'string' && before.resource_group_name.toLowerCase() !== scope.resourceGroup.toLowerCase()) return false;
    if (typeof before.id === 'string' && before.id.toLowerCase().startsWith('/subscriptions/') && before.id.split('/')[2]?.toLowerCase() !== scope.subscriptionId.toLowerCase()) return false;
  } else {
    if (type === 'aws_ecs_service' || type === 'aws_ecs_express_gateway_service') {
      const ecs = `arn:aws:ecs:${scope.region}:${scope.accountId}`;
      const name = block.service_name ?? block.name;
      const arn = before.service_arn ?? before.arn ?? before.id;
      if (![scope.prefix, ecs + ':cluster/' + scope.prefix].includes(String(before.cluster))
        || arn !== ecs + ':service/' + scope.prefix + '/' + name) return false;
    }
    if (type === 'aws_scheduler_schedule' && before.group_name !== (block.group_name ?? 'default')) return false;
    if (type === 'aws_cloudwatch_event_rule' || type === 'aws_cloudwatch_event_target') {
      if ((before.event_bus_name ?? 'default') !== (block.event_bus_name ?? 'default')) return false;
    }
    for (const field of ['arn', 'id', 'service_arn']) {
      if (typeof before[field] !== 'string' || !before[field].startsWith('arn:')) continue;
      const [, , , region, account] = before[field].split(':');
      if ((region && region !== scope.region) || (account && account !== scope.accountId)) return false;
    }
  }
  for (const field of ['name', 'service_name', 'family', 'role_name', 'role', 'bucket', 'cluster_name', 'scope', 'rule', 'vpc_id', 'log_group_name', 'role_definition_id', 'principal_id', 'user_assigned_identity_id', 'target_id', 'alarm_name', 'dashboard_name']) {
    const value = block[field];
    if (typeof value !== 'string') continue;
    let expected: unknown = value;
    if (value.includes('${')) {
      const reference = /^\$\{(aws_(?:iam_role|s3_bucket|ecs_cluster)\.[A-Za-z0-9_-]+)\.(?:id|name|bucket)\}$/.exec(value);
      if (reference) {
        const source = declaration(config, reference[1]!);
        expected = reference[1]!.startsWith('aws_s3_bucket.') ? source?.bucket : source?.name;
      } else {
        const nativeRef = /^\$\{((?:data\.)?[a-z0-9_]+\.[A-Za-z0-9_-]+)\.([a-z0-9_]+)\}$/.exec(value);
        if (!nativeRef || !declaration(config, nativeRef[1]!)) return false;
        const source = declaration(config, nativeRef[1]!);
        const literal = source?.[nativeRef[2]!];
        expected = typeof literal === 'string' && !literal.includes('${') ? literal : priorValues.get(nativeRef[1]!)?.[nativeRef[2]!];
      }
      if (typeof expected !== 'string' || expected.includes('${')) return false;
    }
    if (before[field] !== expected) return false;
  }
  return true;
}

export type AppliedDeclarations = (state: EngineStateIdentity, scope: EngineRetirementScope, addresses: string[]) => AppliedEngineDeclaration[];

/** A state entry alone cannot authorize removing a workload that disappeared from the spec. */
export function environmentRetirementMappings(input: {
  configuration: EngineConfiguration; state: EngineStateIdentity; scope: EngineRetirementScope;
  plans: string; shown: string; applied: AppliedDeclarations;
}): EngineConfiguration['resources'] {
  const { configuration, state, scope } = input;
  if (state.partition !== 'environment' || state.provider !== scope.provider) return {};
  const { resource_changes, prior_state } = JSON.parse(input.shown) as {
    prior_state?: { values?: { root_module?: { resources?: Array<{ mode: string; address: string; values: Attributes }> } } };
    resource_changes?: Array<{ type: string; mode: string; address: string; change: { actions: string[]; before: Attributes } }> };
  const removed = new Map((resource_changes ?? []).filter(row => row.mode === 'managed' && row.address.startsWith(row.type + '.')
    && row.change?.actions?.length === 1 && row.change.actions[0] === 'delete' && row.change.before && !configuration.resources[row.address])
    .map(row => [row.address, row.change.before]));
  const resources: EngineConfiguration['resources'] = {};
  if (!removed.size) return resources;
  const priorValues = new Map((prior_state?.values?.root_module?.resources ?? []).map(row => [row.address, row.values]));
  for (const row of resource_changes ?? []) {
    if (row.change?.before) priorValues.set(row.address, row.change.before);
  }
  const configs = new Map<string, EngineConfiguration>();
  for (const proof of input.applied(state, scope, [...removed.keys()])) {
    if (!eligible(proof, scope) || !/^[A-Za-z0-9_-]{1,128}$/.test(proof.planId)) continue;
    const before = removed.get(proof.address);
    if (!before) continue;
    const key = proof.planId + '/' + proof.configurationDigest;
    let config = configs.get(key);
    if (!config) {
      try {
        config = JSON.parse(fs.readFileSync(path.join(input.plans, proof.planId + '.config.json'), 'utf8')) as EngineConfiguration;
        if (configurationDigest(config) !== proof.configurationDigest) continue;
        configs.set(key, config);
      } catch { continue; }
    }
    const block = declaration(config, proof.address);
    const priorMapping = config.resources?.[proof.address];
    if (!priorMapping || priorMapping.actionId !== proof.actionId || priorMapping.name !== proof.name || priorMapping.kind !== proof.kind) continue;
    if (!block || !matchesNative(proof.address, config, block, before, state, scope, priorValues)) continue;
    resources[proof.address] = { actionId: proof.actionId, kind: proof.kind, name: proof.name, requiresConfirm: true,
      ...(/^(aws_cloudwatch_log_group|aws_secretsmanager_secret)\./.test(proof.address) ? { dataBearing: true } : {}) };
  }
  return resources;
}
