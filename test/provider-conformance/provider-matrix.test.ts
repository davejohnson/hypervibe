import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import {
  cacheProviderContracts,
  databaseProviderContracts,
  hostingProviderContracts,
  managedWorkflowGitHubCredentials,
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
        expect(['json', 'number', 'boolean', undefined]).toContain(
          credential.parseAs
        );
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

  it('keeps managed-workflow live profiles reviewable, exact, and fixture-backed', () => {
    for (const entry of hostingProviderContracts.filter(
      (provider) => provider.managedWorkflow
    )) {
      expect(entry.status).not.toBe('planned');
      const managed = entry.managedWorkflow!;
      expect(managed.environmentName).toBe('production');
      expect(managed.workflow).toMatch(/^deploy-[a-z0-9-]+-production\.yml$/);
      expect(managed.publicUrlProtocols.length).toBeGreaterThan(0);
      expect(
        managed.publicUrlProtocols.every((protocol) => (
          protocol === 'http:' || protocol === 'https:'
        ))
      ).toBe(true);
      expect(new Set(managed.publicUrlProtocols).size).toBe(
        managed.publicUrlProtocols.length
      );
      expect(new Set(managed.requiredPaths).size).toBe(
        managed.requiredPaths.length
      );
      expect(managed.requiredPaths).toContain('.hypervibe/spec.json');
      for (const requiredPath of managed.requiredPaths.filter(
        (requiredPath) => requiredPath !== '.hypervibe/spec.json'
      )) {
        expect(
          existsSync(path.join(
            import.meta.dirname,
            '../..',
            managed.fixtureDirectory,
            requiredPath
          ))
        ).toBe(true);
      }
    }
    for (const credential of managedWorkflowGitHubCredentials) {
      expect(credential.environmentVariable).toMatch(
        environmentVariablePattern
      );
      expect(credential).not.toHaveProperty('value');
    }
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

  it('allows live candidates only after the installed registry exposes that lifecycle', () => {
    const implemented = new Set(['ready-for-live', 'supported']);
    for (const entry of hostingProviderContracts.filter((provider) => implemented.has(provider.status))) {
      expect(providerRegistry.supports(entry.provider, 'hosting')).toBe(true);
    }
    for (const entry of databaseProviderContracts.filter((provider) => implemented.has(provider.status))) {
      expect(providerRegistry.supportsEngine(entry.provider, 'database', entry.engine)).toBe(true);
    }
    for (const entry of cacheProviderContracts.filter((provider) => implemented.has(provider.status))) {
      expect(providerRegistry.supportsEngine(entry.provider, 'cache', entry.engine)).toBe(true);
    }
  });

  it('tracks the implemented DigitalOcean slice without claiming live support', () => {
    const entries = providerContracts.filter(
      (entry) => entry.provider === 'digitalocean'
    );

    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.status === 'planned')).toBe(true);
    expect(entries.every((entry) => entry.implementationNote?.includes('implemented'))).toBe(true);
    expect(providerRegistry.supports('digitalocean', 'hosting')).toBe(true);
    expect(
      providerRegistry.supportsEngine('digitalocean', 'database', 'postgres')
    ).toBe(true);
    expect(
      providerRegistry.supportsEngine('digitalocean', 'cache', 'redis')
    ).toBe(true);
  });

  it('tracks the implemented Render slice without claiming live support', () => {
    const entries = providerContracts.filter(
      (entry) => entry.provider === 'render'
    );

    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.status === 'planned')).toBe(true);
    expect(entries.every((entry) => entry.implementationNote?.includes('implemented'))).toBe(true);
    expect(providerRegistry.supports('render', 'hosting')).toBe(true);
    expect(
      providerRegistry.supportsEngine('render', 'database', 'postgres')
    ).toBe(true);
    expect(
      providerRegistry.supportsEngine('render', 'cache', 'redis')
    ).toBe(true);
  });

  it('tracks the implemented Heroku hosting slice without claiming live support', () => {
    const entry = hostingProviderContracts.find(
      (provider) => provider.provider === 'heroku'
    );

    expect(entry).toMatchObject({
      status: 'planned',
      implementationNote: expect.stringContaining('implemented'),
    });
    expect(providerRegistry.supports('heroku', 'hosting')).toBe(true);
  });

  it('exposes the implemented Azure hosting slice to the managed-workflow live gate', () => {
    const entry = hostingProviderContracts.find(
      (provider) => provider.provider === 'azure-container-apps'
    );

    expect(entry).toMatchObject({
      status: 'ready-for-live',
      implementationNote: expect.stringContaining('implemented'),
      credentials: expect.arrayContaining([
        expect.objectContaining({ field: 'registryId' }),
        expect.objectContaining({ field: 'registryServer' }),
      ]),
      managedWorkflow: {
        environmentName: 'production',
        fixtureDirectory: 'test/provider-conformance/fixture',
        workflow: 'deploy-azure-container-apps-production.yml',
        publicUrlProtocols: ['https:'],
        serviceName: 'web',
        service: {
          workloadKind: 'web',
          startCommand: 'node server.mjs',
          healthCheckPath: '/health',
          public: true,
        },
      },
    });
    expect(providerRegistry.supports('azure-container-apps', 'hosting')).toBe(
      true
    );
  });

  it('exposes the implemented Vercel slice only to the managed-workflow live gate', () => {
    const entry = hostingProviderContracts.find(
      (provider) => provider.provider === 'vercel'
    );

    expect(entry).toMatchObject({
      status: 'ready-for-live',
      implementationNote: expect.stringContaining('implemented'),
      credentials: expect.arrayContaining([
        expect.objectContaining({ field: 'accessToken' }),
        expect.objectContaining({ field: 'teamId', optional: true }),
      ]),
      managedWorkflow: {
        environmentName: 'production',
        workflow: 'deploy-vercel-production.yml',
        publicUrlProtocols: ['https:'],
        serviceName: 'web',
        service: {
          workloadKind: 'web',
          healthCheckPath: '/api/health',
          public: true,
        },
      },
    });
    expect(providerRegistry.supports('vercel', 'hosting')).toBe(true);
  });

  it('exposes the implemented AWS ECS hosting slice to the managed-workflow live gate', () => {
    const entry = hostingProviderContracts.find(
      (provider) => provider.provider === 'ecs'
    );

    expect(entry).toMatchObject({
      status: 'ready-for-live',
      implementationNote: expect.stringContaining('implemented'),
      credentials: expect.arrayContaining([
        expect.objectContaining({ field: 'ecrRepositoryArn' }),
        expect.objectContaining({ field: 'ecrRepositoryUri' }),
        expect.objectContaining({ field: 'subnetIds', parseAs: 'json' }),
        expect.objectContaining({ field: 'securityGroupIds', parseAs: 'json' }),
        expect.objectContaining({ field: 'executionRoleArn' }),
        expect.objectContaining({ field: 'targetGroupArn' }),
        expect.objectContaining({ field: 'publicUrl', optional: true }),
      ]),
      managedWorkflow: {
        environmentName: 'production',
        fixtureDirectory: 'test/provider-conformance/fixture',
        workflow: 'deploy-ecs-production.yml',
        publicUrlProtocols: ['http:', 'https:'],
        serviceName: 'web',
        service: {
          workloadKind: 'web',
          startCommand: 'node server.mjs',
          healthCheckPath: '/health',
          public: true,
        },
      },
    });
    expect(providerRegistry.supports('ecs', 'hosting')).toBe(true);
  });
});
