import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
// Capability admission only; native distinctions are in operator-output-retirement.md.
describe('operator-owned output retirement provider roster', () => {
  const names = ['azure-container-apps', 'cloudrun', 'digitalocean', 'ecs', 'fly', 'railway', 'vercel'];
  it('keeps every hosting provider explicit', () => expect(providerRegistry.namesFor('hosting').sort()).toEqual(names));
  it.each(names)('%s does not inherit operator deletion from customer secret delivery', name => {
    expect(Boolean(providerRegistry.getOperatorOutputDelivery(name)?.retirement)).toBe(name === 'cloudrun');
  });
});
