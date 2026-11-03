import { runCli } from '../../interfaces/cli/run.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createRecoverySet } from '../../domain/services/recovery-set.service.js';
import { POSTGRES_BACKUP_FORMAT_VERSION, type PostgresBackupEvidence } from '../../domain/services/postgres-backup.service.js';
import type { StorageObjectClient } from '../../domain/ports/storage.port.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../providers.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { executePlanApply } from '../apply-plan.js';
import * as engine from '../managed-backup.js';
import * as health from '../../domain/services/recovery-set-health.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { mergeRepoPlatformBindings } from '../../domain/spec/repo-bindings-file.js';
import * as targets from '../../domain/services/managed-backup-target.service.js';
import { recoveryFailure } from '../../domain/ports/recovery-diagnostics.port.js';

// User requirement: a manually deployed app can review one local backup and
// isolated logical restore without publishing another project's root spec.
// Real command/SQLite/spec/plan boundary; native observations below are synthetic.
describe('one-use local backup authority', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-manual-backup-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  it('persists a separate manual backup plan without observing unrelated deployment or repository publication', async () => {
    const ctx = createCommandContext(), registry = new CommandRegistry(); registerCoreTools(registry, ctx);
    const project = ctx.repos.projects.create({ name: 'operator-host', defaultPlatform: 'cloudrun' });
    ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: { provider: 'cloudrun', projectId: 'native-project', services: { web: { serviceId: 'existing-web' } } } });
    const store = new SpecStore();
    const spec = { version: 1, project: project.name, gitRemoteUrl: 'https://github.com/owner/production-app.git', environments: { test: {
      hosting: { provider: 'cloudrun' }, services: { web: {} }, database: { provider: 'cloudsql', engine: 'postgres' },
      backups: { mode: 'daily', runnerImage: `registry/helper@sha256:${'a'.repeat(64)}`, run: { id: 'pre-live-check' } },
    } } };
    expect(() => store.replace(project, spec)).not.toThrow();
    const broad = vi.spyOn(PlanService.prototype, 'observeEnvironment').mockRejectedValue(Error('Unrelated deployment observation forbidden'));
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(targets, 'resolveManagedBackupTarget').mockResolvedValue({ state: 'blocked', issues: ['Synthetic native prerequisites are not yet ready.'] });
    const result: any = await registry.get('hv_plan')!.execute({ project: project.name, env: 'test', scope: 'backups', includeEnvFile: false });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data.scope).toBe('backup-run');
    expect(result.data.actions).toHaveLength(1);
    expect(result.data.actions[0]).toMatchObject({ verified: false });
    expect((ctx.repos.runs.findById(result.data.planId)!.plan as any).actions[0].metadata.operation).toBe('manualBackupRun');
    expect(broad).not.toHaveBeenCalled();
  });
  function readyFixture() {
    const ctx = createCommandContext(), registry = new CommandRegistry(); registerCoreTools(registry, ctx);
    const project = ctx.repos.projects.create({ name: 'manual-host', defaultPlatform: 'cloudrun' });
    const runtime = { provider: 'cloudrun', evidence: { source: 'exact-native-source' } };
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: {
      provider: 'cloudrun', projectId: 'native-project', services: { web: { serviceId: 'unchanged-web' } },
      appliedSpecHash: 'unchanged-deployment', recoveryRuntime: runtime,
    } });
    const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'existing-sql',
      bindings: { provider: 'cloudsql', providerScope: { projectId: 'native-project' } } });
    const store = new SpecStore(); const image = `registry/helper@sha256:${'a'.repeat(64)}`;
    store.replace(project, { version: 1, project: project.name, gitRemoteUrl: 'https://github.com/owner/unrelated-production-root.git', environments: { test: {
      hosting: { provider: 'cloudrun' }, services: { web: {} }, database: { provider: 'cloudsql', engine: 'postgres' },
      backups: { mode: 'daily', runnerImage: image, run: { id: 'once-before-live' } },
    } } });
    const target: targets.ManagedBackupTarget = { version: 1, project: project.name, environment: environment.name, environmentId: environment.id,
      hosting: { provider: 'cloudrun', providerScope: { projectId: 'native-project' }, region: 'us-central1' }, runnerImage: image,
      destination: { name: 'archive', identity: { provider: 'gcs', externalId: 'existing-archive', instanceScope: { projectId: 'native-project' } } },
      database: { componentId: component.id, source: { provider: 'cloudsql', primaryExternalId: 'existing-sql', providerScope: { projectId: 'native-project' }, resourceIdentity: { instanceId: 'original-sql-lifetime' } } },
      objects: [], fileReferenceQueries: [], retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7,
      runtimeBindingHash: canonicalJsonSha256(runtime), executionTarget: { provider: 'cloudrun', environmentId: environment.id, region: 'us-central1',
        providerScope: { projectId: 'native-project' }, identity: { provider: 'gcp', principal: 'backup@example.iam.gserviceaccount.com', scope: { projectId: 'native-project' }, source: 'observed' },
        configuration: { nativeIdentity: 'unchanged-backup' }, worker: { provider: 'cloudrun', configuration: { nativeIdentity: 'unchanged-backup' } } },
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async provider => ({ success: true, connectionProvider: provider, adapter: { name: provider } as never }));
    const source = vi.spyOn(targets, 'resolveManagedBackupTarget').mockImplementation(async () => ({ state: 'ready', target,
      contractHash: targets.managedBackupTargetHash(target), providerCredentialNames: [] }));
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    const broad = vi.spyOn(PlanService.prototype, 'observeEnvironment').mockRejectedValue(Error('Unrelated observation forbidden'));
    const execute = vi.spyOn(engine, 'executeLocalManagedBackup').mockImplementation(async params => {
      const retained = ctx.repos.environments.findById(environment.id)!.platformBindings.manualRecovery as any;
      expect(retained['once-before-live'].executionId).toBe(params.executionId);
      await params.lifecycle.persist({ version: 1, provider: 'cloudrun', authorityHash: 'b'.repeat(64), phase: 'complete',
        coordinates: { jobName: 'exact-job', jobUid: 'exact-job-uid', executionName: 'exact-execution', executionUid: 'exact-execution-uid' }, terminal: { status: 'succeeded', exitCode: 0 } });
      await params.beforeCompletion('exact-execution');
      return { version: 2, environment: environment.name, status: 'healthy', reasonCodes: [], counts: { applied: 1, skipped: 0 }, setId: params.executionId };
    });
    const archive = { destroy: vi.fn() };
    vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true, adapter: { name: 'gcs' } as never });
    vi.spyOn(targets, 'openRecoveryStorage').mockResolvedValue(archive as never);
    vi.spyOn(health, 'observeRecoveryExecution').mockResolvedValue({ setId: 'exact-set', completedAt: new Date().toISOString() });
    const plan = () => registry.get('hv_plan')!.execute({ project: project.name, env: 'test', scope: 'backups', includeEnvFile: false }) as Promise<any>;
    const apply = (planId: string, confirmActions: string[] = []) => {
      const current = store.get(project)!;
      return executePlanApply(ctx, { project, spec: current.spec, specRevision: current.revision, planId, confirmActions });
    };
    return { ctx, registry, project, environment, component, store, target, source, broad, execute, archive, plan, apply };
  }
  it('requires exact confirmation then keeps a completed one-use request mutation-free without CI credentials', async () => {
    const f = readyFixture(), first = await f.plan();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.data.scope).toBe('backup-run');
    expect(first.data.actions[0]).toMatchObject({ requiresConfirm: true, billable: true, dataBearing: true });
    const skipped = await f.apply(first.data.planId);
    expect(f.execute).not.toHaveBeenCalled();
    expect(skipped.kind).toBe('executed');
    const review = await f.plan();
    const done = await f.apply(review.data.planId, ['manual-backup:once-before-live']);
    expect(done.kind, JSON.stringify(done)).toBe('executed');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0][0].target.automation).toBeUndefined();
    const bindings: any = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    expect(bindings.manualRecovery['once-before-live'].complete).toBe(true);
    expect(bindings.services).toEqual(f.environment.platformBindings.services);
    expect(bindings.appliedSpecHash).toBe('unchanged-deployment');
    const repeated = await f.plan();
    expect((f.ctx.repos.runs.findById(repeated.data.planId)!.plan as any).actions[0].type).toBe('noop');
    await f.apply(repeated.data.planId);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.broad).not.toHaveBeenCalled();
    expect(f.source.mock.calls.every(([, options]) => options?.localAuthority === true)).toBe(true);
  });
  it('retains an uncertain checkpoint through restart and only resumes the same request', async () => {
    const f = readyFixture();
    f.execute.mockImplementationOnce(async params => {
      await params.lifecycle.persist({ version: 1, provider: 'cloudrun', authorityHash: 'c'.repeat(64), phase: 'run-attempted', coordinates: { jobName: 'exact-job', jobUid: 'original-job' } });
      throw Error('Synthetic lost run acknowledgment');
    });
    const first = await f.plan(); await f.apply(first.data.planId, ['manual-backup:once-before-live']);
    const pending: any = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.manualRecovery;
    expect(pending['once-before-live'].checkpoint.phase).toBe('run-attempted');
    expect(pending['once-before-live'].complete).toBeUndefined();
    const again = await f.plan(); await f.apply(again.data.planId, ['manual-backup:once-before-live']);
    expect(f.execute.mock.calls[1][0].lifecycle.state).toEqual(pending['once-before-live'].checkpoint);
    expect(f.execute.mock.calls[1][0].executionId).toBe(f.execute.mock.calls[0][0].executionId);
  });
  it('preserves the closed preflight diagnosis through the actual apply result without exposing provider text', async () => {
    const f = readyFixture();
    f.execute.mockRejectedValueOnce(recoveryFailure('credentials', 'authorization', undefined,
      { mutationAttempted: false }, 'postgres://private-value-must-not-escape'));
    const planned = await f.plan();
    const result: any = await f.registry.get('hv_apply')!.execute({ project: f.project.name, planId: planned.data.planId,
      confirmActions: ['manual-backup:once-before-live'] });
    expect(result.data.receipts).toMatchObject([{ status: 'pending', data: { diagnostic: {
      stage: 'credentials', category: 'authorization', task: { mutationAttempted: false },
    } } }]);
    const retained: any = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.manualRecovery;
    expect(retained['once-before-live'].checkpoint).toBeUndefined();
    expect(retained['once-before-live'].complete).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(JSON.stringify(f.ctx.repos.runs.findById(result.data.applyRunId)?.receipts)).not.toContain('private-value');
  });
  it('preserves a validated nonhealthy local result diagnostic and ignores arbitrary thrown diagnostic text', async () => {
    const f = readyFixture();
    f.execute.mockResolvedValueOnce({ version: 2, environment: f.environment.name, status: 'unknown', reasonCodes: ['cleanup-unverified'],
      counts: { applied: 1, skipped: 0 }, diagnostic: { stage: 'restore-cleanup', category: 'cleanup', localCleanupFailed: true } });
    const planned = await f.plan();
    const first: any = await f.registry.get('hv_apply')!.execute({ project: f.project.name, planId: planned.data.planId,
      confirmActions: ['manual-backup:once-before-live'] });
    expect(first.data.receipts[0]).toMatchObject({ status: 'pending', data: { diagnostic: { stage: 'restore-cleanup', category: 'cleanup', localCleanupFailed: true } } });
    f.execute.mockRejectedValueOnce(Object.assign(Error('private-password'), { diagnostic: { stage: 'private-stage', category: 'private-category' } }));
    const again = await f.plan();
    const second: any = await f.registry.get('hv_apply')!.execute({ project: f.project.name, planId: again.data.planId,
      confirmActions: ['manual-backup:once-before-live'] });
    expect(JSON.stringify(second)).not.toMatch(/private-password|private-stage|private-category/);
    expect(second.data.receipts[0].status).toBe('pending');
  });
  it('continues a reserved preflight failure under the same request with no prior native checkpoint', async () => {
    const f = readyFixture();
    f.execute.mockRejectedValueOnce(recoveryFailure('credentials', 'unknown', undefined, { mutationAttempted: false }));
    const first = await f.plan();
    await f.apply(first.data.planId, ['manual-backup:once-before-live']);
    const prior: any = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.manualRecovery;
    expect(prior['once-before-live'].checkpoint).toBeUndefined();
    const next = await f.plan();
    const nextAction = (f.ctx.repos.runs.findById(next.data.planId)!.plan as any).actions[0];
    expect(nextAction.metadata.recordHash).toBe(canonicalJsonSha256(prior['once-before-live']));
    expect(nextAction.metadata.executionId).toBe(prior['once-before-live'].executionId);
    await f.apply(next.data.planId, ['manual-backup:once-before-live']);
    expect(f.execute.mock.calls[1][0].lifecycle.state).toBeUndefined();
    expect(f.execute.mock.calls[1][0].executionId).toBe(prior['once-before-live'].executionId);
    expect((f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.manualRecovery as any)['once-before-live'].complete).toBe(true);
    const done = await f.plan(); await f.apply(done.data.planId);
    expect(f.execute).toHaveBeenCalledTimes(2); // The first call never reached native progress.
  });
  it.each(['before-provider', 'during-callback'])('refuses a concurrent binding overwrite %s', async when => {
    const f = readyFixture(); const first = await f.plan();
    const change = () => { const current = f.ctx.repos.environments.findById(f.environment.id)!;
      f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { ...current.platformBindings, unrelated: 'concurrent-value' }); };
    if (when === 'before-provider') change();
    else f.execute.mockImplementationOnce(async params => {
      change(); await expect(params.lifecycle.persist({ version: 1, provider: 'cloudrun', authorityHash: 'c'.repeat(64), phase: 'create-attempted', coordinates: { jobName: 'reserved-job' } })).rejects.toThrow();
      throw Error('Stopped before native create');
    });
    await f.apply(first.data.planId, ['manual-backup:once-before-live']);
    const current: any = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    expect(current.unrelated).toBe('concurrent-value');
    expect(current.manualRecovery?.['once-before-live']?.complete).toBeUndefined();
    if (when === 'before-provider') expect(f.execute).not.toHaveBeenCalled();
  });
  it('rejects forged source, resource, dependencies and deployment inputs in saved manual plans', async () => {
    const f = readyFixture(); const result = await f.plan();
    const saved = f.ctx.repos.runs.findById(result.data.planId)!.plan as any;
    expect(planRunDocumentSchema.safeParse(saved).success).toBe(true);
    for (const mutate of [
      (p: any) => p.actions[0].resource.name = 'web',
      (p: any) => p.actions[0].requiresConfirm = false,
      (p: any) => p.actions[0].metadata.extra = 'unreviewed',
      (p: any) => p.actions[0].dependsOn = ['unrelated'],
      (p: any) => p.sourceCommitSha = 'a'.repeat(40),
      (p: any) => p.overrides = { services: ['web'] },
    ]) { const changed = structuredClone(saved); mutate(changed); expect(planRunDocumentSchema.safeParse(changed).success).toBe(false); }
  });
  it('rejects imported operation authority and preserves its local history', () => {
    const local = { manualRecovery: { retained: { durable: true } }, projectId: 'local' };
    expect(() => mergeRepoPlatformBindings({}, { manualRecovery: {} })).toThrow(/local/);
    expect(mergeRepoPlatformBindings(local, { projectId: 'local' }).manualRecovery).toEqual(local.manualRecovery);
  });

  it.each(['component', 'spec', 'connection', 'environment-connection'])('stops before the next native effect after %s authority changes', async changed => {
    const f = readyFixture();
    const connection = f.ctx.repos.connections.create({ provider: 'cloudrun', credentialsEncrypted: 'synthetic-encrypted-reference' });
    f.ctx.repos.connections.updateStatus(connection.id, 'verified');
    const scoped = changed === 'environment-connection' ? f.ctx.repos.connections.create({ provider: 'cloudrun', scope: 'github.com/owner/unrelated-production-root#environment=test', credentialsEncrypted: 'synthetic-scoped-reference' }) : undefined;
    if (scoped) f.ctx.repos.connections.updateStatus(scoped.id, 'verified');
    let denied = false;
    f.execute.mockImplementationOnce(async params => {
      if (changed === 'component') f.ctx.repos.components.updateBindings(f.component.id, { ...f.component.bindings, providerScope: { projectId: 'other-project' } });
      if (changed === 'spec') { const before = f.store.get(f.project)!.spec; f.store.replace(f.project, { ...before, environments: { ...before.environments, test: { ...before.environments.test, backups: { mode: 'daily', run: { id: 'different-request' } } } } }); }
      if (changed === 'connection') f.ctx.repos.connections.updateStatus(connection.id, 'failed');
      if (changed === 'environment-connection') f.ctx.repos.connections.updateStatus(scoped!.id, 'failed');
      try { await params.lifecycle.persist({ version: 1, provider: 'cloudrun', authorityHash: 'c'.repeat(64), phase: 'create-attempted', coordinates: { jobName: 'reserved-job' } }); } catch { denied = true; }
      throw Error('No native write after changed authority');
    });
    const review = await f.plan(); await f.apply(review.data.planId, ['manual-backup:once-before-live']);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(denied).toBe(true);
  });

  it('joins the real local executor, retained archive verification and SQLite completion without deleting older archives', async () => {
    const f = readyFixture(); f.execute.mockRestore(); vi.mocked(health.observeRecoveryExecution).mockRestore();
    const values = new Map<string, Buffer>([['older-recovery-set/retained.dump', Buffer.from('older retained archive')]]);
    const revision = (bytes: Buffer) => ({ etag: createHash('sha256').update(bytes).digest('hex') });
    const remove = vi.fn(async () => { throw Error('Retention deletion forbidden'); });
    const archive: StorageObjectClient = {
      async list(options) { return [...values].filter(([key]) => !options?.prefix || key.startsWith(options.prefix)).map(([key, bytes]) => ({ key, size: bytes.length, revision: revision(bytes) })); },
      async get(key) { const bytes = values.get(key); if (!bytes) throw Error('Missing object'); return { body: Readable.from([bytes]), size: bytes.length, revision: revision(bytes) }; },
      async put(key, payload, options) { if (options?.ifAbsent && values.has(key)) throw Error('Existing object'); const parts: Buffer[] = []; for await (const part of payload.body as Readable) parts.push(Buffer.from(part)); values.set(key, Buffer.concat(parts)); },
      remove, destroy() {},
    };
    vi.mocked(targets.openRecoveryStorage).mockResolvedValue(archive);
    let taskCalls = 0;
    const runJob = vi.fn(async (_environment, _service, _command, options) => {
      taskCalls++;
      const task = options.managedRecoveryTask;
      const checkpoint = { version: 1 as const, provider: 'cloudrun', authorityHash: 'd'.repeat(64), coordinates: { jobName: 'exact-job', jobUid: 'exact-job-uid', executionName: 'exact-execution', executionUid: 'exact-execution-uid' } };
      await task.lifecycle.persist({ ...checkpoint, phase: 'running' });
      const config = JSON.parse(task.variables.HYPERVIBE_BACKUP_CONFIG);
      // Real manifest producer/coordinator with synthetic SQL restore evidence.
      // Native task and real PostgreSQL compatibility are separate contract suites.
      await createRecoverySet({ runId: task.executionId, project: f.target.project, environment: f.target.environment,
        contractHash: config.contractHash, destination: f.target.destination.identity, archive, objects: [],
        database: { source: f.target.database!.source, sourceUrl: 'postgres://synthetic-private-fixture' } }, {
        backupDatabase: async input => {
          const bytes = Buffer.from('synthetic verified SQL archive');
          const proof: PostgresBackupEvidence = { formatVersion: POSTGRES_BACKUP_FORMAT_VERSION, mechanism: 'postgres-logical-archive', source: input.source,
            destination: input.destination, runId: input.runId, archiveKey: `${input.archivePrefix}/${input.runId}/database.dump`,
            manifestKey: `${input.archivePrefix}/${input.runId}/database.complete.json`, archiveRevision: revision(bytes), sha256: revision(bytes).etag,
            bytes: bytes.length, dataTime: new Date().toISOString(), completedAt: new Date().toISOString(), sourceVersion: '15', targetVersion: '15',
            tableCount: 1, totalRows: '1', restoreVerified: true, cleanupVerified: true, coverage: 'single-database-schema-and-data',
            applicationCompatibility: 'unverified', applied: 1, skipped: 0 };
          values.set(proof.archiveKey, bytes); values.set(proof.manifestKey, Buffer.from(JSON.stringify(proof)));
          return { evidence: proof, fileReferences: [] };
        },
      });
      await task.lifecycle.persist({ ...checkpoint, phase: 'complete', terminal: { status: 'succeeded', exitCode: 0 } });
      return { jobId: 'exact-execution', status: 'completed', exitCode: 0, mutationAttempted: true, receipt: { success: true, message: 'Synthetic native cleanup verified', data: { cleanupVerified: true } } };
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async provider => ({ success: true, connectionProvider: provider, adapter: {
      name: provider, configureTarget: vi.fn(), ...(provider === 'cloudrun' ? { runJob } : {}),
      ...(provider === 'cloudsql' ? { dailyBackups: { observe: async () => ({ state: 'known', source: f.target.database!.source }) } } : {}),
    } as never }));
    const first = await f.plan(); const outcome = await f.apply(first.data.planId, ['manual-backup:once-before-live']);
    expect(outcome.kind, JSON.stringify(outcome)).toBe('executed');
    const retained: any = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.manualRecovery;
    expect(retained['once-before-live'].complete, JSON.stringify(outcome)).toBe(true);
    expect(retained['once-before-live'].jobId).toBe('exact-execution');
    expect(values.has('older-recovery-set/retained.dump')).toBe(true); expect(remove).not.toHaveBeenCalled();
    expect([...values.keys()].filter(key => key.endsWith('execution.complete.json'))).toHaveLength(1);
    const again = await f.plan(); expect((f.ctx.repos.runs.findById(again.data.planId)!.plan as any).actions[0].type).toBe('noop');
    await f.apply(again.data.planId); expect(taskCalls).toBe(1);
    const markerKey = [...values.keys()].find(key => key.endsWith('execution.complete.json'))!;
    values.set(markerKey, Buffer.from(JSON.stringify({ ...JSON.parse(values.get(markerKey)!.toString()), jobId: 'other-execution' })));
    const changed = await f.plan(); expect(changed.data.actions[0].verified).toBe(false); expect(taskCalls).toBe(1);
  });

  it('does not reuse a hosted deployment-only grant as local backup authority', async () => {
    const f = readyFixture();
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, connectionProvider: 'hypervibe-deployment-binding', adapter: { name: 'cloudrun' } as never });
    const result = await f.plan();
    expect(result.data.actions[0]?.verified).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['cli', 'mcp'])('reaches the same isolated saved backup plan through %s', async transport => {
    const f = readyFixture(); const args = { project: f.project.name, env: 'test', scope: 'backups', includeEnvFile: false }; let result: any;
    if (transport === 'cli') {
      let output = '';
      await runCli(['plan', '--input', '-', '--json'], { registry: f.registry, initialize: false, io: {
        readStdin: async () => JSON.stringify(args), writeOut: value => { output += value; }, writeErr: () => {}, confirm: async () => false, stdinIsTTY: false,
      } }); result = JSON.parse(output);
    } else {
      const server = new McpServer({ name: 'manual-backup', version: '1' }); registerCoreTools(createMcpCommandRegistrar(server), f.ctx);
      const client = new Client({ name: 'manual-backup', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);
      try { result = (await client.callTool({ name: 'hv_plan', arguments: args })).structuredContent; }
      finally { await client.close(); await server.close(); }
    }
    expect(result?.ok, JSON.stringify(result)).toBe(true); expect(result.data.scope).toBe('backup-run');
    expect((f.ctx.repos.runs.findById(result.data.planId)!.plan as any).actions[0].metadata.operation).toBe('manualBackupRun');
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([{ services: ['web'] }, { envVars: { PRIVATE_INPUT: 'must-not-be-used' } }, { includeEnvFile: true }, { credential: 'DATABASE_PASSWORD' }, { intent: 'replace' }])('rejects unrelated manual-run inputs %j', async extra => {
    const f = readyFixture(); const result: any = await f.registry.get('hv_plan')!.execute({ project: f.project.name, env: 'test', scope: 'backups', ...extra });
    expect(result.ok).toBe(false); expect(f.execute).not.toHaveBeenCalled();
  });
  it('keeps a one-use reservation after desired intent removal and rejects a changed target under its id', async () => {
    const f = readyFixture(); f.execute.mockRejectedValueOnce(Error('Synthetic interruption before task acknowledgment'));
    const first = await f.plan(); await f.apply(first.data.planId, ['manual-backup:once-before-live']);
    const before = f.store.get(f.project)!.spec;
    f.store.replace(f.project, { ...before, environments: { test: { ...before.environments.test, backups: { mode: 'daily', runnerImage: f.target.runnerImage } } } });
    expect((f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.manualRecovery as any)['once-before-live']).toBeTruthy();
    f.store.replace(f.project, before); f.target.runnerImage = `registry/helper@sha256:${'f'.repeat(64)}`;
    const next = await f.plan(); expect(next.data.actions[0].verified).toBe(false); expect(f.execute).toHaveBeenCalledOnce();
  });

});
