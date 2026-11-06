import { providerRegistry, type ProviderLifecycleCapability } from '../../src/domain/registry/provider.registry.js';

/** Review existing-resource operations even when resource creation is planned. */
export function reviewedOperationProviders(capability: ProviderLifecycleCapability): string[] {
  return providerRegistry.all()
    .filter(provider => provider.metadata.maturity?.lifecycle?.[capability] !== undefined)
    .map(provider => provider.metadata.name)
    .sort();
}
