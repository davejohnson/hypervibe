import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import {
  firstProviderSpecValidationFailure,
  validateProjectSpecProviders,
} from '../provider-spec-validation.js';

// Synthetic metadata exercises the generic workload validator independently of clouds.
const hostingFixture = providerRegistry.get('cloudrun')!;
providerRegistry.register({ ...hostingFixture, metadata: { ...hostingFixture.metadata, name: 'fixture-web-hosting',
  lifecycle: { hosting: { workloadKinds: ['web'], customDomains: 'unsupported', teardownBoundary: 'services' } },
  maturity: { lifecycle: { hosting: { status: 'ready-for-live' } } } } });

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

function storageSpec(provider: string) {
  return projectSpecSchema.parse({
    version: 1,
    project: 'provider-storage-contract',
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: {},
        storage: {
          uploads: {
            provider,
            type: 'bucket',
            region: provider === 'railway' ? 'iad' : 'us-east-1',
            injectInto: [],
          },
        },
      },
    },
  });
}

function infrastructureSpec(params: { hosting: string; loadBalancer?: string; queues?: boolean }) {
  return projectSpecSchema.parse({
    version: 1,
    project: 'provider-infrastructure-contract',
    environments: {
      staging: {
        hosting: { provider: params.hosting },
        services: {
          api: { workloadKind: 'web', public: true },
          fallback: { workloadKind: 'web', public: true },
        },
        ...(params.queues && params.hosting === 'railway'
          ? { database: { provider: 'railway' } }
          : {}),
        ...(params.queues ? { queues: { jobs: {} } } : {}),
        ...(params.loadBalancer
          ? {
              domain: 'api.example.com',
              loadBalancer: {
                provider: params.loadBalancer,
                services: ['api', 'fallback'],
              },
            }
          : {}),
      },
    },
  });
}

function workloadSpec(provider: string, workloadKind: 'web' | 'worker' | 'cron') {
  return projectSpecSchema.parse({
    version: 1,
    project: 'provider-workload-contract',
    environments: {
      staging: {
        hosting: { provider },
        services: {
          processor: {
            workloadKind,
            ...(workloadKind === 'cron'
              ? { startCommand: 'npm run scheduled', cronSchedule: '0 * * * *' }
              : {}),
          },
        },
      },
    },
  });
}

describe('validateProjectSpecProviders', () => {
  it('scopes validation to the requested environment so another environment cannot block it', () => {
    const candidate = projectSpecSchema.parse({ version: 1, project: 'provider-contract', environments: {
      production: { hosting: { provider: 'railway' }, services: {} },
      gcp: { hosting: { provider: 'cloudrun' }, services: {} },
    } });
    expect(firstProviderSpecValidationFailure(candidate)).toMatchObject({ details: { path: 'environments.gcp.hosting.provider' } });
    expect(firstProviderSpecValidationFailure(candidate, 'production')).toBeUndefined();
    expect(firstProviderSpecValidationFailure(candidate, 'gcp')).toMatchObject({ details: { maturityStatus: 'planned' } });
  });
  it.each(['cloudrun', 'ecs', 'azure-container-apps'])('reports %s as awaiting engine integration, not an unknown provider', provider => {
    expect(firstProviderSpecValidationFailure(spec(provider))).toMatchObject({
      message: expect.stringContaining('is planned'),
      hint: expect.stringContaining('OpenTofu'),
      details: { maturityStatus: 'planned', path: 'environments.staging.hosting.provider' },
    });
  });

  it('keeps Railway volume lifecycle available while cloud provisioning awaits the engine', () => {
    expect(providerRegistry.namesFor('hosting').filter(name => name !== 'fixture-web-hosting')).toEqual(['railway']);
    const candidate = workloadSpec('railway', 'web');
    candidate.environments.staging.services.processor.volume = { mountPath: '/data' };
    expect(firstProviderSpecValidationFailure(candidate)).toBeUndefined();
  });

  it('accepts Railway primary and derived lifecycle adapters', () => {
    expect(validateProjectSpecProviders(spec('railway', 'railway', 'railway'))).toEqual([]);
  });

  it('accepts all retained Railway workload kinds', () => {
    for (const kind of ['web', 'worker', 'cron'] as const) {
      expect(validateProjectSpecProviders(workloadSpec('railway', kind))).toEqual([]);
    }
  });

  it('keeps unsupported workload kinds distinct from missing lifecycle implementations', () => {
    expect(firstProviderSpecValidationFailure(workloadSpec('fixture-web-hosting', 'worker'))).toMatchObject({
      message: expect.stringContaining('does not support workload kind "worker"'),
      details: { path: 'environments.staging.services.processor.workloadKind', capability: 'hosting', service: 'processor', workloadKind: 'worker' },
    });
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
    expect(issues[1].available).toContain('railway');
    expect(issues[2].available).toContain('railway');
  });

  it('enforces Railway datastore hosting boundaries', () => {
    for (const capability of ['database', 'cache'] as const) {
      const candidate = capability === 'database' ? spec('cloudrun', 'railway') : spec('cloudrun', undefined, 'railway');
      expect(validateProjectSpecProviders(candidate)).toContainEqual(expect.objectContaining({
        field: capability + '.provider', provider: 'railway', capability, incompatibleHostingProvider: 'cloudrun', available: ['railway'],
      }));
    }
    expect(validateProjectSpecProviders(spec('railway', 'railway', 'railway'))).toEqual([]);
  });

  it('validates storage provider lifecycle maturity', () => {
    expect(firstProviderSpecValidationFailure(storageSpec('s3'))).toMatchObject({ details: { maturityStatus: 'planned' } });
    expect(validateProjectSpecProviders(storageSpec('missing-storage'))).toContainEqual(
      expect.objectContaining({
        field: 'storage.provider',
        provider: 'missing-storage',
        capability: 'storage',
      })
    );
  });

  it('validates queue lifecycle through hosting-provider metadata', () => {
    expect(validateProjectSpecProviders(infrastructureSpec({ hosting: 'cloudrun', queues: true }))).toContainEqual(expect.objectContaining({ field: 'queues', provider: 'cloudrun', capability: 'queue' }));
    expect(validateProjectSpecProviders(infrastructureSpec({ hosting: 'railway', queues: true }))).toEqual([]);
    expect(validateProjectSpecProviders(infrastructureSpec({ hosting: 'ecs', queues: true }))).toContainEqual(
      expect.objectContaining({ field: 'queues', provider: 'ecs', capability: 'queue' })
    );
  });

  it('enforces application-managed PostgreSQL queue constraints through lifecycle metadata', () => {
    const withoutDatabase = projectSpecSchema.parse({
      version: 1,
      project: 'postgres-queue-without-database',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {},
          queues: { jobs: {} },
        },
      },
    });
    expect(firstProviderSpecValidationFailure(withoutDatabase)).toMatchObject({
      message: expect.stringContaining('require a declared PostgreSQL database'),
      details: {
        path: 'environments.staging.queues',
        capability: 'queue',
      },
    });

    const unsupportedOption = projectSpecSchema.parse({
      version: 1,
      project: 'postgres-queue-ack-deadline',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          database: { provider: 'railway' },
          services: {},
          queues: { jobs: { ackDeadlineSeconds: 120 } },
        },
      },
    });
    expect(firstProviderSpecValidationFailure(unsupportedOption)).toMatchObject({
      message: expect.stringContaining('do not support ackDeadlineSeconds'),
      hint: expect.stringContaining('available only for provider-managed Pub/Sub queues'),
      details: {
        path: 'environments.staging.queues.jobs.ackDeadlineSeconds',
        capability: 'queue',
      },
    });

    const managedPubSub = projectSpecSchema.parse({
      version: 1,
      project: 'managed-pubsub-ack-deadline',
      environments: {
        staging: {
          hosting: { provider: 'cloudrun' },
          services: {},
          queues: { jobs: { ackDeadlineSeconds: 120 } },
        },
      },
    });
    expect(validateProjectSpecProviders(managedPubSub)).toContainEqual(expect.objectContaining({ field: 'queues', provider: 'cloudrun', capability: 'queue' }));
  });

  it('validates provider-managed load-balancer lifecycle independently of hosting', () => {
    expect(validateProjectSpecProviders(infrastructureSpec({
      hosting: 'railway',
      loadBalancer: 'cloudflare',
    }))).toEqual([]);
    expect(validateProjectSpecProviders(infrastructureSpec({
      hosting: 'railway',
      loadBalancer: 'missing-edge',
    }))).toContainEqual(expect.objectContaining({
      field: 'loadBalancer.provider',
      provider: 'missing-edge',
      capability: 'load-balancer',
    }));
  });


});
