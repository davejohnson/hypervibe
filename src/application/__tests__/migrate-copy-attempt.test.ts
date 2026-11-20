import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { acquireMigrationTargetLease } from '../../adapters/db/migration-target-lease.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import * as access from '../../domain/services/database-access.service.js';
import { createCommandContext } from '../context.js';
import * as launch from '../launch.js';
import * as engine from '../infrastructure-engine.js';
import * as transfer from '../migration-transfer-gcp.js';
import { migrateEnvironment } from '../migrate.js';
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
import * as readiness from '../migration-cutover-readiness.js';
import * as commands from '../commands.js';

const oldCopiedAt = '2026-11-01T00:00:00.000Z';
const manifest = { tables: { 'public.invoices': '1:42' }, totalRows: '1', version: '160000' };
const successfulDatabase = { ok: true, source: manifest, target: manifest, restoreWarnings: 0 };
const successfulStorage = { ok: true, comparison: 'download', source: { count: 2, bytes: 40 }, target: { count: 2, bytes: 40 }, differences: 0 };

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-copy-attempt-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  vi.spyOn(pg, 'Client').mockImplementation(function () {
    return {
      connect: async () => {}, end: async () => {},
      query: async (sql: string) => ({ rows: sql.includes('server_version_num') ? [{ v: '160000' }] : [{ tables: '1', rows: '1' }] }),
    };
  } as any);
  vi.spyOn(access, 'acquireManagedDatabaseAccess').mockResolvedValue({ ok: true, lease: {
    withConnection: async (operation: (url: string) => unknown) => operation('postgresql://fixture.invalid/source'),
    release: async () => ({ status: 'no_op' }),
  } } as any);
  vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true, adapter: {
    getCredentials: async () => ({ endpoint: 'https://fixture.invalid', accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret', region: 'us-east-1', urlStyle: 'path', bucket: 'source-files' }),
  } } as any);
  vi.spyOn(engine, 'observeSecret').mockResolvedValue({ state: 'present', value: { latestVersion: '1' } } as any);
  vi.spyOn(launch, 'launchEnvironment').mockImplementation(async (_ctx, params) => params.stopAfter
    ? { status: 'ready', stage: params.stopAfter } as any
    : { status: 'live', urls: { web: 'https://target.invalid' } } as any);
  vi.spyOn(transfer, 'runTransferJob').mockImplementation(async (_context, job) => (job.purpose === 'database' ? successfulDatabase : successfulStorage) as any);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(kind: 'database' | 'files' | 'both', worker: 'simulated' | 'current' = 'simulated') {
  // State-machine cases use a transport that accepts the fixture's synthetic inputs.
  // The credential-admission cases below exercise the installed worker's real capability.
  if (worker === 'simulated') vi.spyOn(transfer, 'transferCredentialHandoffProblem').mockReturnValue(undefined);
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'copy-attempt', defaultPlatform: 'railway' });
  const hasDatabase = kind !== 'files';
  const hasFiles = kind !== 'database';
  const database = { tables: 1, rows: '1', match: true, differences: [], restoreWarnings: 0 };
  const storage = hasFiles ? [{ name: 'files', files: 2, bytes: 40, match: true }] : [];
  ctx.repos.environments.create({ projectId: project.id, name: 'source', platformBindings: {
    ...(hasFiles ? { storage: { files: { provider: 's3', externalId: 'source-files', instanceScope: { accountId: 'fixture', region: 'us-east-1' } } } } : {}),
  } });
  const target = ctx.repos.environments.create({ projectId: project.id, name: 'target', platformBindings: { engine: {
    kind: 'opentofu', importedSecrets: [], database: { instanceName: 'target-db' }, storage: hasFiles ? ['files'] : [],
    migration: { from: 'source', sourceMajor: 16, copiedAt: oldCopiedAt, ...(hasDatabase ? { database } : {}), storage },
  } } });
  new SpecStore().replace(project, { version: 1, project: project.name, environments: {
    source: { hosting: { provider: 'railway' }, domain: 'source.example.com', services: {},
      ...(hasDatabase ? { database: { provider: 'cloudsql', version: 16 } } : {}),
      ...(hasFiles ? { storage: { files: { provider: 's3', type: 'bucket', region: 'us-east-1', injectInto: [] } } } : {}),
    },
    target: { hosting: { provider: 'cloudrun', engine: 'opentofu' }, services: {},
      ...(hasDatabase ? { database: { provider: 'cloudsql', version: 16 } } : {}),
      ...(hasFiles ? { storage: { files: { provider: 'gcs', type: 'bucket', region: 'us-central1', injectInto: [] } } } : {}),
    },
  } });
  vi.spyOn(engine, 'resolveEngineContext').mockImplementation(async () => ({
    environment: ctx.repos.environments.findById(target.id)!, gcpProjectId: 'fixture-project', region: 'us-central1',
    runtimeServiceAccountEmail: 'fixture@fixture.invalid', adapter: { engineAccessToken: async () => 'fixture-token' },
  } as any));
  const current = () => (ctx.repos.environments.findById(target.id)!.platformBindings.engine as engine.EngineBinding).migration!;
  const migrate = (options: Partial<Parameters<typeof migrateEnvironment>[1]> = {}) => migrateEnvironment(ctx, { project, from: 'source', to: 'target', ...options });
  const releaseCalls = () => vi.mocked(launch.launchEnvironment).mock.calls.filter(([, params]) => !params.stopAfter);
  return { ctx, project, target, current, migrate, releaseCalls };
}

describe.each(['database', 'files', 'both'] as const)('%s refresh attempts', (kind) => {
  it.each(['failure', 'interruption'] as const)('blocks reuse and cutover after a partial %s and permits a fresh copy', async (outcome) => {
    const f = fixture(kind);
    let beforeDestruction: unknown;
    vi.mocked(transfer.runTransferJob).mockImplementation(async (_context, job) => {
      if (kind === 'both' && job.purpose === 'database') return successfulDatabase as any;
      beforeDestruction = structuredClone(f.current());
      if (outcome === 'interruption') throw new Error('Transfer interrupted after replacing target data');
      return { ok: false, error: 'Transfer failed after replacing target data' } as any;
    });
    const refresh = f.migrate({ copyData: true, refreshData: true });
    if (outcome === 'interruption') await expect(refresh).rejects.toThrow('Transfer interrupted');
    else await expect(refresh).resolves.toMatchObject({ status: 'blocked' });
    expect(f.releaseCalls()).toHaveLength(0);
    const transfersAfterFailure = vi.mocked(transfer.runTransferJob).mock.calls.length;
    await expect(f.migrate()).resolves.toMatchObject({ status: 'blocked', message: expect.stringContaining('refreshData=true') });
    await expect(f.migrate({ cutover: true })).resolves.toMatchObject({ status: 'blocked' });
    await expect(f.migrate({ verifyOnly: true })).resolves.toMatchObject({ status: 'blocked' });
    expect(f.releaseCalls()).toHaveLength(0);
    expect(transfer.runTransferJob).toHaveBeenCalledTimes(transfersAfterFailure);
    expect(beforeDestruction).toMatchObject({ copyAttempt: { id: expect.any(String), status: 'incomplete' }, previousCopy: { copiedAt: oldCopiedAt } });
    expect(f.current()).not.toHaveProperty('copiedAt');
    expect(f.current()).not.toHaveProperty('database');
    expect(f.current()).not.toHaveProperty('storage');

    vi.mocked(transfer.runTransferJob).mockImplementation(async (_context, job) => (job.purpose === 'database' ? successfulDatabase : successfulStorage) as any);
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'migrated' });
    expect(f.current()).toMatchObject({ copyAttempt: { status: 'complete' }, previousCopy: { copiedAt: oldCopiedAt } });
    expect(f.current().copiedAt).not.toBe(oldCopiedAt);
    const transfersAfterRecovery = vi.mocked(transfer.runTransferJob).mock.calls.length;
    await expect(f.migrate()).resolves.toMatchObject({ status: 'migrated', dataCopiedAt: f.current().copiedAt });
    expect(transfer.runTransferJob).toHaveBeenCalledTimes(transfersAfterRecovery);
  });
});

describe('copy evidence preservation', () => {
  it('reuses an unchanged completed copy and preserves it while fresh approval is pending', async () => {
    const f = fixture('database');
    await expect(f.migrate()).resolves.toMatchObject({ status: 'migrated', dataCopiedAt: oldCopiedAt });
    await expect(f.migrate({ refreshData: true })).resolves.toMatchObject({ status: 'needs_copy_approval' });
    expect(f.current().copiedAt).toBe(oldCopiedAt);
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
  });

  it('keeps an overlapping refresh out of the destination until its current copy finishes', async () => {
    const f = fixture('database');
    let finish!: (value: typeof successfulDatabase) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(transfer.runTransferJob).mockImplementationOnce(async () => {
      entered();
      return await new Promise<any>((resolve) => { finish = resolve; });
    });
    const original = f.migrate({ copyData: true, refreshData: true });
    await started;
    try {
      expect(await f.migrate({ copyData: true, refreshData: true })).toMatchObject({ status: 'blocked' });
      expect(transfer.runTransferJob).toHaveBeenCalledTimes(1);
    } finally {
      finish(successfulDatabase);
      await original;
    }
    expect(f.current().copyAttempt?.status).toBe('complete');
  });

  it('requires native cleanup evidence before retrying an interrupted job in a new invocation', async () => {
    const f = fixture('database');
    const resources = { gcpProjectId: 'fixture-project', region: 'us-central1', jobId: 'hv-migrate-database-abc123', secretIds: [] };
    vi.mocked(transfer.runTransferJob).mockImplementationOnce(async (context) => {
      await context.recordTransferResources!(resources);
      throw new Error('Controller disconnected with a native execution pending');
    });
    await expect(f.migrate({ copyData: true, refreshData: true })).rejects.toThrow('Controller disconnected');
    const observe = vi.spyOn(transfer, 'verifyTransferResourcesAbsent').mockResolvedValue(false);
    const recover = vi.spyOn(transfer, 'recoverTerminalTransferResources').mockResolvedValue(false);
    for (const options of [{ copyData: true, refreshData: true }, { cutover: true, confirmCutover: true }]) {
      await expect(f.migrate(options)).resolves.toMatchObject({ status: 'blocked', message: expect.stringContaining('previous transfer') });
    }
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ gcpProjectId: 'fixture-project' }), resources);
    expect(transfer.runTransferJob).toHaveBeenCalledTimes(1);
    expect(f.releaseCalls()).toHaveLength(0);
    expect(recover).toHaveBeenCalledTimes(1);
    recover.mockResolvedValue(true);
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'migrated' });
    expect(transfer.runTransferJob).toHaveBeenCalledTimes(2);
  });

  it('does not touch target data when the incomplete attempt cannot be persisted', async () => {
    const f = fixture('database');
    vi.spyOn(f.ctx.repos.environments, 'replacePlatformBindingsIfUnchanged').mockReturnValue(false);
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked' });
    expect(f.current().copiedAt).toBe(oldCopiedAt);
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
    expect(f.releaseCalls()).toHaveLength(0);
  });

  it.each(['infrastructure', 'release'] as const)('prevents refresh from rewriting data during %s of a reused release', async (pauseAt) => {
    const f = fixture('database');
    let resume!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let paused = false;
    vi.mocked(launch.launchEnvironment).mockImplementation(async (_ctx, params) => {
      if (!paused && (pauseAt === 'infrastructure' ? params.stopAfter === 'infrastructure' : !params.stopAfter)) {
        paused = true;
        entered();
        await new Promise<void>((resolve) => { resume = resolve; });
      }
      return params.stopAfter ? { status: 'ready', stage: params.stopAfter } as any : { status: 'live', urls: {} } as any;
    });
    const older = f.migrate();
    await waiting;
    try {
      await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked' });
      expect(transfer.runTransferJob).not.toHaveBeenCalled();
    } finally {
      resume();
    }
    await expect(older).resolves.toMatchObject({ status: 'migrated', dataCopiedAt: oldCopiedAt });
    expect(f.current().copiedAt).toBe(oldCopiedAt);
  });

  it('cannot turn a changed completion snapshot into copy authority', async () => {
    const f = fixture('database');
    const find = f.ctx.repos.environments.findById.bind(f.ctx.repos.environments);
    let armed = false;
    let reads = 0;
    vi.spyOn(f.ctx.repos.environments, 'findById').mockImplementation((id) => {
      const snapshot = find(id);
      if (armed && id === f.target.id && ++reads === 2) {
        armed = false;
        const binding = snapshot!.platformBindings.engine as engine.EngineBinding;
        f.ctx.repos.environments.updatePlatformBindings(id, { engine: { ...binding, migration: {
          ...binding.migration, copiedAt: undefined, database: undefined, storage: undefined,
          copyAttempt: { id: 'newer-attempt', startedAt: new Date().toISOString(), status: 'incomplete' },
        } } });
      }
      return snapshot;
    });
    vi.mocked(transfer.runTransferJob).mockImplementation(async () => { armed = true; return successfulDatabase as any; });
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked' });
    expect(f.current()).toMatchObject({ copyAttempt: { id: 'newer-attempt', status: 'incomplete' } });
    expect(f.current()).not.toHaveProperty('copiedAt');
    expect(f.releaseCalls()).toHaveLength(0);
  });

  it('reuses a newly completed copy after release fails without copying again', async () => {
    const f = fixture('database');
    vi.mocked(launch.launchEnvironment).mockImplementation(async (_ctx, params) => params.stopAfter
      ? { status: 'ready', stage: params.stopAfter } as any : { status: 'blocked', message: 'Release failed' });
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked' });
    const completed = structuredClone(f.current());
    expect(completed).toMatchObject({ copyAttempt: { status: 'complete' }, copiedAt: expect.any(String) });
    vi.mocked(launch.launchEnvironment).mockImplementation(async (_ctx, params) => params.stopAfter
      ? { status: 'ready', stage: params.stopAfter } as any : { status: 'live', urls: {} } as any);
    await expect(f.migrate()).resolves.toMatchObject({ status: 'migrated', dataCopiedAt: completed.copiedAt });
    expect(transfer.runTransferJob).toHaveBeenCalledTimes(1);
  });
});

describe('all declared application buckets are required', () => {
  it.each(['source binding', 'source scope', 'target declaration', 'target binding', 'source credentials'] as const)('stops before replacing the database when the %s is missing', async (missing) => {
    const f = fixture('both');
    const store = new SpecStore();
    const spec = store.get(f.project)!.spec;
    const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'source')!;
    if (missing === 'source binding') f.ctx.repos.environments.updatePlatformBindings(source.id, { storage: {} });
    if (missing === 'source scope') f.ctx.repos.environments.updatePlatformBindings(source.id, {
      storage: { files: { provider: 's3', externalId: 'source-files', instanceScope: {} } },
    });
    if (missing === 'target declaration') {
      delete spec.environments.target!.storage!.files;
      store.replace(f.project, spec);
    }
    if (missing === 'target binding') f.ctx.repos.environments.updatePlatformBindings(f.target.id, {
      engine: { ...f.target.platformBindings.engine as engine.EngineBinding, storage: [] },
    });
    if (missing === 'source credentials') vi.mocked(adapterFactory.getStorageAdapter).mockResolvedValue({ success: false, error: 'unavailable' } as any);

    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked', message: expect.stringContaining('files') });
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
    expect(f.releaseCalls()).toHaveLength(0);
    expect(f.current().copiedAt).toBe(oldCopiedAt);
    await expect(f.migrate({ verifyOnly: true })).resolves.toMatchObject({ status: 'blocked' });
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
  });

  it('stops before copying when the source binding changes during target preparation', async () => {
    const f = fixture('both');
    const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'source')!;
    vi.mocked(launch.launchEnvironment).mockImplementation(async (_ctx, params) => {
      if (params.stopAfter === 'infrastructure') f.ctx.repos.environments.updatePlatformBindings(source.id, { storage: {} });
      return params.stopAfter ? { status: 'ready', stage: params.stopAfter } as any : { status: 'live', urls: {} } as any;
    });
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked' });
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
  });

  it('keeps target-only and backup buckets outside the copy', async () => {
    const f = fixture('files');
    const store = new SpecStore();
    const spec = store.get(f.project)!.spec;
    const files = spec.environments.source!.storage!.files!;
    spec.environments.source!.storage!.backups = { ...files, purpose: 'backup' };
    spec.environments.target!.storage!.independent = { ...spec.environments.target!.storage!.files! };
    store.replace(f.project, spec);
    const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'source')!;
    const tracked = source.platformBindings.storage as Record<string, unknown>;
    f.ctx.repos.environments.updatePlatformBindings(source.id, { storage: { ...tracked, independent: tracked.files } });
    await expect(f.migrate({ refreshData: true })).resolves.toMatchObject({ status: 'needs_copy_approval', storage: ['files'] });
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'migrated', storage: [{ name: 'files' }] });
    expect(transfer.runTransferJob).toHaveBeenCalledTimes(1);
  });

  it('cannot report a verified comparison after another copy starts', async () => {
    const f = fixture('files');
    vi.mocked(transfer.runTransferJob).mockImplementation(async () => {
      const binding = f.ctx.repos.environments.findById(f.target.id)!.platformBindings.engine as engine.EngineBinding;
      f.ctx.repos.environments.updatePlatformBindings(f.target.id, { engine: { ...binding, migration: {
        from: 'source', copyAttempt: { id: 'newer', startedAt: new Date().toISOString(), status: 'incomplete' },
      } } });
      return successfulStorage as any;
    });
    await expect(f.migrate({ verifyOnly: true })).resolves.toMatchObject({ status: 'blocked' });
  });

  it('refuses to release or cut over using an older file count receipt', async () => {
    const f = fixture('files');
    await expect(f.migrate()).resolves.toMatchObject({ status: 'blocked', message: expect.stringContaining('refreshData=true') });
    await expect(f.migrate({ cutover: true })).resolves.toMatchObject({ status: 'blocked', message: expect.stringContaining('refreshData=true') });
    expect(f.releaseCalls()).toHaveLength(0);
  });

  it('checks the exact native bucket when reusing a completed copy', async () => {
    const f = fixture('files');
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'migrated' });
    const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'source')!;
    f.ctx.repos.environments.updatePlatformBindings(source.id, { storage: { files: {
      provider: 's3', externalId: 'different-bucket', instanceScope: { accountId: 'fixture', region: 'us-east-1' },
    } } });
    await expect(f.migrate()).resolves.toMatchObject({ status: 'blocked' });
    expect(f.releaseCalls()).toHaveLength(1);
  });

  it.each([
    { ok: true, differences: 0 },
    { ok: true, comparison: 'download', source: { bytes: 40 }, target: { bytes: 40 }, differences: 0 },
    { ok: true, comparison: 'download', source: { count: 2, bytes: 40 }, target: { count: 2, bytes: 41 }, differences: 0 },
  ])('refuses incomplete or conflicting inventories in both copy and verification', async (result) => {
    const f = fixture('files');
    vi.mocked(transfer.runTransferJob).mockResolvedValue(result as any);
    const checked = await f.migrate({ verifyOnly: true });
    expect(['blocked', 'differs']).toContain(checked.status);
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked' });
    expect(f.releaseCalls()).toHaveLength(0);
  });
});

describe('current source credential handoff', () => {
  function railwayFixture() {
    const f = fixture('database', 'current');
    const store = new SpecStore();
    store.merge(f.project, { environments: {
      source: { database: { provider: 'railway' } },
      target: { services: { web: { workloadKind: 'web', public: true } } },
    } });
    const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'source')!;
    const scope = { projectId: 'railway-project', environmentId: 'railway-env' };
    f.ctx.repos.environments.updatePlatformBindings(source.id, scope);
    f.ctx.repos.components.create({ environmentId: source.id, type: 'postgres', externalId: 'source-postgres',
      bindings: { provider: 'railway', providerScope: scope } });
    const runPrivateTask = vi.fn(async ({ command }: { command: string }) => ({
      exitCode: 0, output: command.includes('HV_SERVER_VERSION') ? 'HV_SERVER_VERSION 160000'
        : 'HV_TRANSFER_RESULT ' + JSON.stringify({ ok: true, source: manifest, sourceIdentity: '42:123' }),
    }));
    const versionSource = { ...scope, serviceId: 'source-postgres', serviceInstanceId: 'source-instance', replicaId: 'active-replica',
      deploymentId: 'active-deployment', volumeId: 'source-volume', volumeInstanceId: 'source-volume-instance', imageDigest: 'sha256:' + 'a'.repeat(64) };
    const versionInspection = { programHash: () => '7'.repeat(64), observe: vi.fn(async () => ({ ...versionSource })), inspect: vi.fn(async () => ({ versionNumber: 170002, tables: 4, estimatedRows: '20' })),
      hasTrustedAccess: vi.fn(async () => false) };
    const adapter = Object.assign(Object.create(RailwayAdapter.prototype), { name: 'railway', privateMigrationSourceInspection: versionInspection,
      serviceName: async () => 'source-postgres', runPrivateTask, lastPrivateTaskCleanup: true,
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter } as any);
    vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({ success: true, adapter } as any);
    vi.spyOn(transfer, 'signedObjectUrl').mockReturnValue('https://fixture.invalid/private-dump');
    vi.mocked(engine.resolveEngineContext).mockResolvedValue({
      environment: f.target, gcpProjectId: 'fixture-project', region: 'us-central1', adapter: {
        engineAccessToken: async () => 'fixture', engineConnection: () => ({ credentials: '{}' }),
      },
    } as any);
    return { ...f, store, runPrivateTask, versionInspection, versionSource };
  }

  it('stops before exporting a private Railway dump and keeps the previous receipt', async () => {
    const f = railwayFixture();
    vi.mocked(transfer.runTransferJob).mockRestore();
    const result = await f.migrate({ copyData: true, refreshData: true });
    expect(f.runPrivateTask.mock.calls.some(([job]) => job.command.includes('pg_dump'))).toBe(false);
    expect(f.current().copiedAt).toBe(oldCopiedAt);
    expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/handoff/i) });
    expect(launch.launchEnvironment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stopAfter: 'infrastructure' }));
  });

  it('keeps Railway serving when the final copy cannot receive its private inputs', async () => {
    const f = railwayFixture();
    vi.spyOn(readiness, 'migrationCutoverReadiness').mockResolvedValue({ domain: 'source.example.com', alreadyForwarding: false, problems: [] });
    const registry = vi.spyOn(commands, 'createCommandRegistry').mockReturnValue({ get: () => ({
      execute: async () => ({ ok: false, error: { message: 'Unexpected source pause' } }),
    }) } as any);
    const before = f.store.get(f.project)!.spec;
    const result = await f.migrate({ cutover: true, confirmCutover: true });
    expect(f.store.get(f.project)!.spec).toEqual(before);
    expect(registry).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/handoff/i) });
  });

  it('finishes target preparation and identifies an unavailable copy before asking for its approval', async () => {
    const f = railwayFixture();
    await expect(f.migrate({ refreshData: true })).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/handoff/i) });
    expect(launch.launchEnvironment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stopAfter: 'infrastructure' }));
    expect(f.current().copiedAt).toBe(oldCopiedAt);
  });

  it('uses the previously observed major for target preparation without starting a Railway service', async () => {
    const f = railwayFixture();
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/handoff/i) });
    expect(f.runPrivateTask).not.toHaveBeenCalled();
    expect(launch.launchEnvironment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stopAfter: 'infrastructure' }));
  });

  it('saves the exact private version inspection for review without reading SQL or starting a service', async () => {
    const f = railwayFixture();
    f.ctx.repos.environments.updatePlatformBindings(f.target.id, { engine: {
      ...f.target.platformBindings.engine as engine.EngineBinding, migration: { from: 'source' },
    } });
    f.versionInspection.hasTrustedAccess.mockResolvedValue(true);
    const result = await f.migrate();
    if (result.status !== 'needs_confirmation') throw new Error('Expected a saved source version plan.');
    expect(result.confirmActions).toEqual([expect.stringContaining('version')]);
    expect(f.versionInspection.inspect).not.toHaveBeenCalled();
    expect(f.runPrivateTask).not.toHaveBeenCalled();
    const plan = f.ctx.repos.runs.findById(result.planId)!;
    expect(plan.plan).toMatchObject({ scope: 'migration-source-version', actions: [{ metadata: { source: f.versionSource } }] });
    const document = planRunDocumentSchema.parse(plan.plan);
    expect(planRunDocumentSchema.safeParse({ ...document, scope: 'full' }).success).toBe(false);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [document.actions[0], document.actions[0]] }).success).toBe(false);
    const changed = structuredClone(document);
    changed.actions[0].metadata!.programHash = '0'.repeat(64);
    expect(planRunDocumentSchema.safeParse(changed).success).toBe(false);
    const applied = await f.migrate({ planId: result.planId, confirmActions: result.confirmActions });
    expect(applied).toMatchObject({ status: 'source_inspected', inventory: { versionNumber: 170002, tables: 4, estimatedRows: '20' } });
    expect(f.versionInspection.inspect).toHaveBeenCalledTimes(1);
    expect(await f.migrate()).toMatchObject({ status: 'blocked', message: expect.stringMatching(/handoff/i) });
    expect(f.store.get(f.project)?.spec.environments.target.database?.version).toBe(17);
    expect(f.versionInspection.inspect).toHaveBeenCalledTimes(1);
    expect(f.current().sourceMajor).toBeUndefined();
    f.versionSource.replicaId = 'replacement-replica';
    expect(await f.migrate()).toMatchObject({ status: 'needs_confirmation' });
    expect(f.versionInspection.inspect).toHaveBeenCalledTimes(1);
  });

  it('does not substitute a bare historical version for source identity and a successful receipt', async () => {
    const f = railwayFixture();
    f.ctx.repos.environments.updatePlatformBindings(f.target.id, { engine: {
      ...f.target.platformBindings.engine as engine.EngineBinding, migration: { from: 'source', sourceMajor: 12 },
    } });
    f.versionInspection.hasTrustedAccess.mockResolvedValue(true);
    expect(await f.migrate()).toMatchObject({ status: 'needs_confirmation' });
    expect(f.versionInspection.inspect).not.toHaveBeenCalled();
  });

  it.each([
    { hosting: 'aws', database: 'rds' },
    { hosting: 'azure', database: 'azure-postgres' },
  ])('reviews only the Railway source for a declared $hosting destination', async ({ hosting, database }) => {
    const f = railwayFixture();
    f.store.merge(f.project, { environments: { rehearsal: { hosting: { provider: hosting, engine: 'opentofu' }, database: { provider: database }, services: {} } } });
    const rehearsal = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'rehearsal' });
    const spec = f.store.get(f.project);
    const otherMigration = f.current();
    f.versionInspection.hasTrustedAccess.mockResolvedValue(true);
    const review = await f.migrate({ inspectSource: true, to: 'rehearsal' });
    expect(review.status).toBe('needs_confirmation');
    if (review.status !== 'needs_confirmation') throw new Error('Expected a saved source inspection plan.');
    const approval = { planId: review.planId, confirmActions: review.confirmActions };
    expect(await f.migrate(approval)).toMatchObject({ status: 'blocked' });
    expect(await f.migrate({ to: 'rehearsal', ...approval })).toMatchObject({ status: 'source_inspected', inventory: { tables: 4 } });
    expect(f.store.get(f.project)).toEqual(spec);
    expect(f.ctx.repos.environments.findById(rehearsal.id)?.platformBindings).toEqual(rehearsal.platformBindings);
    expect(f.current()).toEqual(otherMigration);
    expect(launch.launchEnvironment).not.toHaveBeenCalled();
    expect(transfer.runTransferJob).not.toHaveBeenCalled();

    // Even an ordinary migration cannot use this receipt for a different destination.
    f.ctx.repos.environments.updatePlatformBindings(f.target.id, { engine: {
      ...f.target.platformBindings.engine as engine.EngineBinding, migration: { from: 'source' },
    } });
    expect(await f.migrate()).toMatchObject({ status: 'needs_confirmation' });
    expect(f.current()).toEqual({ from: 'source' });
    expect(f.releaseCalls()).toHaveLength(0);
  });

  it('can review and apply a source inspection while the named destination is locked', async () => {
    const f = railwayFixture();
    f.versionInspection.hasTrustedAccess.mockResolvedValue(true);
    const lease = acquireMigrationTargetLease(f.project.id, 'target')!;
    try {
      const review = await f.migrate({ inspectSource: true });
      expect(review.status).toBe('needs_confirmation');
      if (review.status !== 'needs_confirmation') throw new Error('Expected a saved source inspection plan.');
      expect(await f.migrate({ planId: review.planId, confirmActions: review.confirmActions })).toMatchObject({ status: 'source_inspected' });
      expect(await f.migrate()).toMatchObject({ status: 'blocked', message: expect.stringContaining('already running') });
    } finally {
      lease.close();
    }
  });

  it.each([
    { hosting: 'aws', database: 'rds', guidance: /Aurora Data API/ },
    { hosting: 'azure', database: 'azure-postgres', guidance: /private connector/ },
  ])('reports available database access for a $hosting source without contacting Railway', async ({ hosting, database, guidance }) => {
    const f = railwayFixture();
    f.store.merge(f.project, { environments: { source: { hosting: { provider: hosting, engine: 'opentofu' }, database: { provider: database } } } });
    const result = await commands.createCommandRegistry(f.ctx).get('hv_migrate')!.execute({
      project: f.project.id, from: 'source', to: 'target', inspectSource: true,
    });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(guidance) } });
    expect(f.versionInspection.observe).not.toHaveBeenCalled();
    expect(access.acquireManagedDatabaseAccess).not.toHaveBeenCalled();
    expect(launch.launchEnvironment).not.toHaveBeenCalled();
  });

  it('reviews the source before asking Google Cloud for a target, and requires the exact approval', async () => {
    const f = railwayFixture();
    const fresh = () => f.migrate({ inspectSource: true, to: 'future-target' });
    const prior = f.store.get(f.project)!;
    expect(await fresh()).toMatchObject({ status: 'blocked', message: expect.stringContaining('sshKnownHostsFile') });
    expect(f.versionInspection.observe).not.toHaveBeenCalled();
    f.versionInspection.hasTrustedAccess.mockResolvedValue(true);
    const review = await fresh();
    if (review.status !== 'needs_confirmation') throw new Error('Expected source review');
    expect(await f.migrate({ inspectSource: true, to: 'future-target', planId: review.planId })).toMatchObject({ status: 'blocked' });
    expect(await f.migrate({ inspectSource: true, to: 'wrong-target', planId: review.planId, confirmActions: review.confirmActions })).toMatchObject({ status: 'blocked' });
    expect(await f.migrate({ inspectSource: true, copyData: true })).toMatchObject({ status: 'blocked' });
    f.versionSource.imageDigest = 'sha256:' + 'b'.repeat(64);
    expect(await f.migrate({ inspectSource: true, to: 'future-target', planId: review.planId, confirmActions: review.confirmActions })).toMatchObject({ status: 'blocked' });
    expect(f.versionInspection.inspect).not.toHaveBeenCalled();
    expect(f.store.get(f.project)).toEqual(prior);
    expect(launch.launchEnvironment).not.toHaveBeenCalled();
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
  });

  it('directs empty-target qualification to hv_launch when no observed source major is available', async () => {
    const f = railwayFixture();
    f.ctx.repos.environments.updatePlatformBindings(f.target.id, { engine: {
      ...f.target.platformBindings.engine as engine.EngineBinding, migration: { from: 'source' },
    } });
    const result = await f.migrate();
    expect(f.runPrivateTask).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/version.*hv_launch/i) });
    expect(f.current()).toEqual({ from: 'source' });
  });

  it('can release a completed database copy without a new private handoff', async () => {
    const f = railwayFixture();
    await expect(f.migrate()).resolves.toMatchObject({ status: 'migrated', dataCopiedAt: oldCopiedAt });
    expect(f.runPrivateTask).not.toHaveBeenCalled();
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
  });

  it('stops verification before asking for bucket credentials that cannot reach the job', async () => {
    const f = fixture('files', 'current');
    await expect(f.migrate({ verifyOnly: true })).resolves.toMatchObject({ status: 'blocked', message: expect.stringMatching(/handoff/i) });
    expect(adapterFactory.getStorageAdapter).not.toHaveBeenCalled();
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
  });

  it('keeps a read-only Railway database comparison from launching unreviewed native tasks', async () => {
    const f = railwayFixture();
    const before = structuredClone(f.current());
    const result = await f.migrate({ verifyOnly: true });
    expect(f.runPrivateTask).not.toHaveBeenCalled();
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
    expect(launch.launchEnvironment).not.toHaveBeenCalled();
    expect(f.current()).toEqual(before);
    expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/reviewed.*verification.*tasks/i) });
  });
});
