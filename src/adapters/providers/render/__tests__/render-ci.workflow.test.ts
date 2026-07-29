import { describe, expect, it } from 'vitest';
import type { BranchDeployTarget } from '../../../../domain/ports/ci-deploy.port.js';
import { buildBranchDeployWorkflow } from '../../../../domain/services/github-ops.service.js';
import {
  buildRenderGitHubActionsSteps,
  RENDER_CI_REQUIRED_SECRETS,
} from '../render-ci.workflow.js';
import '../render.adapter.js';

function target(
  overrides: Partial<BranchDeployTarget> = {}
): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web', 'worker'],
    providerProjectId: 'tea-owner-1',
    providerServiceIds: ['srv-web-1', 'srv-worker-1'],
    needsServiceNames: true,
    needsJobNames: false,
    webStartCommand: 'npm start',
    ...overrides,
  };
}

describe('Render GitHub Actions workflow', () => {
  it('publishes a full-SHA GHCR image and deploys only durable service IDs', () => {
    const result = buildRenderGitHubActionsSteps(target());

    expect(result.requiredSecrets).toEqual(RENDER_CI_REQUIRED_SECRETS);
    expect(result.requiredVariables).toEqual([]);
    expect(result.permissions).toContain('contents: read');
    expect(result.permissions).toContain('packages: write');
    expect(result.steps).toContain(
      "'ghcr.io/' + repository + ':' + sha"
    );
    expect(result.steps).toContain('docker/build-push-action@v6');
    expect(result.steps).toContain('platforms: linux/amd64');
    expect(result.steps).toContain(
      "RENDER_SERVICE_IDS_JSON: '[\"srv-web-1\",\"srv-worker-1\"]'"
    );
    expect(result.steps).toContain(
      "'/services/' + encodeURIComponent(serviceId) + '/deploys'"
    );
    expect(result.steps).toContain('{ imageUrl: expectedImage }');
    expect(result.steps).toContain(
      "const bootstrapImage = 'docker.io/library/alpine:3.20'"
    );
    expect(result.steps).toContain(
      "'PATCH',\n                  '/services/' + encodeURIComponent(serviceId)"
    );
    expect(result.steps).toContain(
      'registryCredentialId:\n                        process.env.RENDER_REGISTRY_CREDENTIAL_ID'
    );
    expect(result.steps).toContain("deploy?.status !== 'live'");
    expect(result.steps).toContain(
      'deploy?.image?.ref !== expectedImage'
    );
    expect(result.steps).not.toMatch(/\brender\s+deploys\b/);
    expect(result.steps).not.toContain("'/services',");
    expect(result.steps).not.toContain("'/postgres'");
    expect(result.steps).not.toContain("'/key-value'");
    expect(result.steps).not.toContain("'/registrycredentials'");
  });

  it('requires durable identity variables when bindings do not exist yet', () => {
    const result = buildRenderGitHubActionsSteps(target({
      providerProjectId: undefined,
      providerServiceIds: [],
    }));

    expect(result.requiredVariables).toEqual([
      'RENDER_SERVICE_IDS_JSON',
      'RENDER_OWNER_ID',
    ]);
    expect(result.steps).toContain(
      'RENDER_SERVICE_IDS_JSON: ${{ vars.RENDER_SERVICE_IDS_JSON }}'
    );
    expect(result.steps).toContain(
      'RENDER_OWNER_ID: ${{ vars.RENDER_OWNER_ID }}'
    );
    expect(result.steps).not.toContain('RENDER_TARGET_NAMES');
  });

  it('is embedded behind the shared exact-SHA and applied-spec gates', () => {
    const workflow = buildBranchDeployWorkflow(
      'render',
      target(),
      { includeStep: false }
    );

    expect(workflow.path).toBe(
      '.github/workflows/deploy-render-production.yml'
    );
    expect(workflow.requiredSecrets).toEqual(
      RENDER_CI_REQUIRED_SECRETS
    );
    expect(workflow.content).toContain(
      'ref: ${{ steps.deploy.outputs.sha }}'
    );
    expect(workflow.content).toContain('HYPERVIBE_APPLIED_SPEC_HASH');
    expect(workflow.content).toContain('Publish exact-SHA image');
    expect(workflow.content).toContain(
      'Deploy exact-SHA image to existing Render services'
    );
  });
});
