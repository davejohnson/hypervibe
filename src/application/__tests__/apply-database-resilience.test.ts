import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context.js';
import type { Component } from '../../domain/entities/component.entity.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import type { Project } from '../../domain/entities/project.entity.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { environmentSpecSchema } from '../../domain/spec/spec.schema.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { DATABASE_RESILIENCE_OPERATIONS } from '../../domain/services/database-resilience-plan.service.js';
import { applyDatabaseResilienceAction } from '../apply-database-resilience.js';

function fixture() {
  const now = new Date();
  const project: Project = {
    id: 'project-1', name: 'app', defaultPlatform: 'cloudrun', policies: {}, createdAt: now, updatedAt: now,
  };
  let environment: Environment = {
    id: 'env-1', projectId: project.id, name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
  };
  let component: Component = {
    id: 'component-1', environmentId: environment.id, type: 'postgres', externalId: 'primary-1',
    bindings: {
      provider: 'cloudsql', instanceId: 'primary-1', username: 'app', password: 'secret', database: 'app',
      resilience: { replicas: {} },
    },
    createdAt: now, updatedAt: now,
  };
  const ctx = {
    repos: {
      environments: {
        findByProjectAndName: () => environment,
        updatePlatformBindings: (_id: string, patch: Record<string, unknown>) => {
          environment = { ...environment, platformBindings: { ...environment.platformBindings, ...patch } };
          return environment;
        },
      },
      components: {
        findByEnvironmentAndType: () => component,
        update: (_id: string, patch: { bindings?: Record<string, unknown>; externalId?: string }) => {
          component = { ...component, bindings: patch.bindings ?? component.bindings, externalId: patch.externalId ?? component.externalId };
          return component;
        },
      },
    },
  } as unknown as CommandContext;
  const environmentSpec = environmentSpecSchema.parse({
    hosting: { provider: 'cloudrun' }, services: { web: {} },
    database: { provider: 'cloudsql', resilience: { replicas: { analytics: { region: 'us-west1' } } } },
  });
  return {
    ctx, project, environmentSpec,
    environment: () => environment,
    component: () => component,
    setComponent: (next: Component) => { component = next; },
  };
}

function replicaAction(type: 'create' | 'destroy', externalId?: string): PlanAction {
  return {
    id: `database:cloudsql:replica:analytics${type === 'destroy' ? ':destroy' : ''}`,
    type,
    resource: { kind: 'database', name: 'analytics', provider: 'cloudsql' },
    verified: true,
    reason: 'test',
    metadata: {
      operation: type === 'create'
        ? DATABASE_RESILIENCE_OPERATIONS.replicaProvision
        : DATABASE_RESILIENCE_OPERATIONS.replicaDestroy,
      primaryExternalId: 'primary-1',
      replicaName: 'analytics',
      region: 'us-west1',
      ...(externalId ? { replicaExternalId: externalId } : {}),
    },
  };
}

function resilienceAdapter(overrides: Record<string, unknown> = {}) {
  return {
    name: 'cloudsql',
    configureAvailability: vi.fn(),
    configureBackupPolicy: vi.fn(),
    provisionReadReplica: vi.fn().mockResolvedValue({
      receipt: { success: true, message: 'created' },
      replica: {
        externalId: 'replica-1', region: 'us-west1', connectionName: 'gcp-project:us-west1:replica-1',
        connectionUrl: 'postgresql://app:secret@203.0.113.1/app',
      },
    }),
    destroyReadReplica: vi.fn().mockResolvedValue({ success: true, message: 'deleted' }),
    ...overrides,
  };
}

describe('applyDatabaseResilienceAction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records replica credentials only in encrypted component bindings and repo-safe topology separately', async () => {
    const state = fixture();
    const adapter = resilienceAdapter();
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: adapter as never });

    const result = await applyDatabaseResilienceAction({
      ctx: state.ctx, project: state.project, environmentName: 'production', environmentSpec: state.environmentSpec,
      action: replicaAction('create'),
    });

    expect(result.success).toBe(true);
    expect((state.component().bindings.resilience as { replicas: Record<string, unknown> }).replicas.analytics).toMatchObject({
      externalId: 'replica-1',
      connectionUrl: 'postgresql://app:secret@203.0.113.1/app',
    });
    expect(state.environment().platformBindings.databaseTopology).toEqual({
      primary: { provider: 'cloudsql', externalId: 'primary-1' },
      replicas: { analytics: { provider: 'cloudsql', externalId: 'replica-1', region: 'us-west1' } },
    });
    expect(JSON.stringify(result)).not.toContain('postgresql://');
    expect(JSON.stringify(state.environment().platformBindings)).not.toContain('secret');
  });

  it('refuses stale primary identity before resolving or mutating a provider adapter', async () => {
    const state = fixture();
    const getAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');
    const action = replicaAction('create');
    action.metadata = { ...action.metadata, primaryExternalId: 'old-primary' };

    const result = await applyDatabaseResilienceAction({
      ctx: state.ctx, project: state.project, environmentName: 'production', environmentSpec: state.environmentSpec, action,
    });

    expect(result).toMatchObject({ success: false, status: 'blocked' });
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('preserves the durable binding when provider deletion is not proven', async () => {
    const state = fixture();
    state.setComponent({
      ...state.component(),
      bindings: {
        ...state.component().bindings,
        resilience: { replicas: { analytics: { externalId: 'replica-1', region: 'us-west1' } } },
      },
    });
    const adapter = resilienceAdapter({
      destroyReadReplica: vi.fn().mockResolvedValue({ success: false, message: 'pending', error: 'still observable' }),
    });
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: adapter as never });
    const destroySpec = environmentSpecSchema.parse({
      hosting: { provider: 'cloudrun' }, services: { web: {} },
      database: { provider: 'cloudsql', resilience: { replicas: {} } },
    });

    const result = await applyDatabaseResilienceAction({
      ctx: state.ctx, project: state.project, environmentName: 'production', environmentSpec: destroySpec,
      action: replicaAction('destroy', 'replica-1'),
    });

    expect(result.success).toBe(false);
    expect(adapter.destroyReadReplica).toHaveBeenCalledOnce();
    expect((state.component().bindings.resilience as { replicas: Record<string, unknown> }).replicas.analytics).toBeTruthy();
  });
});
