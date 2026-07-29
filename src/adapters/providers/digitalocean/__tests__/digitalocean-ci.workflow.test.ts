import { describe, expect, it } from 'vitest';
import type { BranchDeployTarget } from '../../../../domain/ports/ci-deploy.port.js';
import { buildBranchDeployWorkflow } from '../../../../domain/services/github-ops.service.js';
import {
  buildDigitalOceanGitHubActionsSteps,
  DIGITALOCEAN_CI_REQUIRED_SECRETS,
} from '../digitalocean-ci.workflow.js';
import '../digitalocean.adapter.js';

function target(
  overrides: Partial<BranchDeployTarget> = {}
): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web', 'worker'],
    providerProjectId: 'do-app-1',
    providerServiceIds: [
      'do-app-1:services:web',
      'do-app-1:workers:worker',
    ],
    needsServiceNames: true,
    needsJobNames: false,
    webStartCommand: 'npm start',
    ...overrides,
  };
}

describe('DigitalOcean App Platform GitHub Actions workflow', () => {
  it('publishes an exact-SHA image and updates only existing bound components', () => {
    const result = buildDigitalOceanGitHubActionsSteps(target());

    expect(result.requiredSecrets).toEqual(DIGITALOCEAN_CI_REQUIRED_SECRETS);
    expect(result.requiredVariables).toEqual([]);
    expect(result.permissions).toContain('contents: read');
    expect(result.steps).toContain(
      "if (!/^[0-9a-f]{40}$/i.test(sha))"
    );
    expect(result.steps).toContain(
      "'registry.digitalocean.com/' + registry + '/' + repository + ':' + sha"
    );
    expect(result.steps).toContain('docker/build-push-action@v6');
    expect(result.steps).toContain('tags: ${{ steps.image.outputs.uri }}');
    expect(result.steps).toContain(
      "DIGITALOCEAN_TARGET_BINDINGS: '[\"do-app-1:services:web\",\"do-app-1:workers:worker\"]'"
    );
    expect(result.steps).toContain(
      "'GET',\n              '/v2/apps/' + encodeURIComponent(appId)"
    );
    expect(result.steps).toContain(
      "'PUT',\n              '/v2/apps/' + encodeURIComponent(appId)"
    );
    expect(result.steps).toContain(
      "+ '/deployments/' + encodeURIComponent(deploymentId)"
    );
    expect(result.steps).toContain(
      "finalApp?.active_deployment?.id !== deploymentId"
    );
    expect(result.steps).toContain(
      "current?.tag !== process.env.DEPLOY_SHA"
    );
    expect(result.steps).not.toMatch(/\bdoctl\b/);
    expect(result.steps).not.toContain("method: 'POST'");
    expect(result.steps).not.toContain('/v2/registries');
  });

  it('derives the durable app identity from component bindings', () => {
    const result = buildDigitalOceanGitHubActionsSteps(target({
      providerProjectId: undefined,
      providerServiceIds: ['do-app-derived:services:web'],
      serviceNames: ['web'],
    }));

    expect(result.requiredVariables).toEqual([]);
    expect(result.steps).toContain(
      "DIGITALOCEAN_APP_ID: 'do-app-derived'"
    );
  });

  it('requires an explicit app variable only when no durable binding exists', () => {
    const result = buildDigitalOceanGitHubActionsSteps(target({
      providerProjectId: undefined,
      providerServiceIds: [],
      serviceNames: ['web'],
    }));

    expect(result.requiredVariables).toEqual(['DIGITALOCEAN_APP_ID']);
    expect(result.steps).toContain(
      'DIGITALOCEAN_APP_ID: ${{ vars.DIGITALOCEAN_APP_ID }}'
    );
    expect(result.steps).toContain(
      "DIGITALOCEAN_TARGET_NAMES: '[\"web\"]'"
    );
  });

  it('blocks inconsistent or cross-app bindings while generating the workflow', () => {
    expect(() => buildDigitalOceanGitHubActionsSteps(target({
      providerProjectId: 'do-app-1',
      providerServiceIds: ['do-app-2:services:web'],
    }))).toThrow(/component bindings reference do-app-2/);

    expect(() => buildDigitalOceanGitHubActionsSteps(target({
      providerProjectId: undefined,
      providerServiceIds: [
        'do-app-1:services:web',
        'do-app-2:workers:worker',
      ],
    }))).toThrow(/multiple apps/);
  });

  it('is embedded behind the shared exact-SHA and applied-spec gates', () => {
    const workflow = buildBranchDeployWorkflow(
      'digitalocean',
      target(),
      { includeStep: false }
    );

    expect(workflow.path).toBe(
      '.github/workflows/deploy-digitalocean-production.yml'
    );
    expect(workflow.requiredSecrets).toEqual(
      DIGITALOCEAN_CI_REQUIRED_SECRETS
    );
    expect(workflow.content).toContain(
      'ref: ${{ steps.deploy.outputs.sha }}'
    );
    expect(workflow.content).toContain('HYPERVIBE_APPLIED_SPEC_HASH');
    expect(workflow.content).toContain('Publish exact-SHA image');
    expect(workflow.content).toContain(
      'Deploy exact-SHA image to existing DigitalOcean components'
    );
  });
});
