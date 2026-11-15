import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import * as checkpoint from '../apply-database-resilience.js';
import '../providers.js';

describe('checkpoint-only apply stage', () => {
  let directory: string; let ctx: CommandContext;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-checkpoint-stage-'));
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
  });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  it('uses only database access, passes exact confirmation, and leaves deployment acceptance untouched', async () => {
    const project = ctx.repos.projects.create({ name: 'checkpoint-app', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: { appliedSpecHash: 'august-contract', services: { web: { serviceId: 'web' } } } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: { hosting: { provider: 'railway' }, services: { web: {} }, database: { provider: 'railway', resilience: { checkpoint: { id: 'pre-beta' } } } } } });
    const action = { id: 'database:railway:checkpoint:pre-beta', type: 'create', resource: { kind: 'database', provider: 'railway', name: 'postgres' }, verified: true, billable: true, dataBearing: true, requiresConfirm: true, reason: 'Snapshot', metadata: { operation: 'databaseCheckpointCreate', primaryExternalId: 'db', checkpointId: 'pre-beta', source: { primaryExternalId: 'db', providerScope: { projectId: 'p', environmentId: 'prod' }, volumeId: 'v', volumeInstanceId: 'vi' } } };
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: { kind: 'hv_plan', scope: 'database-checkpoint', environmentName: 'production', specRevision: 1, observedFingerprint: null, actions: [action] } });
    const providerPreflight = vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    const broaderPreflight = vi.spyOn(PlanService.prototype, 'preflight').mockImplementation(() => { throw new Error('Unrelated workflow/config preflight called'); });
    const observe = vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(() => { throw new Error('Unrelated provider observation called'); });
    const mutate = vi.spyOn(checkpoint, 'applyDatabaseResilienceAction').mockResolvedValue({ success: true, message: 'Snapshot confirmed; no restore tested' });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id, confirmActions: [action.id], alwaysRunBootstrap: true });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(providerPreflight).toHaveBeenCalledWith(['railway']);
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ confirmedActionIds: new Set([action.id]) }));
    expect(broaderPreflight).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual(environment.platformBindings);
  });
  it('blocks a pre-contract persisted plan with replan guidance and preserves its saved request', async () => {
    const project = ctx.repos.projects.create({ name: 'old-checkpoint-plan', defaultPlatform: 'railway' });
    const source = { primaryExternalId: 'db', providerScope: { projectId: 'p', environmentId: 'prod' }, volumeId: 'v', volumeInstanceId: 'vi' };
    const retained = { source, label: 'hv-pre-beta-original', beforeBackupIds: [], beforeBackupExternalIds: [],
      requestStartedAt: '2026-09-30T06:00:00Z', workflowId: 'original-workflow', state: 'running' };
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: { databaseCheckpoints: { 'pre-beta': retained } } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: { hosting: { provider: 'railway' }, services: {}, database: { provider: 'railway', resilience: { checkpoint: { id: 'pre-beta' } } } } } });
    const action = { id: 'database:railway:checkpoint:pre-beta', type: 'update', resource: { kind: 'database', provider: 'railway', name: 'postgres' }, verified: true, billable: true, dataBearing: true, requiresConfirm: true, reason: 'Observe snapshot', metadata: {
      operation: 'databaseCheckpointCreate', primaryExternalId: 'db', checkpointId: 'pre-beta', source: { ...source, backups: [] }, workflowId: 'original-workflow',
    } };
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: { kind: 'hv_plan', scope: 'database-checkpoint', environmentName: 'production', specRevision: 1, observedFingerprint: null, actions: [action] } });
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    const mutate = vi.spyOn(checkpoint, 'applyDatabaseResilienceAction');
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id, confirmActions: [action.id] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(JSON.stringify(result)).toContain('Re-run hv_plan');
    expect(JSON.stringify(result)).not.toContain('ZodError');
    expect(mutate).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)!.platformBindings.databaseCheckpoints).toEqual({ 'pre-beta': retained });
  });

});
