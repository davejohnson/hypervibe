import { describe, expect, it } from 'vitest';
import type { BranchDeployTarget } from '../../../../domain/ports/ci-deploy.port.js';
import { buildBranchDeployWorkflow } from '../../../../domain/services/github-ops.service.js';
import {
  AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS,
  buildAzureContainerAppsGitHubActionsSteps,
} from '../azure-container-apps-ci.workflow.js';
import '../azure-container-apps.adapter.js';

const ENVIRONMENT_ID =
  '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/hypervibe-test/providers/Microsoft.App/managedEnvironments/hv-production';
const WEB_ID =
  '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/hypervibe-test/providers/Microsoft.App/containerApps/hv-web';
const WORKER_ID =
  '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/hypervibe-test/providers/Microsoft.App/containerApps/hv-worker';

function target(
  overrides: Partial<BranchDeployTarget> = {}
): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web', 'worker'],
    providerProjectId: ENVIRONMENT_ID,
    providerServiceIds: [WEB_ID, WORKER_ID],
    needsServiceNames: true,
    needsJobNames: false,
    webStartCommand: 'npm start',
    ...overrides,
  };
}

describe('Azure Container Apps GitHub Actions workflow', () => {
  it('publishes and releases an exact digest only to durable app bindings', () => {
    const result = buildAzureContainerAppsGitHubActionsSteps(target());

    expect(result.requiredSecrets).toEqual(
      AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS
    );
    expect(result.requiredVariables).toEqual([]);
    expect(result.permissions).toContain('contents: read');
    expect(result.steps).toContain('docker/build-push-action@v6');
    expect(result.steps).toContain('platforms: linux/amd64');
    expect(result.steps).toContain(
      'IMAGE_DIGEST: ${{ steps.azure_publish.outputs.digest }}'
    );
    expect(result.steps).toContain(
      `AZURE_CONTAINER_APP_IDS_JSON: '${JSON.stringify([WEB_ID, WORKER_ID])}'`
    );
    expect(result.steps).toContain(
      "'https://management.azure.com//.default'"
    );
    expect(result.steps).toContain(
      "appId + '/sourcecontrols'"
    );
    expect(result.steps).toContain(
      'async function azureList(resourceId, description)'
    );
    expect(result.steps).toContain(
      'if (!payload.nextLink) return values'
    );
    expect(result.steps).toContain(
      'parsed.origin !== management'
    );
    expect(result.steps).toContain(
      "'PATCH', appId"
    );
    expect(result.steps).toContain(
      "process.env.IMAGE_URI.replace(/:[^/:]+$/, '')"
    );
    expect(result.steps).toContain(
      "deployed?.image !== exactImage"
    );
    expect(result.steps).toContain(
      'latestReadyRevisionName'
    );
    expect(result.steps).toContain(
      'health check escaped the bound app origin'
    );
    expect(result.steps).not.toMatch(/\baz\s+(?:login|acr|containerapp)\b/);
    expect(result.steps).not.toContain("'PUT', appId");
    expect(result.steps).not.toContain('roleAssignments');
  });

  it('falls back to explicit durable variables before apply has bindings', () => {
    const result = buildAzureContainerAppsGitHubActionsSteps(target({
      providerProjectId: undefined,
      providerServiceIds: [],
    }));

    expect(result.requiredVariables).toEqual([
      'AZURE_CONTAINER_APP_IDS_JSON',
      'AZURE_CONTAINER_APPS_ENVIRONMENT_ID',
    ]);
    expect(result.steps).toContain(
      'AZURE_CONTAINER_APP_IDS_JSON: ${{ vars.AZURE_CONTAINER_APP_IDS_JSON }}'
    );
    expect(result.steps).toContain(
      'AZURE_CONTAINER_APPS_ENVIRONMENT_ID: ${{ vars.AZURE_CONTAINER_APPS_ENVIRONMENT_ID }}'
    );
  });

  it('emits syntactically valid github-script JavaScript', () => {
    const steps = buildAzureContainerAppsGitHubActionsSteps(target()).steps;
    const marker = '          script: |\n';
    const start = steps.lastIndexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const script = steps
      .slice(start + marker.length)
      .split('\n')
      .map((line) => line.startsWith('            ') ? line.slice(12) : line)
      .join('\n');

    expect(() => new Function(
      'fetch',
      'process',
      'URLSearchParams',
      'URL',
      `return (async () => {\n${script}\n})();`
    )).not.toThrow();
  });

  it('is embedded behind the shared exact-SHA and applied-spec gates', () => {
    const workflow = buildBranchDeployWorkflow(
      'azure-container-apps',
      target(),
      { includeStep: false }
    );

    expect(workflow.path).toBe(
      '.github/workflows/deploy-azure-container-apps-production.yml'
    );
    expect(workflow.requiredSecrets).toEqual(
      AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS
    );
    expect(workflow.content).toContain(
      'ref: ${{ steps.deploy.outputs.sha }}'
    );
    expect(workflow.content).toContain('HYPERVIBE_APPLIED_SPEC_HASH');
    expect(workflow.content).toContain(
      'Publish exact-SHA Azure image'
    );
    expect(workflow.content).toContain(
      'Release exact image digest to existing Azure Container Apps'
    );
  });
});
