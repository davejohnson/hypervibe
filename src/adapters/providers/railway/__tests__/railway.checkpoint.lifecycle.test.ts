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

  async function setup(dropCreateResponse = false) {
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
            primaryExternalId: 'checkpoint-db', volumeInstanceId: 'instance-volume-1',
          }, beforeBackupIds: [], beforeBackupExternalIds: [] });
          expect(ctx.repos.environments.findById(environment.id)!.platformBindings.databaseCheckpoints)
            .toEqual({ 'pre-beta': recovery });
          sawDurableIntentBeforeMutation = true;
        }
        if (query.includes('query DatabaseCheckpointWorkflow')) {
          return Response.json({ data: { workflowStatus: { status: 'Complete' } } });
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
        .toMatchObject({ primaryExternalId: 'checkpoint-db', volumeInstanceId: 'instance-volume-1' });
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

  it('persists before mutation, records exact provider evidence, and replans mutation-free', async () => {
    const f = await setup();
    const action = await f.plan();
    expect(await f.apply(action, false)).toMatchObject({ success: false, status: 'blocked' });
    expect(f.http.mutations).toHaveLength(0);
    expect(await f.apply(action)).toMatchObject({ success: true, data: {
      applied: 1, skipped: 0, restoreVerified: false, workflowId: 'backup-workflow',
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
});
