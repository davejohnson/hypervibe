import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import * as access from '../../domain/services/database-access.service.js';
import * as commands from '../commands.js';
import { createCommandContext } from '../context.js';
import * as engine from '../infrastructure-engine.js';
import * as awsEngine from '../infrastructure-engine-aws.js';
import * as launch from '../launch.js';
import * as transfer from '../migration-transfer-gcp.js';
import { migrateEnvironment } from '../migrate.js';

type Options = Partial<Parameters<typeof migrateEnvironment>[1]>;
const providers = [
  { label: 'Railway', hosting: 'railway', database: 'railway' },
  { label: 'Google Cloud', hosting: 'cloudrun', database: 'cloudsql' },
  { label: 'AWS ECS/RDS', hosting: 'ecs', database: 'rds' },
  { label: 'Azure', hosting: 'azure-container-apps', database: 'azure-postgres' },
  // Existing saved AWS engine specs take a separate branch before hv_launch.
  { label: 'saved AWS engine', hosting: 'aws', database: 'rds', engine: 'opentofu' as const },
] as const;
const modes: Array<{ label: string; options: Options }> = [
  { label: 'initial migration', options: {} },
  { label: 'approved copy', options: { importSecrets: true, copyData: true } },
  { label: 'approved refresh', options: { copyData: true, refreshData: true } },
  { label: 'cutover review', options: { cutover: true } },
  { label: 'approved cutover', options: { cutover: true, confirmCutover: true } },
  { label: 'verification', options: { verifyOnly: true } },
];
const preparationStop = { status: 'blocked' as const, message: 'Fixture: target preparation needs access.' };
const copiedAt = '2026-11-01T00:00:00.000Z';
const manifest = { tables: { 'public.invoices': '1:42' }, totalRows: '1', version: '160000' };
const successfulDatabase = { ok: true, source: manifest, target: manifest, restoreWarnings: 0 };
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-migrate-self-copy-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  vi.spyOn(launch, 'launchEnvironment').mockResolvedValue(preparationStop);
  vi.spyOn(engine, 'resolveEngineContext').mockResolvedValue({ blocked: preparationStop.message });
  vi.spyOn(awsEngine, 'resolveAwsEngineContext').mockResolvedValue({ blocked: preparationStop.message });
  vi.spyOn(access, 'acquireManagedDatabaseAccess').mockResolvedValue({ ok: false, error: 'Unexpected source access' } as any);
  vi.spyOn(transfer, 'runTransferJob').mockRejectedValue(new Error('Unexpected transfer job'));
  vi.spyOn(engine, 'writeSecretVersion').mockRejectedValue(new Error('Unexpected secret write'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(provider: typeof providers[number], nativeScope?: { sourceProjectId: string; targetProjectId: string }) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'self-copy', defaultPlatform: provider.hosting });
  const platformBindings = {
    ...(nativeScope ? { projectId: nativeScope.sourceProjectId } : {}),
    engine: { kind: 'opentofu', importedSecrets: [], ...(provider.database === 'cloudsql' ? { database: { instanceName: 'production-db' } } : {}), migration: {
      from: 'production', sourceMajor: 16, copiedAt,
      database: { tables: 1, rows: '1', match: true, differences: [], restoreWarnings: 0 }, storage: [],
    } },
  };
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings });
  if (nativeScope) ctx.repos.environments.create({ projectId: project.id, name: 'replacement', platformBindings: {
    ...platformBindings, projectId: nativeScope.targetProjectId,
  } });
  const environmentSpec = {
    hosting: { provider: provider.hosting, ...('engine' in provider ? { engine: provider.engine } : {}) },
    services: { web: { workloadKind: 'web', public: true } },
    domain: 'production.example.com', database: { provider: provider.database, version: 16 },
  };
  const store = new SpecStore();
  store.replace(project, { version: 1, project: project.name, environments: {
    production: environmentSpec,
    ...(nativeScope ? { replacement: { ...environmentSpec, domain: 'replacement.example.com' } } : {}),
  } });
  const before = { spec: store.get(project), environments: ctx.repos.environments.findByProjectId(project.id) };
  const effects = {
    mergeSpec: vi.spyOn(SpecStore.prototype, 'merge'),
    replaceSpec: vi.spyOn(SpecStore.prototype, 'replace'),
    createEnvironment: vi.spyOn(ctx.repos.environments, 'create'),
    updateEnvironment: vi.spyOn(ctx.repos.environments, 'update'),
    updateBindings: vi.spyOn(ctx.repos.environments, 'updatePlatformBindings'),
    replaceBindings: vi.spyOn(ctx.repos.environments, 'replacePlatformBindingsIfUnchanged'),
    syncBindings: vi.spyOn(ctx.repos.environments, 'syncRepoBindingsForId'),
  };
  const migrate = (options: Options = {}) => migrateEnvironment(ctx, { project, from: 'production', to: 'production', ...options });
  const expectNoEffects = () => {
    for (const spy of Object.values(effects)) expect(spy).not.toHaveBeenCalled();
    expect(launch.launchEnvironment).not.toHaveBeenCalled();
    expect(engine.resolveEngineContext).not.toHaveBeenCalled();
    expect(awsEngine.resolveAwsEngineContext).not.toHaveBeenCalled();
    expect(access.acquireManagedDatabaseAccess).not.toHaveBeenCalled();
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
    expect(engine.writeSecretVersion).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect({ spec: store.get(project), environments: ctx.repos.environments.findByProjectId(project.id) }).toEqual(before);
  };
  return { ctx, project, environment, store, effects, migrate, expectNoEffects };
}

function expectSelfMigrationBlocked(result: Awaited<ReturnType<typeof migrateEnvironment>>) {
  expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/same|different|distinct/i) });
}

describe.each(providers)('$label self-migration boundary', (provider) => {
  it.each(modes)('rejects $label before preparation or any persisted change', async ({ options }) => {
    const f = fixture(provider);
    expectSelfMigrationBlocked(await f.migrate(options));
    f.expectNoEffects();
  });

  it('allows a distinct new target to reach normal target preparation', async () => {
    const f = fixture(provider);
    await expect(f.migrate({ to: 'replacement', copyData: true })).resolves.toEqual(preparationStop);
    expect(f.effects.mergeSpec).toHaveBeenCalledOnce();
    expect(f.store.get(f.project)!.spec.environments.replacement).toMatchObject({ hosting: { provider: 'cloudrun' } });
    expect(launch.launchEnvironment).toHaveBeenCalledExactlyOnceWith(f.ctx, expect.objectContaining({ environmentName: 'replacement', stopAfter: 'prepare' }));
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
  });
});

describe('Cloud SQL native identity aliases', () => {
  it.each(modes)('rejects $label between different names bound to the same database', async ({ options }) => {
    const f = fixture(providers[1], { sourceProjectId: 'fixture-project', targetProjectId: 'fixture-project' });
    expect(f.ctx.repos.environments.findByProjectAndName(f.project.id, 'replacement')!.id).not.toBe(f.environment.id);
    expectSelfMigrationBlocked(await f.migrate({ ...options, to: 'replacement' }));
    f.expectNoEffects();
  });

  it('does not mistake matching instance names in different projects for the same database', async () => {
    const f = fixture(providers[1], { sourceProjectId: 'source-project', targetProjectId: 'target-project' });
    await expect(f.migrate({ to: 'replacement', copyData: true, refreshData: true })).resolves.toEqual(preparationStop);
    expect(launch.launchEnvironment).toHaveBeenCalledExactlyOnceWith(f.ctx, expect.objectContaining({ environmentName: 'replacement', stopAfter: 'prepare' }));
    expect(f.effects.mergeSpec).not.toHaveBeenCalled();
    expect(f.effects.updateBindings).not.toHaveBeenCalled();
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
  });
});

describe('self-migration with a ready Cloud SQL copy', () => {
  function readyFixture() {
    const f = fixture(providers[1]);
    vi.mocked(launch.launchEnvironment).mockImplementation(async (_ctx, params) => params.stopAfter
      ? { status: 'ready', stage: params.stopAfter } as any
      : { status: 'live', urls: { web: 'https://production.example.com' } } as any);
    vi.mocked(engine.resolveEngineContext).mockImplementation(async () => ({
      environment: f.ctx.repos.environments.findById(f.environment.id)!,
      gcpProjectId: 'fixture-project', region: 'us-central1', runtimeServiceAccountEmail: 'fixture@fixture.invalid',
      adapter: { engineAccessToken: async () => 'fixture-token' },
    } as any));
    vi.spyOn(pg, 'Client').mockImplementation(function () {
      return { connect: async () => {}, end: async () => {},
        query: async (sql: string) => ({ rows: sql.includes('server_version_num') ? [{ v: '160000' }] : [{ tables: '1', rows: '1' }] }),
      };
    } as any);
    vi.mocked(access.acquireManagedDatabaseAccess).mockResolvedValue({ ok: true, lease: {
      withConnection: async (operation: (url: string) => unknown) => operation('postgresql://fixture.invalid/production'),
      release: async () => ({ status: 'no_op' }),
    } } as any);
    vi.spyOn(engine, 'observeSecret').mockResolvedValue({ state: 'present', value: { latestVersion: '1' } } as any);
    vi.mocked(transfer.runTransferJob).mockResolvedValue(successfulDatabase);
    // A pre-fix confirmed cutover can persist maintenance before planning. Stop
    // that plan at a controlled prerequisite rather than reaching a provider.
    vi.spyOn(commands, 'createCommandRegistry').mockReturnValue({ get: () => ({
      execute: async () => ({ ok: false, error: { message: 'Fixture: cutover plan needs access.' } }),
    }) } as any);
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockRejectedValue(new Error('Unexpected provider adapter'));
    return f;
  }

  it.each(modes)('rejects $label even when saved copy evidence and data access are ready', async ({ options }) => {
    const f = readyFixture();
    expectSelfMigrationBlocked(await f.migrate(options));
    f.expectNoEffects();
    expect(commands.createCommandRegistry).not.toHaveBeenCalled();
    expect(adapterFactory.getProviderAdapter).not.toHaveBeenCalled();
  });
});
