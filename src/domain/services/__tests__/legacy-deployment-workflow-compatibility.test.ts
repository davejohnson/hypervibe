import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { buildEcsExpressGitHubActionsSteps } from '../../../adapters/providers/aws/ecs-express-ci.workflow.js';
import { buildCloudRunGitHubActionsSteps } from '../../../adapters/providers/gcp/cloudrun-ci.workflow.js';
import { buildAzureContainerAppsGitHubActionsSteps } from '../../../adapters/providers/azure/azure-container-apps-ci.workflow.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { githubActionsWorkflowInputHash } from '../github-ops.service.js';
import { brokerTarget } from './cloud-deployment-ci.fixture.js';

const base: BranchDeployTarget = { environmentName: 'production', kind: 'production', branch: 'main',
  autoDeployOnPush: false, serviceNames: ['web'], providerServiceIds: ['web'] };

// Exact serialized emitter results produced independently from committed 7fcb852
// under the normal Vitest transform (the emitters embed helper function source),
// before the new broker mode. This pins legacy bytes, including YAML whitespace;
// it is compatibility evidence, not a claim of live provider support.
describe('legacy deployment workflow compatibility', () => {
  it.each([
    ['ecs', buildEcsExpressGitHubActionsSteps, { ...base,
      providerProjectId: 'arn:aws:ecs:us-west-2:123456789012:cluster/example',
      providerServiceIds: ['arn:aws:ecs:us-west-2:123456789012:service/example/web'],
    }, 'fa9c6196bed9b6b8bb00609bb660ce7d4d8b949c638dfdcc884a3a71803337eb'],
    ['cloudrun', buildCloudRunGitHubActionsSteps, { ...base, providerRegion: 'us-west1',
      providerScope: { projectId: 'test-project', region: 'us-west1' },
    }, 'b797a111b2be98d6b5b728bb3a4e8819dff96c29d5c500d2c21d4daec9dea715'],
    ['azure-container-apps', buildAzureContainerAppsGitHubActionsSteps, { ...base,
      providerProjectId: '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/example',
      providerServiceIds: ['/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/example/providers/Microsoft.App/containerApps/web'],
    }, '7b4861010e5f1e4fc774102c1ee44198b0eeba06ea00a7c20a78c1f39a8d3048'],
  ] as const)('preserves %s legacy emitter bytes', (_provider, render, target, expected) => {
    expect(createHash('sha256').update(JSON.stringify(render({ ...target, providerServiceIds: [...target.providerServiceIds] }))).digest('hex')).toBe(expected);
  });

  it('preserves existing provider revisions while the explicit new connection changes semantic inputs', () => {
    expect(providerRegistry.getMetadata('ecs')?.orchestration?.ci?.rendererRevision).toBeUndefined();
    expect(providerRegistry.getMetadata('azure-container-apps')?.orchestration?.ci?.rendererRevision).toBeUndefined();
    expect(providerRegistry.getMetadata('cloudrun')?.orchestration?.ci?.rendererRevision).toBe(2);
    const broker = brokerTarget(), legacy = { ...broker }; delete legacy.deploymentAccess;
    const hash = (target: BranchDeployTarget) => githubActionsWorkflowInputHash({ provider: 'ecs', target, migration: { includeStep: false } });
    expect(hash(broker)).not.toBe(hash(legacy));
  });
});
