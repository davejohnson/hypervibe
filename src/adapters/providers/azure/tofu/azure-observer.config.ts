import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { observerSubjects } from '../../../../domain/spec/runtime-observation.js';
import { azureKey, type AzureEngineInput } from './azure-engine.config.js';

export const OBSERVER_ARM_READER = 'acdd72a7-3385-48ef-bd42-f606fba81ae7';
export const OBSERVER_LOG_READER = '3b03c2da-16b3-4a49-8834-0f8130efdd3b';

export function addAzureObserverConfiguration(input: AzureEngineInput, files: EngineConfiguration['files'], resources: Record<string, EngineResourceMapping>) {
  const scopes: Record<string, { scope: string; role: string; condition?: string; condition_version?: string }> = {};
  const apps = [...(input.services ?? []), ...(input.workers ?? [])];
  const jobs = input.jobs ?? [];
  const role = (guid: string) => '/subscriptions/' + input.subscriptionId + '/providers/Microsoft.Authorization/roleDefinitions/' + guid;
  scopes.observer_environment = { scope: input.shared.appsEnvironmentId, role: role(OBSERVER_ARM_READER) };
  for (const [type, values] of [['azurerm_container_app', apps], ['azurerm_container_app_job', jobs]] as const) {
    for (const value of values) scopes['observer_app_' + azureKey(value.logicalName)] = {
      scope: '${' + type + '.' + azureKey(value.logicalName) + '.id}', role: role(OBSERVER_ARM_READER),
    };
  }
  const assignments: Record<string, unknown> = {};
  const addresses = ['azurerm_user_assigned_identity.observer', 'azurerm_federated_identity_credential.observer', 'azurerm_federated_identity_credential.observer_immutable',
    ...new Set(['observer_logs', ...Object.keys(scopes), ...(input.previousObserverServices ?? []).map(name => 'observer_app_' + azureKey(name))].map(name => 'azurerm_role_assignment.' + name))];
  for (const address of addresses) resources[address] = { actionId: 'identity:runtime-observer', kind: 'service', name: 'runtime observer', requiresConfirm: true };
  if (!input.observation || !apps.length && !jobs.length) return;
  const subjects = observerSubjects(input.observation);
  scopes.observer_logs = { scope: input.observation.workspaceResourceId, role: role(OBSERVER_LOG_READER), condition_version: '2.0',
    condition: azureObserverLogCondition(apps.map(v => v.resourceName), jobs.map(v => v.resourceName)) };
  for (const [name, { scope, role, ...condition }] of Object.entries(scopes)) assignments[name] = {
    scope, role_definition_id: role, ...condition, principal_id: '${azurerm_user_assigned_identity.observer.principal_id}', principal_type: 'ServicePrincipal',
  };
  files['observer.tf.json'] = { resource: {
    azurerm_user_assigned_identity: { observer: { name: input.prefix + '-observer', resource_group_name: input.resourceGroup, location: input.location,
      tags: { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() } } },
    azurerm_federated_identity_credential: Object.fromEntries(Object.entries(subjects).map(([kind, subject]) => [
      kind === 'legacy' ? 'observer' : 'observer_immutable', { name: kind === 'legacy' ? 'github-observe' : 'github-observe-immutable',
        user_assigned_identity_id: '${azurerm_user_assigned_identity.observer.id}', issuer: 'https://token.actions.githubusercontent.com',
        audience: ['api://AzureADTokenExchange'], subject },
    ])),
    azurerm_role_assignment: assignments,
  } };
}

export function azureObserverLogCondition(apps: string[], jobs: string[]) {
  const allowed = (names: string[], column: string) => names.sort().map(name => {
    if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error('Invalid observer workload name.');
    return `@Resource[Microsoft.OperationalInsights/workspaces/tables/record:${column}] StringEquals '${name}'`;
  });
  const rows = [...allowed(apps, 'ContainerAppName_s'), ...allowed(jobs, 'ContainerJobName_s')];
  if (!rows.length) throw new Error('No container log workloads were selected.');
  return "(!(ActionMatches{'Microsoft.OperationalInsights/workspaces/tables/data/read'})) OR ((@Resource[Microsoft.OperationalInsights/workspaces/tables:name] StringEquals 'ContainerAppConsoleLogs_CL') AND (" + rows.join(' OR ') + '))';
}
