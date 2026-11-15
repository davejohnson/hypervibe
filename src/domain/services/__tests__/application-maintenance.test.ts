import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { projectSpecSchema, type EnvironmentSpec } from '../../spec/spec.schema.js';
import { observeEnvironmentMaintenance } from '../environment-maintenance.service.js';
import { planMaintenance } from '../maintenance-plan.service.js';
import { planDataMigration } from '../data-migration-plan.service.js';

const mocks = vi.hoisted(() => ({
  databaseUrl: vi.fn(),
  edge: vi.fn(),
}));
vi.mock('../database-ops.service.js', () => ({ resolveExternalDatabaseUrl: mocks.databaseUrl }));
vi.mock('../cloudflare-ops.service.js', () => ({ getCloudflareAdapter: () => ({ adapter: {
  observeMaintenanceEdge: mocks.edge,
  ensureMaintenanceEdge: vi.fn(),
  removeMaintenanceEdge: vi.fn(),
} }) }));

const project = { id: 'project-id', name: 'private-app' } as Project;
const environment = {
  id: 'environment-id', projectId: project.id, name: 'production',
  platformBindings: {
    provider: 'railway', projectId: 'railway-project', environmentId: 'railway-env',
    services: { web: { serviceId: 'web-id' } },
    maintenance: {
      mode: 'application', state: 'active',
      workloads: { web: { serviceId: 'web-id', workloadKind: 'web', wasRunning: true } },
    },
  },
} as unknown as Environment;
function spec(enabled = true): EnvironmentSpec {
  return {
    hosting: { provider: 'railway' }, domain: 'app.example.com',
    services: { web: { workloadKind: 'web' } },
    database: { provider: 'railway', engine: 'postgres' },
    maintenance: { enabled, mode: 'application' },
  } as unknown as EnvironmentSpec;
}
const hostingAdapter = {
  observeMaintenanceWorkload: vi.fn(async () => ({
    state: 'suspended', serviceId: 'web-id', workloadKind: 'web', wasRunning: false,
  })),
  suspendMaintenanceWorkload: vi.fn(), resumeMaintenanceWorkload: vi.fn(),
};

beforeEach(() => {
  mocks.databaseUrl.mockReset().mockRejectedValue(new Error('Database is private-only'));
  mocks.edge.mockReset().mockResolvedValue({ state: 'active', hostname: 'app.example.com', markerVerified: true });
});

describe('application maintenance without database access', () => {
  it('accepts an explicit application pause without changing the legacy default', () => {
    const parsed = projectSpecSchema.parse({ version: 1, project: project.name,
      environments: { production: spec() } });
    expect(parsed.environments.production.maintenance).toEqual({ enabled: true, mode: 'application' });
  });

  it('verifies paused applications without opening or inspecting private PostgreSQL', async () => {
    const observation = await observeEnvironmentMaintenance({ project, environment,
      environmentSpec: spec(), hostingAdapter });
    expect(observation).toMatchObject({ mode: 'application', state: 'active', stage: 'verified',
      database: { state: 'unmanaged' } });
    expect(mocks.databaseUrl).not.toHaveBeenCalled();
    const plan = planMaintenance({ environmentName: 'production', environmentSpec: spec(), environment,
      observed: { maintenance: observation } as ObservedState });
    expect(plan.pending).toBe(false);
    expect(plan.actions.some(action => String(action.metadata?.operation).includes('Database'))).toBe(false);
  });

  it('does not require a database unfreeze to resume a paused application', () => {
    const plan = planMaintenance({ environmentName: 'production', environmentSpec: spec(false), environment,
      observed: { maintenance: { mode: 'application', state: 'active', stage: 'verified',
        edge: { state: 'active', hostname: 'app.example.com', markerVerified: true },
        workloads: { web: { state: 'suspended', serviceId: 'web-id', workloadKind: 'web' } },
        database: { state: 'unmanaged' },
      } } as unknown as ObservedState });
    expect(plan.actions.map(action => action.metadata?.operation)).toEqual([
      'maintenanceWorkloadResume', 'maintenanceEdgeDisable', 'maintenanceVerifyExit',
    ]);
  });

  it('does not let an application pause authorize automated data copying', () => {
    const sourceSpec = spec();
    const targetSpec = { ...spec(), dataMigration: { id: 'copy', fromEnvironment: 'source',
      include: { database: true, storage: [] } } } as EnvironmentSpec;
    const active = { state: 'active', stage: 'verified', mode: 'application',
      edge: { state: 'active', hostname: 'app.example.com', markerVerified: true },
      workloads: {}, database: { state: 'unmanaged' },
    } as const;
    const plan = planDataMigration({ targetEnvironmentName: 'production', targetSpec,
      targetEnvironment: environment, targetComponents: [], sourceSpec, sourceEnvironment: environment,
      sourceComponents: [{ id: 'db-id', environmentId: environment.id, type: 'postgres', externalId: 'db-native',
        bindings: { provider: 'railway' }, createdAt: new Date(), updatedAt: new Date() }],
      sourceMaintenance: active, targetMaintenance: active });
    expect(plan.actions[0]).toMatchObject({ verified: false,
      metadata: { blockedReason: 'data_migration_requires_data_maintenance' } });
  });
});
