import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { ConvergeExecutor } from '../../domain/plan/converge.executor.js';
import { createCommandContext } from '../context.js';
import { ENGINE_PLAN_SCOPE, planEngineSecrets, recordEnginePlan } from '../engine-shared.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-engine-shared-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

const action = (key: string, stored: boolean): PlanAction => ({
  id: `secret:${key}`, type: stored ? 'noop' : 'create', verified: true, resource: { kind: 'secret', name: key, provider: 'aws' }, reason: stored ? 'stored' : 'generate',
});

// Contract (ARCHITECTURE.md, Reconciliation Safety Invariants): present, absent and
// unknown stay distinct; only confirmed absence plans a create; Hypervibe never
// invents a key an outside service issues.
describe('shared engine secret planning', () => {
  const plan = (store: Record<string, 'present' | 'absent' | { unknown: string }>) => planEngineSecrets({
    environmentName: 'testing', generated: ['JWT_SECRET', 'SESSION_SECRET'], outside: ['STRIPE_KEY'],
    observe: async (key) => store[key] ?? 'absent', action,
  });

  it('creates only generated keys confirmed absent', async () => {
    expect(await plan({ STRIPE_KEY: 'present', JWT_SECRET: 'present' })).toEqual({ actions: [action('JWT_SECRET', true), action('SESSION_SECRET', false)] });
  });

  it('stops on a missing outside key and names it, planning nothing', async () => {
    expect(await plan({ JWT_SECRET: 'present' })).toEqual({ blocked: [expect.stringContaining('STRIPE_KEY')], missingOutsideKeys: ['STRIPE_KEY'] });
  });

  it('plans without a value for an outside key declared optional, and reports it so workloads leave it out', async () => {
    const result = await planEngineSecrets({
      environmentName: 'testing', generated: ['JWT_SECRET'], outside: ['STRIPE_KEY', 'SENTRY_DSN'], optional: ['STRIPE_KEY'],
      observe: async (key) => (({ JWT_SECRET: 'present', SENTRY_DSN: 'present' } as Record<string, 'present'>)[key] ?? 'absent'), action,
    });
    expect(result).toEqual({ actions: [action('JWT_SECRET', true)], unset: ['STRIPE_KEY'] });
  });

  it('still stops on a required key when an optional one is also missing', async () => {
    const result = await planEngineSecrets({
      environmentName: 'testing', generated: [], outside: ['STRIPE_KEY', 'SENTRY_DSN'], optional: ['STRIPE_KEY'], observe: async () => 'absent', action,
    });
    expect(result).toEqual({ blocked: [expect.stringContaining('SENTRY_DSN')], missingOutsideKeys: ['SENTRY_DSN'] });
  });

  it.each(['STRIPE_KEY', 'SESSION_SECRET'])('blocks instead of creating when %s cannot be read', async (key) => {
    const result = await plan({ STRIPE_KEY: 'present', JWT_SECRET: 'present', [key]: { unknown: 'The secret store could not be read.' } });
    expect(result).toEqual({ blocked: ['The secret store could not be read.'] });
  });
});

describe('shared engine plan recording', () => {
  const actions: PlanAction[] = [
    { id: 'secret:A', type: 'noop', verified: true, resource: { kind: 'secret', name: 'A', provider: 'aws' }, reason: 'stored' },
    { id: 'service:web', type: 'create', verified: true, resource: { kind: 'service', name: 'web', provider: 'aws' }, reason: 'create', metadata: { operation: 'engineImageRelease' } },
    { id: 'service:worker', type: 'update', verified: true, requiresConfirm: true, resource: { kind: 'service', name: 'worker', provider: 'aws' }, reason: 'replace', metadata: { operation: 'engineImageRelease' } },
  ];
  function record(confirm?: 'all') {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'engine-shared', defaultPlatform: 'aws' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'testing' });
    return recordEnginePlan({ projectId: project.id, environmentId: environment.id, environmentName: 'testing', specRevision: 3, actions,
      warnings: ['one warning'], engine: { planId: 'plan-1', aws: { accountId: '1' } }, ...(confirm ? { confirm } : {}) });
  }

  it('saves a loadable plan and asks to confirm only consequential actions', () => {
    const result = record();
    expect(result).toMatchObject({ environmentName: 'testing', specRevision: 3, warnings: ['one warning'], confirmActions: ['service:worker'] });
    const loaded = new ConvergeExecutor().loadPlan(result.planRunId);
    if ('error' in loaded) throw new Error(loaded.error);
    expect(loaded.document).toMatchObject({ scope: ENGINE_PLAN_SCOPE, environmentName: 'testing', specRevision: 3, engine: { planId: 'plan-1', aws: { accountId: '1' } } });
    expect(loaded.document.actions.map((item) => item.id)).toEqual(actions.map((item) => item.id));
  });

  it('confirms every action of a teardown', () => {
    expect(record('all').confirmActions).toEqual(['secret:A', 'service:web', 'service:worker']);
  });
});
