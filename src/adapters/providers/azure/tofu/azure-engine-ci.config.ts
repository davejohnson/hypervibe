import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { assertEngineCiIntent } from '../../../../domain/spec/engine-ci.js';
import { azureKey, type AzureEngineInput } from './azure-engine.config.js';

/** Branch-scoped federation on an environment-specific identity, separate from local deploy access. */
export function addAzureCiConfiguration(input: AzureEngineInput, files: EngineConfiguration['files'], resources: Record<string, EngineResourceMapping>): void {
  if (!input.ci) return;
  assertEngineCiIntent(input.ci);
  const group = `/subscriptions/${input.subscriptionId}/resourceGroups/${input.resourceGroup}`;
  const assignments: Record<string, unknown> = {};
  const assign = (name: string, scope: string, role: string) => { assignments[name] = {
    scope, role_definition_id: `\${azurerm_role_definition.${role}.role_definition_resource_id}`,
    principal_id: '${azurerm_user_assigned_identity.ci.principal_id}', principal_type: 'ServicePrincipal',
  }; };
  for (const service of [...(input.services ?? []), ...(input.workers ?? [])]) assign(`ci_${azureKey(service.logicalName)}`, `\${azurerm_container_app.${azureKey(service.logicalName)}.id}`, 'ci_release');
  for (const job of input.jobs ?? []) assign(`ci_job_${azureKey(job.logicalName)}`, `\${azurerm_container_app_job.${azureKey(job.logicalName)}.id}`, 'ci_release');
  assign('ci_build', input.shared.registryId, 'ci_build');
  files['ci.tf.json'] = { resource: {
    azurerm_user_assigned_identity: { ci: { name: `${input.prefix}-ci`, resource_group_name: input.resourceGroup, location: input.location,
      tags: { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() } } },
    azurerm_federated_identity_credential: { ci: { name: 'github-release',
      user_assigned_identity_id: '${azurerm_user_assigned_identity.ci.id}', issuer: 'https://token.actions.githubusercontent.com', audience: ['api://AzureADTokenExchange'],
      subject: `repo:${input.ci.repository}:ref:refs/heads/${input.ci.branch}` } },
    azurerm_role_definition: {
      ci_release: { name: `${input.prefix}-release`, scope: group, assignable_scopes: [group],
        permissions: [{ actions: ['Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write', 'Microsoft.App/containerApps/revisions/read', 'Microsoft.App/jobs/read', 'Microsoft.App/jobs/write'] }] },
      ci_build: { name: `${input.prefix}-build`, scope: group, assignable_scopes: [group], permissions: [{ actions: [
        'Microsoft.ContainerRegistry/registries/read', 'Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action',
        'Microsoft.ContainerRegistry/registries/scheduleRun/action', 'Microsoft.ContainerRegistry/registries/runs/read',
        'Microsoft.ContainerRegistry/registries/runs/listLogSasUrl/action', 'Microsoft.ContainerRegistry/registries/pull/read',
      ] }] },
    },
    azurerm_role_assignment: assignments,
  }, output: { ci_client_id: { value: '${azurerm_user_assigned_identity.ci.client_id}' }, ci_principal_id: { value: '${azurerm_user_assigned_identity.ci.principal_id}' } } };
  const file = files['ci.tf.json'] as { resource: Record<string, Record<string, unknown>> };
  for (const [type, instances] of Object.entries(file.resource)) for (const name of Object.keys(instances)) resources[`${type}.${name}`] = {
    actionId: 'identity:ci-release', kind: 'service', name: 'ci-release', requiresConfirm: true,
  };
}
