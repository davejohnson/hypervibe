import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter, getDb } from '../../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../../application/context.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { projectSpecSchema, type ProjectSpec } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { planDatabaseBootstrap, applyDatabaseBootstrap } from '../database-bootstrap.service.js';
import { databaseBootstrapActionSchema, databaseBootstrapRecoverySchema, hasPendingDatabaseBootstrap } from '../../plan/database-bootstrap.contract.js';
import type { DatabaseTaskCheckpoint, EnvironmentTaskOptions } from '../../ports/hosting.port.js';
import '../../../application/providers.js';

// Real SQLite/encrypted persistence; provider observations and task effects are
// synthetic lifecycle evidence. The emitted program has separate real PG tests.
let directory: string, ctx: ReturnType<typeof createCommandContext>, project: ReturnType<typeof ctx.repos.projects.create>;
let environment: ReturnType<typeof ctx.repos.environments.create>, component: ReturnType<typeof ctx.repos.components.create>;
let spec: ProjectSpec, inspect: ReturnType<typeof vi.fn>, runJob: ReturnType<typeof vi.fn>, starts: number;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const image = `ghcr.io/owner/app@sha256:${'a'.repeat(64)}`;
const source = { provider: 'railway', primaryExternalId: 'db-id', providerScope: { projectId: 'native-project', environmentId: 'native-environment' },
  resourceIdentity: { volumeId: 'new-volume', volumeInstanceId: 'new-volume-instance' } };
const privateUrl = 'postgresql://private-bootstrap-user:private-bootstrap-password@database.railway.internal:5432/private-bootstrap-database';
const privateHash = hash(privateUrl);
const evidence = () => ({ source, databaseDeploymentId: 'new-db-deployment', image, sourceServiceId: 'web-id', sourceInstanceId: 'web-instance',
  variableReferences: [{ sourceServiceId: 'db-id', variableName: 'DATABASE_URL', targetName: 'DATABASE_URL' }], approvedVariables: { NODE_ENV: 'production' },
  verification: { rawReferences: 'verified', configuredValues: 'matched', sqlAuthentication: 'unchecked', deployedConfiguration: 'unchecked', applicationOperation: 'unchecked' },
  privateConfiguration: { keys: ['DATABASE_URL'], expectedHashes: { DATABASE_URL: privateHash },
    authentication: { username: 'private-bootstrap-user', database: 'private-bootstrap-database' },
    rawDefinitions: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' }, issuerDefinitions: { DATABASE_URL: privateUrl }, resolvedValues: { DATABASE_URL: privateUrl } } });
const pending = { jobId: '', status: 'running', receipt: { success: false, message: 'pending', data: { cleanupVerified: false } } };
const job = (state: DatabaseTaskCheckpoint) => ({ jobId: state.deploymentId, status: state.terminal!.status === 'succeeded' ? 'completed' : 'failed', exitCode: state.terminal!.exitCode,
  receipt: { success: state.terminal!.status === 'succeeded', message: 'finite result', data: { cleanupVerified: true, databaseTask: state.terminal!.result } } });
function terminal(options: EnvironmentTaskOptions, failed = false): DatabaseTaskCheckpoint {
  const declared = options.declaredTask!, task = declared.databaseTask!;
  return { version: 1, authorityHash: hash('public-authority'), phase: 'terminal', taskServiceId: `task-${task.mode}`,
    taskInstanceId: `instance-${task.mode}`, deploymentId: `deployment-${task.mode}`, terminal: {
      status: failed ? 'failed' : 'succeeded', exitCode: failed ? 1 : 0,
      result: { version: 1, executionId: declared.executionId, mode: task.mode, commandHash: task.commandHash,
        authentication: failed ? 'rejected' : 'authenticated', migration: !failed && task.mode === 'migrate' ? 'completed' : 'unchecked',
        ...(!failed && task.mode === 'migrate' ? { exitCode: 0 } : {}) },
    } };
}
async function advance(options: EnvironmentTaskOptions, failed = false, stopAt: 'deployed' | 'cleanup-attempted' | 'complete' = 'complete') {
  const task = options.declaredTask!.databaseTask!, end = terminal(options, failed);
  const identity = { version: end.version, authorityHash: end.authorityHash };
  const owned = { ...identity, taskServiceId: end.taskServiceId, taskInstanceId: end.taskInstanceId };
  const sequence: DatabaseTaskCheckpoint[] = [
    { ...identity, phase: 'create-attempted' }, { ...identity, phase: 'created', taskServiceId: end.taskServiceId },
    { ...owned, phase: 'created' }, { ...owned, phase: 'configure-attempted' }, { ...owned, phase: 'configured' },
    { ...owned, phase: 'deploy-attempted' }, { ...owned, phase: 'deployed', deploymentId: end.deploymentId }, end,
    { ...end, phase: 'cleanup-attempted' }, ...(stopAt === 'complete' ? [{ ...end, phase: 'complete' as const }] : []),
  ];
  const previous = task.state ? sequence.map(item => item.phase).lastIndexOf(task.state.phase) : -1;
  let state = task.state;
  for (const next of sequence.slice(previous + 1)) {
    state = await task.persist(next);
    if (next.phase === stopAt) break;
  }
  return state!;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hv-bootstrap-lifecycle-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(join(directory, 'test.db')).migrate();
  ctx = createCommandContext(); project = ctx.repos.projects.create({ name: 'bootstrap-test', defaultPlatform: 'railway' });
  spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: {
    hosting: { provider: 'railway' }, services: { web: { releaseCommand: 'npm run db:migrate' } }, envVars: { NODE_ENV: 'production' },
    database: { provider: 'railway', freshInitialization: { id: 'empty-once', discardExistingData: true,
      target: { externalId: source.primaryExternalId, providerScope: source.providerScope } } },
  } } });
  (spec.environments.production.database!.freshInitialization as any).bootstrap = { service: 'web', image };
  environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', ...source.providerScope, services: { web: { serviceId: 'web-id' } }, appliedSpecHash: 'unchanged-application-contract',
  } });
  ctx.repos.services.create({ projectId: project.id, name: 'web', buildConfig: spec.environments.production.services.web });
  component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: source.primaryExternalId,
    bindings: { provider: 'railway', providerScope: source.providerScope, volumeId: 'new-volume', volumeInstanceId: 'new-volume-instance' } });
  const target = { provider: source.provider, externalId: source.primaryExternalId, providerScope: source.providerScope };
  const metadata = { operation: 'databaseFreshInitialize', componentId: component.id, intentId: 'empty-once', target,
    configurationFingerprint: hash('public-config'), bindingsFingerprint: hash('public-bindings'), environmentFingerprint: hash('public-environment') };
  ctx.repos.components.updateBindings(component.id, { freshInitialization: { metadata, inspectionEncrypted: getSecretStore().encryptObject({ synthetic: true }),
    startedAt: '2026-01-01T00:00:00.000Z', progress: { phase: 'complete', storageId: 'new-volume', storageInstanceId: 'new-volume-instance', deploymentId: 'new-db-deployment' },
    storageBindings: { volumeId: 'new-volume', volumeInstanceId: 'new-volume-instance' }, completed: { intentId: 'empty-once', target,
      storageId: 'new-volume', storageInstanceId: 'new-volume-instance', deploymentId: 'new-db-deployment', configurationFingerprint: hash('public-config'), verifiedAt: '2026-01-01T00:01:00.000Z' } } });
  starts = 0; inspect = vi.fn(async () => evidence());
  runJob = vi.fn(async (_environment, _service, _command, options: EnvironmentTaskOptions) => {
    const task = options.declaredTask!.databaseTask!;
    if (task.state?.phase === 'create-attempted') return pending;
    if (!task.state) starts++;
    const complete = await advance(options); return job(complete);
  });
  vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({ success: true, adapter: { name: 'railway', databaseInitialization: { inspect }, runJob } as any });
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
const plan = async () => {
  const result = await planDatabaseBootstrap({ project, spec, revision: 1, environmentName: 'production' });
  if (result && 'error' in result) throw new Error(result.error);
  return result;
};
async function apply(planned: NonNullable<Awaited<ReturnType<typeof plan>>>, confirmed = true) {
  const document = ctx.repos.runs.findById(planned.planRunId)!.plan as any;
  return applyDatabaseBootstrap({ project, spec: spec.environments.production, environmentName: 'production', action: planned.actions[0],
    confirmed: new Set(confirmed ? [planned.actions[0].id] : []), encrypted: document.overrides?.databaseBootstrapEncrypted });
}
const recovery = () => databaseBootstrapRecoverySchema.parse(ctx.repos.components.findById(component.id)!.bindings.databaseBootstrap);

describe('isolated database bootstrap lifecycle', () => {
  it('freezes encrypted private expectations, authenticates separately, then consumes the exact migration once', async () => {
    const authentication = (await plan())!;
    expect(authentication.actions).toHaveLength(1); expect(authentication.actions[0]).toMatchObject({ billable: true, requiresConfirm: true, dataBearing: false,
      metadata: { operation: 'databaseBootstrapAuthenticate', mode: 'authenticate' } });
    expect(starts).toBe(0);
    for (const serialized of [JSON.stringify(authentication), JSON.stringify(ctx.repos.runs.findById(authentication.planRunId)!.plan)]) {
      expect(serialized).not.toContain(privateUrl); expect(serialized).not.toContain(privateHash); expect(serialized).not.toContain('private-bootstrap-user');
    }
    expect(await apply(authentication)).toMatchObject({ success: true });
    const migration = (await plan())!;
    expect(migration.actions).toHaveLength(1); expect(migration.actions[0]).toMatchObject({ dataBearing: true, metadata: { operation: 'databaseBootstrapMigrate', mode: 'migrate' } });
    expect(await apply(migration, false)).toMatchObject({ success: false, status: 'blocked' }); expect(starts).toBe(1);
    expect(await apply(migration)).toMatchObject({ success: true }); expect(starts).toBe(2);
    expect(recovery().consumedAt).toBeDefined(); expect(await plan()).toBeNull();
    expect(await apply(migration)).toMatchObject({ success: true }); expect(starts).toBe(2);
    expect(ctx.repos.environments.findById(environment.id)!.platformBindings.appliedSpecHash).toBe('unchanged-application-contract');
    const persisted = JSON.stringify(getDb().prepare('SELECT bindings FROM components WHERE id=?').get(component.id));
    expect(persisted).not.toContain(privateUrl); expect(persisted).not.toContain(privateHash);
  });
  it('rejects unconfirmed, noop and broadened actions without provider execution', async () => {
    const p = (await plan())!;
    expect(await apply(p, false)).toMatchObject({ status: 'blocked' });
    for (const action of [{ ...p.actions[0], type: 'noop' }, { ...p.actions[0], dependsOn: ['other'] },
      { ...p.actions[0], billable: false }, { ...p.actions[0], metadata: { ...p.actions[0].metadata, expectedHashes: { DATABASE_URL: privateHash } } }]) {
      expect(databaseBootstrapActionSchema.safeParse(action).success).toBe(false);
    }
    expect(runJob).not.toHaveBeenCalled();
  });
  it('blocks changed private references or database identity after plan without leaking provider errors', async () => {
    const p = (await plan())!;
    inspect.mockResolvedValue({ ...evidence(), privateConfiguration: { ...evidence().privateConfiguration, rawDefinitions: { DATABASE_URL: '${{other.DATABASE_URL}}' } } });
    expect(await apply(p)).toMatchObject({ status: 'blocked' }); expect(runJob).not.toHaveBeenCalled();
    inspect.mockRejectedValue(new Error(privateUrl));
    const blocked = (await plan())!; expect(blocked.actions).toEqual([]); expect(blocked.blocked).toHaveLength(1); expect(JSON.stringify(blocked)).not.toContain(privateUrl);
  });
  it('persists uncertain execution before dispatch and never chooses another execution on retry', async () => {
    runJob.mockImplementationOnce(async (_env, _service, _command, options: EnvironmentTaskOptions) => {
      starts++; await options.declaredTask!.databaseTask!.persist({ version: 1, authorityHash: hash('public-authority'), phase: 'create-attempted' });
      throw new Error(privateUrl);
    });
    expect(await apply((await plan())!)).toMatchObject({ success: false });
    const original = recovery().authenticationExecutionId;
    expect(await apply((await plan())!)).toMatchObject({ success: false, status: 'pending' });
    expect(recovery().authenticationExecutionId).toBe(original); expect(starts).toBe(1);
    expect(runJob.mock.calls[1][3].declaredTask.databaseTask.state.phase).toBe('create-attempted');
  });
  it('retains terminal authentication failure and blocks automatic retry for this generation', async () => {
    runJob.mockImplementationOnce(async (_env, _service, _command, options: EnvironmentTaskOptions) => {
      starts++; return job(await advance(options, true));
    });
    expect(await apply((await plan())!)).toMatchObject({ success: false });
    const blocked = (await plan())!; expect(blocked.actions).toEqual([]); expect(blocked.blocked).toHaveLength(1); expect(starts).toBe(1);
    expect(hasPendingDatabaseBootstrap(ctx.repos.components.findById(component.id)!.bindings)).toBe(true);
  });
  it('resumes owned terminal cleanup despite changed command, then blocks any newly selected migration', async () => {
    runJob.mockImplementationOnce(async (_env, _service, _command, options: EnvironmentTaskOptions) => {
      starts++; await advance(options, false, 'cleanup-attempted'); return pending;
    });
    expect(await apply((await plan())!)).toMatchObject({ status: 'pending' });
    spec.environments.production.services.web.releaseCommand = 'npm run different-migration';
    inspect.mockRejectedValue(new Error('cleanup must not require changed configuration'));
    expect(await apply((await plan())!)).toMatchObject({ success: false, status: 'blocked', data: { cleanupVerified: true } }); expect(starts).toBe(1);
    expect(recovery().authentication?.phase).toBe('complete'); expect(recovery().authenticationVerifiedAt).toBeUndefined();
    expect((await plan())!.blocked).toHaveLength(1); expect(starts).toBe(1);
  });
  it('never re-arms consumed bootstrap when normal migration and backup configuration changes', async () => {
    await apply((await plan())!); const migration = (await plan())!; await apply(migration);
    (spec.environments.production.database as any).backups = { mode: 'daily' };
    expect(await plan()).toBeNull();
    spec.environments.production.services.web.releaseCommand = 'npm run new-migration';
    expect(await plan()).toBeNull();
    delete (spec.environments.production.database!.freshInitialization as any).bootstrap;
    expect(await plan()).toBeNull();
    expect(await apply(migration)).toMatchObject({ success: true, data: { providerMutations: 0 } }); expect(starts).toBe(2);
  });
  it('observes and cleans an acknowledged deployment despite drift without repeating its task', async () => {
    runJob.mockImplementationOnce(async (_env, _service, _command, options: EnvironmentTaskOptions) => {
      starts++; await advance(options, false, 'deployed'); return pending;
    });
    expect(await apply((await plan())!)).toMatchObject({ status: 'pending' });
    const execution = recovery().authenticationExecutionId;
    spec.environments.production.services.web.releaseCommand = 'npm run changed-migration';
    inspect.mockRejectedValue(new Error('current source is unavailable'));
    const resumed = (await plan())!;
    expect(resumed.actions).toHaveLength(1);
    expect(await apply(resumed)).toMatchObject({ success: false, status: 'blocked', data: { cleanupVerified: true } });
    expect(recovery().authenticationExecutionId).toBe(execution);
    expect(recovery().authentication?.phase).toBe('complete');
    expect(recovery().authenticationVerifiedAt).toBeUndefined(); expect(starts).toBe(1);
  });
  it('retains terminal receipts without current proof when the exact source changes during execution', async () => {
    const execute = runJob.getMockImplementation() as (...args: any[]) => Promise<any>;
    runJob.mockImplementationOnce(async (env, service, command, options) => {
      const result = await execute(env, service, command, options);
      inspect.mockResolvedValue({ ...evidence(), source: { ...source, resourceIdentity: { ...source.resourceIdentity, volumeInstanceId: 'replacement-volume-instance' } } });
      return result;
    });
    expect(await apply((await plan())!)).toMatchObject({ success: false, status: 'blocked', data: { cleanupVerified: true } });
    expect(recovery().authentication?.phase).toBe('complete'); expect(recovery().authenticationVerifiedAt).toBeUndefined();
    expect(recovery().consumedAt).toBeUndefined(); expect(starts).toBe(1); expect((await plan())!.blocked).toHaveLength(1);
  });
  it('refuses a provider callback that rewinds an acknowledged deployment to another create', async () => {
    runJob.mockImplementationOnce(async (_env, _service, _command, options: EnvironmentTaskOptions) => {
      const task = options.declaredTask!.databaseTask!;
      const identity = { version: 1 as const, authorityHash: hash('public-authority') };
      await task.persist({ ...identity, phase: 'create-attempted' });
      await task.persist({ ...identity, phase: 'created', taskServiceId: 'owned-task' });
      const owned = { ...identity, taskServiceId: 'owned-task', taskInstanceId: 'owned-instance' };
      await task.persist({ ...owned, phase: 'configure-attempted' });
      await task.persist({ ...owned, phase: 'configured' });
      await task.persist({ ...owned, phase: 'deploy-attempted' });
      await task.persist({ ...owned, phase: 'deployed', deploymentId: 'owned-deployment' });
      await task.persist({ ...identity, phase: 'create-attempted' });
      return pending;
    });
    expect(await apply((await plan())!)).toMatchObject({ success: false, status: 'blocked' });
    expect(recovery().authentication).toMatchObject({ phase: 'deployed', deploymentId: 'owned-deployment' });
  });
  it('requires persisted checkpoint readback before the adapter may create a task', async () => {
    let created = false;
    const original = ComponentRepository.prototype.updateBindings;
    vi.spyOn(ComponentRepository.prototype, 'updateBindings').mockImplementation(function (this: ComponentRepository, id, bindings) {
      if ((bindings.databaseBootstrap as any)?.authentication?.phase === 'create-attempted') return this.findById(id);
      return original.call(this, id, bindings);
    });
    runJob.mockImplementationOnce(async (_env, _service, _command, options: EnvironmentTaskOptions) => {
      await options.declaredTask!.databaseTask!.persist({ version: 1, authorityHash: hash('public-authority'), phase: 'create-attempted' });
      created = true; return pending;
    });
    expect(await apply((await plan())!)).toMatchObject({ success: false, status: 'blocked' });
    expect(created).toBe(false); expect(recovery().authentication).toBeUndefined();
  });
  it.each(['created', 'deployed'] as const)('retains a provider %s acknowledgement when journal readback fails without adopting it', async phase => {
    const original = ComponentRepository.prototype.updateBindings;
    vi.spyOn(ComponentRepository.prototype, 'updateBindings').mockImplementation(function (this: ComponentRepository, id, bindings) {
      if ((bindings.databaseBootstrap as any)?.authentication?.phase === phase) return this.findById(id);
      return original.call(this, id, bindings);
    });
    let acknowledged: DatabaseTaskCheckpoint | undefined;
    runJob.mockImplementationOnce(async (_env, _service, _command, options: EnvironmentTaskOptions) => {
      starts++;
      const task = options.declaredTask!.databaseTask!, persist = task.persist;
      task.persist = async next => { acknowledged = next; return persist(next); };
      try { await advance(options); } catch { /* Independent provider acknowledgement outlives local failure. */ }
      return { ...pending, receipt: { ...pending.receipt, data: { cleanupVerified: false,
        databaseTaskAcknowledgement: acknowledged, recoveryRequired: true } } };
    });
    const planned = (await plan())!;
    const result = await apply(planned);
    expect(result).toMatchObject({ success: false, status: 'blocked', data: {
      databaseTaskAcknowledgement: acknowledged, recoveryRequired: true, cleanupVerified: false,
    } });
    expect(recovery().authentication?.phase).toBe(phase === 'created' ? 'create-attempted' : 'deploy-attempted');
    expect(recovery().authenticationVerifiedAt).toBeUndefined(); expect(starts).toBe(1);
    expect(JSON.stringify(result)).not.toContain(privateUrl); expect(JSON.stringify(result)).not.toContain(privateHash);
    runJob.mockImplementationOnce(async (_env, _service, _command, options: EnvironmentTaskOptions) => {
      expect(options.declaredTask!.databaseTask!.state?.phase).toBe(phase === 'created' ? 'create-attempted' : 'deploy-attempted');
      return pending;
    });
    expect(await apply(planned)).toMatchObject({ success: false, status: 'pending' }); expect(starts).toBe(1);
  });
  it('passes only the provider-neutral completed storage coordinates to the inspector', async () => {
    await plan();
    expect(Object.keys(inspect.mock.calls[0][0].completedInitialization).sort())
      .toEqual(['deploymentId', 'storageId', 'storageInstanceId', 'target']);
  });
  it('blocks a database identity also owned by another environment before any task', async () => {
    const other = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'railway', ...source.providerScope } });
    ctx.repos.components.create({ environmentId: other.id, type: 'postgres', externalId: source.primaryExternalId,
      bindings: { provider: 'railway', providerScope: source.providerScope } });
    const result = (await plan())!;
    expect(result.actions).toEqual([]); expect(result.blocked).toHaveLength(1); expect(runJob).not.toHaveBeenCalled();
  });
});
