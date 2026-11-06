import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ConvergeExecutor, type PlanRunDocument } from '../converge.executor.js';
import type { PlanAction } from '../plan.types.js';
import type { EngineActionSegment } from '../../ports/infrastructure-engine.port.js';

let projectId: string;
let environmentId: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-engine-segment-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  projectId = new ProjectRepository().create({ name: 'engine-segment' }).id;
  environmentId = new EnvironmentRepository().create({ projectId, name: 'staging' }).id;
});

const segment = (addresses: string[]): EngineActionSegment => ({
  id: 'opentofu:plan-1', engine: 'opentofu', planDigest: 'p', configurationDigest: 'c',
  engineVersion: '1.13.9', providerVersions: {}, addresses,
});

function engineAction(name: string, extra: Partial<PlanAction> = {}): PlanAction {
  return {
    id: `service:${name}`,
    type: 'create',
    resource: { kind: 'service', name, provider: 'gcp' },
    verified: true,
    reason: 'engine',
    metadata: { engineSegment: segment([`google_cloud_run_v2_service.${name}`]) },
    ...extra,
  };
}

function storePlan(actions: PlanAction[]): string {
  const document = { kind: 'hv_plan', scope: 'infrastructure-engine', engine: { planId: 'plan-1' }, environmentName: 'staging', specRevision: 1, observedFingerprint: null, actions } as PlanRunDocument;
  return new RunRepository().create({ projectId, environmentId, type: 'plan', plan: document as unknown as Record<string, unknown> }).id;
}

describe('engine segments', () => {
  it('executes one saved engine plan once and records a receipt per action', async () => {
    const planRunId = storePlan([engineAction('web'), engineAction('api')]);
    const handler = vi.fn();
    const segmentHandler = vi.fn(async () => ({
      outcomes: { 'google_cloud_run_v2_service.web': 'succeeded' as const, 'google_cloud_run_v2_service.api': 'succeeded' as const },
      diagnostics: [],
    }));
    const result = await new ConvergeExecutor().execute({ planRunId, currentSpecRevision: 1, handler, segmentHandler });
    expect(result.success).toBe(true);
    expect(segmentHandler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(result.receipts.map((r) => [r.actionId, r.status])).toEqual([['service:web', 'succeeded'], ['service:api', 'succeeded']]);
  });

  it('reports each member truthfully after a partial engine failure', async () => {
    const planRunId = storePlan([engineAction('web'), engineAction('api'), engineAction('worker')]);
    const result = await new ConvergeExecutor().execute({
      planRunId, currentSpecRevision: 1, handler: vi.fn(),
      segmentHandler: async () => ({
        outcomes: {
          'google_cloud_run_v2_service.web': 'failed',
          'google_cloud_run_v2_service.api': 'succeeded',
          'google_cloud_run_v2_service.worker': 'unknown',
        },
        diagnostics: ['quota exceeded'],
      }),
    });
    expect(result.success).toBe(false);
    expect(Object.fromEntries(result.receipts.map((r) => [r.actionId, r.status]))).toEqual({
      'service:web': 'failed', 'service:api': 'succeeded', 'service:worker': 'pending',
    });
  });

  it('rejects engine actions outside the isolated engine stage', async () => {
    const document = { kind: 'hv_plan', environmentName: 'staging', specRevision: 1, observedFingerprint: null, actions: [engineAction('web')] } as PlanRunDocument;
    const planRunId = new RunRepository().create({ projectId, environmentId, type: 'plan', plan: document as unknown as Record<string, unknown> }).id;
    expect(new ConvergeExecutor().loadPlan(planRunId)).toHaveProperty('error');
  });

  it('blocks engine actions when the apply path has no engine executor', async () => {
    const planRunId = storePlan([engineAction('web')]);
    const result = await new ConvergeExecutor().execute({ planRunId, currentSpecRevision: 1, handler: vi.fn() });
    expect(result.receipts[0]).toMatchObject({ actionId: 'service:web', status: 'blocked' });
  });

  it('does not run the engine before its external prerequisites complete', async () => {
    const prerequisite: PlanAction = {
      id: 'secret:api-key', type: 'create', resource: { kind: 'secret', name: 'api-key', provider: 'gcp' }, verified: true, reason: 'secret', metadata: { operation: 'gcpSecretManagerEnsure' },
    };
    const planRunId = storePlan([prerequisite, engineAction('web', { dependsOn: ['secret:api-key'] })]);
    const segmentHandler = vi.fn();
    const result = await new ConvergeExecutor().execute({
      planRunId, currentSpecRevision: 1, segmentHandler,
      handler: async () => ({ success: false, message: 'secret write failed' }),
    });
    expect(segmentHandler).not.toHaveBeenCalled();
    expect(result.receipts.map((r) => r.status)).toEqual(['failed', 'aborted']);
  });

  it('requires confirmation of destructive engine actions before anything runs', async () => {
    const planRunId = storePlan([engineAction('web', { type: 'replace', requiresConfirm: true })]);
    const segmentHandler = vi.fn();
    const result = await new ConvergeExecutor().execute({ planRunId, currentSpecRevision: 1, handler: vi.fn(), segmentHandler });
    expect(segmentHandler).not.toHaveBeenCalled();
    expect(result.receipts[0]?.status).toBe('skipped_requires_confirm');
  });
});
