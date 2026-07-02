import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { CLOUD_PREPARE_PROFILES, QUEUE_PREPARE_ADDON } from '../cloud-prepare.js';
import { applyQueueAction, isQueueAction, parseQueueBindings, planQueues, QUEUE_OPERATIONS } from '../queue-plan.service.js';
import type { IProviderAdapter } from '../../ports/provider.port.js';
import type { PlanAction } from '../../plan/plan.types.js';
import type { Project } from '../../entities/project.entity.js';
import type { Environment } from '../../entities/environment.entity.js';

function cloudrunPolicies(options: { queueAddon: boolean }): Record<string, unknown> {
  const profile = CLOUD_PREPARE_PROFILES.cloudrun;
  return {
    cloudPreparation: {
      cloudrun: {
        provider: 'cloudrun',
        version: profile.version,
        preparedAt: new Date().toISOString(),
        requiredApis: [
          ...profile.requiredApis,
          ...(options.queueAddon ? QUEUE_PREPARE_ADDON.requiredApis : []),
        ],
        requiredRoles: [
          ...profile.requiredRoles,
          ...(options.queueAddon ? QUEUE_PREPARE_ADDON.requiredRoles : []),
        ],
      },
    },
  };
}

function pubsubSpec(overrides: Record<string, unknown> = {}) {
  return environmentSpecSchema.parse({
    hosting: { provider: 'cloudrun' },
    services: { web: {}, jobs: { workloadKind: 'worker' } },
    queues: { 'email-jobs': { ackDeadlineSeconds: 120 } },
    ...overrides,
  });
}

function postgresSpec(overrides: Record<string, unknown> = {}) {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    database: { provider: 'railway' },
    services: { web: {}, jobs: { workloadKind: 'worker' } },
    queues: { 'email-jobs': {} },
    ...overrides,
  });
}

interface FakeQueueAdapter {
  getQueueSubscription: ReturnType<typeof vi.fn>;
  ensureQueue: ReturnType<typeof vi.fn>;
  destroyQueue: ReturnType<typeof vi.fn>;
}

function stubAdapter(capabilities: Record<string, unknown>): FakeQueueAdapter {
  const fake = {
    name: 'fake',
    capabilities,
    getQueueSubscription: vi.fn().mockResolvedValue(null),
    ensureQueue: vi.fn().mockResolvedValue({
      topicName: 'projects/gcp-project/topics/gcp-project-email-jobs',
      subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
      createdTopic: true,
      createdSubscription: true,
    }),
    destroyQueue: vi.fn().mockResolvedValue(undefined),
  };
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
    success: true,
    adapter: fake as unknown as IProviderAdapter,
  });
  return fake;
}

function ensureAction(name: string, extraMetadata: Record<string, unknown> = {}): PlanAction {
  return {
    id: `queue:${name}`,
    type: 'create',
    resource: { kind: 'queue', name, provider: 'cloudrun' },
    verified: true,
    reason: 'test',
    metadata: { operation: QUEUE_OPERATIONS.ensure, queueName: name, ...extraMetadata },
  };
}

function destroyAction(name: string): PlanAction {
  return {
    id: `queue:${name}:destroy`,
    type: 'destroy',
    resource: { kind: 'queue', name, provider: 'cloudrun' },
    verified: true,
    reason: 'test',
    metadata: { operation: QUEUE_OPERATIONS.destroy, queueName: name },
  };
}

describe('queue-plan.service', () => {
  let tempDir: string;
  const envRepo = () => new EnvironmentRepository();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-queue-plan-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedProject(options: { queueAddon?: boolean; platform?: string } = {}): { project: Project; environment: Environment } {
    const platform = options.platform ?? 'cloudrun';
    const project = new ProjectRepository().create({
      name: 'queueapp',
      defaultPlatform: platform,
      policies: platform === 'cloudrun' ? cloudrunPolicies({ queueAddon: options.queueAddon ?? true }) : {},
    });
    const environment = envRepo().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: platform, projectId: 'gcp-project' },
    });
    return { project, environment };
  }

  describe('pubsub backend', () => {
    it('plans a verified create when the subscription does not exist', async () => {
      const { project, environment } = seedProject();
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.getQueueSubscription.mockResolvedValue(null);

      const { actions, warnings } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(warnings).toEqual([]);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        id: 'queue:email-jobs',
        type: 'create',
        verified: true,
        resource: { kind: 'queue', name: 'email-jobs' },
        metadata: { operation: QUEUE_OPERATIONS.ensure, queueName: 'email-jobs', ackDeadlineSeconds: 120 },
      });
      expect(isQueueAction(actions[0])).toBe(true);
    });

    it('plans a noop when the subscription matches the spec', async () => {
      const { project, environment } = seedProject();
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.getQueueSubscription.mockResolvedValue({
        name: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
        topic: 'projects/gcp-project/topics/gcp-project-email-jobs',
        ackDeadlineSeconds: 120,
      });

      const { actions } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ id: 'queue:email-jobs', type: 'noop', verified: true });
      expect(actions[0].diff).toBeUndefined();
    });

    it('plans an update with a field diff on ackDeadlineSeconds drift', async () => {
      const { project, environment } = seedProject();
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.getQueueSubscription.mockResolvedValue({
        name: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
        topic: 'projects/gcp-project/topics/gcp-project-email-jobs',
        ackDeadlineSeconds: 10,
      });

      const { actions } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(actions[0].type).toBe('update');
      expect(actions[0].diff).toEqual([{ field: 'ackDeadlineSeconds', from: '10', to: '120' }]);
      expect(actions[0].reason).toContain('ackDeadlineSeconds');
    });

    it('plans a confirm-gated destroy for bindings removed from the spec', async () => {
      const { project, environment } = seedProject();
      envRepo().updatePlatformBindings(environment.id, {
        queues: { old: { backend: 'pubsub', topicName: 'projects/gcp-project/topics/gcp-project-old' } },
      });
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.getQueueSubscription.mockResolvedValue({
        name: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
        topic: 'projects/gcp-project/topics/gcp-project-email-jobs',
        ackDeadlineSeconds: 120,
      });

      const { actions } = await planQueues({
        project,
        environmentSpec: pubsubSpec(),
        environment: envRepo().findById(environment.id),
      });
      const destroy = actions.find((action) => action.id === 'queue:old:destroy')!;
      expect(destroy).toMatchObject({
        type: 'destroy',
        verified: true,
        dataBearing: true,
        requiresConfirm: true,
        metadata: { operation: QUEUE_OPERATIONS.destroy, queueName: 'old' },
      });
      expect(destroy.reason).toContain('undelivered messages');
    });

    it('degrades to unverified creates with a warning when observation throws', async () => {
      const { project, environment } = seedProject();
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.getQueueSubscription.mockRejectedValue(new Error('pubsub 500'));

      const { actions, warnings } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(warnings.some((warning) => warning.includes('Could not observe Pub/Sub') && warning.includes('pubsub 500'))).toBe(true);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ id: 'queue:email-jobs', type: 'create', verified: false });
    });

    it('warns and fails apply when the project is not queue-prepared', async () => {
      const { project, environment } = seedProject({ queueAddon: false });
      stubAdapter({ queues: { backend: 'pubsub' } });

      const { warnings } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(warnings.some((warning) => warning.includes('prepare'))).toBe(true);

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec(),
        action: ensureAction('email-jobs'),
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Re-run hv_connect');
      expect(result.error).toContain('prepare');
    });

    it('applies ensure via the adapter and persists the pubsub binding', async () => {
      const { project, environment } = seedProject();
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec(),
        action: ensureAction('email-jobs', { ackDeadlineSeconds: 120 }),
      });

      expect(result.success).toBe(true);
      expect(adapter.ensureQueue).toHaveBeenCalledWith(
        expect.objectContaining({ id: environment.id }),
        'email-jobs',
        { ackDeadlineSeconds: 120 }
      );
      const bindings = parseQueueBindings(envRepo().findById(environment.id));
      expect(bindings['email-jobs']).toMatchObject({
        backend: 'pubsub',
        topicName: 'projects/gcp-project/topics/gcp-project-email-jobs',
        subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
      });
    });

    it('applies destroy via the adapter and clears the binding', async () => {
      const { project, environment } = seedProject();
      envRepo().updatePlatformBindings(environment.id, {
        queues: {
          'email-jobs': { backend: 'pubsub', topicName: 't' },
          keep: { backend: 'pubsub', topicName: 't2' },
        },
      });
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec(),
        action: destroyAction('email-jobs'),
      });

      expect(result.success).toBe(true);
      expect(adapter.destroyQueue).toHaveBeenCalledWith(expect.objectContaining({ id: environment.id }), 'email-jobs');
      const bindings = parseQueueBindings(envRepo().findById(environment.id));
      expect(bindings['email-jobs']).toBeUndefined();
      expect(bindings.keep).toMatchObject({ backend: 'pubsub' });
    });
  });

  describe('postgres backend', () => {
    it('plans an unverified create for declared, unbound queues', async () => {
      const { project, environment } = seedProject({ platform: 'railway' });
      stubAdapter({ queues: { backend: 'postgres' } });

      const { actions } = await planQueues({ project, environmentSpec: postgresSpec(), environment });
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ id: 'queue:email-jobs', type: 'create', verified: false });
      expect(actions[0].reason).toContain('app-managed');
    });

    it('plans a noop when the queue binding exists', async () => {
      const { project, environment } = seedProject({ platform: 'railway' });
      envRepo().updatePlatformBindings(environment.id, {
        queues: { 'email-jobs': { backend: 'postgres' } },
      });
      stubAdapter({ queues: { backend: 'postgres' } });

      const { actions } = await planQueues({
        project,
        environmentSpec: postgresSpec(),
        environment: envRepo().findById(environment.id),
      });
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ id: 'queue:email-jobs', type: 'noop' });
    });

    it('plans a destroy without confirm when the binding leaves the spec', async () => {
      const { project, environment } = seedProject({ platform: 'railway' });
      envRepo().updatePlatformBindings(environment.id, {
        queues: { 'email-jobs': { backend: 'postgres' } },
      });
      stubAdapter({ queues: { backend: 'postgres' } });

      const { actions } = await planQueues({
        project,
        environmentSpec: postgresSpec({ queues: undefined }),
        environment: envRepo().findById(environment.id),
      });
      const destroy = actions.find((action) => action.id === 'queue:email-jobs:destroy')!;
      expect(destroy.type).toBe('destroy');
      expect(destroy.requiresConfirm).toBeUndefined();
      expect(destroy.dataBearing).toBeUndefined();
      expect(destroy.reason).toContain('app-managed');
    });

    it('applies ensure and destroy by persisting and clearing bindings only', async () => {
      const { project, environment } = seedProject({ platform: 'railway' });
      const adapter = stubAdapter({ queues: { backend: 'postgres' } });

      const ensured = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: postgresSpec(),
        action: ensureAction('email-jobs'),
      });
      expect(ensured.success).toBe(true);
      expect(parseQueueBindings(envRepo().findById(environment.id))['email-jobs']).toMatchObject({ backend: 'postgres' });
      expect(adapter.ensureQueue).not.toHaveBeenCalled();

      const destroyed = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: postgresSpec(),
        action: destroyAction('email-jobs'),
      });
      expect(destroyed.success).toBe(true);
      expect(parseQueueBindings(envRepo().findById(environment.id))['email-jobs']).toBeUndefined();
      expect(adapter.destroyQueue).not.toHaveBeenCalled();
    });
  });

  describe('warnings and unsupported providers', () => {
    it('warns when queues are declared without a worker service', async () => {
      const { project, environment } = seedProject({ platform: 'railway' });
      stubAdapter({ queues: { backend: 'postgres' } });

      const noWorker = await planQueues({
        project,
        environmentSpec: postgresSpec({ services: { web: {} } }),
        environment,
      });
      expect(noWorker.warnings.some((warning) => warning.includes('worker'))).toBe(true);

      const withWorker = await planQueues({ project, environmentSpec: postgresSpec(), environment });
      expect(withWorker.warnings.some((warning) => warning.includes('worker'))).toBe(false);
    });

    it('returns a warning and zero actions when the provider has no queue backend', async () => {
      const { project, environment } = seedProject();
      stubAdapter({});

      const { actions, warnings } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(actions).toEqual([]);
      expect(warnings.some((warning) => warning.includes('does not support queues'))).toBe(true);
    });
  });
});
