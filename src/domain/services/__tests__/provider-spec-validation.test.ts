import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { validateProjectSpecProviders } from '../provider-spec-validation.js';

function spec(hosting: string, database?: string, cache?: string) {
  return projectSpecSchema.parse({
    version: 1,
    project: 'provider-contract',
    environments: {
      staging: {
        hosting: { provider: hosting },
        services: {},
        ...(database ? { database: { provider: database } } : {}),
        ...(cache ? { cache: { provider: cache } } : {}),
      },
    },
  });
}

describe('validateProjectSpecProviders', () => {
  it('accepts installed primary and derived lifecycle adapters', () => {
    expect(validateProjectSpecProviders(spec('railway', 'railway'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('cloudrun', 'cloudsql'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('railway', undefined, 'railway'))).toEqual([]);
  });

  it('reports unknown capabilities with the exact spec path and available providers', () => {
    const issues = validateProjectSpecProviders(spec('missing-host', 'missing-db', 'missing-cache'));
    expect(issues).toEqual([
      expect.objectContaining({
        field: 'hosting.provider',
        provider: 'missing-host',
        capability: 'hosting',
      }),
      expect.objectContaining({
        field: 'database.provider',
        provider: 'missing-db',
        capability: 'database',
      }),
      expect.objectContaining({
        field: 'cache.provider',
        provider: 'missing-cache',
        capability: 'cache',
      }),
    ]);
    expect(issues[0].available).toContain('railway');
    expect(issues[1].available).toContain('supabase');
    expect(issues[2].available).toContain('railway');
  });

  it('rejects an engine the selected provider cannot reconcile', () => {
    const candidate = projectSpecSchema.parse({
      version: 1,
      project: 'provider-contract',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {},
          database: { provider: 'cloudsql', engine: 'mongodb' },
        },
      },
    });
    expect(validateProjectSpecProviders(candidate)).toEqual([
      expect.objectContaining({
        field: 'database.engine',
        provider: 'cloudsql',
        engine: 'mongodb',
        available: ['postgres'],
      }),
    ]);
  });
});
