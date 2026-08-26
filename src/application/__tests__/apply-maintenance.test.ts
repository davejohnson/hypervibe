import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { IProviderAdapter } from '../../domain/ports/provider.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';

vi.mock('../../domain/services/environment-maintenance.service.js', async (original) => {
  const actual = await original<typeof import('../../domain/services/environment-maintenance.service.js')>();
  return { ...actual, observeEnvironmentMaintenance: vi.fn() };
});

import { observeEnvironmentMaintenance } from '../../domain/services/environment-maintenance.service.js';
import { applyMaintenanceAction } from '../apply-maintenance.js';

describe('applyMaintenanceAction', () => {
  beforeEach(() => {
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(
      mkdtempSync(path.join(tmpdir(), 'hypervibe-maintenance-')),
      'test.db'
    )).migrate();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(observeEnvironmentMaintenance).mockReset();
  });

  it('persists every restoration snapshot before the first workload mutation', async () => {
    const project = new ProjectRepository().create({
      name: 'maintenance-apply',
      defaultPlatform: 'digitalocean',
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'digitalocean',
        projectId: 'do-app-1',
        services: {
          nightly: { serviceId: 'do-app-1:jobs:nightly' },
          worker: { serviceId: 'do-app-1:workers:worker' },
          web: { serviceId: 'do-app-1:services:web' },
        },
      },
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'digitalocean' },
          domain: 'app.example.com',
          maintenance: { enabled: true },
          services: {
            nightly: {
              workloadKind: 'cron',
              cronSchedule: '0 3 * * *',
              startCommand: 'npm run nightly',
            },
            worker: { workloadKind: 'worker' },
            web: { workloadKind: 'web' },
          },
        },
      },
    });
    const action: PlanAction = {
      id: 'maintenance:production:workload:nightly',
      type: 'update',
      resource: { kind: 'maintenance', name: 'nightly', provider: 'digitalocean' },
      verified: true,
      reason: 'Suspend cron workload nightly',
      metadata: {
        operation: 'maintenanceWorkloadSuspend',
        environmentName: 'production',
        serviceName: 'nightly',
        serviceId: 'do-app-1:jobs:nightly',
        workloadKind: 'cron',
      },
    };
    vi.mocked(observeEnvironmentMaintenance).mockResolvedValue({
      state: 'partial',
      stage: 'workloads',
      edge: {
        state: 'active',
        hostname: 'app.example.com',
        markerVerified: true,
      },
      workloads: {
        nightly: {
          serviceId: 'do-app-1:jobs:nightly',
          workloadKind: 'cron',
          state: 'running',
          providerState: { appId: 'do-app-1', componentName: 'nightly' },
        },
        worker: {
          serviceId: 'do-app-1:workers:worker',
          workloadKind: 'worker',
          state: 'running',
          providerState: { appId: 'do-app-1', componentName: 'worker' },
        },
        web: {
          serviceId: 'do-app-1:services:web',
          workloadKind: 'web',
          state: 'running',
          providerState: { appId: 'do-app-1', componentName: 'web' },
        },
      },
      database: { state: 'not-applicable' },
    });
    const suspendMaintenanceWorkload = vi.fn(async (mutatingEnvironment) => {
      expect(mutatingEnvironment.platformBindings.maintenance).toMatchObject({
        workloads: {
          nightly: { serviceId: 'do-app-1:jobs:nightly', wasRunning: true },
          worker: { serviceId: 'do-app-1:workers:worker', wasRunning: true },
          web: { serviceId: 'do-app-1:services:web', wasRunning: true },
        },
      });
      return { success: true, message: 'archived app' };
    });
    const adapter = {
      name: 'digitalocean',
      capabilities: {
        supportedBuilders: [],
        supportedComponents: [],
        supportsAutoWiring: false,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: false,
        managedTls: true,
        supportsObserve: true,
        supportsMaintenance: true,
      },
      connect: vi.fn(),
      verify: vi.fn(),
      ensureProject: vi.fn(),
      ensureComponent: vi.fn(),
      deploy: vi.fn(),
      setEnvVars: vi.fn(),
      observeMaintenanceWorkload: vi.fn(),
      suspendMaintenanceWorkload,
      resumeMaintenanceWorkload: vi.fn(),
    } as unknown as IProviderAdapter;
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter,
    });

    const result = await applyMaintenanceAction({
      ctx: createCommandContext(),
      project,
      environmentName: 'production',
      environmentSpec: spec.environments.production,
      action,
    });

    expect(result).toMatchObject({ success: true, message: 'archived app' });
    expect(suspendMaintenanceWorkload).toHaveBeenCalledTimes(1);
    expect(new EnvironmentRepository().findById(environment.id)?.platformBindings.maintenance)
      .toMatchObject({
        workloads: {
          nightly: { serviceId: 'do-app-1:jobs:nightly' },
          worker: { serviceId: 'do-app-1:workers:worker' },
          web: { serviceId: 'do-app-1:services:web' },
        },
      });
  });
});
