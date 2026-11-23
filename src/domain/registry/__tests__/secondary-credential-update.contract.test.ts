import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { providerRegistry } from '../provider.registry.js';

describe('registered secondary connection-credential contract', () => {
  it('limits secondary updates to the registered GitHub and Railway credentials', () => {
    const providers = providerRegistry.all().filter(provider => provider.metadata.category === 'deployment');
    expect(providers.map(provider => provider.metadata.name).sort()).toEqual([
      'aws', 'azure', 'cloudrun', 'github', 'railway',
    ]);
    expect(providers.filter(provider => provider.credentialUpdate).map(provider => provider.metadata.name).sort()).toEqual(['github', 'railway']);
    const capability = providerRegistry.get('github')!.credentialUpdate!;
    expect(capability.secretKeys).toEqual(['apiToken', 'packageReadToken']);
    expect(capability.matches({ packageReadToken: 'synthetic-package' })).toBe(true);
    expect(capability.matches({ apiToken: 'synthetic-api', packageReadToken: 'synthetic-package' })).toBe(false);
    const railway = providerRegistry.get('railway')!.credentialUpdate!;
    const files = { sshIdentityFile: '/test/identity', sshKnownHostsFile: '/test/hosts' };
    expect(railway.matches(files)).toBe(true);
    expect(railway.matches({ ...files, apiToken: 'synthetic-api' })).toBe(false);
    expect(railway.matches({ packageReadToken: 'synthetic-package' })).toBe(false);
  });
});
