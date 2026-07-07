import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import {
  ConvergeExecutor,
  fingerprintObservedState,
  orderActions,
  type PlanRunDocument,
} from '../converge.executor.js';
import type { PlanAction } from '../plan.types.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';

let projectId: string;
let environmentId: string;
const runRepo = () => new RunRepository();

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-converge-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  const project = new ProjectRepository().create({ name: 'converge-test' });
  projectId = project.id;
  environmentId = new EnvironmentRepository().create({ projectId, name: 'staging' }).id;
});

function action(partial: Partial<PlanAction> & { id: string }): PlanAction {
  return {
    type: 'create',
    resource: { kind: 'service', name: partial.id.split(':')[1] ?? partial.id, provider: 'railway' },
    verified: true,
    reason: 'test',
    ...partial,
  } as PlanAction;
}

function storePlan(actions: PlanAction[], overrides: Partial<PlanRunDocument> = {}): string {
  const document: PlanRunDocument = {
    kind: 'hv_plan',
    environmentName: 'staging',
    specRevision: 1,
    observedFingerprint: null,
    actions,
    ...overrides,
  };
  return runRepo().create({ projectId, environmentId, type: 'plan', plan: document as unknown as Record<string, unknown> }).id;
}

describe('orderActions', () => {
  it('orders by dependsOn', () => {
    const ordered = orderActions([
      action({ id: 'service:web', dependsOn: ['project:railway'] }),
      action({ id: 'project:railway', resource: { kind: 'project', name: 'p', provider: 'railway' } }),
    ]);
    expect(ordered.map((a) => a.id)).toEqual(['project:railway', 'service:web']);
  });

  it('throws on cycles', () => {
    expect(() => orderActions([
      action({ id: 'a', dependsOn: ['b'] }),
      action({ id: 'b', dependsOn: ['a'] }),
    ])).toThrow(/cycle/i);
  });
});

describe('ConvergeExecutor staleness', () => {
  it('rejects unknown plan ids', async () => {
    const result = await new ConvergeExecutor().execute({
      planRunId: 'nope', currentSpecRevision: 1, handler: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects plans against a superseded spec revision', async () => {
    const planId = storePlan([action({ id: 'service:web' })], { specRevision: 1 });
    const result = await new ConvergeExecutor().execute({
      planRunId: planId, currentSpecRevision: 2, handler: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Re-run hv_plan');
  });

  it('rejects plans older than the max age', async () => {
    const planId = storePlan([action({ id: 'service:web' })]);
    const result = await new ConvergeExecutor().execute({
      planRunId: planId, currentSpecRevision: 1, handler: vi.fn(), maxPlanAgeMs: -1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Re-run hv_plan');
  });

  it('rejects when live infrastructure changed since planning', async () => {
    const planId = storePlan([action({ id: 'service:web' })], { observedFingerprint: 'abc' });
    const result = await new ConvergeExecutor().execute({
      planRunId: planId, currentSpecRevision: 1, freshObservedFingerprint: 'def', handler: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('changed since this plan');
  });

  it('rejects double-apply of the same plan', async () => {
    const planId = storePlan([action({ id: 'service:web' })]);
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
    const first = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(first.success).toBe(true);
    const second = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(second.success).toBe(false);
    expect(second.error).toContain('already applied');
  });
});

describe('ConvergeExecutor execution', () => {
  it('executes actions in dependency order, skipping noops', async () => {
    const executedIds: string[] = [];
    const handler = vi.fn(async (a: PlanAction) => {
      executedIds.push(a.id);
      return { success: true, message: 'ok' };
    });
    const planId = storePlan([
      action({ id: 'service:web', dependsOn: ['project:railway'] }),
      action({ id: 'database:railway', type: 'noop' }),
      action({ id: 'project:railway', resource: { kind: 'project', name: 'p', provider: 'railway' } }),
    ]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(true);
    expect(executedIds).toEqual(['project:railway', 'service:web']);
    expect(result.receipts.find((r) => r.actionId === 'database:railway')!.status).toBe('skipped_noop');

    const applyRun = runRepo().findById(result.applyRunId!)!;
    expect(applyRun.type).toBe('apply');
    expect(applyRun.status).toBe('succeeded');
    expect((applyRun.plan as Record<string, unknown>).planRunId).toBe(planId);
  });

  it('skips confirm-gated destroys unless confirmed, and blocks dependents of skipped actions', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
    const planId = storePlan([
      action({ id: 'database:railway:destroy', type: 'destroy', dataBearing: true, requiresConfirm: true }),
      action({ id: 'cleanup:after', dependsOn: ['database:railway:destroy'] }),
    ]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    const statuses = new Map(result.receipts.map((r) => [r.actionId, r.status]));
    expect(statuses.get('database:railway:destroy')).toBe('skipped_requires_confirm');
    expect(statuses.get('cleanup:after')).toBe('aborted');
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes confirm-gated destroys when explicitly confirmed', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'destroyed' });
    const planId = storePlan([
      action({ id: 'database:railway:destroy', type: 'destroy', dataBearing: true, requiresConfirm: true }),
    ]);
    const result = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      confirmDestroy: ['database:railway:destroy'],
      handler,
    });
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('returns and persists handler data on action receipts', async () => {
    const handlerData = {
      appDeploymentPending: true,
      appDeployment: { status: 'pending_ci' },
    };
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'ok', data: handlerData });
    const planId = storePlan([action({ id: 'service:web' })]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(true);
    expect(result.receipts.find((receipt) => receipt.actionId === 'service:web')).toMatchObject({
      status: 'succeeded',
      data: handlerData,
    });

    const applyRun = runRepo().findById(result.applyRunId!)!;
    expect(applyRun.receipts.find((receipt) => receipt.step === 'service:web')?.result).toMatchObject({
      message: 'ok',
      ...handlerData,
    });
  });

  it('records pending actions without treating them as failed and blocks dependents', async () => {
    const handler = vi.fn(async (a: PlanAction) =>
      a.id === 'domain:example.com:register'
        ? { success: false, status: 'pending' as const, message: 'registration in progress', data: { state: 'in_progress' } }
        : { success: true, message: 'ok' });
    const planId = storePlan([
      action({
        id: 'domain:example.com:register',
        resource: { kind: 'domain', name: 'example.com', provider: 'cloudflare' },
      }),
      action({
        id: 'domain:example.com',
        resource: { kind: 'domain', name: 'example.com', provider: 'railway' },
        dependsOn: ['domain:example.com:register'],
      }),
    ]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(false);
    expect(result.error).toBeUndefined();
    const statuses = new Map(result.receipts.map((r) => [r.actionId, r.status]));
    expect(statuses.get('domain:example.com:register')).toBe('pending');
    expect(statuses.get('domain:example.com')).toBe('aborted');

    const applyRun = runRepo().findById(result.applyRunId!)!;
    expect(applyRun.status).toBe('pending');
    expect(applyRun.completedAt).toBeInstanceOf(Date);
    expect(applyRun.receipts.find((receipt) => receipt.step === 'domain:example.com:register')).toMatchObject({
      status: 'pending',
      result: { message: 'registration in progress', state: 'in_progress' },
    });
  });

  it('records blocked actions separately from provider failures', async () => {
    const handler = vi.fn(async () => ({
      success: false,
      status: 'blocked' as const,
      message: 'user action required',
      error: 'Verify registrant contact',
    }));
    const planId = storePlan([action({ id: 'domain:example.com:register' })]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.receipts[0]).toMatchObject({
      actionId: 'domain:example.com:register',
      status: 'blocked',
      message: 'user action required',
      error: 'Verify registrant contact',
    });
    const applyRun = runRepo().findById(result.applyRunId!)!;
    expect(applyRun.status).toBe('blocked');
    expect(applyRun.completedAt).toBeInstanceOf(Date);
  });

  it('aborts remaining actions after a failure and records a failed apply run', async () => {
    const handler = vi.fn(async (a: PlanAction) =>
      a.id === 'service:web'
        ? { success: false, message: 'deploy failed', error: 'boom' }
        : { success: true, message: 'ok' });
    const planId = storePlan([
      action({ id: 'service:web' }),
      action({ id: 'domain:myapp.dev', type: 'update', resource: { kind: 'domain', name: 'myapp.dev', provider: 'railway' } }),
    ]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    const statuses = new Map(result.receipts.map((r) => [r.actionId, r.status]));
    expect(statuses.get('service:web')).toBe('failed');
    expect(statuses.get('domain:myapp.dev')).toBe('aborted');
    expect(runRepo().findById(result.applyRunId!)!.status).toBe('failed');
  });
});

describe('fingerprintObservedState', () => {
  const base: ObservedState = {
    provider: 'railway',
    observedAt: '2026-06-10T00:00:00Z',
    projectExists: true,
    projectId: 'p1',
    environmentId: 'e1',
    services: [{
      name: 'web', externalId: 's1', workloadKind: 'web', customDomains: ['b.com', 'a.com'],
      config: { startCommand: 'npm start' },
      envVarKeys: ['A', 'B'],
      envVarHashes: { B: hashEnvValue('2'), A: hashEnvValue('1') },
      status: 'running',
    }],
    databases: [{ provider: 'railway', engine: 'postgres', externalId: 'db1', status: 'running' }],
    partial: false,
    warnings: [],
  };

  it('is stable across volatile fields and ordering', () => {
    const reordered: ObservedState = {
      ...base,
      observedAt: '2026-06-11T12:00:00Z',
      warnings: ['transient'],
      services: [{
        ...base.services[0],
        customDomains: ['a.com', 'b.com'],
        envVarHashes: { A: hashEnvValue('1'), B: hashEnvValue('2') },
      }],
    };
    expect(fingerprintObservedState(reordered)).toBe(fingerprintObservedState(base));
  });

  it('changes when meaningful state changes', () => {
    const changed: ObservedState = {
      ...base,
      services: [{ ...base.services[0], envVarHashes: { A: hashEnvValue('1'), B: hashEnvValue('CHANGED') } }],
    };
    expect(fingerprintObservedState(changed)).not.toBe(fingerprintObservedState(base));
  });

  it('changes when deploy source changes', () => {
    const withSource: ObservedState = {
      ...base,
      services: [{ ...base.services[0], source: { repo: 'dave/app', branch: 'main' } }],
    };
    const withOtherBranch: ObservedState = {
      ...base,
      services: [{ ...base.services[0], source: { repo: 'dave/app', branch: 'staging' } }],
    };
    expect(fingerprintObservedState(withSource)).not.toBe(fingerprintObservedState(withOtherBranch));
  });
});
