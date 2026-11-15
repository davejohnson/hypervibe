import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import type { MaintenanceEdgeBinding, MaintenanceWorkloadSnapshot, TrafficEdgeTarget } from '../../domain/ports/maintenance.port.js';
import type { ObservedState } from '../../domain/ports/observe.port.js';
import type { IProviderAdapter } from '../../domain/ports/provider.port.js';
import { projectSpecSchema, type EnvironmentSpec } from '../../domain/spec/spec.schema.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import * as cloudflare from '../../domain/services/cloudflare-ops.service.js';
import * as targetResolver from '../../domain/services/domain-target.service.js';
import { observeEnvironmentMaintenance, parseEnvironmentMaintenanceBinding } from '../../domain/services/environment-maintenance.service.js';
import { MAINTENANCE_OPERATIONS, planMaintenance } from '../../domain/services/maintenance-plan.service.js';
import { applyMaintenanceAction } from '../apply-maintenance.js';
import { createCommandContext } from '../context.js';

let directory: string;
beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-routing-lifecycle-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

// Stateful lifecycle doubles model exact route identity and lost acknowledgments.
// They do not establish Cloudflare or hosting-provider API compatibility.
function harness() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'routing-app', defaultPlatform: 'railway' });
  const pageEdge: MaintenanceEdgeBinding = { hostname: 'app.example.com', accountId: 'account', zoneId: 'zone', routeId: 'route', scriptName: 'script', contentHash: 'page-content' };
  const snapshot: MaintenanceWorkloadSnapshot = {
    serviceId: 'old-web', environmentId: 'old-env', workloadKind: 'web', wasRunning: true,
    deploymentId: 'old-deployment', numReplicas: 3, providerState: { runtimeFloor: 1 },
  };
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'old-project', environmentId: 'old-env',
    services: { web: { serviceId: 'old-web', url: 'https://old.example.net' } },
    maintenance: { mode: 'application', state: 'active', edge: pageEdge, workloads: { web: snapshot } },
  } });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    production: { hosting: { provider: 'railway' }, domain: pageEdge.hostname,
      services: { web: { workloadKind: 'web' } }, maintenance: { enabled: true, mode: 'application', page: 'off' },
      domainTarget: { environment: 'next', service: 'web' } },
    next: { hosting: { provider: 'cloudrun' }, services: { web: { workloadKind: 'web' } } },
  } }).environments.production;
  const current = () => ctx.repos.environments.findById(environment.id)!;
  let liveEdge: MaintenanceEdgeBinding = structuredClone(pageEdge);
  let target: TrafficEdgeTarget = { origin: 'https://replacement.run.app', targetFingerprint: 'a'.repeat(64) };
  let targetReady = true;
  let loseReceipt = false;
  let routeVisible = true;
  let rejectPageWrite = false;
  const writes: string[] = [];
  const adapter = {
    observeMaintenanceWorkload: vi.fn(async () => ({ ...snapshot, state: 'suspended', wasRunning: false, numReplicas: 0 })),
    suspendMaintenanceWorkload: vi.fn(async () => { throw new Error('Source is already paused'); }),
    resumeMaintenanceWorkload: vi.fn(async () => { writes.push('resume'); return { success: true, message: 'restored' }; }),
  };
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: adapter as unknown as IProviderAdapter });
  vi.spyOn(targetResolver, 'observeDomainTarget').mockImplementation(async () => targetReady
    ? { state: 'ready', target: structuredClone(target) } : { state: 'unknown', reason: 'target_unknown' });
  const sameRoute = (binding: MaintenanceEdgeBinding | undefined) => binding
    && ['hostname', 'accountId', 'zoneId', 'routeId', 'scriptName'].every(field => binding[field as keyof MaintenanceEdgeBinding] === pageEdge[field as keyof MaintenanceEdgeBinding]);
  const edgeObservation = (binding: MaintenanceEdgeBinding | undefined, active: boolean) => ({
    state: active ? 'active' as const : 'unknown' as const, hostname: pageEdge.hostname,
    markerVerified: active, ...(binding ? { binding: structuredClone(binding) } : {}),
  });
  const edgeAdapter = {
    maintenanceContentHash: () => pageEdge.contentHash,
    observeMaintenanceEdge: vi.fn(async (_hostname: string, binding?: MaintenanceEdgeBinding) =>
      edgeObservation(binding, Boolean(sameRoute(binding) && !liveEdge.origin && binding?.contentHash === liveEdge.contentHash))),
    observeTrafficEdge: vi.fn(async (_hostname: string, expected: TrafficEdgeTarget, binding: MaintenanceEdgeBinding) =>
      edgeObservation(binding, Boolean(sameRoute(binding) && liveEdge.origin === expected.origin && liveEdge.targetFingerprint === expected.targetFingerprint
        && binding.origin === liveEdge.origin && binding.targetFingerprint === liveEdge.targetFingerprint && binding.contentHash === liveEdge.contentHash))),
    prepareTrafficEdge: vi.fn(async (_hostname: string, expected: TrafficEdgeTarget, binding: MaintenanceEdgeBinding) => {
      expect(sameRoute(binding)).toBe(true);
      return { ...binding, ...expected, contentHash: `traffic:${expected.targetFingerprint}` };
    }),
    ensureTrafficEdge: vi.fn(async (_hostname: string, expected: TrafficEdgeTarget, binding: MaintenanceEdgeBinding) => {
      expect(parseEnvironmentMaintenanceBinding(current())?.pendingEdge).toEqual(binding);
      expect(binding).toMatchObject(expected);
      writes.push('route');
      if (routeVisible) liveEdge = structuredClone(binding);
      if (loseReceipt) return { success: false, message: 'Response lost after script update', error: 'response_lost' };
      return { success: true, message: 'Target selected', data: { binding } };
    }),
    ensureMaintenanceEdge: vi.fn(async (_hostname: string, _hash: string, binding?: MaintenanceEdgeBinding) => {
      expect(sameRoute(binding)).toBe(true);
      const pending = parseEnvironmentMaintenanceBinding(current())?.pendingEdge;
      expect(sameRoute(pending)).toBe(true);
      // A known traffic update must survive until a superseding page PUT is
      // acknowledged; seeing the old public 503 does not cancel that update.
      if (pending?.origin) expect(pending).toMatchObject(target);
      else expect(pending).toEqual(pageEdge);
      writes.push('page');
      if (rejectPageWrite) return { success: false, message: 'Page script write rejected', error: 'provider_rejected' };
      liveEdge = structuredClone(pageEdge);
      return { success: true, message: 'Page restored', data: { binding: pageEdge } };
    }),
    removeMaintenanceEdge: vi.fn(async () => { writes.push('delete'); return { success: true, message: 'Removed' }; }),
  };
  vi.spyOn(cloudflare, 'getCloudflareAdapter').mockReturnValue({ adapter: edgeAdapter, scope: 'example.com' } as unknown as ReturnType<typeof cloudflare.getCloudflareAdapter>);
  const observe = (desired = spec) => observeEnvironmentMaintenance({ project, environment: current(), environmentSpec: desired, hostingAdapter: adapter });
  const plan = async (desired = spec) => planMaintenance({ environmentName: environment.name, environmentSpec: desired, environment: current(), observed: { maintenance: await observe(desired) } as ObservedState });
  const apply = (action: PlanAction, desired = spec) => applyMaintenanceAction({ ctx, project, environmentName: environment.name, environmentSpec: desired, action });
  const action = async (operation: string, desired = spec) => (await plan(desired)).actions.find(value => value.metadata?.operation === operation)!;
  const applyPlan = async (desired = spec) => {
    for (const value of (await plan(desired)).actions) {
      expect(value.verified).toBe(true);
      if (value.type !== 'noop') expect(await apply(value, desired)).toMatchObject({ success: true });
    }
  };
  return { spec, snapshot, pageEdge, current, writes, adapter, edgeAdapter, observe, plan, apply, action, applyPlan,
    unknownTarget: () => { targetReady = false; },
    changeTarget: () => { target = { ...target, targetFingerprint: 'b'.repeat(64) }; },
    loseRouteReceipt: () => { loseReceipt = true; },
    delayRoutePropagation: () => { routeVisible = false; },
    rejectPageOverwrite: () => { rejectPageWrite = true; } };
}

describe('application maintenance traffic routing lifecycle', () => {
  it('switches to the exact target while preserving paused source snapshots and then has a mutation-free plan', async () => {
    const h = harness();
    await h.applyPlan();
    expect(h.writes).toEqual(['route']);
    expect(h.current().platformBindings.maintenance).toMatchObject({ state: 'active', workloads: { web: h.snapshot }, edge: { ...h.pageEdge, origin: 'https://replacement.run.app', contentHash: expect.any(String) } });
    expect(await h.observe()).toMatchObject({ state: 'active', page: 'off' });
    expect((await h.plan()).actions.every(action => action.type === 'noop')).toBe(true);
    expect(h.adapter.resumeMaintenanceWorkload).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'changed'])('rejects a %s target after planning without changing the script', async condition => {
    const h = harness();
    const route = await h.action(MAINTENANCE_OPERATIONS.edgeRoute);
    if (condition === 'unknown') h.unknownTarget(); else h.changeTarget();
    expect(await h.apply(route)).toMatchObject({ success: false, status: 'blocked' });
    expect(h.writes).toEqual([]);
    expect(h.edgeAdapter.prepareTrafficEdge).not.toHaveBeenCalled();
  });

  it('recovers a lost script acknowledgment from pending identity without another script mutation', async () => {
    const h = harness();
    const route = await h.action(MAINTENANCE_OPERATIONS.edgeRoute);
    h.loseRouteReceipt();
    expect(await h.apply(route)).toMatchObject({ success: false, status: 'blocked' });
    expect(parseEnvironmentMaintenanceBinding(h.current())).toMatchObject({ edge: h.pageEdge, pendingEdge: { origin: 'https://replacement.run.app' }, workloads: { web: h.snapshot } });
    const replan = await h.plan();
    expect(replan.actions.filter(action => action.type !== 'noop').map(action => action.metadata?.operation)).toEqual([MAINTENANCE_OPERATIONS.verifyEnter]);
    await h.applyPlan();
    expect(h.writes).toEqual(['route']);
    expect(parseEnvironmentMaintenanceBinding(h.current())).toMatchObject({ state: 'active', edge: { origin: 'https://replacement.run.app' }, workloads: { web: h.snapshot } });
    expect(parseEnvironmentMaintenanceBinding(h.current())?.pendingEdge).toBeUndefined();
  });

  it('restores the 503 page on the same route while leaving source workloads paused', async () => {
    const h = harness();
    await h.applyPlan();
    const pageSpec: EnvironmentSpec = { ...h.spec, maintenance: { enabled: true, mode: 'application', page: 'active' } };
    await h.applyPlan(pageSpec);
    expect(h.writes).toEqual(['route', 'page']);
    expect(await h.observe(pageSpec)).toMatchObject({ state: 'active', page: 'active' });
    expect(parseEnvironmentMaintenanceBinding(h.current())).toMatchObject({ edge: h.pageEdge, workloads: { web: h.snapshot } });
    expect(h.edgeAdapter.removeMaintenanceEdge).not.toHaveBeenCalled();
    expect(h.adapter.resumeMaintenanceWorkload).not.toHaveBeenCalled();
  });

  it('can restore the page after a lost route acknowledgment even when the selected target becomes unhealthy', async () => {
    const h = harness();
    h.loseRouteReceipt();
    expect(await h.apply(await h.action(MAINTENANCE_OPERATIONS.edgeRoute))).toMatchObject({ success: false });
    expect(parseEnvironmentMaintenanceBinding(h.current())?.pendingEdge?.origin).toBe('https://replacement.run.app');
    h.unknownTarget();
    const pageSpec: EnvironmentSpec = { ...h.spec, maintenance: { enabled: true, mode: 'application', page: 'active' } };
    await h.applyPlan(pageSpec);
    expect(h.writes).toEqual(['route', 'page']);
    expect(parseEnvironmentMaintenanceBinding(h.current())).toMatchObject({ state: 'active', edge: h.pageEdge, workloads: { web: h.snapshot } });
    expect(parseEnvironmentMaintenanceBinding(h.current())?.pendingEdge).toBeUndefined();
    expect(h.adapter.resumeMaintenanceWorkload).not.toHaveBeenCalled();
    expect(h.edgeAdapter.removeMaintenanceEdge).not.toHaveBeenCalled();
  });

  it('forces a page overwrite while an accepted pending traffic update has not reached the public edge', async () => {
    const h = harness();
    h.loseRouteReceipt();
    h.delayRoutePropagation();
    expect(await h.apply(await h.action(MAINTENANCE_OPERATIONS.edgeRoute))).toMatchObject({ success: false });
    h.unknownTarget();
    const pageSpec: EnvironmentSpec = { ...h.spec, maintenance: { enabled: true, mode: 'application', page: 'active' } };
    expect(await h.observe(pageSpec)).toMatchObject({ page: 'active', edge: { contentHash: h.pageEdge.contentHash } });
    expect(await h.action(MAINTENANCE_OPERATIONS.edgeEnable, pageSpec)).toMatchObject({ type: 'update', verified: true });
    await h.applyPlan(pageSpec);
    expect(h.writes).toEqual(['route', 'page']);
    expect(parseEnvironmentMaintenanceBinding(h.current())).toMatchObject({ state: 'active', edge: h.pageEdge, workloads: { web: h.snapshot } });
    expect(parseEnvironmentMaintenanceBinding(h.current())?.pendingEdge).toBeUndefined();
  });

  it('keeps pending traffic identity when an explicit page overwrite is rejected', async () => {
    const h = harness();
    h.loseRouteReceipt();
    h.delayRoutePropagation();
    await h.apply(await h.action(MAINTENANCE_OPERATIONS.edgeRoute));
    const pending = parseEnvironmentMaintenanceBinding(h.current())?.pendingEdge;
    expect(pending?.origin).toBe('https://replacement.run.app');
    h.unknownTarget();
    h.rejectPageOverwrite();
    const pageSpec: EnvironmentSpec = { ...h.spec, maintenance: { enabled: true, mode: 'application', page: 'active' } };
    // Force the reviewed overwrite shape to isolate apply from the independent
    // planner regression that currently labels the same operation noop.
    const overwrite: PlanAction = { ...await h.action(MAINTENANCE_OPERATIONS.edgeEnable, pageSpec), type: 'update', requiresConfirm: true, billable: true };
    expect(await h.apply(overwrite, pageSpec)).toMatchObject({ success: false, status: 'blocked' });
    expect(h.writes).toEqual(['route', 'page']);
    expect(parseEnvironmentMaintenanceBinding(h.current())?.pendingEdge).toEqual(pending);
    expect(parseEnvironmentMaintenanceBinding(h.current())?.workloads).toEqual({ web: h.snapshot });
  });

  it('cannot finalize maintenance from the old public page while a different traffic update remains pending', async () => {
    const h = harness();
    h.loseRouteReceipt();
    h.delayRoutePropagation();
    await h.apply(await h.action(MAINTENANCE_OPERATIONS.edgeRoute));
    const pending = parseEnvironmentMaintenanceBinding(h.current())?.pendingEdge;
    h.unknownTarget();
    const pageSpec: EnvironmentSpec = { ...h.spec, maintenance: { enabled: true, mode: 'application', page: 'active' } };
    const verify = await h.action(MAINTENANCE_OPERATIONS.verifyEnter, pageSpec);
    expect(await h.apply(verify, pageSpec)).toMatchObject({ success: false, status: 'blocked' });
    expect(parseEnvironmentMaintenanceBinding(h.current())?.pendingEdge).toEqual(pending);
    expect(h.writes).toEqual(['route']);
  });

  it.each(['target selected', 'pending route'])('blocks restoring the original while %s remains', async condition => {
    const h = harness();
    if (condition === 'pending route') {
      h.loseRouteReceipt();
      await h.apply(await h.action(MAINTENANCE_OPERATIONS.edgeRoute));
    }
    const exit = structuredClone(h.spec);
    exit.maintenance = { enabled: false, mode: 'application' };
    if (condition === 'pending route') delete exit.domainTarget;
    const planned = await h.plan(exit);
    expect(planned.actions.every(action => !action.verified)).toBe(true);
    for (const action of planned.actions) expect(await h.apply(action, exit)).toMatchObject({ success: false, status: 'blocked' });
    expect(h.adapter.resumeMaintenanceWorkload).not.toHaveBeenCalled();
    expect(h.edgeAdapter.removeMaintenanceEdge).not.toHaveBeenCalled();
    expect(h.writes).toEqual(condition === 'pending route' ? ['route'] : []);
  });

  it.each(['hostname', 'origin', 'targetFingerprint', 'targetEnvironment', 'targetService', 'environmentName'])('rejects tampered %s metadata before a script write', async field => {
    const h = harness();
    const route = await h.action(MAINTENANCE_OPERATIONS.edgeRoute);
    route.metadata = { ...route.metadata, [field]: 'changed' };
    expect(await h.apply(route)).toMatchObject({ success: false, status: 'blocked' });
    expect(h.writes).toEqual([]);
  });

  it.each(['provider', 'name'])('rejects a traffic action whose resource %s differs from the reviewed route', async field => {
    const h = harness();
    const route = await h.action(MAINTENANCE_OPERATIONS.edgeRoute);
    route.resource = { ...route.resource, [field]: 'unrelated-resource' };
    expect(await h.apply(route)).toMatchObject({ success: false, status: 'blocked' });
    expect(h.writes).toEqual([]);
  });

  it('does not mutate the script when directly given a noop traffic action', async () => {
    const h = harness();
    const route = await h.action(MAINTENANCE_OPERATIONS.edgeRoute);
    await h.apply({ ...route, type: 'noop' });
    expect(h.writes).toEqual([]);
  });
});
