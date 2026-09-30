import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context.js';
import type { Component } from '../../domain/entities/component.entity.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import type { Project } from '../../domain/entities/project.entity.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { environmentSpecSchema } from '../../domain/spec/spec.schema.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { DATABASE_RESILIENCE_OPERATIONS } from '../../domain/services/database-resilience-plan.service.js';
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
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

describe('snapshot checkpoint apply boundary', () => {
  afterEach(() => vi.restoreAllMocks());
  function checkpointFixture() {
    const state = fixture();
    state.setComponent({ ...state.component(), bindings: { provider: 'railway', resilience: {} } });
    const source = { provider: 'railway', providerScope: { projectId: 'p1', environmentId: 'production1' }, primaryExternalId: 'primary-1', resourceIdentity: { volumeId: 'v1', volumeInstanceId: 'vi1' }, backups: [] as unknown[] };
    const { backups: _backups, ...identity } = source;
    const action: PlanAction = {
      id: 'database:railway:checkpoint:pre-beta', type: 'create', resource: { kind: 'database', provider: 'railway', name: 'postgres' },
      verified: true, reason: 'Requested snapshot', billable: true, dataBearing: true, requiresConfirm: true,
      metadata: { operation: 'databaseCheckpointCreate', primaryExternalId: 'primary-1', checkpointId: 'pre-beta', source: identity },
    };
    const environmentSpec = { ...state.environmentSpec, database: { provider: 'railway', engine: 'postgres', resilience: { checkpoint: { id: 'pre-beta' } } } } as typeof state.environmentSpec;
    const binding = () => (state.component().bindings.resilience as { checkpoints?: Record<string, any> }).checkpoints?.['pre-beta'];
    const native = new RailwayAdapter();
    const adapter = {
      observeCheckpointSource: vi.fn(async () => structuredClone(source)),
      createCheckpoint: vi.fn(async (_source, label) => {
        expect(binding()).toMatchObject({ state: 'attempting', label, beforeBackupIds: [] });
        source.backups = [{ id: 'b1', externalId: 'backup-external-1', name: label, createdAt: new Date().toISOString(), expiresAt: null, usedMB: 42, referencedMB: 42, volumeInstanceSizeMB: 100 }];
        return { acknowledged: true, operationId: 'w1' };
      }),
      observeCheckpointRequest: vi.fn(async (_environment: Environment, _component: Component, request: import('../../domain/ports/database-checkpoint.port.js').DatabaseCheckpointBinding) => native.observeDatabaseCheckpointRequest(request)),
      observeCheckpointWorkflow: vi.fn(async () => {
        expect(binding()).toMatchObject({ operationId: 'w1', state: 'running' });
        return { state: 'complete' };
      }),
    };
    vi.spyOn(native, 'observeDatabaseCheckpointSource').mockImplementation(async () => adapter.observeCheckpointSource() as never);
    vi.spyOn(native, 'observeDatabaseCheckpointWorkflow').mockImplementation(async () => adapter.observeCheckpointWorkflow() as never);
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: adapter as never });
    const apply = (overrides = {}) => applyDatabaseResilienceAction({ ctx: state.ctx, project: state.project, environmentName: 'production', environmentSpec, action, confirmedActionIds: new Set([action.id]), ...overrides });
    return { ...state, action, source, binding, adapter, apply };
  }
  it('persists before a single create, verifies exact workflow and new backup, and exports a safe recovery identity', async () => {
    const state = checkpointFixture();
    const result = await state.apply();
    expect(result).toMatchObject({ success: true, data: { checkpointId: 'pre-beta', applied: 1, skipped: 0, restoreVerified: false } });
    expect(state.binding()).toMatchObject({ state: 'complete', operationId: 'w1', backup: { id: 'b1' } });
    expect(state.environment().platformBindings.databaseCheckpoints).toMatchObject({ 'pre-beta': { source: { resourceIdentity: { volumeInstanceId: 'vi1' } }, backup: { id: 'b1' } } });
    expect(state.adapter.createCheckpoint).toHaveBeenCalledOnce();
    const second = await state.apply();
    expect(second).toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    expect(state.adapter.createCheckpoint).toHaveBeenCalledOnce();
  });
  it('retains a safe operation diagnostic when normalized completed evidence is malformed', async () => {
    const state = checkpointFixture();
    state.adapter.observeCheckpointRequest.mockResolvedValue({ state: 'complete', source: {}, backup: {} } as never);
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked', data: {
      applied: null, operationId: 'w1', observationFailure: { stage: 'operation_status', category: 'invalid_response' },
    } });
    expect(state.adapter.createCheckpoint).toHaveBeenCalledOnce();
    expect(state.binding()).toMatchObject({ state: 'running', operationId: 'w1' });
  });

  it('never reissues a write with an uncertain acknowledgement', async () => {
    const state = checkpointFixture();
    state.adapter.createCheckpoint.mockRejectedValue(new Error('connection lost with secret raw body'));
    const failed = await state.apply();
    expect(failed).toMatchObject({ success: false, status: 'blocked', data: { checkpointId: 'pre-beta', applied: null, skipped: 0, restoreVerified: false } });
    expect(JSON.stringify(failed)).not.toContain('secret raw body');
    expect(state.binding()).toMatchObject({ state: 'unknown' });
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.adapter.createCheckpoint).toHaveBeenCalledOnce();
  });
  it('recomputes all confirmation requirements and exact caller confirmation before provider writes', async () => {
    const state = checkpointFixture();
    for (const field of ['requiresConfirm', 'billable', 'dataBearing']) {
      const action = { ...state.action, [field]: false };
      expect(await state.apply({ action })).toMatchObject({ success: false, status: 'blocked' });
    }
    expect(await state.apply({ confirmedActionIds: new Set(['different-action']) })).toMatchObject({ success: false, status: 'blocked' });
    expect(state.adapter.createCheckpoint).not.toHaveBeenCalled();
  });
  it('retains a missing workflow acknowledgement and blocks a new intent as well as a retry', async () => {
    const state = checkpointFixture();
    state.adapter.createCheckpoint.mockResolvedValue({ acknowledged: false } as never);
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    const nextSpec = { ...state.environmentSpec, database: { provider: 'railway', engine: 'postgres', resilience: { checkpoint: { id: 'another-request' } } } };
    const nextAction = { ...state.action, id: 'database:railway:checkpoint:another-request', metadata: { ...state.action.metadata, checkpointId: 'another-request' } };
    expect(await state.apply({ environmentSpec: nextSpec, action: nextAction })).toMatchObject({ success: false, status: 'blocked' });
    expect(state.adapter.createCheckpoint).toHaveBeenCalledOnce();
  });
  it.each(['error', 'not-found'])('does not repeat a provider workflow that returns %s', async (workflowState) => {
    const state = checkpointFixture();
    state.adapter.observeCheckpointWorkflow.mockResolvedValue({ state: workflowState });
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.adapter.createCheckpoint).toHaveBeenCalledOnce();
  });
  it('waits for visibility of the uniquely labeled new backup and resumes without another create', async () => {
    vi.useFakeTimers();
    try {
      const state = checkpointFixture();
      state.adapter.observeCheckpointWorkflow.mockResolvedValue({ state: 'running' });
      const pending = state.apply();
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ success: false, status: 'pending' });
      state.adapter.observeCheckpointWorkflow.mockResolvedValue({ state: 'complete' });
      expect(await state.apply()).toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
      expect(state.adapter.createCheckpoint).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('refuses old or duplicate matching backup identities even after workflow completion', async () => {
    const state = checkpointFixture();
    state.adapter.createCheckpoint.mockImplementation(async (_source, label) => {
      state.source.backups = [1, 2].map((i) => ({ id: `b${i}`, externalId: `external-${i}`, name: label, createdAt: new Date().toISOString(), expiresAt: null, usedMB: 0, referencedMB: 0, volumeInstanceSizeMB: 100 }));
      return { acknowledged: true, operationId: 'w1' };
    });
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.binding()).toMatchObject({ state: 'running' });
  });
  it('rejects previously inventoried external backup IDs and timestamps before the request', async () => {
    vi.useFakeTimers();
    try {
      const state = checkpointFixture();
      const original = { id: 'b-old', externalId: 'external-old', name: 'old', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: null, usedMB: 0, referencedMB: 0, volumeInstanceSizeMB: 100 };
      state.source.backups = [original];
      state.adapter.createCheckpoint.mockImplementation(async (_source, label) => {
        state.source.backups = [{ ...original, id: 'changed-internal-id', name: label, createdAt: new Date().toISOString() }, { ...original, id: 'different-id', externalId: 'different-external', name: label }];
        return { acknowledged: true, operationId: 'w1' };
      });
      const pending = state.apply(); await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ success: false, status: 'pending' });
      expect(state.binding()).not.toHaveProperty('backup');
      expect(state.adapter.createCheckpoint).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('does not replace an expired or deleted completed backup on a retry', async () => {
    const state = checkpointFixture();
    expect(await state.apply()).toMatchObject({ success: true });
    state.source.backups = [];
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.adapter.createCheckpoint).toHaveBeenCalledOnce();
  });
  it('blocks malformed persisted recovery evidence rather than treating it as a fresh intent', async () => {
    const state = checkpointFixture();
    state.setComponent({ ...state.component(), bindings: { ...state.component().bindings, resilience: { checkpoints: { 'pre-beta': { state: 'complete' } } } } });
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.adapter.createCheckpoint).not.toHaveBeenCalled();
  });
  it('blocks provider creation when the durable reservation was not persisted', async () => {
    const state = checkpointFixture();
    vi.spyOn(state.ctx.repos.components, 'update').mockReturnValue(null);
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.adapter.createCheckpoint).not.toHaveBeenCalled();
  });
  it('rejects a changed volume instance in the same provider environment before any write', async () => {
    const state = checkpointFixture();
    state.source.resourceIdentity.volumeInstanceId = 'replacement-instance';
    state.action.metadata = { ...state.action.metadata, source: { ...state.source, volumeInstanceId: 'vi1' } };
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.adapter.createCheckpoint).not.toHaveBeenCalled();
  });
});
