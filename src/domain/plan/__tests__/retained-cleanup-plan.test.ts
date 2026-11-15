import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../../adapters/providers/gcp/cloudsql.adapter.js';
import '../../../adapters/providers/aws/ecs-express.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import type { ObservedState } from '../../ports/observe.port.js';
import type { Project } from '../../entities/project.entity.js';
import { PlanService } from '../plan.service.js';
import { CACHE_OPERATIONS } from '../../services/cache-plan.service.js';
import { providerRegistry, standardDatabaseRuntimeProjection } from '../../registry/provider.registry.js';
import { z } from 'zod';

// Synthetic lifecycle owners exercise shared safety without restoring cloud CRUD.
for (const [name, teardownBoundary] of [['fixture-hosting', 'services'], ['fixture-project-hosting', 'project']] as const) {
  providerRegistry.register({
    metadata: {
      name, displayName: `Synthetic ${name}`, category: 'deployment', credentialsSchema: z.object({}),
      lifecycle: { hosting: { workloadKinds: ['web', 'worker', 'cron'], customDomains: 'unsupported', teardownBoundary } },
      maturity: { lifecycle: { hosting: { status: 'ready-for-live' } } },
    },
    inspection: {
      resources: ['environment'], defaultResource: 'environment',
      selectors: { environment: { mode: 'environment-forensics', optional: ['project', 'env', 'limit'], list: true } },
      inspect: async () => { throw new Error('Synthetic inventory requires explicit observations.'); },
    },
    factory: () => { throw new Error('Synthetic hosting requires an explicit test adapter.'); },
  });
}
for (const [name, hosting] of [['fixture-database', 'fixture-hosting']] as const) {
  providerRegistry.register({
    metadata: {
      name, displayName: `Synthetic ${name}`, category: 'database', credentialsSchema: z.object({}),
      lifecycle: { databaseEngines: ['postgres'], databaseConnectivity: { compatibleHostingProviders: [hosting] } },
      maturity: { lifecycle: { database: { status: 'ready-for-live' } } },
    },
    inspection: {
      resources: ['database', 'backup'], defaultResource: 'database',
      selectors: {
        database: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId'], collectionKey: 'databases' },
        backup: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId'], collectionKey: 'backups' },
      },
      inspect: (adapter, request) => (adapter as { inspectBackupResources: (request: unknown) => Promise<Record<string, unknown>> }).inspectBackupResources(request),
    },
    databaseRuntime: standardDatabaseRuntimeProjection,
    retainedCleanup: {
      resources: ['backup'],
      destroy: (adapter, target) => (adapter as { destroyRetainedBackup: (target: unknown) => Promise<{ success: boolean; message: string }> }).destroyRetainedBackup(target),
    },
    factory: () => { throw new Error('Synthetic database requires an explicit test adapter.'); },
  });
}
for (const [name, hosting] of [['fixture-cache', 'fixture-hosting']] as const) {
  providerRegistry.register({
    metadata: {
      name, displayName: `Synthetic ${name}`, category: 'cache', credentialsSchema: z.object({}),
      lifecycle: { cacheEngines: ['redis'], cacheConnectivity: { compatibleHostingProviders: [hosting] } },
      maturity: { lifecycle: { cache: { status: 'ready-for-live' } } },
    },
    inspection: {
      resources: ['cache'], defaultResource: 'cache',
      selectors: { cache: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId'], collectionKey: 'caches' } },
      inspect: async () => { throw new Error('Synthetic inventory requires explicit observations.'); },
    },
    factory: () => { throw new Error('Synthetic cache requires an explicit test adapter.'); },
  });
}

const originalCwd = process.cwd();
let project: Project;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-retained-cleanup-plan-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  project = new ProjectRepository().create({
    name: 'retained-cleanup-plan-test',
    defaultPlatform: 'railway',
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

type PreviousHosting = {
  provider: string;
  projectId?: string;
  environmentId?: string;
  services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
};

type ExpectedCleanupAction = {
  id: string;
  kind: 'service' | 'environment' | 'project';
  name: string;
  provider: string;
  metadata: Record<string, unknown>;
  dependsOn?: string[];
};

function mockCurrentHostingObservation(provider: string, startCommand = 'npm start'): void {
  const observed: ObservedState = {
    provider,
    observedAt: new Date().toISOString(),
    projectExists: true,
    projectId: 'current-project',
    environmentId: 'current-environment',
    services: [{
      name: 'web',
      externalId: 'current-web',
      workloadKind: 'web',
      customDomains: [],
      config: { startCommand },
      sourceState: 'disconnected',
      envVarKeys: [],
      envVarHashes: {},
      status: 'running',
    }],
    databases: [],
    caches: [],
    storage: [],
    completeness: {
      project: 'complete',
      environment: 'complete',
      services: 'complete',
      databases: 'complete',
      caches: 'complete',
      storage: 'complete',
    },
    partial: false,
    warnings: [],
  };

  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
    success: true,
    adapter: {
      name: provider,
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: [],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {},
      verify: async () => ({ success: true }),
      configureTarget: async () => {},
      ensureProject: async () => ({ success: true, message: 'unused' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('unused'); },
      setEnvVars: async () => ({ success: true, message: 'unused' }),
      observe: async () => observed,
    },
  } as never);
}

function arrangeEnvironment(
  currentProvider: string,
  previousHosting?: PreviousHosting,
  observedStartCommand = 'npm start'
): void {
  new SpecStore().replace(project, {
    version: 1,
    project: project.name,
    environments: {
      production: {
        hosting: { provider: currentProvider },
        services: { web: { startCommand: 'npm start' } },
        envVars: {},
      },
    },
  });
  new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: currentProvider,
      projectId: 'current-project',
      environmentId: 'current-environment',
      services: { web: { serviceId: 'current-web' } },
      ...(previousHosting ? { previousHosting } : {}),
    },
  });
  new ServiceRepository().create({
    projectId: project.id,
    name: 'web',
    buildConfig: {},
    envVarSpec: {},
  });
  mockCurrentHostingObservation(currentProvider, observedStartCommand);
}

const cleanupOptions = { scope: 'retained-cleanup' } as const;

describe('PlanService retained-cleanup scope', () => {
  it.each([
    ['service filter', { serviceFilter: ['web'] }],
    ['environment variable overrides', { envVarOverrides: { FEATURE_FLAG: 'enabled' } }],
    ['explicit environment file', { envFile: '.env.cleanup' }],
    ['environment-file loading flag', { includeEnvFile: false }],
    ['delegated secret references', { secretRefs: { API_TOKEN: 'env:API_TOKEN' } }],
  ])('rejects incompatible %s instead of silently widening or changing the cleanup plan', async (_label, input) => {
    arrangeEnvironment('railway', {
      provider: 'fixture-hosting',
      projectId: 'old-gcp-project',
      services: { web: { serviceId: 'old-fixture-hosting-web' } },
    });

    const result = await new PlanService().plan(project, 'production', {
      ...cleanupOptions,
      ...input,
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/retained-cleanup/i);
    expect(new RunRepository().findByProjectId(project.id)).toEqual([]);
  });

  it('fails clearly when there is no retained previous-hosting target', async () => {
    arrangeEnvironment('railway');

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/no abandoned hosting provider retained for cleanup/i);
    expect(new RunRepository().findByProjectId(project.id)).toEqual([]);
  });

  it('plans one exact confirmation-gated retained database destroy without unrelated actions', async () => {
    arrangeEnvironment('railway');
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      previousDatabase: {
        provider: 'fixture-database',
        externalId: 'legacy-production-db',
        engine: 'postgres',
        name: 'legacy-production-db',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      },
    });
    const disconnect = vi.fn(async () => {});
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'fixture-database',
        capabilities: {
          supportedDatabases: ['postgres'],
          supportsPooling: false,
          supportsReadReplicas: false,
          supportsPointInTimeRecovery: false,
          serverlessOptimized: false,
        },
        connect: async () => {},
        verify: async () => ({ success: true }),
        disconnect,
        provision: async () => { throw new Error('unused'); },
        observeDatabase: async () => ({
          provider: 'fixture-database',
          engine: 'postgres',
          externalId: 'legacy-production-db',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
          status: 'running',
        }),
        getConnectionUrl: async () => null,
        destroy: async () => { throw new Error('unused'); },
      },
    });

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions).toEqual([expect.objectContaining({
      id: 'database:fixture-database:retained-destroy',
      type: 'destroy',
      resource: { kind: 'database', name: 'postgres', provider: 'fixture-database' },
      verified: true,
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        operation: 'retainedDatabaseDestroy',
        externalId: 'legacy-production-db',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      },
    })]);
    expect(disconnect).toHaveBeenCalledOnce();
    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(document).toMatchObject({ scope: 'retained-cleanup', actions: plan.actions });
  });

  it('plans a retained Railway database destroy with its complete environment scope', async () => {
    arrangeEnvironment('railway');
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      previousDatabase: {
        provider: 'railway',
        externalId: 'retained-railway-db',
        engine: 'postgres',
        name: 'postgres-db',
        resourceKind: 'service',
        providerScope: {
          projectId: 'retained-project',
          environmentId: 'retained-environment',
        },
      },
    });
    const disconnect = vi.fn(async () => {});
    const observeDatabase = vi.fn(async () => ({
      provider: 'railway',
      engine: 'postgres',
      externalId: 'retained-railway-db',
      providerScope: {
        projectId: 'retained-project',
        environmentId: 'retained-environment',
      },
      name: 'postgres-db',
      status: 'running',
    }));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        observeDatabase,
        disconnect,
      },
    } as never);

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions).toEqual([expect.objectContaining({
      id: 'database:railway:retained-destroy',
      verified: true,
      metadata: {
        operation: 'retainedDatabaseDestroy',
        externalId: 'retained-railway-db',
        resourceKind: 'service',
        providerScope: {
          projectId: 'retained-project',
          environmentId: 'retained-environment',
        },
      },
    })]);
    expect(observeDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ id: environment.id }),
      expect.objectContaining({
        bindings: expect.objectContaining({ resourceKind: 'service' }),
      })
    );
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('blocks a legacy project-only retained Railway database before provider observation', async () => {
    arrangeEnvironment('railway');
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      previousDatabase: {
        provider: 'railway',
        externalId: 'retained-railway-db',
        engine: 'postgres',
        name: 'postgres-db',
        providerScope: { projectId: 'retained-project' },
      },
    });
    const getDatabaseAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/environmentId.*re-run hv_inspect.*re-import/i);
    expect(getDatabaseAdapter).not.toHaveBeenCalled();
    expect(new RunRepository().findByProjectId(project.id)).toEqual([]);
  });

  it('plans one exact confirmation-gated retained cache destroy without unrelated actions', async () => {
    arrangeEnvironment('railway');
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      previousCache: {
        provider: 'fixture-cache',
        externalId: 'projects/gcp/locations/us-west1/instances/legacy-cache',
        engine: 'redis',
        providerEngine: 'redis',
        name: 'legacy-cache',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      },
    });
    const disconnect = vi.fn(async () => {});
    vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'fixture-cache',
        capabilities: {
          supportedCaches: ['redis'],
          supportsTls: true,
          supportsHighAvailability: true,
          supportsPersistence: true,
          serverlessOptimized: false,
        },
        connect: async () => {},
        verify: async () => ({ success: true }),
        disconnect,
        provision: async () => { throw new Error('unused'); },
        observeCache: async () => ({
          provider: 'fixture-cache',
          engine: 'redis',
          externalId: 'projects/gcp/locations/us-west1/instances/legacy-cache',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
          name: 'legacy-cache',
          status: 'running',
        }),
        getConnectionUrl: async () => null,
        destroy: async () => { throw new Error('unused'); },
      },
    });

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions).toEqual([expect.objectContaining({
      id: 'cache:fixture-cache:retained-destroy',
      type: 'destroy',
      resource: { kind: 'cache', name: 'redis', provider: 'fixture-cache' },
      verified: true,
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        operation: CACHE_OPERATIONS.retainedDestroy,
        externalId: 'projects/gcp/locations/us-west1/instances/legacy-cache',
        name: 'legacy-cache',
        engine: 'redis',
        providerEngine: 'redis',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      },
    })]);
    expect(disconnect).toHaveBeenCalledOnce();
    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(document).toMatchObject({ scope: 'retained-cleanup', actions: plan.actions });
  });

  it('plans one exact confirmation-gated provider resource destroy without unrelated actions', async () => {
    arrangeEnvironment('railway');
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      previousResource: {
        provider: 'fixture-database',
        resource: 'backup',
        externalId: 'projects/gcp-project/backups/backup-123',
        name: 'backup-123',
        providerScope: { projectId: 'gcp-project' },
      },
    });
    const currentObserved = await adapterFactory.getProviderAdapter('railway', project);
    const disconnect = vi.fn(async () => {});
    vi.mocked(adapterFactory.getProviderAdapter).mockImplementation(async (provider) => provider === 'fixture-database'
      ? {
          success: true,
          adapter: {
            disconnect,
            inspectBackupResources: async () => ({
              observation: 'present',
              resource: 'backup',
              backups: [{
                id: 'projects/gcp-project/backups/backup-123',
                name: 'backup-123',
                providerScope: { projectId: 'gcp-project' },
              }],
              partial: false,
              truncated: false,
            }),
          },
        } as never
      : currentObserved);

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions).toEqual([expect.objectContaining({
      id: 'retained-resource:fixture-database:backup:destroy',
      type: 'destroy',
      resource: { kind: 'retained-resource', name: 'backup', provider: 'fixture-database' },
      verified: true,
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        operation: 'retainedResourceDestroy',
        resource: 'backup',
        externalId: 'projects/gcp-project/backups/backup-123',
        name: 'backup-123',
        providerScope: { projectId: 'gcp-project' },
      },
    })]);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('blocks retained provider-resource deletion when exact observation is partial', async () => {
    arrangeEnvironment('railway');
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      previousResource: {
        provider: 'fixture-database',
        resource: 'backup',
        externalId: 'projects/gcp-project/backups/backup-123',
        name: 'backup-123',
        providerScope: { projectId: 'gcp-project' },
      },
    });
    const currentObserved = await adapterFactory.getProviderAdapter('railway', project);
    vi.mocked(adapterFactory.getProviderAdapter).mockImplementation(async (provider) => provider === 'fixture-database'
      ? {
          success: true,
          adapter: {
            disconnect: async () => {},
            inspectBackupResources: async () => ({
              observation: 'unknown',
              resource: 'backup',
              backups: [],
              partial: true,
              truncated: false,
            }),
          },
        } as never
      : currentObserved);

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions).toEqual([expect.objectContaining({
      id: 'retained-resource:fixture-database:backup:destroy',
      verified: false,
      metadata: expect.objectContaining({ blockedReason: 'retained_resource_observation_unknown' }),
    })]);
    expect(plan.warnings.join('\n')).toMatch(/incomplete or unknown observation/i);
  });

  it('blocks retained database deletion when live observation omits durable provider scope', async () => {
    arrangeEnvironment('railway');
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      previousDatabase: {
        provider: 'fixture-database',
        externalId: 'legacy-production-db',
        engine: 'postgres',
        name: 'legacy-production-db',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      },
    });
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'fixture-database',
        capabilities: {
          supportedDatabases: ['postgres'],
          supportsPooling: false,
          supportsReadReplicas: false,
          supportsPointInTimeRecovery: false,
          serverlessOptimized: false,
        },
        connect: async () => {},
        verify: async () => ({ success: true }),
        disconnect: async () => {},
        provision: async () => { throw new Error('unused'); },
        observeDatabase: async () => ({
          provider: 'fixture-database',
          engine: 'postgres',
          externalId: 'legacy-production-db',
          status: 'running',
        }),
        getConnectionUrl: async () => null,
        destroy: async () => { throw new Error('unused'); },
      },
    });

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(false);
    expect(plan.actions).toEqual([expect.objectContaining({
      id: 'database:fixture-database:retained-destroy',
      verified: false,
      metadata: expect.objectContaining({
        blockedReason: 'retained_database_observation_unknown',
      }),
    })]);
    expect(plan.warnings.join('\n')).toContain('omitted the durable scope');
  });

  it.each([
    ['service', 'railway', { provider: 'fixture-hosting', projectId: 'old-gcp-project', services: { web: {} } }],
    ['services', 'railway', { provider: 'fixture-hosting', services: { web: { serviceId: 'old-fixture-hosting-web' } } }],
    ['environment', 'fixture-hosting', { provider: 'railway', projectId: 'old-railway-project', services: {} }],
    ['project', 'railway', { provider: 'fixture-project-hosting', services: { web: { serviceId: 'old-fixture-project-hosting-web' } } }],
  ])('rejects an incomplete retained %s-boundary identity before persisting', async (_boundary, currentProvider, previousHosting) => {
    arrangeEnvironment(currentProvider, previousHosting);

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/incomplete/i);
    expect(new RunRepository().findByProjectId(project.id)).toEqual([]);
  });

  it('does not create or load an environment deploy file', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-cleanup-env-file-')));
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'app'));
    writeFileSync(path.join(root, '.env'), 'SESSION_SECRET=must-not-enter-cleanup-plan\n');
    const productionEnvPath = path.join(root, '.env.production');
    arrangeEnvironment('railway', {
      provider: 'fixture-hosting',
      projectId: 'old-gcp-project',
      services: { web: { serviceId: 'old-fixture-hosting-web' } },
    });

    process.chdir(path.join(root, 'app'));
    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).not.toHaveProperty('error');
    expect(existsSync(productionEnvPath)).toBe(false);
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.scope).toBe('retained-cleanup');
    expect(plan.warnings.join(' ')).not.toMatch(/deploy env file|\.env\.production/i);
    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(document.overrides).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain('SESSION_SECRET');
  });

  it.each([
    {
      boundary: 'services',
      currentProvider: 'railway',
      previousHosting: {
        provider: 'fixture-hosting',
        projectId: 'old-gcp-project',
        services: {
          web: { serviceId: 'old-fixture-hosting-web' },
          cron: { jobName: 'old-fixture-hosting-cron-job', resourceType: 'job' },
        },
      },
      expected: [
        {
          id: 'service:cron:previous-destroy',
          kind: 'service',
          name: 'cron',
          provider: 'fixture-hosting',
          metadata: { cleanupBoundary: 'services', serviceId: 'old-fixture-hosting-cron-job' },
        },
        {
          id: 'service:web:previous-destroy',
          kind: 'service',
          name: 'web',
          provider: 'fixture-hosting',
          metadata: { cleanupBoundary: 'services', serviceId: 'old-fixture-hosting-web' },
        },
      ],
    },
    {
      boundary: 'environment',
      currentProvider: 'fixture-hosting',
      previousHosting: {
        provider: 'railway',
        projectId: 'old-railway-project',
        environmentId: 'old-railway-environment',
        services: { web: { serviceId: 'old-railway-web' } },
      },
      expected: [{
        id: 'environment:production:railway:previous-destroy',
        kind: 'environment',
        name: 'production',
        provider: 'railway',
        metadata: {
          cleanupBoundary: 'environment',
          projectId: 'old-railway-project',
          environmentId: 'old-railway-environment',
        },
      }],
    },
    {
      boundary: 'project',
      currentProvider: 'railway',
      previousHosting: {
        provider: 'fixture-project-hosting',
        projectId: 'old-fixture-project-hosting-project',
        services: {
          web: { serviceId: 'old-fixture-project-hosting-web' },
          worker: { serviceId: 'old-fixture-project-hosting-worker' },
        },
      },
      expected: [
        {
          id: 'service:web:previous-destroy',
          kind: 'service',
          name: 'web',
          provider: 'fixture-project-hosting',
          metadata: { cleanupBoundary: 'project', serviceId: 'old-fixture-project-hosting-web' },
        },
        {
          id: 'service:worker:previous-destroy',
          kind: 'service',
          name: 'worker',
          provider: 'fixture-project-hosting',
          metadata: { cleanupBoundary: 'project', serviceId: 'old-fixture-project-hosting-worker' },
        },
        {
          id: 'project:fixture-project-hosting:previous-destroy',
          kind: 'project',
          name: 'production',
          provider: 'fixture-project-hosting',
          metadata: { cleanupBoundary: 'project', projectId: 'old-fixture-project-hosting-project' },
          dependsOn: [
            'service:web:previous-destroy',
            'service:worker:previous-destroy',
          ],
        },
      ],
    },
  ] as Array<{
    boundary: string;
    currentProvider: string;
    previousHosting: PreviousHosting;
    expected: ExpectedCleanupAction[];
  }>)('emits only provider-neutral previousHostingDestroy actions for the $boundary boundary', async ({ currentProvider, previousHosting, expected }) => {
    arrangeEnvironment(currentProvider, previousHosting);

    const result = await new PlanService().plan(project, 'production', cleanupOptions);

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.scope).toBe('retained-cleanup');
    expect(plan.actions).toHaveLength(expected.length);
    expect(plan.actions.map((action) => action.id).sort()).toEqual(expected.map((action) => action.id).sort());
    const expectedById = new Map(expected.map((action) => [action.id, action]));
    for (const action of plan.actions) {
      const expectedAction = expectedById.get(action.id)!;
      expect(action).toMatchObject({
        id: expectedAction.id,
        type: 'destroy',
        resource: {
          kind: expectedAction.kind,
          name: expectedAction.name,
          provider: expectedAction.provider,
        },
        verified: false,
        requiresConfirm: true,
        metadata: {
          operation: 'previousHostingDestroy',
          previousProvider: expectedAction.provider,
          ...expectedAction.metadata,
        },
        ...(expectedAction.dependsOn ? { dependsOn: expectedAction.dependsOn } : {}),
      });
    }
    expect(new Set(plan.blocked.map((entry) => entry.provider))).toEqual(new Set([
      currentProvider,
      previousHosting.provider,
    ]));
    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(document).toMatchObject({
      kind: 'hv_plan',
      scope: 'retained-cleanup',
      observedFingerprint: expect.any(String),
      actions: plan.actions,
    });
    expect(document.overrides).toBeUndefined();
  });

  it('leaves the default full plan behavior unchanged', async () => {
    arrangeEnvironment('railway', {
      provider: 'fixture-hosting',
      projectId: 'old-gcp-project',
      services: { web: { serviceId: 'old-fixture-hosting-web' } },
    }, 'node stale.js');

    const result = await new PlanService().plan(project, 'production');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.scope).toBe('full');
    expect(plan.actions).toContainEqual(expect.objectContaining({
      id: 'service:web',
      type: 'update',
      resource: { kind: 'service', name: 'web', provider: 'railway' },
    }));
    expect(plan.actions).toContainEqual(expect.objectContaining({
      id: 'service:web:previous-destroy',
      type: 'destroy',
      resource: { kind: 'service', name: 'web', provider: 'fixture-hosting' },
      metadata: expect.objectContaining({ operation: 'previousHostingDestroy' }),
    }));
  });
});
