import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import type {
  MaintenanceEdgeBinding,
  MaintenanceWorkloadObservation,
  MaintenanceWorkloadSnapshot,
} from '../../domain/ports/maintenance.port.js';
import type { ObservedState } from '../../domain/ports/observe.port.js';
import type { IProviderAdapter } from '../../domain/ports/provider.port.js';
import { projectSpecSchema, type EnvironmentSpec } from '../../domain/spec/spec.schema.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import * as cloudflare from '../../domain/services/cloudflare-ops.service.js';
import * as databaseAccess from '../../domain/services/database-access.service.js';
import * as databaseOps from '../../domain/services/database-ops.service.js';
import * as postgres from '../../domain/services/postgres-maintenance.service.js';
import {
  observeEnvironmentMaintenance,
  parseEnvironmentMaintenanceBinding,
} from '../../domain/services/environment-maintenance.service.js';
import {
  MAINTENANCE_OPERATIONS,
  planMaintenance,
} from '../../domain/services/maintenance-plan.service.js';
import { applyMaintenanceAction } from '../apply-maintenance.js';
import { createCommandContext } from '../context.js';

let directory: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-application-maintenance-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  const privateDatabase = async (): Promise<never> => {
    throw new Error('This private database must not be accessed for an application pause');
  };
  vi.spyOn(databaseOps, 'resolveExternalDatabaseUrl').mockImplementation(privateDatabase);
  vi.spyOn(databaseAccess, 'acquireManagedDatabaseAccess').mockImplementation(privateDatabase);
  vi.spyOn(postgres, 'observePostgresWriteFence').mockImplementation(privateDatabase);
  vi.spyOn(postgres, 'setPostgresWriteFence').mockImplementation(privateDatabase);
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function expectDatabaseUntouched(): void {
  expect(databaseOps.resolveExternalDatabaseUrl).not.toHaveBeenCalled();
  expect(databaseAccess.acquireManagedDatabaseAccess).not.toHaveBeenCalled();
  expect(postgres.observePostgresWriteFence).not.toHaveBeenCalled();
  expect(postgres.setPostgresWriteFence).not.toHaveBeenCalled();
}

// These stateful boundary doubles test shared lifecycle behavior, not provider API contracts.
function harness(options: { drainingPausedCron?: boolean } = {}) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'private-app', defaultPlatform: 'railway' });
  const original: Record<string, MaintenanceWorkloadObservation> = {
    nightly: {
      serviceId: 'nightly-id', environmentId: 'provider-env', workloadKind: 'cron',
      wasRunning: !options.drainingPausedCron, state: 'running', cronSchedule: '17 3 * * *',
      providerState: {
        schedulerState: options.drainingPausedCron ? 'PAUSED' : 'ENABLED',
        timezone: 'America/Vancouver',
      },
    },
    worker: {
      serviceId: 'worker-id', environmentId: 'provider-env', workloadKind: 'worker',
      wasRunning: true, state: 'running', numReplicas: 2, sleepApplication: false,
      providerState: { runtimeFloor: 2 },
    },
    web: {
      serviceId: 'web-id', environmentId: 'provider-env', workloadKind: 'web',
      wasRunning: true, state: 'running', numReplicas: 3, sleepApplication: true,
      deploymentId: 'web-deployment', providerState: { runtimeFloor: 1 },
    },
  };
  const workloads = structuredClone(original);
  const restored = structuredClone(original);
  if (options.drainingPausedCron) restored.nightly.state = 'suspended';
  const writes: string[] = [];
  let edgeState: 'active' | 'inactive' | 'unknown' = 'inactive';
  const edgeBinding: MaintenanceEdgeBinding = {
    hostname: 'app.example.com', accountId: 'account-id', zoneId: 'zone-id',
    routeId: 'route-id', scriptName: 'maintenance-script', contentHash: 'reviewed-content',
  };
  const environment = ctx.repos.environments.create({
    projectId: project.id, name: 'production',
    platformBindings: {
      provider: 'railway', projectId: 'provider-project', environmentId: 'provider-env',
      services: Object.fromEntries(Object.entries(original).map(([name, value]) => [name, {
        serviceId: value.serviceId,
      }])),
    },
  });
  const spec = projectSpecSchema.parse({
    version: 1, project: project.name,
    environments: { production: {
      hosting: { provider: 'railway' }, domain: edgeBinding.hostname,
      services: {
        web: { workloadKind: 'web' },
        worker: { workloadKind: 'worker' },
        nightly: { workloadKind: 'cron', cronSchedule: '17 3 * * *', startCommand: 'npm run nightly' },
      },
      database: { provider: 'railway', engine: 'postgres' },
      maintenance: { enabled: true, mode: 'application' },
    } },
  }).environments.production;
  const currentEnvironment = () => ctx.repos.environments.findById(environment.id)!;
  const workloadName = (snapshot: Pick<MaintenanceWorkloadSnapshot, 'serviceId'>) => {
    const name = Object.keys(workloads).find((candidate) => workloads[candidate].serviceId === snapshot.serviceId);
    expect(name).toBeDefined();
    return name!;
  };
  const adapter = {
    observeMaintenanceWorkload: vi.fn(async (_environment, serviceId: string) =>
      structuredClone(workloads[workloadName({ serviceId })])),
    suspendMaintenanceWorkload: vi.fn(async (_environment, snapshot: MaintenanceWorkloadSnapshot) => {
      const saved = parseEnvironmentMaintenanceBinding(currentEnvironment());
      // Every original setting must be durable before the first provider mutation.
      expect(saved).toMatchObject({ mode: 'application', workloads: original });
      expect(edgeState).toBe('active');
      const name = workloadName(snapshot);
      writes.push(`suspend:${name}`);
      workloads[name] = options.drainingPausedCron && name === 'nightly'
        ? { ...workloads[name], state: 'suspended' }
        : {
        ...workloads[name], state: 'suspended', wasRunning: false, numReplicas: 0,
        ...(snapshot.workloadKind === 'cron' ? { cronSchedule: '' } : {}),
      };
      return { success: true, message: `Suspended ${name}` };
    }),
    resumeMaintenanceWorkload: vi.fn(async (_environment, snapshot: MaintenanceWorkloadSnapshot) => {
      expect(edgeState).toBe('active');
      const name = workloadName(snapshot);
      writes.push(`resume:${name}`);
      workloads[name] = {
        ...structuredClone(snapshot), state: snapshot.wasRunning ? 'running' : 'suspended',
      };
      return { success: true, message: `Restored ${name}` };
    }),
  } as unknown as IProviderAdapter;
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
  const edgeAdapter = {
    maintenanceContentHash: () => edgeBinding.contentHash,
    observeMaintenanceEdge: vi.fn(async () => ({
      state: edgeState, hostname: edgeBinding.hostname,
      markerVerified: edgeState === 'active',
      ...(edgeState === 'active' ? { binding: structuredClone(edgeBinding) } : {}),
    })),
    ensureMaintenanceEdge: vi.fn(async () => {
      writes.push('edge:enable');
      edgeState = 'active';
      return { success: true, message: 'Maintenance response enabled', data: { binding: edgeBinding } };
    }),
    removeMaintenanceEdge: vi.fn(async (binding: MaintenanceEdgeBinding) => {
      expect(binding).toEqual(edgeBinding);
      expect(workloads).toEqual(restored);
      writes.push('edge:disable');
      edgeState = 'inactive';
      return { success: true, message: 'Normal traffic restored' };
    }),
  };
  vi.spyOn(cloudflare, 'getCloudflareAdapter').mockReturnValue({
    adapter: edgeAdapter,
    scope: 'example.com',
  } as unknown as ReturnType<typeof cloudflare.getCloudflareAdapter>);
  const observe = (desired = spec) => observeEnvironmentMaintenance({
    project, environment: currentEnvironment(), environmentSpec: desired, hostingAdapter: adapter,
  });
  const plan = async (desired = spec) => planMaintenance({
    environmentName: 'production', environmentSpec: desired, environment: currentEnvironment(),
    observed: { maintenance: await observe(desired) } as ObservedState,
  });
  const apply = (action: PlanAction, desired = spec) => applyMaintenanceAction({
    ctx, project, environmentName: 'production', environmentSpec: desired, action,
  });
  const applyPlan = async (desired = spec) => {
    const planned = await plan(desired);
    const finished = new Set<string>();
    for (const action of planned.actions) {
      expect(action.verified, action.reason).toBe(true);
      for (const dependency of action.dependsOn ?? []) expect(finished.has(dependency)).toBe(true);
      if (action.type !== 'noop') expect(await apply(action, desired), action.reason).toMatchObject({ success: true });
      finished.add(action.id);
    }
    return planned;
  };
  return {
    ctx, spec, original, restored, workloads, writes, adapter, currentEnvironment,
    observe, plan, apply, applyPlan,
    loseEdgeObservation: () => { edgeState = 'unknown'; },
  };
}

describe('application maintenance plan/apply lifecycle with a private database', () => {
  it('preserves a paused cron schedule when its current execution was still draining at entry', async () => {
    // A native schedule already PAUSED may still have a current execution.
    // Its activity observation is running; its restoration setting is paused.
    const h = harness({ drainingPausedCron: true });
    expect(await h.observe()).toMatchObject({
      workloads: { nightly: { state: 'running', wasRunning: false } },
    });
    await h.applyPlan();
    expect(h.currentEnvironment().platformBindings.maintenance).toMatchObject({
      workloads: { nightly: { wasRunning: false, providerState: { schedulerState: 'PAUSED' } } },
    });
    const exitSpec: EnvironmentSpec = {
      ...h.spec, maintenance: { enabled: false, mode: 'application' },
    };
    const exit = await h.applyPlan(exitSpec);
    expect(exit.actions.find((action) => action.metadata?.serviceName === 'nightly')).toMatchObject({
      type: 'noop', metadata: { operation: MAINTENANCE_OPERATIONS.workloadResume },
    });
    expect(h.workloads).toEqual(h.restored);
    expect(h.writes).not.toContain('resume:nightly');
    expect(h.currentEnvironment().platformBindings.maintenance).toBeUndefined();
    expectDatabaseUntouched();
  });

  it.each(['disable maintenance', 'remove maintenance from the spec'])(
    'preserves exact workload settings when resuming by %s',
    async (resumeMethod) => {
      const h = harness();
      const enter = await h.applyPlan();
      expect(enter.actions.map((action) => action.metadata?.operation)).toEqual([
        MAINTENANCE_OPERATIONS.edgeEnable,
        MAINTENANCE_OPERATIONS.workloadSuspend,
        MAINTENANCE_OPERATIONS.workloadSuspend,
        MAINTENANCE_OPERATIONS.workloadSuspend,
        MAINTENANCE_OPERATIONS.verifyEnter,
      ]);
      expect(await h.observe()).toMatchObject({
        mode: 'application', state: 'active', stage: 'verified', database: { state: 'unmanaged' },
      });
      expect(h.currentEnvironment().platformBindings.maintenance).toMatchObject({
        mode: 'application', state: 'active', workloads: h.original,
      });
      expect((await h.plan()).actions.every((action) => action.type === 'noop')).toBe(true);
      const exitSpec: EnvironmentSpec = structuredClone(h.spec);
      if (resumeMethod === 'disable maintenance') exitSpec.maintenance = { enabled: false, mode: 'application' };
      else delete exitSpec.maintenance;
      const exit = await h.applyPlan(exitSpec);
      expect(exit.actions.map((action) => action.metadata?.operation)).toEqual([
        MAINTENANCE_OPERATIONS.workloadResume,
        MAINTENANCE_OPERATIONS.workloadResume,
        MAINTENANCE_OPERATIONS.workloadResume,
        MAINTENANCE_OPERATIONS.edgeDisable,
        MAINTENANCE_OPERATIONS.verifyExit,
      ]);
      expect(h.workloads).toEqual(h.original);
      expect(h.currentEnvironment().platformBindings.maintenance).toBeUndefined();
      expect(h.writes).toEqual([
        'edge:enable', 'suspend:nightly', 'suspend:worker', 'suspend:web',
        'resume:web', 'resume:worker', 'resume:nightly', 'edge:disable',
      ]);
      expectDatabaseUntouched();
    }
  );

  it('blocks suspension when a previously verified maintenance edge becomes unknown', async () => {
    const h = harness();
    const reviewed = await h.plan();
    expect(await h.apply(reviewed.actions[0])).toMatchObject({ success: true });
    h.loseEdgeObservation();
    const bindingBefore = h.currentEnvironment().platformBindings;
    const blockedPlan = await h.plan();
    expect(blockedPlan.actions[0]).toMatchObject({
      verified: false, metadata: { blockedReason: 'maintenance_edge_unknown' },
    });
    expect(await h.apply(reviewed.actions[1])).toMatchObject({ success: false, status: 'blocked' });
    expect(h.writes).toEqual(['edge:enable']);
    expect(h.workloads).toEqual(h.original);
    expect(h.currentEnvironment().platformBindings).toEqual(bindingBefore);
    expectDatabaseUntouched();
  });

  it('blocks a mode change after pausing before any database or provider write', async () => {
    const h = harness();
    await h.applyPlan();
    const writesBefore = [...h.writes];
    const bindingBefore = h.currentEnvironment().platformBindings;
    const update = vi.spyOn(h.ctx.repos.environments, 'update');
    const changed: EnvironmentSpec = {
      ...h.spec, maintenance: { enabled: false, mode: 'data' },
    };
    const planned = await h.plan(changed);
    expect(planned.actions.length).toBeGreaterThan(0);
    for (const action of planned.actions) {
      expect(action).toMatchObject({ verified: false, metadata: { blockedReason: 'maintenance_mode_changed' } });
      expect(await h.apply(action, changed)).toMatchObject({ success: false, status: 'blocked' });
    }
    expect(h.writes).toEqual(writesBefore);
    expect(update).not.toHaveBeenCalled();
    expect(h.currentEnvironment().platformBindings).toEqual(bindingBefore);
    expectDatabaseUntouched();
  });

  it.each([MAINTENANCE_OPERATIONS.databaseFence, MAINTENANCE_OPERATIONS.databaseUnfence])(
    'rejects a direct %s action during an application pause without writes',
    async (operation) => {
      const h = harness();
      await h.applyPlan();
      const writesBefore = [...h.writes];
      const bindingBefore = h.currentEnvironment().platformBindings;
      const update = vi.spyOn(h.ctx.repos.environments, 'update');
      const action: PlanAction = {
        id: 'maintenance:production:database-fence', type: 'update', verified: true,
        resource: { kind: 'maintenance', name: 'postgres', provider: 'railway' },
        reason: 'Attempt a database operation outside the application pause',
        metadata: { operation, environmentName: 'production' },
      };
      expect(await h.apply(action)).toMatchObject({ success: false, status: 'blocked' });
      expect(h.writes).toEqual(writesBefore);
      expect(update).not.toHaveBeenCalled();
      expect(h.currentEnvironment().platformBindings).toEqual(bindingBefore);
      expectDatabaseUntouched();
    }
  );
});
