import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import * as bootstrap from '../../domain/services/bootstrap.service.js';
import '../providers.js';

describe('fresh service capacity authority at saved-plan apply', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-bounds-apply-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  it.each(['stripped-marker', 'unknown-bounds', 'duplicate-native-id'] as const)('blocks %s before any workload mutation', async variant => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'capacity-app', defaultPlatform: 'cloudrun' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'cloudrun', projectId: 'capacity-project', environmentId: 'us-central1', region: 'us-central1', services: { web: { serviceId: 'web' } },
    } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
      staging: { hosting: { provider: 'cloudrun' }, services: { web: { instanceBounds: { min: 0, max: 1 } } } },
    } });
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
      provider: 'cloudrun', projectExists: true, projectId: 'capacity-project', environmentId: 'us-central1',
      observedAt: new Date().toISOString(), partial: false, warnings: [], databases: [],
      services: Array.from({ length: variant === 'duplicate-native-id' ? 2 : 1 }, () => ({ name: 'web', externalId: 'web',
        workloadKind: 'web', status: 'running', customDomains: [], envVarKeys: [], envVarHashes: {},
        config: variant === 'unknown-bounds' ? {} : { instanceBounds: { min: 0, max: 5 } } })),
    } });
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockResolvedValue({ success: true, summary: {} });
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
      kind: 'hv_plan', scope: 'full', environmentName: 'staging', specRevision: 1, observedFingerprint: null,
      actions: [{ id: 'service:web', type: 'update', resource: { kind: 'service', name: 'web', provider: 'cloudrun' },
        verified: true, reason: 'Reviewed workload update', ...(variant === 'stripped-marker' ? {} : { billable: true, requiresConfirm: true }) }],
    } });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id, confirmActions: ['service:web'] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false, receipts: [expect.objectContaining({
      actionId: 'service:web', status: 'blocked', message: expect.stringMatching(/instance bounds/i),
    })] } });
    expect(deploy).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual(environment.platformBindings);
  });
});
