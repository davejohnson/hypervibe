import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { createCommandContext } from '../../../../application/context.js';
import { applyDatabaseCheckpoint } from '../../../../application/apply-database-checkpoint.js';
import { planDatabaseResilience } from '../../../../domain/services/database-resilience-plan.service.js';
import { PlanService } from '../../../../domain/plan/plan.service.js';
import { adapterFactory } from '../../../../domain/services/adapter.factory.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { projectId, stagingId, railwayHttpFixture } from './railway-http.fixture.js';
import { checkpointObservationFailures, privateProviderDetail } from './railway.checkpoint-observation.fixture.js';

describe('Railway checkpoint durable lifecycle through serialized transport', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hypervibe-checkpoint-test-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(root, 'hypervibe-test.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T06:00:00Z'));
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true });
  });

  async function setup(dropCreateResponse = false, workflowResponse?: () => Response,
    observationResponse?: (query: string) => Response | undefined) {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'checkpoint-contract', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging',
      platformBindings: { provider: 'railway', projectId, environmentId: stagingId } });
    const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres',
      externalId: 'checkpoint-db', bindings: { provider: 'railway', resourceKind: 'service',
        providerScope: { projectId, environmentId: stagingId } } });
    let sawDurableIntentBeforeMutation = false;
    const http = await railwayHttpFixture({ dropBackupCreateResponse: dropCreateResponse,
      responseOverride: ({ query }) => {
        if (query.includes('mutation DatabaseCheckpointCreate')) {
          const before = ctx.repos.components.findById(component.id)!;
          const recovery = (before.bindings.resilience as any)?.checkpoints?.['pre-beta'];
          expect(recovery).toMatchObject({ state: 'attempting', source: {
            primaryExternalId: 'checkpoint-db', resourceIdentity: { volumeInstanceId: 'instance-volume-1' },
          }, beforeBackupIds: [], beforeBackupExternalIds: [] });
          expect(ctx.repos.environments.findById(environment.id)!.platformBindings.databaseCheckpoints)
            .toEqual({ 'pre-beta': recovery });
          sawDurableIntentBeforeMutation = true;
        }
        const overridden = observationResponse?.(query);
        if (overridden) return overridden;
        if (query.includes('query DatabaseCheckpointWorkflow')) {
          return workflowResponse?.() ?? Response.json({ data: { workflowStatus: { status: 'Complete' } } });
        }
        return undefined;
      },
    });
    http.addService('checkpoint-db', 'postgres', stagingId).instances.get(stagingId)!.source = { image: 'postgres:17' };
    http.addVolume('checkpoint-db', stagingId, '/var/lib/postgresql/data');
    const adapter = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter, envRepo: ctx.repos.environments });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: http.adapter });
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter });
    const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: {},
      database: { provider: 'railway', resilience: { checkpoint: { id: 'pre-beta' } } } });
    const plan = async () => {
      const current = ctx.repos.components.findById(component.id)!;
      const currentEnvironment = ctx.repos.environments.findById(environment.id)!;
      const observation = await new PlanService().observeEnvironment(project, currentEnvironment, environmentSpec);
      expect(observation.observed?.databases.find((database) => database.externalId === 'checkpoint-db')?.resilience?.checkpointSource)
        .toMatchObject({ primaryExternalId: 'checkpoint-db', resourceIdentity: { volumeInstanceId: 'instance-volume-1' } });
      const result = planDatabaseResilience({ environmentSpec, capabilities: { checkpoints: true },
        local: { services: [], components: [current], bindings: currentEnvironment.platformBindings } as never,
        observed: observation.observed,
      });
      expect(result.actions).toHaveLength(1);
      return result.actions[0]!;
    };
    const apply = async (action: Awaited<ReturnType<typeof plan>>, confirmed = true) => applyDatabaseCheckpoint({
      ctx, environment: ctx.repos.environments.findById(environment.id)!,
      component: ctx.repos.components.findById(component.id)!, environmentSpec, action, adapter,
      confirmedActionIds: new Set(confirmed ? [action.id] : []),
    });
    return { ctx, environment, component, http, plan, apply, sawIntent: () => sawDurableIntentBeforeMutation };
  }

  it.each(checkpointObservationFailures)('reports $name safely on create and resume without another write', async (failure) => {
    let failing = true;
    const f = await setup(false, () => failing ? failure.respond()
      : Response.json({ data: { workflowStatus: { status: 'Complete' } } }));
    const expected = { success: false, status: 'blocked', data: {
      applied: null, skipped: 0, restoreVerified: false, operationId: 'backup-workflow',
      observationFailure: { stage: 'workflow_status', category: failure.category,
        ...('httpStatus' in failure ? { httpStatus: failure.httpStatus } : {}) },
    } };
    const first = await f.apply(await f.plan());
    expect(JSON.stringify(first)).not.toContain(privateProviderDetail);
    expect(first).toMatchObject(expected);
    const retained = f.ctx.repos.components.findById(f.component.id)!.bindings;
    expect((retained.resilience as any).checkpoints['pre-beta']).toMatchObject({ state: 'running', operationId: 'backup-workflow' });
    const next = await f.plan();
    expect(next.type).toBe('update');
    const resumed = await f.apply(next);
    expect(JSON.stringify(resumed)).not.toContain(privateProviderDetail);
    expect(resumed).toMatchObject(expected);
    expect(f.ctx.repos.components.findById(f.component.id)!.bindings).toEqual(retained);
    expect(f.http.mutations.map((entry) => entry.field)).toEqual(['volumeInstanceBackupCreate']);
    // Inventory already contains the matching snapshot, but failed workflow reads
    // must not finalize it. Only a later successful terminal read can do so.
    failing = false;
    expect(await f.apply(await f.plan())).toMatchObject({ success: true, data: {
      applied: 0, skipped: 1, restoreVerified: false, operationId: 'backup-workflow',
    } });
    expect(f.http.mutations.map((entry) => entry.field)).toEqual(['volumeInstanceBackupCreate']);
    expect(f.http.contractErrors).toEqual([]);
  });

  it('distinguishes inventory failure after terminal workflow observation and retains the created request', async () => {
    let workflowRead = false;
    const f = await setup(false, () => {
      workflowRead = true;
      return Response.json({ data: { workflowStatus: { status: 'Complete' } } });
    }, (query) => workflowRead && query.includes('DatabaseCheckpointBackups')
      ? Response.json({ errors: [{ message: privateProviderDetail }] }, { status: 403 }) : undefined);
    const result = await f.apply(await f.plan());
    expect(result).toMatchObject({ success: false, status: 'blocked', data: {
      applied: null, restoreVerified: false, operationId: 'backup-workflow',
      observationFailure: { stage: 'source_inventory', category: 'authorization', httpStatus: 403 },
    } });
    expect(JSON.stringify(result)).not.toContain(privateProviderDetail);
    expect(JSON.stringify(result)).not.toContain('No backup was created');
    expect(f.http.mutations.map((entry) => entry.field)).toEqual(['volumeInstanceBackupCreate']);
    expect((f.ctx.repos.components.findById(f.component.id)!.bindings.resilience as any).checkpoints['pre-beta'])
      .toMatchObject({ state: 'running', operationId: 'backup-workflow' });
  });

  it.each(['Complete', 'Error'] as const)('does not call a local persistence failure a failed provider read after %s', async (status) => {
    const f = await setup(false, () => Response.json({ data: { workflowStatus: { status } } }));
    const update = f.ctx.repos.components.update.bind(f.ctx.repos.components);
    vi.spyOn(f.ctx.repos.components, 'update').mockImplementation((id, patch) => {
      const state = (patch.bindings?.resilience as any)?.checkpoints?.['pre-beta']?.state;
      if (state === 'complete' || state === 'error') throw new Error(privateProviderDetail);
      return update(id, patch);
    });
    const result = await f.apply(await f.plan());
    expect(result).toMatchObject({ success: false, status: 'blocked', data: {
      applied: null, operationId: 'backup-workflow', restoreVerified: false,
    } });
    expect(result.data).not.toHaveProperty('observationFailure');
    expect(JSON.stringify(result)).not.toContain(privateProviderDetail);
    expect(f.http.mutations.map((entry) => entry.field)).toEqual(['volumeInstanceBackupCreate']);
  });

  it('persists before mutation, records exact provider evidence, and replans mutation-free', async () => {
    const f = await setup();
    const action = await f.plan();
    expect(await f.apply(action, false)).toMatchObject({ success: false, status: 'blocked' });
    expect(f.http.mutations).toHaveLength(0);
    expect(await f.apply(action)).toMatchObject({ success: true, data: {
      applied: 1, skipped: 0, restoreVerified: false, operationId: 'backup-workflow',
      backup: { id: 'backup-1', externalId: 'snapshot-1', createdAt: '2026-09-30T06:00:00.000Z' },
    } });
    expect(f.sawIntent()).toBe(true);
    const next = await f.plan();
    expect(next.type).toBe('noop');
    expect(await f.apply(next)).toMatchObject({ success: true, data: { applied: 0, skipped: 1, restoreVerified: false } });
    expect(f.http.mutations.map((entry) => entry.field)).toEqual(['volumeInstanceBackupCreate']);
    expect(f.http.contractErrors).toEqual([]);
  });

  it('keeps uncertain acknowledgement across a new repository read and never creates again', async () => {
    const f = await setup(true);
    const action = await f.plan();
    expect(await f.apply(action)).toMatchObject({ success: false, status: 'blocked' });
    expect(f.sawIntent()).toBe(true);
    expect((f.ctx.repos.components.findById(f.component.id)!.bindings.resilience as any).checkpoints['pre-beta'].state).toBe('unknown');
    expect((await f.plan()).metadata?.blockedReason).toBe('database_checkpoint_write_uncertain');
    // Even a stale, previously confirmed plan cannot issue the create again.
    expect(await f.apply(action)).toMatchObject({ success: false, status: 'blocked' });
    expect(f.http.mutations.map((entry) => entry.field)).toEqual(['volumeInstanceBackupCreate']);
    expect(f.http.contractErrors).toEqual([]);
  });
  it('resumes the pre-contract saved Railway request after a repository/SQLite round trip without creating again', async () => {
    let denied = true;
    const f = await setup(false, () => denied
      ? Response.json({ errors: [{ message: 'not authorized' }] }, { status: 403 })
      : Response.json({ data: { workflowStatus: { status: 'Complete' } } }));
    expect(await f.apply(await f.plan())).toMatchObject({ status: 'blocked' });
    const component = f.ctx.repos.components.findById(f.component.id)!;
    const retained = (component.bindings.resilience as any).checkpoints['pre-beta'];
    const { operationId, acknowledged: _acknowledged, source, ...request } = retained;
    // Exact persisted shape from the preceding Railway implementation, not a
    // source inferred from the current environment or provider selection.
    const legacy = { ...request, workflowId: operationId, source: {
      primaryExternalId: source.primaryExternalId, providerScope: source.providerScope,
      volumeId: source.resourceIdentity.volumeId, volumeInstanceId: source.resourceIdentity.volumeInstanceId,
    } };
    f.ctx.repos.components.update(component.id, { bindings: { ...component.bindings,
      resilience: { checkpoints: { 'pre-beta': legacy } } } });
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { databaseCheckpoints: { 'pre-beta': legacy } });
    expect((createCommandContext().repos.components.findById(component.id)!.bindings.resilience as any)
      .checkpoints['pre-beta'].workflowId).toBe('backup-workflow');
    denied = false;
    const plan = await f.plan();
    expect(plan).toMatchObject({ type: 'update', metadata: { operationId: 'backup-workflow' } });
    expect(await f.apply(plan)).toMatchObject({ success: true, data: {
      applied: 0, skipped: 1, operationId: 'backup-workflow', source: { provider: 'railway' },
      recovery: { ready: false, checks: { recoveryPoint: 'verified', databaseValidation: 'unknown' } },
    } });
    expect(f.http.mutations.map(entry => entry.field)).toEqual(['volumeInstanceBackupCreate']);
    expect(f.http.contractErrors).toEqual([]);
  });

});
