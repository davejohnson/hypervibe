import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import * as access from '../../domain/services/database-access.service.js';
import { createCommandContext } from '../context.js';
import * as launch from '../launch.js';
import * as engine from '../infrastructure-engine.js';
import * as transfer from '../migration-transfer-gcp.js';
import { migrateEnvironment } from '../migrate.js';

const oldCopiedAt = '2026-11-01T00:00:00.000Z';
const manifest = { tables: { 'public.invoices': '1:42' }, totalRows: '1', version: '160000' };
const successfulDatabase = { ok: true, source: manifest, target: manifest, restoreWarnings: 0 };
const successfulStorage = { ok: true, source: { count: 2, bytes: 40 }, target: { count: 2, bytes: 40 }, differences: 0 };

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

function fixture(kind: 'database' | 'files' | 'both') {
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
    kind: 'opentofu', importedSecrets: [], database: { instanceName: 'target-db' },
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

  it('does not let an older completion overwrite a newer failed attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T20:00:00.000Z'));
    const f = fixture('database');
    let finishOlder!: (value: any) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(transfer.runTransferJob).mockImplementationOnce(async () => {
      entered();
      return await new Promise<any>((resolve) => { finishOlder = resolve; });
    }).mockResolvedValueOnce({ ok: false, error: 'Newer copy failed' } as any);
    const older = f.migrate({ copyData: true, refreshData: true });
    await started;
    const olderAttempt = f.current().copyAttempt!;
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked' });
    const newer = structuredClone(f.current());
    expect(newer.copyAttempt!.startedAt).toBe(olderAttempt.startedAt);
    expect(newer.copyAttempt!.id).not.toBe(olderAttempt.id);
    finishOlder(successfulDatabase);
    await expect(older).resolves.toMatchObject({ status: 'blocked' });
    expect(f.current()).toEqual(newer);
    expect(f.current()).toMatchObject({ copyAttempt: { status: 'incomplete' }, previousCopy: { copiedAt: oldCopiedAt } });
    expect(f.current()).not.toHaveProperty('copiedAt');
    expect(f.releaseCalls()).toHaveLength(0);
  });

  it('does not touch target data when the incomplete attempt cannot be persisted', async () => {
    const f = fixture('database');
    vi.spyOn(f.ctx.repos.environments, 'replacePlatformBindingsIfUnchanged').mockReturnValue(false);
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked' });
    expect(f.current().copiedAt).toBe(oldCopiedAt);
    expect(transfer.runTransferJob).not.toHaveBeenCalled();
    expect(f.releaseCalls()).toHaveLength(0);
  });

  it.each(['infrastructure', 'release'] as const)('rechecks copy evidence after awaiting %s', async (pauseAt) => {
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
    vi.mocked(transfer.runTransferJob).mockResolvedValue({ ok: false, error: 'New copy failed' } as any);
    await expect(f.migrate({ copyData: true, refreshData: true })).resolves.toMatchObject({ status: 'blocked' });
    resume();
    await expect(older).resolves.toMatchObject({ status: 'blocked' });
    if (pauseAt === 'infrastructure') expect(f.releaseCalls()).toHaveLength(0);
    expect(f.current()).not.toHaveProperty('copiedAt');
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
