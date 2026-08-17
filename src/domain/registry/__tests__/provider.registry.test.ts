import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderRegistry, type RegisteredProvider } from '../provider.registry.js';

function provider(
  name: string,
  category: RegisteredProvider['metadata']['category'],
  derivedAdapters?: RegisteredProvider['derivedAdapters']
): RegisteredProvider {
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
        ...(category === 'database' || derivedAdapters?.database
          ? { databaseEngines: ['postgres'] }
          : {}),
        ...(category === 'cache' || derivedAdapters?.cache
          ? { cacheEngines: ['redis'] }
          : {}),
      },
    },
    factory: () => ({}),
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
});
