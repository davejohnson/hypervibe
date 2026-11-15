import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import * as backup from '../apply-backup-policy.js';
import '../providers.js';

// This mocks only the shared action handler. Native transport and reservation
// behavior are verified by the provider and apply-backup-policy suites.
describe('daily backup policy-only executor stage', () => {
  let directory: string;
  let ctx: CommandContext;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-daily-backup-stage-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  it('routes a confirmed saved policy plan without deployment preflight, observation, or acceptance writes', async () => {
    const project = ctx.repos.projects.create({ name: 'daily-backup-app', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { appliedSpecHash: 'previous-production-contract',
        projectId: 'p', environmentId: 'prod', services: { web: { serviceId: 'web' } } } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      environments: { production: { hosting: { provider: 'railway' }, services: { web: {} }, database: { provider: 'railway' } } } });
    const action = {
      id: 'backup-policy:database:railway:postgres', type: 'update',
      resource: { kind: 'database', provider: 'railway', name: 'postgres' },
      verified: true, billable: true, dataBearing: true, requiresConfirm: true, reason: 'Configure daily schedule',
      metadata: { operation: 'dailyBackupConfigure',
        item: { resource: { kind: 'database', name: 'postgres', provider: 'railway', retained: false,
          bindingState: 'bound', componentId: 'local-db' }, state: 'needs-configuration',
          target: { kind: 'database', componentId: 'local-db' } },
        source: { provider: 'railway', primaryExternalId: 'db',
          providerScope: { projectId: 'p', environmentId: 'prod' },
          resourceIdentity: { volumeId: 'v', volumeInstanceId: 'vi' } },
        policyFingerprint: 'a'.repeat(64),
        preservationFingerprint: 'b'.repeat(64),
      },
    };
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'backup-policy', environmentName: 'production',
        specRevision: 1, observedFingerprint: null, actions: [action] } });
    const providerPreflight = vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    const broaderPreflight = vi.spyOn(PlanService.prototype, 'preflight')
      .mockImplementation(() => { throw new Error('Unrelated workflow/config preflight called'); });
    const observe = vi.spyOn(PlanService.prototype, 'observeEnvironment')
      .mockImplementation(() => { throw new Error('Unrelated deployment observation called'); });
    const configure = vi.spyOn(backup, 'applyBackupPolicyAction').mockResolvedValue({ success: true,
      message: 'Daily policy verified; backup completion and restore unchecked', data: { applied: 1, skipped: 0 } });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id,
      confirmActions: [action.id], alwaysRunBootstrap: true });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(providerPreflight).toHaveBeenCalledWith(['railway']);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ project, environmentName: 'production',
      action, confirmedActionIds: new Set([action.id]) }));
    expect(broaderPreflight).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual(environment.platformBindings);
  });
});
