import { describe, expect, it } from 'vitest';
import type { BranchDeployTarget } from '../../../../domain/ports/ci-deploy.port.js';
import { buildBranchDeployWorkflow } from '../../../../domain/services/github-ops.service.js';
import {
  buildHerokuGitHubActionsSteps,
  HEROKU_CI_REQUIRED_SECRETS,
} from '../heroku-ci.workflow.js';
import '../heroku.adapter.js';

const WEB_BINDING =
  '11111111-1111-4111-8111-111111111111:web:basic';
const WORKER_BINDING =
  '22222222-2222-4222-8222-222222222222:worker:standard-1x';

function target(
  overrides: Partial<BranchDeployTarget> = {}
): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web', 'worker'],
    providerProjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    providerServiceIds: [WEB_BINDING, WORKER_BINDING],
    needsServiceNames: true,
    needsJobNames: false,
    webStartCommand: 'npm start',
    ...overrides,
  };
}

describe('Heroku GitHub Actions workflow', () => {
  it('releases exact local image IDs only to durable app bindings', () => {
    const result = buildHerokuGitHubActionsSteps(target());

    expect(result.requiredSecrets).toEqual(HEROKU_CI_REQUIRED_SECRETS);
    expect(result.requiredVariables).toEqual([]);
    expect(result.permissions).toContain('contents: read');
    expect(result.steps).toContain('docker/build-push-action@v6');
    expect(result.steps).toContain('load: true');
    expect(result.steps).toContain('platforms: linux/amd64');
    expect(result.steps).toContain(
      `HEROKU_SERVICE_BINDINGS_JSON: '[\"${WEB_BINDING}\",\"${WORKER_BINDING}\"]'`
    );
    expect(result.steps).toContain(
      "['image', 'inspect', '--format={{.Id}}', localImage]"
    );
    expect(result.steps).toContain(
      `JSON.stringify('exec sh -lc "$HYPERVIBE_START_COMMAND"')`
    );
    expect(result.steps).toContain(
      "'application/vnd.heroku+json; version=3.docker-releases'"
    );
    expect(result.steps).toContain('docker_image: imageId');
    expect(result.steps).toContain('quantity: 1');
    expect(result.steps).toContain('dyno_size: { name: target.dynoSize }');
    expect(result.steps).toContain("release?.status !== 'succeeded'");
    expect(result.steps).toContain(
      'releaseConfig.HYPERVIBE_DEPLOY_SHA !== process.env.DEPLOY_SHA'
    );
    expect(result.steps).toContain(
      'releaseConfig.HYPERVIBE_IMAGE_ID !== imageId'
    );
    expect(result.steps).toContain(
      'Heroku formation does not match the applied service binding'
    );
    expect(result.steps).not.toContain("heroku container:");
    expect(result.steps).not.toContain("'/apps',");
    expect(result.steps).not.toContain("'/add-ons'");
  });

  it('requires durable identity variables when bindings are not applied yet', () => {
    const result = buildHerokuGitHubActionsSteps(target({
      providerProjectId: undefined,
      providerServiceIds: [],
    }));

    expect(result.requiredVariables).toEqual([
      'HEROKU_SERVICE_BINDINGS_JSON',
      'HEROKU_ACCOUNT_ID',
    ]);
    expect(result.steps).toContain(
      'HEROKU_SERVICE_BINDINGS_JSON: ${{ vars.HEROKU_SERVICE_BINDINGS_JSON }}'
    );
    expect(result.steps).toContain(
      'HEROKU_ACCOUNT_ID: ${{ vars.HEROKU_ACCOUNT_ID }}'
    );
  });

  it('emits syntactically valid github-script JavaScript', () => {
    const steps = buildHerokuGitHubActionsSteps(target()).steps;
    const marker = '          script: |\n';
    const start = steps.lastIndexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const script = steps
      .slice(start + marker.length)
      .split('\n')
      .map((line) => line.startsWith('            ') ? line.slice(12) : line)
      .join('\n');

    expect(() => new Function(
      'require',
      'fetch',
      'process',
      'core',
      `return (async () => {\n${script}\n})();`
    )).not.toThrow();
  });

  it('is embedded behind the shared exact-SHA and applied-spec gates', () => {
    const workflow = buildBranchDeployWorkflow(
      'heroku',
      target(),
      { includeStep: false }
    );

    expect(workflow.path).toBe(
      '.github/workflows/deploy-heroku-production.yml'
    );
    expect(workflow.requiredSecrets).toEqual(
      HEROKU_CI_REQUIRED_SECRETS
    );
    expect(workflow.content).toContain(
      'ref: ${{ steps.deploy.outputs.sha }}'
    );
    expect(workflow.content).toContain('HYPERVIBE_APPLIED_SPEC_HASH');
    expect(workflow.content).toContain(
      'Build exact-SHA Heroku base image'
    );
    expect(workflow.content).toContain(
      'Release exact-SHA images to existing Heroku apps'
    );
  });
});
