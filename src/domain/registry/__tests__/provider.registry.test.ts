import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderRegistry, type RegisteredProvider } from '../provider.registry.js';

function provider(
  name: string,
  category: RegisteredProvider['metadata']['category'],
  derivedAdapters?: RegisteredProvider['derivedAdapters']
): RegisteredProvider {
  const supportsDatabase = category === 'database' || Boolean(derivedAdapters?.database);
  const supportsCache = category === 'cache' || Boolean(derivedAdapters?.cache);
  const supportsStorage = category === 'storage' || Boolean(derivedAdapters?.storage);
  const supportsHosting = category === 'deployment';
  const resources = [
    ...(supportsHosting ? ['environment' as const] : []),
    ...(supportsDatabase ? ['database' as const] : []),
    ...(supportsCache ? ['cache' as const] : []),
    ...(supportsStorage ? ['storage' as const] : []),
  ];
  const selectors = Object.fromEntries(resources.map((resource) => [resource, resource === 'environment'
    ? {
        mode: 'environment-forensics' as const,
        required: ['project', 'env'] as const,
        optional: ['limit'] as const,
        list: true,
      }
    : {
        mode: 'provider-resource' as const,
        optional: ['id', 'name', 'limit'] as const,
        mutuallyExclusive: [['id', 'name']] as const,
        list: true,
        scopeKeys: ['accountId'],
      }]));
  return {
    metadata: {
      name,
      displayName: name,
      category,
      credentialsSchema: z.object({ token: z.string() }),
      lifecycle: {
        ...(category === 'deployment'
          ? { hosting: { customDomains: 'unsupported' as const, teardownBoundary: 'services' as const } }
          : {}),
        ...(supportsDatabase
          ? { databaseEngines: ['postgres'] }
          : {}),
        ...(supportsCache
          ? { cacheEngines: ['redis'] }
          : {}),
      },
    },
    factory: () => ({}),
    ...(resources.length > 0 ? {
      inspection: {
        resources,
        defaultResource: resources[0],
        selectors,
        inspect: async () => ({ observation: 'present', resource: resources[0] }),
      },
    } : {}),
    ...(derivedAdapters ? { derivedAdapters } : {}),
  };
}

describe('ProviderRegistry lifecycle capabilities', () => {
  it('derives lifecycle support from registered adapter capabilities', () => {
    const registry = new ProviderRegistry();
    registry.register(provider('host', 'deployment'));
    registry.register(provider('db', 'database'));
    registry.register(provider('multi', 'deployment', {
      database: () => ({}),
      cache: () => ({}),
      storage: () => ({}),
    }));

    expect(registry.namesFor('hosting')).toEqual(['host', 'multi']);
    expect(registry.namesFor('database')).toEqual(['db', 'multi']);
    expect(registry.namesFor('cache')).toEqual(['multi']);
    expect(registry.namesFor('storage')).toEqual(['multi']);
    expect(registry.supportsEngine('multi', 'database', 'postgres')).toBe(true);
    expect(registry.supportsEngine('multi', 'database', 'mysql')).toBe(false);
    expect(registry.supportsEngine('multi', 'cache', 'redis')).toBe(true);
  });

  it('rejects duplicate ids instead of silently replacing an adapter', () => {
    const registry = new ProviderRegistry();
    registry.register(provider('acme', 'deployment'));
    expect(() => registry.register(provider('acme', 'database')))
      .toThrow('already registered');
  });

  it('does not treat every deployment-category integration as a hosting lifecycle', () => {
    const registry = new ProviderRegistry();
    const repository = provider('repository', 'deployment');
    delete repository.metadata.lifecycle?.hosting;
    registry.register(repository);

    expect(registry.supports('repository', 'hosting')).toBe(false);
    expect(registry.namesFor('hosting')).toEqual([]);
  });

  it('rejects database lifecycle support without complete provider-owned inventory', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('incomplete-db', 'database');
    delete incomplete.inspection;

    expect(() => registry.register(incomplete)).toThrow(/database lifecycle support without/i);
  });

  it('rejects hosting lifecycle support without provider-owned environment inventory', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('incomplete-host', 'deployment');
    delete incomplete.inspection;

    expect(() => registry.register(incomplete)).toThrow(/hosting lifecycle support without/i);
  });

  it('rejects list contracts that do not accept limit', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('bad-limit-db', 'database');
    incomplete.inspection!.selectors = {
      database: {
        ...incomplete.inspection!.selectors.database!,
        optional: ['id', 'name'],
      },
    };

    expect(() => registry.register(incomplete)).toThrow(/accept limit exactly when list=true/i);
  });

  it('rejects cache lifecycle support without complete provider-owned inventory', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('incomplete-cache', 'cache');
    delete incomplete.inspection;

    expect(() => registry.register(incomplete)).toThrow(/cache lifecycle support without/i);
  });

  it('rejects storage lifecycle support without complete provider-owned inventory', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('incomplete-storage', 'storage');
    delete incomplete.inspection;

    expect(() => registry.register(incomplete)).toThrow(/storage lifecycle support without/i);
  });
});
