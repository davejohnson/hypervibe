import { createHash } from 'node:crypto';
import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { assertEngineCiIntent, type EngineCiIntent } from '../../../../domain/spec/engine-ci.js';
import type { RuntimeObserverBinding } from '../../../../domain/spec/runtime-observation.js';
import { buildGcpPreparationConfiguration } from './gcp-setup.backend.js';
import { buildGcpObservationDashboard } from './gcp-observer-dashboard.config.js';

export type GoogleObserver = Extract<RuntimeObserverBinding, { provider: 'gcp' }>;
export const observerKey = (projectId: string, environment: string) => 'observer_' + createHash('sha256').update(JSON.stringify([projectId, environment])).digest('hex').slice(0, 16);

export function googleObserverBinding(input: {
  key: string; project: string; number: string; environmentId: string; intent: EngineCiIntent; services: GoogleObserver['services'];
}): GoogleObserver {
  const account = 'hv-obs-' + input.key.slice('observer_'.length);
  return { version: 1, provider: 'gcp', repository: input.intent.repository, environmentName: input.intent.environmentName, branch: input.intent.branch, environmentId: input.environmentId, services: input.services,
    gcp: { projectId: input.project, provider: `projects/${input.number}/locations/global/workloadIdentityPools/${account}/providers/github`,
      serviceAccount: `${account}@${input.project}.iam.gserviceaccount.com` } };
}

export function buildGcpObserverConfiguration(binding: GoogleObserver, key: string, repositoryId: string): EngineConfiguration {
  assertEngineCiIntent(binding);
  if (!/^observer_[a-f0-9]{16}$/.test(key) || !/^[1-9]\d*$/.test(repositoryId)) throw new Error('Invalid observer trust identity.');
  const { projectId: project, provider, serviceAccount } = binding.gcp;
  const pool = provider.split('/')[5]!;
  const number = provider.split('/')[1]!;
  const apis = ['iam', 'iamcredentials', 'sts', 'logging', 'monitoring'].map(api => api + '.googleapis.com');
  const config = buildGcpPreparationConfiguration({ gcpProjectId: project, deployServiceAccountEmail: serviceAccount,
    enableApis: apis, grantRoles: [], runtimeGrantRoles: [], runtimeServiceAccountGrantRoles: [] });
  const resource: Record<string, Record<string, unknown>> = {};
  const add = (type: string, label: string, name: string, value: Record<string, unknown>) => {
    (resource[type] ??= {})[label] = value;
    const address = type + '.' + label;
    config.resources[address] = { actionId: 'observer:' + address, kind: 'ci', name };
  };
  const dependencies = apis.map(api => 'google_project_service.' + api.replaceAll('.', '_'));
  const account = 'google_service_account.' + key;
  const poolAddress = 'google_iam_workload_identity_pool.' + key;
  const providerAddress = 'google_iam_workload_identity_pool_provider.' + key;
  const ref = 'refs/heads/' + binding.branch;
  const workflow = binding.repository + '/.github/workflows/hypervibe-observe-' + binding.environmentName + '.yml@' + ref;
  const condition = [`assertion.repository_id == '${repositoryId}'`, `assertion.repository == '${binding.repository}'`,
    `assertion.workflow_ref == '${workflow}'`, `assertion.ref == '${ref}'`, "assertion.ref_type == 'branch'",
    "assertion.runner_environment == 'github-hosted'", "assertion.run_attempt == '1'",
    "(assertion.event_name == 'schedule' || assertion.event_name == 'workflow_dispatch')"].join(' && ');
  if (condition.length > 4096) throw new Error('Observer workflow identity exceeds the Google provider condition limit.');
  add('google_service_account', key, 'Dedicated runtime observer identity', { project, account_id: pool, display_name: 'Hypervibe runtime observer', disabled: false, depends_on: dependencies });
  add('google_iam_workload_identity_pool', key, 'Runtime observer identity pool', { project, workload_identity_pool_id: pool, display_name: 'Hypervibe runtime observer', disabled: false, depends_on: dependencies });
  add('google_iam_workload_identity_pool_provider', key, 'GitHub observer workflow trust', { project, workload_identity_pool_id: pool,
    workload_identity_pool_provider_id: 'github', display_name: 'GitHub observer workflow', disabled: false, depends_on: [poolAddress],
    oidc: [{ issuer_uri: 'https://token.actions.githubusercontent.com' }],
    attribute_mapping: { 'google.subject': 'assertion.repository_id', 'attribute.repository_id': 'assertion.repository_id' }, attribute_condition: condition });
  add('google_service_account_iam_member', key, 'Allow the verified observer workflow to impersonate this identity', {
    service_account_id: `projects/${project}/serviceAccounts/${serviceAccount}`, role: 'roles/iam.workloadIdentityUser',
    member: `principalSet://iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/attribute.repository_id/${repositoryId}`, depends_on: [account, providerAddress] });
  const member = 'serviceAccount:' + serviceAccount;
  for (const [suffix, permission] of [['logs', 'logging.logEntries.list'], ['jobs', 'run.executions.list']] as const) {
    const roleId = key + '_' + suffix;
    add('google_project_iam_custom_role', roleId, permission, { project, role_id: roleId, title: 'Hypervibe observer ' + suffix, permissions: [permission], depends_on: dependencies });
    const role = `projects/${project}/roles/${roleId}`;
    const depends_on = [account, 'google_project_iam_custom_role.' + roleId];
    if (suffix === 'logs') add('google_project_iam_member', key, 'List non-private log entries in ' + project, { project, member, role, depends_on });
    else for (const service of Object.values(binding.services).filter(service => service.workloadKind === 'cron')) {
      const name = service.serviceId.split('/').at(-1)!;
      const label = key + '_' + createHash('sha256').update(service.serviceId).digest('hex').slice(0, 16);
      add('google_cloud_run_v2_job_iam_member', label, 'List executions of ' + name, { project, location: service.region, name, member, role, depends_on });
    }
  }
  config.files[key.replaceAll('_', '-') + '.tf.json'] = { resource };
  const dashboard = buildGcpObservationDashboard(binding, key);
  return { files: { ...config.files, ...dashboard.files }, resources: { ...config.resources, ...dashboard.resources } };
}

// Google soft-deletes WIF pools and providers. Retain their disabled names so the same environment can opt back in immediately.
export function disableGcpObserverConfiguration(previous: EngineConfiguration, key: string): EngineConfiguration {
  const config = structuredClone(previous);
  const owned = config.files[key.replaceAll('_', '-') + '.tf.json'] as { resource: Record<string, Record<string, Record<string, unknown>>> } | undefined;
  if (!owned?.resource.google_service_account?.[key]) throw new Error('The saved Google observer setup has no matching owned identity.');
  for (const [type, entries] of Object.entries(owned.resource)) {
    if (['google_iam_workload_identity_pool_provider', 'google_iam_workload_identity_pool', 'google_service_account'].includes(type)) {
      entries[key]!.disabled = true;
    } else if (type === 'google_project_iam_custom_role') continue;
    else if (['google_project_iam_member', 'google_service_account_iam_member', 'google_cloud_run_v2_job_iam_member'].includes(type)) {
      for (const label of Object.keys(entries)) delete config.resources[type + '.' + label];
      delete owned.resource[type];
    } else throw new Error('The saved observer includes an unknown resource. Preserve its setup.');
  }
  const dashboardFile = `observer-dashboard-${key.replaceAll('_', '-')}.tf.json`;
  const dashboard = config.files[dashboardFile] as { resource: Record<string, Record<string, unknown>> } | undefined;
  for (const [type, entries] of Object.entries(dashboard?.resource ?? {})) {
    if (!['google_monitoring_alert_policy', 'google_monitoring_dashboard'].includes(type)) throw new Error('The saved observer dashboard includes an unknown resource.');
    for (const label of Object.keys(entries)) delete config.resources[type + '.' + label];
  }
  delete config.files[dashboardFile];
  return config;
}

// Project-setup saves its desired manifest before native apply. Keep the mappings for removed, previously owned
// resources so a partial removal can be reviewed and retried against the remaining Google state.
export function retainObserverRemovals(config: EngineConfiguration, previous?: EngineConfiguration): string[] {
  if (!previous) return [];
  const declared = new Set(Object.values(config.files).flatMap(document => {
    const resources = (document as { resource?: Record<string, Record<string, unknown>> }).resource ?? {};
    return Object.entries(resources).flatMap(([type, labels]) => Object.keys(labels).map(label => type + '.' + label));
  }));
  const removed = Object.keys(previous.resources).filter(address => !declared.has(address));
  for (const address of removed) {
    if (!/^(google_cloud_run_v2_job_iam_member|google_service_account_iam_member|google_project_iam_member|google_monitoring_alert_policy|google_monitoring_dashboard)\./.test(address)) {
      throw new Error('An unrecognized resource would be removed from Google observer setup. Preserve the existing state.');
    }
    config.resources[address] = previous.resources[address]!;
  }
  return removed.sort();
}
