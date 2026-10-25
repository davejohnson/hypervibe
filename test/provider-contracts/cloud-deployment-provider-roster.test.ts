import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';

// docs/connect-cloud-deployment-contract.md records native scope differences and
// explicit live gates. Registry admission alone never establishes live support.
describe('hosted deployment provider contract roster', () => {
  it('requires a new review when a hosting provider is added', () => {
    expect(providerRegistry.namesFor('hosting').sort()).toEqual(['azure-container-apps', 'cloudrun', 'digitalocean', 'ecs', 'fly', 'railway', 'vercel']);
  });
  it.each([['ecs', 'aws'], ['cloudrun', 'gcp'], ['azure-container-apps', 'azure']])('%s declares transient callbacks and the reviewed CI identity contract', (name, provider) => {
    const registered = providerRegistry.get(name)!;
    expect(registered.transientAuthentication).toMatchObject({ hostingProvider: name, provider, createAdapter: expect.any(Function), parseScope: expect.any(Function) });
    expect(registered.metadata.orchestration?.ci?.transientDeployment).toBe('github-oidc-broker-v1');
  });
  it.each(['digitalocean', 'fly', 'railway', 'vercel'])('%s has no implicit transient fallback', name => {
    expect(providerRegistry.get(name)?.transientAuthentication).toBeUndefined();
    expect(providerRegistry.getMetadata(name)?.orchestration?.ci?.transientDeployment).toBeUndefined();
  });
});
