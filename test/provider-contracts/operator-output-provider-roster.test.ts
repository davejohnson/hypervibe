import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
describe('local operator private output hosting review', () => {
  it('requires explicit review for every hosting provider', () => {
    const names = ['azure-container-apps', 'cloudrun', 'digitalocean', 'ecs', 'fly', 'railway', 'vercel'];
    expect(providerRegistry.namesFor('hosting').sort()).toEqual(names);
    for (const name of names) expect(Boolean(providerRegistry.getOperatorOutputDelivery(name))).toBe(name === 'cloudrun');
    expect(providerRegistry.getOperatorOutputDelivery('cloudrun')).toMatchObject({ schemaVersion: 1, providers: ['gcp-secret-manager'],
      review: expect.any(Function), create: expect.any(Function) });
  });
});
