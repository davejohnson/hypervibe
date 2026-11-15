import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { providerRegistry, standardDatabaseRuntimeProjection } from '../../domain/registry/provider.registry.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { executePlanApply } from '../apply-plan.js';
import { z } from 'zod';

// Synthetic lifecycle owners exercise shared safety without restoring cloud CRUD.
for (const [name, teardownBoundary] of [['fixture-hosting', 'services']] as const) {
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

let root: string;
let oldCwd: string;
let oldDisable: string | undefined;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  root = mkdtempSync(path.join(tmpdir(), 'hypervibe-command-repo-state-'));
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, '.hypervibe'));
  SqliteAdapter.getInstance(path.join(root, 'test.db')).migrate();
  oldCwd = process.cwd();
  oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
  process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
  process.chdir(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(oldCwd);
  if (oldDisable === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
  else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
  SqliteAdapter.resetInstance();
  rmSync(root, { recursive: true, force: true });
});

describe('canonical command repository-state boundary', () => {
  it('returns a redacted validation error instead of treating a corrupt repo spec as uninitialized', async () => {
    writeFileSync(
      path.join(root, '.hypervibe', 'spec.json'),
      '{"apiToken":"must-not-cross-output",',
      'utf8'
    );
    const result = await createCommandRegistry(createCommandContext()).execute('hv_spec', {});

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: expect.stringContaining('is not valid JSON') },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-cross-output');
  });

  it('returns a validation error instead of using cached identities when repo bindings are corrupt', async () => {
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify({
      version: 1,
      project: 'safe-app',
      environments: {},
    }), 'utf8');
    writeFileSync(
      path.join(root, '.hypervibe', 'bindings.json'),
      '{"databaseUrl":"postgres://secret@host/db",',
      'utf8'
    );
    const ctx = createCommandContext();
    const result = await createCommandRegistry(ctx).execute('hv_spec', {});

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: expect.stringContaining('is not valid JSON') },
    });
    expect(JSON.stringify(result)).not.toContain('postgres://secret@host/db');
    expect(ctx.repos.projects.findAll()).toEqual([]);
  });

  it('does not update an existing project before repository bindings validate', async () => {
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify({
      version: 1,
      project: 'safe-app',
      gitRemoteUrl: 'https://github.com/example/new.git',
      environments: {},
    }), 'utf8');
    writeFileSync(
      path.join(root, '.hypervibe', 'bindings.json'),
      '{"providerToken":"must-not-cross-output",',
      'utf8'
    );
    const ctx = createCommandContext();
    const existing = ctx.repos.projects.create({
      name: 'safe-app',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/example/original.git',
    });

    const result = await createCommandRegistry(ctx).execute('hv_spec', {});

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: expect.stringContaining('is not valid JSON') },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-cross-output');
    expect(ctx.repos.projects.findAll()).toHaveLength(1);
    expect(ctx.repos.projects.findById(existing.id)?.gitRemoteUrl)
      .toBe('https://github.com/example/original.git');
  });

  it('blocks manually edited incompatible specs before plan or status can observe providers', async () => {
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify({
      version: 1,
      project: 'unsafe-app',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          database: { provider: 'fixture-database' },
        },
      },
    }), 'utf8');
    const observeEnvironment = vi.spyOn(PlanService.prototype, 'observeEnvironment');
    const getHostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapterByName');
    const getDatabaseAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');
    const ctx = createCommandContext();
    const registry = createCommandRegistry(ctx);

    const plan = await registry.execute('hv_plan', { project: 'unsafe-app', env: 'staging' });
    const status = await registry.execute('hv_status', { project: 'unsafe-app', env: 'staging' });
    const deploy = await registry.execute('hv_deploy', { project: 'unsafe-app', env: 'staging' });

    for (const result of [plan, status, deploy]) {
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'VALIDATION',
          message: expect.stringContaining('fixture-database database cannot serve workloads hosted by "railway"'),
          details: {
            path: 'environments.staging.database.provider',
            incompatibleHostingProvider: 'railway',
          },
        },
      });
    }
    const project = ctx.resolveProjectOrThrow({ project: 'unsafe-app' });
    const directPlan = await new PlanService().plan(project, 'staging');
    expect(directPlan).toEqual({
      error: expect.stringContaining('fixture-database database cannot serve workloads hosted by "railway"'),
    });
    expect(ctx.repos.environments.findByProjectId(project.id)).toEqual([]);
    expect(observeEnvironment).not.toHaveBeenCalled();
    expect(getHostingAdapter).not.toHaveBeenCalled();
    expect(getDatabaseAdapter).not.toHaveBeenCalled();
  });

  it('blocks apply after a repo spec is manually changed to an incompatible provider combination', async () => {
    const validSpec = {
      version: 1,
      project: 'edited-before-apply',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          database: { provider: 'railway' },
        },
      },
    };
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify(validSpec), 'utf8');
    const ctx = createCommandContext();
    const project = ctx.resolveProjectOrThrow({ project: validSpec.project });
    const specResult = new SpecStore().get(project)!;
    const environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway' },
    });
    const plan = ctx.repos.runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        environmentName: 'staging',
        specRevision: specResult.revision,
        observedFingerprint: null,
        actions: [{
          id: 'service:web:create',
          type: 'create',
          resource: { kind: 'service', name: 'web', provider: 'railway' },
          verified: true,
          reason: 'Create the reviewed web service',
        }],
      },
    });
    ctx.repos.runs.updateStatus(plan.id, 'succeeded');
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify({
      ...validSpec,
      environments: {
        staging: {
          ...validSpec.environments.staging,
          database: { provider: 'fixture-database' },
        },
      },
    }), 'utf8');
    const getHostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapterByName');
    const getDatabaseAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');

    const result = await createCommandRegistry(ctx).execute('hv_apply', {
      project: project.name,
      planId: plan.id,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION',
        message: expect.stringContaining('fixture-database database cannot serve workloads hosted by "railway"'),
      },
    });
    expect(ctx.repos.runs.findByProjectId(project.id)).toHaveLength(1);
    expect(getHostingAdapter).not.toHaveBeenCalled();
    expect(getDatabaseAdapter).not.toHaveBeenCalled();
  });

  it('rejects a persisted plan when provider connectivity metadata has changed, before reserving or mutating', async () => {
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify({
      version: 1,
      project: 'stale-provider-metadata',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          database: { provider: 'railway' },
        },
      },
    }), 'utf8');
    const ctx = createCommandContext();
    const project = ctx.resolveProjectOrThrow({ project: 'stale-provider-metadata' });
    const specResult = new SpecStore().get(project)!;
    const environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway' },
    });
    const action = {
      id: 'service:web:create',
      type: 'create' as const,
      resource: { kind: 'service' as const, name: 'web', provider: 'railway' },
      verified: true,
      reason: 'Create the reviewed web service',
    };
    const plan = ctx.repos.runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        environmentName: 'staging',
        specRevision: specResult.revision,
        observedFingerprint: null,
        actions: [action],
      },
    });
    ctx.repos.runs.updateStatus(plan.id, 'succeeded');

    const connectivity = providerRegistry.getMetadata('railway')?.lifecycle?.databaseConnectivity;
    expect(connectivity).toBeDefined();
    const originalCompatibleHosts = [...connectivity!.compatibleHostingProviders];
    const getHostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapterByName');
    const getDatabaseAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');

    try {
      connectivity!.compatibleHostingProviders.splice(
        0,
        connectivity!.compatibleHostingProviders.length,
        'fixture-hosting'
      );
      const result = await createCommandRegistry(ctx).execute('hv_apply', {
        project: project.name,
        planId: plan.id,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'VALIDATION',
          message: expect.stringContaining('railway database cannot serve workloads hosted by "railway"'),
        },
      });

      const directOutcome = await executePlanApply(ctx, {
        project,
        spec: specResult.spec,
        specRevision: specResult.revision,
        planId: plan.id,
        confirmActions: [],
      });
      expect(directOutcome).toMatchObject({
        kind: 'invalid_spec',
        details: { path: 'environments.staging.database.provider' },
      });
      expect(ctx.repos.runs.findByProjectId(project.id)).toHaveLength(1);
      expect(getHostingAdapter).not.toHaveBeenCalled();
      expect(getDatabaseAdapter).not.toHaveBeenCalled();
    } finally {
      connectivity!.compatibleHostingProviders.splice(
        0,
        connectivity!.compatibleHostingProviders.length,
        ...originalCompatibleHosts
      );
    }
  });
});
