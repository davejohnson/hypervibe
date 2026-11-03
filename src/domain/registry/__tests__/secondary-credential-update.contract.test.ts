import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { providerRegistry } from '../provider.registry.js';

describe('registered secondary connection-credential contract', () => {
  it('keeps the reviewed deployment-provider roster and explicit GitHub-only opt-in', () => {
    const providers = providerRegistry.all().filter(provider => provider.metadata.category === 'deployment');
    expect(providers.map(provider => provider.metadata.name).sort()).toEqual([
      'azure-container-apps', 'cloudrun', 'ecs', 'github', 'railway',
    ]);
    expect(providers.filter(provider => provider.credentialUpdate).map(provider => provider.metadata.name)).toEqual(['github']);
    const capability = providerRegistry.get('github')!.credentialUpdate!;
    expect(capability.secretKeys).toEqual(['apiToken', 'packageReadToken']);
    expect(capability.matches({ packageReadToken: 'synthetic-package' })).toBe(true);
    expect(capability.matches({ apiToken: 'synthetic-api', packageReadToken: 'synthetic-package' })).toBe(false);
  });
});
