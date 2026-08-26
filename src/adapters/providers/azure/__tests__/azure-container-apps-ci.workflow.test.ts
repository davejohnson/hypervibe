import { describe, expect, it } from 'vitest';
import {
  AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS,
  azureRegistryName,
  buildAzureContainerAppsGitHubActionsSteps,
} from '../azure-container-apps-ci.workflow.js';

describe('Azure Container Apps managed CI workflow', () => {
  const resourceGroupId = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/hv-app-production-a1b2c3d4';

  it('derives the registry and mutates only already-bound Container Apps', () => {
    const appId = `${resourceGroupId}/providers/Microsoft.App/containerApps/hv-web-a1b2c3d4`;
    const result = buildAzureContainerAppsGitHubActionsSteps({
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: resourceGroupId,
      providerServiceIds: [appId],
      containerStartCommand: 'node server.mjs',
    });

    expect(result.requiredSecrets).toEqual(AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS);
    expect(result.requiredVariables).toEqual([]);
    expect(result.steps).toContain(`${azureRegistryName(resourceGroupId)}.azurecr.io`);
    expect(result.steps).toContain(appId);
    expect(result.steps).toContain("request('PATCH', appId");
    expect(result.steps).not.toMatch(/resourceGroups.*PUT|managedEnvironments.*PUT|roleAssignments.*PUT/);
    expect(result.steps).not.toContain('az containerapp');
  });

  it('requires explicit variables when no applied binding is compiled', () => {
    const result = buildAzureContainerAppsGitHubActionsSteps({
      environmentName: 'staging',
      kind: 'staging',
      branch: 'main',
      autoDeployOnPush: true,
      serviceNames: ['web'],
      providerServiceIds: [],
    });
    expect(result.requiredVariables).toEqual([
      'AZURE_RESOURCE_GROUP_ID',
      'AZURE_CONTAINER_APP_IDS_JSON',
    ]);
  });
});
