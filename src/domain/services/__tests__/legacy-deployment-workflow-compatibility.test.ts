import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { buildEcsExpressGitHubActionsSteps } from '../../../adapters/providers/aws/ecs-express-ci.workflow.js';
import { buildCloudRunGitHubActionsSteps } from '../../../adapters/providers/gcp/cloudrun-ci.workflow.js';
import { buildAzureContainerAppsGitHubActionsSteps } from '../../../adapters/providers/azure/azure-container-apps-ci.workflow.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { githubActionsWorkflowInputHash, GITHUB_ACTIONS_WORKFLOW_RENDERER_REVISION } from '../github-ops.service.js';
import { brokerTarget } from './cloud-deployment-ci.fixture.js';

const base: BranchDeployTarget = { environmentName: 'production', kind: 'production', branch: 'main',
  autoDeployOnPush: false, serviceNames: ['web'], providerServiceIds: ['web'] };

// Exact serialized emitter results produced independently from committed main 3bfe9b98d5d262741de01ef4d6cb8e0c5a0703a1
// under the normal Vitest transform (the emitters embed helper function source),
// including its credential rollout receipts. This pins legacy bytes, including YAML whitespace;
// it is compatibility evidence, not a claim of live provider support.
describe('legacy deployment workflow compatibility', () => {
  it.each([
    ['ecs', buildEcsExpressGitHubActionsSteps, { ...base,
      providerProjectId: 'arn:aws:ecs:us-west-2:123456789012:cluster/example',
      providerServiceIds: ['arn:aws:ecs:us-west-2:123456789012:service/example/web'],
    }, '599988816e1acd6ebc0d2665203063fc8944801c898c0515daf17f0f89dfa533'],
    ['azure-container-apps', buildAzureContainerAppsGitHubActionsSteps, { ...base,
      providerProjectId: '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/example',
      providerServiceIds: ['/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/example/providers/Microsoft.App/containerApps/web'],
    }, '9df69efa984bff3272df92bff02911fdd6f11ae94f06dc60f98ab93e2259f3e1'],
  ] as const)('preserves %s legacy emitter bytes', (_provider, render, target, expected) => {
    expect(createHash('sha256').update(JSON.stringify(render({ ...target, providerServiceIds: [...target.providerServiceIds] }))).digest('hex')).toBe(expected);
  });

  it('requires reviewed ECS bootstrap revision migration while preserving the legacy emitter bytes', () => {
    expect(providerRegistry.getMetadata('ecs')?.orchestration?.ci?.rendererRevision).toBe(2);
    expect(providerRegistry.getMetadata('azure-container-apps')?.orchestration?.ci?.rendererRevision).toBe(1);
    expect(providerRegistry.getMetadata('cloudrun')?.orchestration?.ci?.rendererRevision).toBe(3);
    const broker = brokerTarget(), legacy = { ...broker }; delete legacy.deploymentAccess;
    const hash = (target: BranchDeployTarget) => githubActionsWorkflowInputHash({ provider: 'ecs', target, migration: { includeStep: false } });
    expect(hash(broker)).not.toBe(hash(legacy));
    // Freeze the previous ECS provider contract independently of its registered
    // revision. A global renderer migration must not mask this provider change.
    const previousTarget = { ...broker }; delete previousTarget.providerImageUris;
    delete previousTarget.programFingerprint; delete previousTarget.deploymentContractFingerprint;
    const previousEcs = canonicalJsonSha256({ version: 1, rendererRevision: GITHUB_ACTIONS_WORKFLOW_RENDERER_REVISION,
      providerRendererRevision: 1, provider: 'ecs', target: previousTarget, migration: { includeStep: false } });
    expect(hash(broker)).not.toBe(previousEcs);
  });
  it('requires a reviewed Cloud Run migration for native Execution completion conditions', () => {
    const target = { ...base, providerRegion: 'us-west1', providerScope: { projectId: 'test-project', region: 'us-west1' } };
    // Keep the independently frozen old emitter and input contract. This is an
    // intentional provider renderer migration, not silent legacy regeneration.
    expect(createHash('sha256').update(JSON.stringify(buildCloudRunGitHubActionsSteps(target))).digest('hex'))
      .not.toBe('1e24d640bcd2bb21b2aec5a772b2b692ea66d2f2e7cbbe5e8c723c2c9800b989');
    const migration = { includeStep: false };
    const previous = canonicalJsonSha256({ version: 1, rendererRevision: GITHUB_ACTIONS_WORKFLOW_RENDERER_REVISION,
      providerRendererRevision: 2, provider: 'cloudrun', target, migration });
    expect(githubActionsWorkflowInputHash({ provider: 'cloudrun', target, migration })).not.toBe(previous);
  });
});
