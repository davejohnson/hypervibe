import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { EnvironmentTaskOptions } from '../../domain/ports/hosting.port.js';
import * as backups from '../../domain/services/backup-policy.service.js';
import * as aliases from '../../domain/services/database-credential-aliases.service.js';
import '../providers.js';
import '../../adapters/providers/railway/railway.adapter.js';

const image = `ghcr.io/example/app@sha256:${'a'.repeat(64)}`;
const privateUrl = 'postgresql://application:synthetic-test@db.railway.internal/app';
const passwordHash = createHash('sha256').update(privateUrl).digest('hex');
let directory: string;
let ctx: ReturnType<typeof createCommandContext>;
let project: ReturnType<typeof ctx.repos.projects.create>;
let environment: ReturnType<typeof ctx.repos.environments.create>;
let spec: ReturnType<typeof projectSpecSchema.parse>;
let revision: number;
let inspect: ReturnType<typeof vi.fn>;
let runJob: ReturnType<typeof vi.fn>;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-bootstrap-integration-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  SqliteAdapter.resetInstance(); SecretStore.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  ctx = createCommandContext();
  project = ctx.repos.projects.create({ name: 'fresh-app', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/example/app' });
  environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'native-project', environmentId: 'native-production', services: { web: { serviceId: 'web-id' } },
  } });
  const target = { provider: 'railway', externalId: 'database-id',
    providerScope: { projectId: 'native-project', environmentId: 'native-production' } };
  spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: {
    hosting: { provider: 'railway' }, services: { web: {}, worker: { workloadKind: 'worker' } }, envVars: { NODE_ENV: 'production' },
    migrations: { mode: 'releaseCommand', command: 'npm run migrate' }, database: { provider: 'railway',
      freshInitialization: { id: 'fresh-production', discardExistingData: true, target: {
        externalId: target.externalId, providerScope: target.providerScope }, bootstrap: { service: 'web', image } } },
  } } });
  revision = new SpecStore().replace(project, spec).revision;
  ctx.repos.services.create({ projectId: project.id, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {} });
  const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: target.externalId });
  const completed = { intentId: 'fresh-production', target, storageId: 'new-volume', storageInstanceId: 'new-volume-instance',
    deploymentId: 'initialized-deployment', configurationFingerprint: 'b'.repeat(64), verifiedAt: '2026-10-26T00:00:00.000Z' };
  ctx.repos.components.updateBindings(component.id, { provider: 'railway', projectId: 'native-project',
    volumeId: completed.storageId, volumeInstanceId: completed.storageInstanceId, freshInitialization: {
      metadata: { operation: 'databaseFreshInitialize', componentId: component.id, intentId: completed.intentId, target,
        configurationFingerprint: completed.configurationFingerprint, bindingsFingerprint: 'c'.repeat(64), environmentFingerprint: 'd'.repeat(64) },
      inspectionEncrypted: ctx.secretStore.encryptObject({ target, configurationFingerprint: completed.configurationFingerprint,
        privateConfiguration: {} }), startedAt: '2026-10-25T23:59:00.000Z',
      progress: { phase: 'complete', storageId: completed.storageId, storageInstanceId: completed.storageInstanceId,
        deploymentId: completed.deploymentId }, storageBindings: { volumeId: completed.storageId,
        volumeInstanceId: completed.storageInstanceId }, completed,
    } });
  inspect = vi.fn(async () => ({ source: { provider: 'railway', primaryExternalId: target.externalId,
    providerScope: target.providerScope, resourceIdentity: { volumeId: completed.storageId, volumeInstanceId: completed.storageInstanceId } },
    databaseDeploymentId: completed.deploymentId, image, sourceServiceId: 'web-id', sourceInstanceId: 'web-instance',
    variableReferences: [{ sourceServiceId: 'database-id', variableName: 'DATABASE_URL', targetName: 'DATABASE_URL' }],
    approvedVariables: { NODE_ENV: 'production' },
    verification: { rawReferences: 'verified', configuredValues: 'matched', sqlAuthentication: 'unchecked',
      deployedConfiguration: 'unchecked', applicationOperation: 'unchecked' },
    privateConfiguration: { keys: ['DATABASE_URL'], expectedHashes: { DATABASE_URL: passwordHash },
      authentication: { username: 'application', database: 'app' }, rawDefinitions: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' },
      issuerDefinitions: { DATABASE_URL: '${{POSTGRES_PASSWORD}}' }, resolvedValues: { DATABASE_URL: privateUrl } },
  }));
  runJob = vi.fn(async (_environment, _service, _command, options: EnvironmentTaskOptions) => {
    const declared = options.declaredTask!, task = declared.databaseTask!;
    let state = task.state;
    if (!state) {
      state = await task.persist({ version: 1, authorityHash: 'e'.repeat(64), phase: 'create-attempted' });
      state = await task.persist({ ...state, phase: 'created', taskServiceId: `task-${task.mode}` });
      state = await task.persist({ ...state, phase: 'configure-attempted', taskInstanceId: `instance-${task.mode}` });
      state = await task.persist({ ...state, phase: 'configured' });
      state = await task.persist({ ...state, phase: 'deploy-attempted' });
      state = await task.persist({ ...state, phase: 'deployed', deploymentId: `deployment-${task.mode}` });
    }
    state = await task.persist({ ...state, phase: 'terminal', terminal: { status: 'succeeded', exitCode: 0, result: {
      version: 1, executionId: declared.executionId, mode: task.mode, commandHash: task.commandHash,
      authentication: 'authenticated', migration: task.mode === 'migrate' ? 'completed' : 'unchecked',
      ...(task.mode === 'migrate' ? { exitCode: 0 } : {}),
    } } });
    state = await task.persist({ ...state, phase: 'cleanup-attempted' });
    state = await task.persist({ ...state, phase: 'complete' });
    return { jobId: state.deploymentId, status: 'completed', exitCode: 0,
      receipt: { success: true, data: { cleanupVerified: true, databaseTask: state.terminal!.result } } };
  });
  vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({ success: true,
    adapter: { name: 'railway', databaseInitialization: { inspect }, runJob } as any });
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockRejectedValue(new Error('unrelated full rollout was reached'));
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); SecretStore.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

describe('fresh schema bootstrap in the normal plan/apply loop', () => {
  it.each(['railway', 'cloudsql'])('recovers the frozen host when desired Cloud Run hosting uses %s', async databaseProvider => {
    runJob.mockImplementationOnce(async (_environment, _service, _command, options: EnvironmentTaskOptions) => {
      const task = options.declaredTask!.databaseTask!;
      let state = await task.persist({ version: 1, authorityHash: 'e'.repeat(64), phase: 'create-attempted' });
      state = await task.persist({ ...state, phase: 'created', taskServiceId: 'owned-task' });
      state = await task.persist({ ...state, phase: 'configure-attempted', taskInstanceId: 'owned-instance' });
      state = await task.persist({ ...state, phase: 'configured' });
      state = await task.persist({ ...state, phase: 'deploy-attempted' });
      await task.persist({ ...state, phase: 'deployed', deploymentId: 'owned-deployment' });
      return { jobId: 'owned-deployment', status: 'running', receipt: { success: false } };
    });
    const first = await new PlanService().plan(project, 'production');
    if ('error' in first) throw new Error(first.error);
    await executePlanApply(ctx, { project, spec, specRevision: revision, planId: first.planRunId,
      confirmActions: [first.actions[0].id] });
    // Desired-provider validity and credentials cannot authorize or prevent
    // observation/cleanup of an already acknowledged Railway execution.
    spec.environments.production.hosting.provider = 'cloudrun';
    spec.environments.production.database!.provider = databaseProvider;
    revision = new SpecStore().replace(project, spec).revision;
    vi.mocked(PlanService.prototype.providerPreflight).mockImplementation(providers => providers
      .filter(provider => provider !== 'railway').map(provider => ({ provider, policy: 'hard', reason: 'Unrelated connection unavailable.' })));
    const recovery = await new PlanService().plan(project, 'production');
    expect(recovery).toMatchObject({ scope: 'database-bootstrap', blocked: [] });
    if ('error' in recovery) throw new Error(recovery.error);
    if (databaseProvider === 'railway') {
      const saved = ctx.repos.runs.findById(recovery.planRunId)!.plan! as Record<string, unknown>;
      ctx.repos.runs.updatePlan(recovery.planRunId, { ...saved, actions: [{ ...recovery.actions[0],
        metadata: { ...recovery.actions[0].metadata, executionId: '11111111-1111-4111-8111-111111111111' } }] });
      expect(await executePlanApply(ctx, { project, spec, specRevision: revision, planId: recovery.planRunId,
        confirmActions: [recovery.actions[0].id] })).toMatchObject({ kind: 'invalid_spec' });
      expect(runJob).toHaveBeenCalledOnce();
      ctx.repos.runs.updatePlan(recovery.planRunId, saved);
    }
    const result = await executePlanApply(ctx, { project, spec, specRevision: revision, planId: recovery.planRunId,
      confirmActions: [recovery.actions[0].id] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(PlanService.prototype.providerPreflight).toHaveBeenLastCalledWith(['railway']);
    expect(runJob).toHaveBeenCalledTimes(2);
    const retained = ctx.repos.components.findByEnvironmentAndType(environment.id, 'postgres')!.bindings.databaseBootstrap as any;
    expect(retained.authentication).toMatchObject({ phase: 'complete', deploymentId: 'owned-deployment' });
    expect(retained.authenticationVerifiedAt).toBeUndefined();
    expect(retained.consumedAt).toBeUndefined();
  });

  it('keeps desired-provider validation for new bootstrap execution', async () => {
    const first = await new PlanService().plan(project, 'production');
    if ('error' in first) throw new Error(first.error);
    spec.environments.production.hosting.provider = 'cloudrun';
    revision = new SpecStore().replace(project, spec).revision;
    expect(await new PlanService().plan(project, 'production')).toHaveProperty('error');
    expect(await executePlanApply(ctx, { project, spec, specRevision: revision, planId: first.planRunId,
      confirmActions: [first.actions[0].id] })).toMatchObject({ kind: 'invalid_spec' });
    expect(runJob).not.toHaveBeenCalled();
  });

  it('keeps retained task recovery reachable before proposing repairs to changed aliases', async () => {
    runJob.mockImplementationOnce(async (_environment, _service, _command, options: EnvironmentTaskOptions) => {
      const task = options.declaredTask!.databaseTask!;
      let state = await task.persist({ version: 1, authorityHash: 'e'.repeat(64), phase: 'create-attempted' });
      state = await task.persist({ ...state, phase: 'created', taskServiceId: 'owned-task' });
      state = await task.persist({ ...state, phase: 'configure-attempted', taskInstanceId: 'owned-instance' });
      state = await task.persist({ ...state, phase: 'configured' });
      state = await task.persist({ ...state, phase: 'deploy-attempted' });
      await task.persist({ ...state, phase: 'deployed', deploymentId: 'owned-deployment' });
      return { jobId: 'owned-deployment', status: 'running', receipt: { success: false } };
    });
    const first = await new PlanService().plan(project, 'production');
    if ('error' in first) throw new Error(first.error);
    expect(await executePlanApply(ctx, { project, spec, specRevision: revision, planId: first.planRunId,
      confirmActions: [first.actions[0].id] })).toMatchObject({ kind: 'executed', result: { success: false } });
    // Independent lifecycle requirement: observe/clean an acknowledged task
    // before new reference repair. Otherwise apply vetoes the proposed repair
    // while the planner makes the required recovery stage unreachable.
    const aliasPlan = vi.spyOn(aliases, 'planDatabaseCredentialAliases').mockResolvedValue({
      scope: 'database-credential-aliases', actions: [], blocked: [],
    } as any);
    inspect.mockRejectedValue(new Error('current database configuration changed'));
    const recovery = await new PlanService().plan(project, 'production');
    expect(recovery).toMatchObject({ scope: 'database-bootstrap', blocked: [], actions: [expect.objectContaining({
      metadata: expect.objectContaining({ mode: 'authenticate' }),
    })] });
    expect(aliasPlan).not.toHaveBeenCalled();
  });

  it('keeps storage initialization first when bootstrap is declared before storage exists', async () => {
    const component = ctx.repos.components.findByEnvironmentAndType(environment.id, 'postgres')!;
    ctx.repos.components.update(component.id, { bindings: { provider: 'railway', projectId: 'native-project' } });
    const storageInspection = vi.fn(async () => ({ state: 'eligible', inspection: {
      target: { provider: 'railway', ...spec.environments.production.database!.freshInitialization!.target },
      configurationFingerprint: 'b'.repeat(64), privateConfiguration: {},
    } }));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true,
      adapter: { name: 'railway', freshInitialization: { inspect: storageInspection } } as any });
    const planned = await new PlanService().plan(project, 'production');
    expect(planned).toMatchObject({ scope: 'database-initialization', blocked: [] });
    expect(storageInspection).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();
  });

  it('plans only private authentication before backups, managed releases or migration', async () => {
    const planned = await new PlanService().plan(project, 'production');
    expect(planned).toMatchObject({ scope: 'database-bootstrap', blocked: [] });
    if ('error' in planned) throw new Error(planned.error);
    expect(planned.actions).toHaveLength(1);
    expect(planned.actions[0]).toMatchObject({ requiresConfirm: true,
      metadata: { operation: 'databaseBootstrapAuthenticate' } });
    expect(JSON.stringify(planned)).not.toContain(passwordHash);
    const saved = ctx.repos.runs.findById(planned.planRunId)!.plan;
    expect(JSON.stringify(saved)).not.toContain(passwordHash);
    expect(planRunDocumentSchema.safeParse(saved).success).toBe(true);
    expect(PlanService.prototype.observeEnvironment).not.toHaveBeenCalled();
    const result = await executePlanApply(ctx, { project, spec, specRevision: revision, planId: planned.planRunId, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(runJob).not.toHaveBeenCalled();
  });

  it('separates confirmed authentication and migration, then preserves ordinary deployment connection checks', async () => {
    const before = structuredClone(environment.platformBindings);
    const staging = ctx.repos.environments.create({ projectId: project.id, name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'native-project', environmentId: 'native-staging' } });
    const documents = ctx.repos.components.create({ environmentId: environment.id, type: 'storage:documents',
      externalId: 'retained-documents', bindings: { provider: 'railway', objects: 15 } });
    for (const mode of ['authenticate', 'migrate']) {
      const planned = await new PlanService().plan(project, 'production');
      if ('error' in planned) throw new Error(planned.error);
      expect(planned.scope).toBe('database-bootstrap');
      expect(planned.actions).toHaveLength(1);
      expect(planned.actions[0].metadata?.mode).toBe(mode);
      const saved = ctx.repos.runs.findById(planned.planRunId)!.plan as Record<string, unknown>;
      expect(planRunDocumentSchema.safeParse({ ...saved, scope: 'full' }).success).toBe(false);
      expect(planRunDocumentSchema.safeParse({ ...saved, actions: [...planned.actions,
        { id: 'service:web', type: 'update', resource: { kind: 'service', provider: 'railway', name: 'web' },
          verified: true, reason: 'Unreviewed rollout' }] }).success).toBe(false);
      const result = await executePlanApply(ctx, { project, spec, specRevision: revision, planId: planned.planRunId,
        confirmActions: [planned.actions[0].id] });
      expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    }
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual(before);
    expect(ctx.repos.environments.findById(staging.id)).toEqual(staging);
    expect(ctx.repos.components.findById(documents.id)).toEqual(documents);
    const ordinary = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
      kind: 'hv_plan', scope: 'full', environmentName: 'production', specRevision: revision, observedFingerprint: null,
      actions: [{ id: 'service:web', type: 'update', resource: { kind: 'service', provider: 'railway', name: 'web' },
        verified: true, reason: 'Ordinary release still requires verified provider access' }],
    } });
    const backupObservation = vi.spyOn(backups, 'observeBackupPolicy').mockResolvedValue({ policy: { mode: 'daily', source: 'default', resources: [] },
      resources: [{ resource: { kind: 'database', name: 'postgres', provider: 'railway', retained: false, bindingState: 'bound' },
        state: 'unknown', reason: 'No verified recovery point for this new generation.' }] });
    const result = await executePlanApply(ctx, { project, spec, specRevision: revision, planId: ordinary.id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'blocked', applyBlocked: [expect.objectContaining({ provider: 'railway',
      reason: expect.stringMatching(/No verified railway connection/) })] });
    expect(backupObservation).not.toHaveBeenCalled();
    expect(runJob).toHaveBeenCalledTimes(2);
  });
});
