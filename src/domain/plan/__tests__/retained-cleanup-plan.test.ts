import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
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
      provider: 'cloudrun',
      projectId: 'old-gcp-project',
      services: { web: { serviceId: 'old-cloudrun-web' } },
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

  it.each([
    ['service', 'railway', { provider: 'cloudrun', projectId: 'old-gcp-project', services: { web: {} } }],
    ['environment', 'cloudrun', { provider: 'railway', projectId: 'old-railway-project', services: {} }],
    ['project', 'railway', { provider: 'ecs', services: { web: { serviceId: 'old-ecs-web' } } }],
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
      provider: 'cloudrun',
      projectId: 'old-gcp-project',
      services: { web: { serviceId: 'old-cloudrun-web' } },
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
        provider: 'cloudrun',
        projectId: 'old-gcp-project',
        services: {
          web: { serviceId: 'old-cloudrun-web' },
          cron: { jobName: 'old-cloudrun-cron-job', resourceType: 'job' },
        },
      },
      expected: [
        {
          id: 'service:cron:previous-destroy',
          kind: 'service',
          name: 'cron',
          provider: 'cloudrun',
          metadata: { cleanupBoundary: 'services', serviceId: 'old-cloudrun-cron-job' },
        },
        {
          id: 'service:web:previous-destroy',
          kind: 'service',
          name: 'web',
          provider: 'cloudrun',
          metadata: { cleanupBoundary: 'services', serviceId: 'old-cloudrun-web' },
        },
      ],
    },
    {
      boundary: 'environment',
      currentProvider: 'cloudrun',
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
        provider: 'ecs',
        projectId: 'old-ecs-project',
        services: {
          web: { serviceId: 'old-ecs-web' },
          worker: { serviceId: 'old-ecs-worker' },
        },
      },
      expected: [
        {
          id: 'service:web:previous-destroy',
          kind: 'service',
          name: 'web',
          provider: 'ecs',
          metadata: { cleanupBoundary: 'project', serviceId: 'old-ecs-web' },
        },
        {
          id: 'service:worker:previous-destroy',
          kind: 'service',
          name: 'worker',
          provider: 'ecs',
          metadata: { cleanupBoundary: 'project', serviceId: 'old-ecs-worker' },
        },
        {
          id: 'project:ecs:previous-destroy',
          kind: 'project',
          name: 'production',
          provider: 'ecs',
          metadata: { cleanupBoundary: 'project', projectId: 'old-ecs-project' },
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
      provider: 'cloudrun',
      projectId: 'old-gcp-project',
      services: { web: { serviceId: 'old-cloudrun-web' } },
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
      resource: { kind: 'service', name: 'web', provider: 'cloudrun' },
      metadata: expect.objectContaining({ operation: 'previousHostingDestroy' }),
    }));
  });
});
