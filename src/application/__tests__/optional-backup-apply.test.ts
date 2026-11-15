import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import * as backups from '../../domain/services/backup-policy.service.js';
import * as health from '../../domain/services/backup-health.service.js';
import * as bootstrap from '../../domain/services/bootstrap.service.js';
import * as checkpoint from '../apply-database-resilience.js';
import '../providers.js';

// User requirement, 2026-10-29: normal application releases must not require
// backup configuration or restore evidence. Exercise actual persisted-plan
// admission, action dispatch and the all-noop deploy path. Hosting execution is
// a synthetic adapter boundary; these checks do not prove live deployment.
describe('optional backup evidence at the real application apply boundary', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-optional-backup-apply-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  });
  afterEach(() => {
    vi.restoreAllMocks(); SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['update', 'missing'], ['noop', 'missing'],
    ['update', 'expires'], ['noop', 'expires'],
  ] as const)('reaches %s application rollout when independent backup evidence is %s', async (type, evidence) => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'optional-backup-apply', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', projectId: 'p', environmentId: 'e',
        appliedSpecHash: 'accepted-contract', services: { web: { serviceId: 'web' } } } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      environments: { production: { hosting: { provider: 'railway' }, services: { web: {} },
        email: { enabled: false }, database: { provider: 'railway' }, backups: { mode: 'daily' } } } });
    const resource = { kind: 'database' as const, name: 'postgres', provider: 'railway', retained: false,
      bindingState: 'bound' as const, componentId: 'component' };
    const source = { provider: 'railway', primaryExternalId: 'db',
      providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: { volumeId: 'v', volumeInstanceId: 'vi' } };
    vi.spyOn(backups, 'observeBackupPolicy').mockResolvedValue({
      policy: { mode: 'daily', source: 'explicit', resources: [resource] },
      resources: [{ resource, state: 'scheduled', observation: { state: 'known', source, daily: true,
        policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot' } }],
    });
    const observedAt = new Date(Date.now() - 1000).toISOString();
    const freshUntil = new Date(Date.now() + 60000).toISOString();
    const observeHealth = vi.spyOn(health, 'observeBackupHealth');
    if (evidence === 'expires') observeHealth.mockResolvedValueOnce({ observedAt, resources: [{
      resource, source, state: 'verified', completedAt: observedAt, dataTime: observedAt,
      recoveryPointId: 'previous-point', freshUntil,
      restore: { state: 'verified', verifiedAt: observedAt, freshUntil },
    }] });
    observeHealth.mockResolvedValue({ observedAt, resources: [{ resource, state: 'missing' }] });
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockResolvedValue({ success: true, summary: {} });
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'full', environmentName: 'production', specRevision: 1, observedFingerprint: null,
        actions: [{ id: 'service:web', type, resource: { kind: 'service', provider: 'railway', name: 'web' },
          verified: true, reason: 'Deploy the reviewed application' }] } });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id,
      confirmActions: [], alwaysRunBootstrap: type === 'noop' });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(deploy).toHaveBeenCalledOnce();
    expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ projectName: project.name,
      environmentName: 'production', services: ['web'] }));
    expect(spec.environments.production.backups).toEqual({ mode: 'daily' });
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual(environment.platformBindings);
  });

  it('keeps an explicit data-operation checkpoint confirmation-gated without deploying code', async () => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'explicit-checkpoint', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', projectId: 'p', environmentId: 'e', appliedSpecHash: 'accepted-contract' } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      environments: { production: { hosting: { provider: 'railway' }, services: { web: {} },
        database: { provider: 'railway', resilience: { checkpoint: { id: 'before-replacement' } } } } } });
    const action = { id: 'database:railway:checkpoint:before-replacement', type: 'create',
      resource: { kind: 'database', provider: 'railway', name: 'postgres' }, verified: true,
      requiresConfirm: true, billable: true, dataBearing: true, reason: 'Explicit recovery checkpoint',
      metadata: { operation: 'databaseCheckpointCreate', primaryExternalId: 'db', checkpointId: 'before-replacement',
        source: { primaryExternalId: 'db', providerScope: { projectId: 'p', environmentId: 'e' }, volumeId: 'v', volumeInstanceId: 'vi' } } };
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'database-checkpoint', environmentName: 'production', specRevision: 1,
        observedFingerprint: null, actions: [action] } });
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    const snapshot = vi.spyOn(checkpoint, 'applyDatabaseResilienceAction');
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap');
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id,
      confirmActions: [], alwaysRunBootstrap: true });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false,
      receipts: [expect.objectContaining({ actionId: action.id, status: 'skipped_requires_confirm', message: expect.stringMatching(/confirm/i) })] } });
    expect(snapshot).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual(environment.platformBindings);
  });
});
