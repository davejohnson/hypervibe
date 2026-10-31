import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';

// Declaration conformance only. docs/connect-cloud-prepared-hosting.md records
// native lifetime/creation differences and the separate live acceptance gate.
describe('installer-prepared hosting provider roster', () => {
  it('requires explicit review when any hosting provider is added', () => {
    expect(providerRegistry.namesFor('hosting').sort()).toEqual(['azure-container-apps', 'cloudrun', 'digitalocean', 'ecs', 'fly', 'railway', 'vercel']);
  });
  it('requires a native prepared-receipt parser for every declared capability', () => {
    for (const name of providerRegistry.namesFor('hosting')) {
      const provider = providerRegistry.get(name)!;
      const capability = provider.metadata.lifecycle?.hosting?.preparedResources;
      if (capability !== undefined) {
        expect(capability).toBe('installer-receipt-v1');
        expect(provider.transientAuthentication?.parsePreparedResources).toEqual(expect.any(Function));
      }
    }
  });
  it('declares the Cloud Run prepared receipt handoff explicitly', () => {
    expect(providerRegistry.getMetadata('cloudrun')?.lifecycle?.hosting?.preparedResources).toBe('installer-receipt-v1');
  });
  it('declares the native Azure prepared handoff independently from create-only support', () => {
    expect(providerRegistry.getMetadata('azure-container-apps')?.lifecycle?.hosting?.preparedResources).toBe('installer-receipt-v1');
    expect(providerRegistry.get('azure-container-apps')?.transientAuthentication?.parsePreparedResources).toEqual(expect.any(Function));
  });
  it.each(['ecs', 'digitalocean', 'fly', 'railway', 'vercel'])('%s cannot infer a prepared binding capability from generic hosting support', name => {
    expect(providerRegistry.getMetadata(name)?.lifecycle?.hosting?.preparedResources).toBeUndefined();
    expect(providerRegistry.get(name)?.transientAuthentication?.parsePreparedResources).toBeUndefined();
  });
});
