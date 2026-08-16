import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { planProviderNativeDeploySources } from '../../src/domain/services/provider-native-deploy-source.service.js';
import { credentialFieldsFromSchema } from '../../src/domain/services/connection-guidance.js';
import { environmentSpecSchema, projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
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
  it('keeps a daily deterministic check and independent provider-truth audit in desired state', () => {
    const repositorySpec = projectSpecSchema.parse(JSON.parse(readFileSync(
      path.resolve('.hypervibe/spec.json'),
      'utf8'
    )));
    const actions = repositorySpec.github?.actions ?? {};

    expect(actions['provider-conformance']).toMatchObject({
      kind: 'check',
      triggers: { schedule: { cron: expect.any(String) } },
      commands: ['npm test -- test/provider-conformance/provider-matrix.test.ts'],
    });
    expect(actions['provider-truth']).toMatchObject({
      kind: 'code-audit',
      schedule: { cron: expect.any(String) },
      documentationDomains: expect.arrayContaining([
        'docs.railway.com',
        'cloud.google.com',
        'docs.aws.amazon.com',
        'learn.microsoft.com',
        'docs.digitalocean.com',
        'vercel.com',
      ]),
    });
    const instructions = actions['provider-truth'].kind === 'code-audit'
      ? actions['provider-truth'].instructions
      : '';
    expect(instructions).toContain('providerContracts');
    expect(instructions).toContain('providerRegistry');
    expect(instructions).toContain('ready-for-live');
    expect(instructions).toContain('live-conformance evidence');
  });

  it('covers the requested hosting providers', () => {
    expect(hostingProviderContracts.map((entry) => entry.vendor)).toEqual([
      'Railway',
      'Google Cloud',
      'AWS',
      'Microsoft Azure',
      'DigitalOcean',
      'Vercel',
    ]);
  });

  it('keeps maintenance live promotion distinct from implemented adapter support', () => {
    expect(
      hostingProviderContracts.find((entry) => entry.provider === 'vercel')
    ).toMatchObject({ maintenance: 'ready-for-live' });
    for (const contract of hostingProviderContracts) {
      const lifecycle = providerRegistry.getMetadata(contract.provider)
        ?.lifecycle?.hosting?.maintenance;
      expect(lifecycle, contract.provider).toBe(
        contract.maintenance === 'unsupported' ? 'unsupported' : 'managed'
      );
    }
  });

  it('pins environment custom-domain support to provider lifecycle metadata', () => {
    for (const contract of hostingProviderContracts) {
      expect(
        providerRegistry.getMetadata(contract.provider)?.lifecycle?.hosting?.customDomains,
        contract.provider
      ).toBe(contract.customDomains);
      expect(
        providerRegistry.getMetadata(contract.provider)?.lifecycle?.hosting?.domainTrafficProxy ?? 'supported',
        contract.provider
      ).toBe(contract.domainTrafficProxy);
    }
    expect(providerRegistry.supports('github', 'hosting')).toBe(false);
    expect(hostingProviderContracts.filter((entry) => entry.customDomains === 'managed').map((entry) => entry.provider))
      .toEqual(['railway', 'cloudrun', 'ecs', 'azure-container-apps', 'digitalocean', 'vercel']);
  });

  it('keeps one isolated DNS-only domain fixture for every hosting provider', () => {
    const fixture = projectSpecSchema.parse(JSON.parse(readFileSync(
      path.resolve('test/provider-conformance/domain-lifecycle.spec.json'),
      'utf8'
    )));
    const environments = Object.values(fixture.environments);

    expect(environments.map((environment) => environment.hosting.provider)).toEqual(
      hostingProviderContracts.map((contract) => contract.provider)
    );
    expect(new Set(environments.map((environment) => environment.domain)).size).toBe(environments.length);
    for (const environment of environments) {
      expect(environment.domain).toMatch(/\.domain-test\.hypervibe\.dev$/);
      expect(environment.domainProxy).toBe(false);
      expect(environment.services.web).toMatchObject({ public: true });
    }
  });

  it('declares and enforces non-native source ownership for every applicable hosting provider', () => {
    const expectedPolicies = {
      railway: 'disconnect',
      digitalocean: 'block',
      vercel: 'block',
    } as const;

    for (const contract of hostingProviderContracts) {
      const metadata = providerRegistry.getMetadata(contract.provider);
      const policy = metadata?.orchestration?.nativeBranchDeploy?.nonNativeSourcePolicy;
      const expected = expectedPolicies[contract.provider as keyof typeof expectedPolicies];
      expect(policy, contract.provider).toBe(expected);
      if (!expected) continue;

      const result = planProviderNativeDeploySources({
        environmentSpec: environmentSpecSchema.parse({
          hosting: { provider: contract.provider },
          services: { web: {} },
          deploy: { strategy: 'manual' },
        }),
        observed: {
          provider: contract.provider,
          observedAt: '2026-08-04T00:00:00.000Z',
          projectExists: true,
          services: [{
            name: 'web',
            externalId: `${contract.provider}-web`,
            workloadKind: 'web',
            customDomains: [],
            config: {},
            source: { repo: 'example/app', branch: 'main' },
            sourceState: 'connected',
            envVarKeys: [],
            envVarHashes: {},
            status: 'running',
          }],
          databases: [],
          completeness: { services: 'complete' },
          partial: false,
          warnings: [],
        },
        providerDisplayName: metadata?.displayName ?? contract.provider,
        nonNativeSourcePolicy: policy,
      });

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject({
        resource: { provider: contract.provider },
        metadata: {
          operation: 'providerNativeDeploySourceDisconnect',
          desiredDeployMode: 'manual',
          ...(expected === 'block'
            ? { blockedReason: 'provider_native_deploy_source_requires_manual_disconnect' }
            : {}),
        },
      });
    }
  });

  it('covers the retained PostgreSQL providers', () => {
    expect(databaseProviderContracts.map((entry) => [entry.vendor, entry.engine])).toEqual([
      ['Google Cloud', 'postgres'],
      ['DigitalOcean', 'postgres'],
      ['AWS', 'postgres'],
      ['Railway', 'postgres'],
      ['Supabase', 'postgres'],
      ['Microsoft Azure', 'postgres'],
      ['Neon', 'postgres'],
    ]);
  });

  it('models Redis separately from PostgreSQL databases', () => {
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

  it('excludes Upstash from the provider catalog', () => {
    expect(
      providerContracts.some((entry) => entry.provider === 'upstash')
    ).toBe(false);
  });

  it('keeps Memorystore live promotion blocked on declarative Cloud Run VPC egress', () => {
    const memorystore = cacheProviderContracts.find(
      (entry) => entry.provider === 'memorystore'
    );
    expect(memorystore).toMatchObject({
      status: 'planned',
      fixtureHostingProvider: 'cloudrun',
    });
    expect(memorystore?.implementationNote).toContain(
      'declaratively attach VPC egress'
    );
  });

  it('keeps ElastiCache live promotion blocked without a declarative AWS workload network', () => {
    expect(
      cacheProviderContracts.find((entry) => entry.provider === 'elasticache')
    ).toMatchObject({
      status: 'planned',
      engine: 'redis',
      fixtureHostingProvider: 'railway',
    });
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

  it('keeps deliberately excluded providers out of the lifecycle catalog and registry', () => {
    const excluded = new Set([
      'heroku',
      'render',
      'fly',
      'fly-managed-postgres',
    ]);
    expect(providerContracts.some((entry) => excluded.has(entry.provider))).toBe(false);
    expect(providerRegistry.supports('heroku', 'hosting')).toBe(false);
    expect(providerRegistry.supports('render', 'hosting')).toBe(false);
    expect(providerRegistry.supportsEngine('render', 'database', 'postgres')).toBe(false);
    expect(providerRegistry.supportsEngine('render', 'cache', 'redis')).toBe(false);
    expect(providerRegistry.supports('ecs', 'hosting')).toBe(true);
    expect(providerRegistry.supports('azure-container-apps', 'hosting')).toBe(true);
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

  it('keeps hosting geography in desired state instead of credentials', () => {
    for (const entry of hostingProviderContracts) {
      expect(entry.credentials.map(({ field }) => field), entry.provider)
        .not.toEqual(expect.arrayContaining(['region', 'location', 'appRegion']));
      const schema = providerRegistry.getMetadata(entry.provider)?.credentialsSchema;
      expect(schema, entry.provider).toBeDefined();
      expect(credentialFieldsFromSchema(schema!)?.map(({ name }) => name), entry.provider)
        .not.toEqual(expect.arrayContaining(['region', 'location', 'appRegion']));
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
      if (managed.database) {
        const database = databaseProviderContracts.find((entry) => (
          entry.provider === managed.database!.provider
          && entry.engine === managed.database!.engine
        ));
        expect(database).toMatchObject({
          provider: managed.database.provider,
          engine: managed.database.engine,
        });
        expect(database?.status).not.toBe('planned');
      }
      if (managed.cache) {
        const cache = cacheProviderContracts.find((entry) => (
          entry.provider === managed.cache!.provider
          && entry.engine === managed.cache!.engine
        ));
        expect(cache).toMatchObject({
          provider: managed.cache.provider,
          engine: managed.cache.engine,
        });
        expect(cache?.status).not.toBe('planned');
      }
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

  it('exposes the complete DigitalOcean stack to the managed-workflow live gate', () => {
    const entries = providerContracts.filter(
      (entry) => entry.provider === 'digitalocean'
    );
    const hosting = entries.find((entry) => entry.kind === 'hosting');

    expect(entries).toHaveLength(3);
    expect(hosting).toMatchObject({
      status: 'ready-for-live',
      managedWorkflow: {
        environmentName: 'production',
        fixtureDirectory: 'test/provider-conformance/fixture',
        workflow: 'deploy-digitalocean-production.yml',
        publicUrlProtocols: ['https:'],
        serviceName: 'web',
        service: {
          workloadKind: 'web',
          startCommand: 'node server.mjs',
          healthCheckPath: '/health',
          public: true,
        },
        database: {
          provider: 'digitalocean',
          engine: 'postgres',
        },
        cache: {
          provider: 'digitalocean',
          engine: 'redis',
        },
      },
    });
    expect(
      entries.every((entry) => entry.status === 'ready-for-live')
    ).toBe(true);
    expect(entries.every((entry) => entry.implementationNote?.includes('implemented'))).toBe(true);
    expect(providerRegistry.supports('digitalocean', 'hosting')).toBe(true);
    expect(
      providerRegistry.supportsEngine('digitalocean', 'database', 'postgres')
    ).toBe(true);
    expect(
      providerRegistry.supportsEngine('digitalocean', 'cache', 'redis')
    ).toBe(true);
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

});
