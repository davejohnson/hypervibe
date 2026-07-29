import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import {
  cacheProviderContracts,
  databaseProviderContracts,
  hostingProviderContracts,
  providerContracts,
} from './provider-matrix.js';

const providerIdPattern = /^[a-z][a-z0-9-]*$/;
const environmentVariablePattern = /^[A-Z][A-Z0-9_]*$/;

describe('provider conformance matrix', () => {
  it('covers the requested hosting providers', () => {
    expect(hostingProviderContracts.map((entry) => entry.vendor)).toEqual([
      'Railway',
      'Google Cloud',
      'DigitalOcean',
      'AWS',
      'Heroku',
      'Render',
      'Microsoft Azure',
      'Fly.io',
      'Vercel',
    ]);
  });

  it('covers the requested Postgres and MongoDB providers', () => {
    expect(databaseProviderContracts.map((entry) => [entry.vendor, entry.engine])).toEqual([
      ['Google Cloud', 'postgres'],
      ['DigitalOcean', 'postgres'],
      ['AWS', 'postgres'],
      ['Railway', 'postgres'],
      ['Render', 'postgres'],
      ['Supabase', 'postgres'],
      ['MongoDB', 'mongodb'],
      ['Microsoft Azure', 'postgres'],
      ['Fly.io', 'postgres'],
      ['Neon', 'postgres'],
    ]);
  });

  it('models Redis separately from SQL and document databases', () => {
    expect(cacheProviderContracts.length).toBeGreaterThan(0);
    expect(cacheProviderContracts.every((entry) => entry.engine === 'redis')).toBe(true);
    expect(databaseProviderContracts.some((entry) => entry.engine === 'redis')).toBe(false);
  });

  it('includes Azure Managed Redis in the cache lifecycle matrix', () => {
    expect(cacheProviderContracts).toContainEqual(
      expect.objectContaining({
        provider: 'azure-managed-redis',
        vendor: 'Microsoft Azure',
        engine: 'redis',
      })
    );
  });

  it('assigns database lifecycle to the provider that owns the resource', () => {
    expect(hostingProviderContracts).toContainEqual(
      expect.objectContaining({ provider: 'vercel', kind: 'hosting' })
    );
    expect(databaseProviderContracts.some((entry) => entry.provider === 'vercel')).toBe(false);
    expect(databaseProviderContracts).toContainEqual(
      expect.objectContaining({ provider: 'neon', engine: 'postgres' })
    );
    expect(hostingProviderContracts.some((entry) => entry.provider === 'neon')).toBe(false);
  });

  it('gates Fly Managed Postgres on a supported provider lifecycle API', () => {
    const flyPostgres = databaseProviderContracts.find(
      (entry) => entry.provider === 'fly-managed-postgres'
    );
    expect(flyPostgres?.status).toBe('planned');
    expect(flyPostgres?.implementationNote).toContain('supported provider lifecycle API');
    expect(flyPostgres?.implementationNote).toContain('Do not implement against flyctl');
  });

  it('uses stable provider ids and secret-free credential descriptors', () => {
    for (const entry of providerContracts) {
      expect(entry.provider).toMatch(providerIdPattern);
      expect(entry.credentials.length).toBeGreaterThan(0);
      for (const credential of entry.credentials) {
        expect(credential.field).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
        expect(credential.environmentVariable).toMatch(environmentVariablePattern);
        expect(credential).not.toHaveProperty('value');
      }
    }
  });

  it('does not duplicate a provider-engine contract within one resource kind', () => {
    const identities = providerContracts.map((entry) => (
      `${entry.kind}:${entry.provider}:${'engine' in entry ? entry.engine : 'hosting'}`
    ));
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('names a hosting fixture for every live datastore contract', () => {
    const hostingIds = new Set(hostingProviderContracts.map((entry) => entry.provider));
    for (const entry of [...databaseProviderContracts, ...cacheProviderContracts]) {
      expect(hostingIds.has(entry.fixtureHostingProvider)).toBe(true);
    }
  });

  it('does not call a datastore supported when its fixture hosting is still planned', () => {
    const hostingStatus = new Map(
      hostingProviderContracts.map((entry) => [entry.provider, entry.status])
    );
    for (const entry of [...databaseProviderContracts, ...cacheProviderContracts]) {
      if (entry.status !== 'supported') continue;
      expect(hostingStatus.get(entry.fixtureHostingProvider)).toBe('supported');
    }
  });

  it('marks providers supported only when the installed registry exposes that lifecycle', () => {
    for (const entry of hostingProviderContracts.filter((provider) => provider.status === 'supported')) {
      expect(providerRegistry.supports(entry.provider, 'hosting')).toBe(true);
    }
    for (const entry of databaseProviderContracts.filter((provider) => provider.status === 'supported')) {
      expect(providerRegistry.supportsEngine(entry.provider, 'database', entry.engine)).toBe(true);
    }
    for (const entry of cacheProviderContracts.filter((provider) => provider.status === 'supported')) {
      expect(providerRegistry.supportsEngine(entry.provider, 'cache', entry.engine)).toBe(true);
    }
  });
});
