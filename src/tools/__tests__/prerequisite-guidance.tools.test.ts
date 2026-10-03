import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { CommandRegistry } from '../../application/commands.js';
import { createCommandContext } from '../../application/context.js';
import { PlanService, type EnvironmentPlan } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { registerCoreTools } from '../core.tools.js';
import { registerHvDeployTools } from '../hv-deploy.tools.js';

// Synthetic lifecycle state through the real command registry and persisted apply
// boundary. These checks validate guidance, not a live provider's backup support.
const gap = 'A fresh isolated restore is not verified for the current source.';
const prerequisite = { category: 'prerequisite' as const, provider: 'hypervibe', policy: 'hard' as const,
  reason: `Backup readiness is incomplete. ${gap}` };
const connection = { category: 'connection' as const, provider: 'railway', policy: 'hard' as const,
  reason: 'A verified Railway connection is required.' };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-prerequisite-guidance-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function setup(blocked: EnvironmentPlan['blocked'], scope: EnvironmentPlan['scope'] = 'full') {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'guidance-app', defaultPlatform: 'railway' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  const store = new SpecStore();
  store.replace(project, { version: 1, project: project.name,
    environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} }, email: { enabled: false } } } });
  const spec = store.get(project)!;
  const backupReadiness = { ready: false, policyReady: true, recoveryPointReady: true, restoreReady: false,
    resources: [], gaps: [gap] };
  const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
    plan: { kind: 'hv_plan', scope, environmentName: 'staging', specRevision: spec.revision,
      observedFingerprint: null, actions: [], backupReadiness } });
  const planned: EnvironmentPlan = { planRunId: run.id, scope, environmentName: 'staging', specRevision: spec.revision,
    verified: true, observed: null, actions: [], unmanaged: [], warnings: [], inputRequired: [], blocked, backupReadiness };
  vi.spyOn(PlanService.prototype, 'plan').mockResolvedValue(planned);
  vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue(blocked);
  vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  const registry = new CommandRegistry();
  registerCoreTools(registry, ctx);
  registerHvDeployTools(registry, ctx);
  return { registry, project, run, ctx };
}

for (const command of ['hv_plan', 'hv_apply', 'hv_deploy']) {
  describe(`${command} blocker guidance`, () => {
    it.each(['prerequisite', 'connection', 'mixed'] as const)('describes %s blockers without inventing credentials', async kind => {
      const blockers = kind === 'mixed' ? [prerequisite, connection] : kind === 'prerequisite' ? [prerequisite] : [connection];
      const { registry, project, run } = setup(blockers);
      const result = await registry.execute(command, { project: project.name,
        ...(command === 'hv_apply' ? { planId: run.id } : { env: 'staging' }) });
      expect(result.ok).toBe(command === 'hv_plan');
      const details = (command === 'hv_plan' ? result.data : result.error?.details) as Record<string, any>;
      expect(details.blocked).toEqual(blockers);
      if (command !== 'hv_plan') expect(result.error?.code).toBe(kind === 'connection' ? 'MISSING_CONNECTION' : 'VALIDATION');
      if (kind !== 'connection') {
        expect(result.hint).toContain(gap);
        expect(result.hint).toContain('hv_plan');
      }
      if (kind === 'prerequisite') {
        expect(details).not.toHaveProperty('connectionSetup');
        expect(result.hint).not.toContain('credential');
        expect(result.next).toEqual(['hv_plan']);
        expect(result.agentInstruction?.action).toBe('stop_and_report');
        expect(result.agentInstruction?.message).not.toContain('missing connection');
      } else {
        expect(details.connectionSetup.map((entry: { provider: string }) => entry.provider)).toEqual(['railway']);
        expect(result.hint).toContain('connectionSetup');
        expect(result.next).toContain('hv_connections');
      }
    });
  });
}

it.each(['hv_apply', 'hv_deploy'])('%s reports saved backup-readiness gaps without credential setup', async command => {
  const { registry, project, run } = setup([prerequisite], 'backup-readiness');
  const result = await registry.execute(command, { project: project.name,
    ...(command === 'hv_apply' ? { planId: run.id } : { env: 'staging' }) });
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe('VALIDATION');
  expect(result.hint).toContain(gap);
  expect(result.error?.details).not.toHaveProperty('connectionSetup');
  expect(result.next).toEqual(['hv_plan']);
});


it.each([undefined, {}, { gaps: 'not an array' }, { gaps: [null, 42, gap] }])(
  'retains a hard blocker for legacy or malformed readiness diagnostics %j', async backupReadiness => {
    const { registry, project, run, ctx } = setup([prerequisite], 'backup-readiness');
    ctx.repos.runs.updatePlan(run.id, { ...run.plan, backupReadiness });
    const result = await registry.execute('hv_apply', { project: project.name, planId: run.id });
    expect(result.error?.code).toBe('VALIDATION');
    expect(result.hint).toContain('Backup readiness is blocked');
    expect(result.error?.details).not.toHaveProperty('connectionSetup');
    expect(result.next).toEqual(['hv_plan']);
    expect(result.agentInstruction?.action).toBe('stop_and_report');
    expect(result.hint).not.toContain('42');
  }
);


it('keeps a prerequisite hard even if a producer incorrectly gives it action-scoped policy', async () => {
  const block = { ...prerequisite, policy: 'action-scoped-if-independent-actions' as const };
  const { registry, project } = setup([block]);
  const result = await registry.execute('hv_plan', { project: project.name, env: 'staging' });
  expect(result.data).toMatchObject({ blocked: [block] });
  expect(result.next).toEqual(['hv_plan']);
  expect(result.agentInstruction?.action).toBe('stop_and_report');
});
