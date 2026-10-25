import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { CloudRunAdapter } from '../../src/adapters/providers/gcp/cloudrun.adapter.js';
import { EcsExpressAdapter } from '../../src/adapters/providers/aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
// Named review: docs/connect-cloud-azure-evidence.md. Registry presence is not live certification.
const reviewed = ['railway', 'cloudrun', 'ecs', 'azure-container-apps', 'fly', 'digitalocean', 'vercel'];
describe('runtime identity provider contract roster', () => {
  it('requires an explicit review when a hosting provider is added', () => {
    expect(providerRegistry.namesFor('hosting').sort()).toEqual([...reviewed].sort());
  });
  it.each([
    ['cloudrun', new CloudRunAdapter(), 'before-workload'],
    ['ecs', new EcsExpressAdapter(), 'before-workload'],
    ['azure-container-apps', new AzureContainerAppsAdapter(), 'before-workload'],
  ] as const)('%s exposes its shared lifecycle capability at the declared dependency stage', (provider, adapter, timing) => {
    expect(adapter.runtimeIdentities.inspect).toBeTypeOf('function');
    expect(adapter.runtimeIdentities.apply).toBeTypeOf('function');
    expect(providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.runtimeIdentityTiming).toBe(timing);
  });
  it('does not silently admit unimplemented identity frontiers', () => {
    for (const provider of ['railway', 'fly', 'digitalocean', 'vercel']) expect(providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.runtimeIdentityTiming).toBeUndefined();
  });
});
