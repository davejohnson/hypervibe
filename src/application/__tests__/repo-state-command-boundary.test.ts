import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { verifiedFinalCopy } from '../migration-cutover-readiness.js';
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

describe('protected migration copies at the command repository boundary', () => {
  beforeEach(() => { execFileSync('git', ['init', '--quiet', root]); });
  const deploy = { strategy: 'branch', trigger: 'ci', autoDeploy: false };
  const migration = (id: string, targetEnvironmentId: string, sourceEnvironmentId = 'source-id') => {
    const startedAt = '2026-08-01T12:00:00Z', copiedAt = '2026-08-01T12:05:00Z';
    const database = { tables: 2, rows: '3', match: true, differences: [], restoreWarnings: 0 };
    return { from: 'source', sourceMajor: 16, copyAttempt: { id, status: 'complete', startedAt }, copiedAt,
      database, storage: [],
      previousCopy: { copiedAt: '2026-07-31T12:05:00Z', storage: [] },
      promotionCopySignature: 'signed-copy-' + id,
      finalCopy: { sourceEnvironmentId, targetEnvironmentId, domain: 'app.example.com', targetService: 'web',
        pauseFingerprint: 'a'.repeat(64), copyAttemptId: id, copiedAt, dataFingerprint: canonicalJsonSha256({ database, storage: [] }) } };
  };
  const old = '11111111-1111-4111-8111-111111111111';
  const current = '22222222-2222-4222-8222-222222222222';
  const file = () => path.join(root, '.hypervibe', 'bindings.json');
  function desired(protectedTarget: boolean) {
    return { version: 1, project: 'safe-app', environments: {
      staging: { hosting: { provider: 'railway' }, services: { web: {} }, deploy },
      production: { hosting: { provider: 'cloudrun' }, services: { web: {} }, database: { provider: 'cloudsql' },
        migrations: { mode: 'releaseCommand', command: 'npm run migrate' },
        deploy: { ...deploy, ...(protectedTarget && { promoteFrom: 'staging' }) } },
    } };
  }
  function checkout(engine: unknown) {
    writeFileSync(file(), JSON.stringify({ version: 1, project: 'safe-app', environments: {
      production: { platformBindings: { provider: 'cloudrun', services: { web: { serviceId: 'prod-web' } }, engine } },
    } }));
  }
  function published() {
    return JSON.parse(readFileSync(file(), 'utf8')).environments.production.platformBindings.engine.migration;
  }

  it.each(['omit', 'replace', 'invalid parent'] as const)('keeps the locally verified copy when a newly checked-out file says %s', async change => {
    const ctx = createCommandContext();
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify(desired(true)));
    const project = ctx.repos.projects.create({ name: 'safe-app', defaultPlatform: 'cloudrun' });
    new SpecStore().replace(project, desired(true));
    const source = ctx.repos.environments.create({ projectId: project.id, name: 'source' });
    const target = ctx.repos.environments.create({ projectId: project.id, name: 'production' });
    const verified = migration(current, target.id, source.id);
    ctx.repos.environments.updatePlatformBindings(target.id, { engine: { kind: 'opentofu', migration: verified } });
    checkout(change === 'invalid parent' ? null : { kind: 'opentofu', ...(change === 'replace' && { migration: migration(old, target.id) }) });

    const read = await createCommandRegistry(ctx).execute('hv_spec', { project: 'safe-app' });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const stored = ctx.repos.environments.findById(target.id)!;
    expect(stored.platformBindings).toMatchObject({ services: { web: { serviceId: 'prod-web' } }, engine: { migration: verified } });
    expect(verifiedFinalCopy(source, stored, 'app.example.com', 'web', 'a'.repeat(64))).toEqual(verified.finalCopy);
    expect(published()).toMatchObject({ copyAttempt: verified.copyAttempt, copiedAt: verified.copiedAt,
      database: { match: true }, promotionCopySignature: verified.promotionCopySignature });
    expect(published()).not.toHaveProperty('finalCopy');
    expect(published().database).toEqual({ match: true });
  });

  it('retains the recorded protection when an older checkout contains neither its policy nor its signature', async () => {
    const ctx = createCommandContext();
    const specFile = path.join(root, '.hypervibe', 'spec.json');
    writeFileSync(specFile, JSON.stringify(desired(false)));
    const project = ctx.repos.projects.create({ name: 'safe-app', defaultPlatform: 'cloudrun' });
    const store = new SpecStore();
    store.replace(project, desired(false));
    store.replace(project, desired(true));
    const env = ctx.repos.environments.create({ projectId: project.id, name: 'production' });
    const { promotionCopySignature: _signature, ...unverified } = migration(old, env.id);
    checkout({ kind: 'opentofu', migration: unverified });
    writeFileSync(specFile, JSON.stringify(desired(false)));
    const read = await createCommandRegistry(ctx).execute('hv_spec', { project: project.name });
    expect(read.ok).toBe(false);
    expect(ctx.repos.environments.findById(env.id)!.platformBindings).not.toHaveProperty('engine.migration.copyAttempt');
    expect(ctx.repos.environments.findById(env.id)!.platformBindings).not.toHaveProperty('engine.migration.finalCopy');
    expect(published()).not.toHaveProperty('finalCopy');
  });

  it.each([false, true])('imports ordinary identities without creating private copy evidence before first observation (existing environment %s)', async existing => {
    const ctx = createCommandContext();
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify(desired(true)));
    const project = ctx.repos.projects.create({ name: 'safe-app', defaultPlatform: 'cloudrun' });
    const environment = existing ? ctx.repos.environments.create({ projectId: project.id, name: 'production' }) : undefined;
    const imported = migration(old, environment?.id ?? 'repo-selected-target');
    checkout({ kind: 'opentofu', migration: imported });
    const read = await createCommandRegistry(ctx).execute('hv_spec', { project: project.name });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const stored = ctx.repos.environments.findByProjectAndName(project.id, 'production')!.platformBindings;
    expect(stored).toMatchObject({ services: { web: { serviceId: 'prod-web' } } });
    for (const field of ['copyAttempt', 'copiedAt', 'database', 'storage', 'finalCopy', 'promotionCopySignature']) {
      expect(stored).not.toHaveProperty('engine.migration.' + field);
    }
    expect(published()).toMatchObject({ copyAttempt: imported.copyAttempt, copiedAt: imported.copiedAt, database: { match: true },
      promotionCopySignature: imported.promotionCopySignature });
    expect(published()).not.toHaveProperty('finalCopy');
  });

  it('keeps a newer local restore that commits while a repository import is in progress', async () => {
    const ctx = createCommandContext();
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify(desired(true)));
    const project = ctx.repos.projects.create({ name: 'safe-app', defaultPlatform: 'cloudrun' });
    const target = ctx.repos.environments.create({ projectId: project.id, name: 'production' });
    const first = migration(old, target.id), latest = migration(current, target.id);
    ctx.repos.environments.updatePlatformBindings(target.id, { engine: { kind: 'opentofu', migration: first } });
    checkout({ kind: 'opentofu', migration: first });
    const environments = ctx.repos.environments;
    const find = environments.findByProjectAndName.bind(environments);
    const race = vi.spyOn(environments, 'findByProjectAndName').mockImplementationOnce((id, name) => {
      const observed = find(id, name)!;
      expect(environments.replacePlatformBindingsIfUnchanged(observed, {
        ...observed.platformBindings, engine: { kind: 'opentofu', migration: latest },
      })).toBe(true);
      return observed;
    });
    const read = await createCommandRegistry(ctx).execute('hv_spec', { project: project.name });
    expect(race).toHaveBeenCalled();
    expect(environments.findById(target.id)?.platformBindings).toMatchObject({ engine: { migration: latest } });
    expect(read.ok).toBe(false);
    expect(await createCommandRegistry(ctx).execute('hv_spec', { project: project.name })).toMatchObject({ ok: true });
    expect(published().copyAttempt.id).toBe(current);
  });

  it('preserves historical migration imports for an ordinary project', async () => {
    const ctx = createCommandContext();
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), JSON.stringify(desired(false)));
    const legacy = { from: 'source', sourceMajor: 16, copiedAt: '2026-07-30T12:05:00Z', storage: [],
      previousCopy: { copiedAt: '2026-07-29T12:05:00Z', storage: [] } };
    checkout({ kind: 'opentofu', migration: legacy });
    const read = await createCommandRegistry(ctx).execute('hv_spec', { project: 'safe-app' });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const project = ctx.repos.projects.findByName('safe-app')!;
    expect(ctx.repos.environments.findByProjectAndName(project.id, 'production')!.platformBindings).toMatchObject({ engine: { migration: legacy } });
  });
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
