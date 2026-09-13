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
import { CloudRunAdapter } from '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { buildQueueEnvVars } from '../queue-env.js';

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
  queueResourceNames: ReturnType<typeof vi.fn>;
  queueProviderScope: ReturnType<typeof vi.fn>;
}

function stubAdapter(capabilities: Record<string, unknown>): FakeQueueAdapter {
  const fake = {
    name: capabilities.queues
      && (capabilities.queues as { backend?: string }).backend === 'postgres'
      ? 'railway'
      : 'cloudrun',
    capabilities,
    getQueueSubscription: vi.fn().mockResolvedValue(null),
    ensureQueue: vi.fn().mockResolvedValue({
      topicName: 'projects/gcp-project/topics/gcp-project-email-jobs',
      subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
      createdTopic: true,
      createdSubscription: true,
    }),
    destroyQueue: vi.fn().mockResolvedValue(undefined),
    queueResourceNames: vi.fn((environment: Environment, queueName: string) => {
      const projectId = String(environment.platformBindings.projectId ?? 'hypervibe');
      const topicId = `${projectId}-${queueName}`;
      return { topicId, subscriptionId: `${topicId}-sub` };
    }),
    queueProviderScope: vi.fn(() => ({ projectId: 'gcp-project' })),
  };
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
    success: true,
    adapter: fake as unknown as IProviderAdapter,
  });
  return fake;
}

function ensureAction(
  name: string,
  extraMetadata: Record<string, unknown> = {},
  provider = 'cloudrun'
): PlanAction {
  return {
    id: `queue:${name}`,
    type: 'create',
    resource: { kind: 'queue', name, provider },
    verified: true,
    reason: 'test',
    metadata: {
      operation: QUEUE_OPERATIONS.ensure,
      queueName: name,
      backend: provider === 'cloudrun' ? 'pubsub' : 'postgres',
      ...(provider === 'cloudrun' ? { providerScope: { projectId: 'gcp-project' } } : {}),
      ...extraMetadata,
    },
  };
}

function destroyAction(name: string, provider = 'cloudrun'): PlanAction {
  const pubsub = provider === 'cloudrun';
  return {
    id: `queue:${name}:destroy`,
    type: 'destroy',
    resource: { kind: 'queue', name, provider },
    verified: true,
    reason: 'test',
    ...(pubsub ? { dataBearing: true, requiresConfirm: true } : {}),
    metadata: pubsub
      ? {
          operation: QUEUE_OPERATIONS.destroy,
          queueName: name,
          backend: 'pubsub',
          topicName: `projects/gcp-project/topics/gcp-project-${name}`,
          subscriptionName: `projects/gcp-project/subscriptions/gcp-project-${name}-sub`,
          providerScope: { projectId: 'gcp-project' },
        }
      : { operation: QUEUE_OPERATIONS.destroy, queueName: name, backend: 'postgres' },
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
    vi.unstubAllGlobals();
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

  function bindPubsubQueue(environment: Environment, name = 'email-jobs', projectId = 'gcp-project'): void {
    envRepo().updatePlatformBindings(environment.id, {
      queues: {
        [name]: {
          backend: 'pubsub',
          topicName: `projects/${projectId}/topics/${projectId}-${name}`,
          subscriptionName: `projects/${projectId}/subscriptions/${projectId}-${name}-sub`,
          providerScope: { projectId },
        },
      },
    });
  }

  describe('pubsub backend', () => {
    it('isolates same-name queues through real adapter plan/apply, runtime wiring, noop and teardown', async () => {
      const { project, environment: production } = seedProject();
      const staging = envRepo().create({ projectId: project.id, name: 'staging',
        platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' } });
      const adapter = new CloudRunAdapter();
      await adapter.connect({ projectId: 'gcp-project', credentials: '{}' });
      vi.spyOn(adapter as unknown as { getAccessToken(): Promise<string> }, 'getAccessToken').mockResolvedValue('token');
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
      // Synthetic Pub/Sub v1 REST state; exercises the real request/parser path,
      // not live or pinned-schema certification (see provider-contracts/README).
      const resources = new Map<string, Record<string, unknown>>();
      const writes: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const name = new URL(String(input)).pathname.replace(/^\/v1\//, '');
        const method = init?.method ?? 'GET';
        expect(name).toMatch(/^projects\/gcp-project\/(topics|subscriptions)\/[a-z0-9-]+$/);
        if (method === 'GET') return resources.has(name) ? Response.json(resources.get(name)) : new Response(null, { status: 404 });
        writes.push(`${method} ${name}`);
        if (method === 'PUT') {
          if (resources.has(name)) return new Response(null, { status: 409 });
          const resource = { ...JSON.parse(String(init?.body)), name };
          resources.set(name, resource);
          return Response.json(resource);
        }
        if (method === 'DELETE') { resources.delete(name); return new Response(null, { status: 204 }); }
        throw new Error(`Unexpected Pub/Sub method ${method}`);
      }));
      const spec = pubsubSpec();
      for (const target of [production, staging]) {
        const planned = await planQueues({ project, environmentSpec: spec, environment: target });
        expect(planned.actions).toHaveLength(1);
        expect(planned.actions[0]).toMatchObject({ type: 'create', verified: true });
        expect(await applyQueueAction({ project, envName: target.name, environmentSpec: spec, action: planned.actions[0]! }))
          .toMatchObject({ success: true });
        const bound = envRepo().findById(target.id)!;
        const vars = buildQueueEnvVars({ environmentSpec: spec, environment: bound, backend: 'pubsub', gcpProjectId: 'gcp-project' });
        expect(resources.has(vars.QUEUE_TOPIC_EMAIL_JOBS!)).toBe(true);
        expect(resources.get(vars.QUEUE_SUBSCRIPTION_EMAIL_JOBS!)?.topic).toBe(vars.QUEUE_TOPIC_EMAIL_JOBS);
        const before = writes.length;
        const replanned = await planQueues({ project, environmentSpec: spec, environment: bound });
        expect(replanned.actions.every((action) => action.type === 'noop')).toBe(true);
        for (const action of replanned.actions) {
          expect(await applyQueueAction({ project, envName: target.name, environmentSpec: spec, action })).toMatchObject({ success: true });
        }
        expect(writes).toHaveLength(before);
      }
      expect(resources.size).toBe(4);
      const removedSpec = pubsubSpec({ queues: {} });
      const plan = await planQueues({ project, environmentSpec: removedSpec, environment: envRepo().findById(staging.id)! });
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]).toMatchObject({ type: 'destroy' });
      expect(await applyQueueAction({ project, envName: staging.name, environmentSpec: removedSpec, action: plan.actions[0]! }))
        .toMatchObject({ success: true });
      expect(resources.size).toBe(2);
      expect((await planQueues({ project, environmentSpec: spec, environment: envRepo().findById(production.id)! }))
        .actions.every((action) => action.type === 'noop')).toBe(true);
    });

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
        metadata: {
          operation: QUEUE_OPERATIONS.ensure,
          queueName: 'email-jobs',
          backend: 'pubsub',
          providerScope: { projectId: 'gcp-project' },
          ackDeadlineSeconds: 120,
        },
      });
      expect(isQueueAction(actions[0])).toBe(true);
    });

    it('plans a noop when the subscription matches the spec', async () => {
      const { project, environment } = seedProject();
      bindPubsubQueue(environment);
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
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ id: 'queue:email-jobs', type: 'noop', verified: true });
      expect(actions[0].diff).toBeUndefined();
    });

    it('plans an update with a field diff on ackDeadlineSeconds drift', async () => {
      const { project, environment } = seedProject();
      bindPubsubQueue(environment);
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.getQueueSubscription.mockResolvedValue({
        name: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
        topic: 'projects/gcp-project/topics/gcp-project-email-jobs',
        ackDeadlineSeconds: 10,
      });

      const { actions } = await planQueues({
        project,
        environmentSpec: pubsubSpec(),
        environment: envRepo().findById(environment.id),
      });
      expect(actions[0].type).toBe('update');
      expect(actions[0].diff).toEqual([{ field: 'ackDeadlineSeconds', from: '10', to: '120' }]);
      expect(actions[0].reason).toContain('ackDeadlineSeconds');
    });

    it('blocks a live Pub/Sub queue that has no durable local binding', async () => {
      const { project, environment } = seedProject();
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.getQueueSubscription.mockResolvedValue({
        name: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
        topic: 'projects/gcp-project/topics/gcp-project-email-jobs',
        ackDeadlineSeconds: 120,
      });

      const { actions, warnings } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: 'update',
        verified: true,
        metadata: { blockedReason: 'queue_binding_missing' },
      });
      expect(warnings.join(' ')).toContain('silently adopt');

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec(),
        action: actions[0],
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('blocked');
      expect(adapter.ensureQueue).not.toHaveBeenCalled();
    });

    it('blocks replacement creation when a durable Pub/Sub binding is confirmed absent', async () => {
      const { project, environment } = seedProject();
      bindPubsubQueue(environment);
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.getQueueSubscription.mockResolvedValue(null);

      const { actions } = await planQueues({
        project,
        environmentSpec: pubsubSpec(),
        environment: envRepo().findById(environment.id),
      });

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: 'update',
        metadata: { blockedReason: 'queue_binding_identity_missing' },
      });
      expect(actions.some((action) => action.type === 'create')).toBe(false);
    });

    it('plans a confirm-gated destroy for bindings removed from the spec', async () => {
      const { project, environment } = seedProject();
      envRepo().updatePlatformBindings(environment.id, {
        queues: {
          old: {
            backend: 'pubsub',
            topicName: 'projects/gcp-project/topics/gcp-project-old',
            subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-old-sub',
            providerScope: { projectId: 'gcp-project' },
          },
        },
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
        metadata: expect.objectContaining({
          operation: QUEUE_OPERATIONS.destroy,
          queueName: 'old',
          backend: 'pubsub',
          topicName: 'projects/gcp-project/topics/gcp-project-old',
          subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-old-sub',
          providerScope: { projectId: 'gcp-project' },
        }),
      });
      expect(destroy.reason).toContain('undelivered messages');
    });

    it('blocks queue mutations with a warning when observation throws', async () => {
      const { project, environment } = seedProject();
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.getQueueSubscription.mockRejectedValue(new Error('pubsub 500'));

      const { actions, warnings } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(warnings.some((warning) => warning.includes('Could not observe Pub/Sub') && warning.includes('pubsub 500'))).toBe(true);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        id: 'queue:email-jobs',
        type: 'update',
        verified: false,
        metadata: { blockedReason: 'queue_observation_unavailable' },
      });

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec(),
        action: actions[0],
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('blocked');
      expect(adapter.ensureQueue).not.toHaveBeenCalled();
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
      expect(result.error).toContain('Re-run hv_connections');
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
        providerScope: { projectId: 'gcp-project' },
      });
    });

    it('does not persist an ensure result from an unexpected Pub/Sub project', async () => {
      const { project, environment } = seedProject();
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      adapter.ensureQueue.mockResolvedValue({
        topicName: 'projects/other-project/topics/gcp-project-email-jobs',
        subscriptionName: 'projects/other-project/subscriptions/gcp-project-email-jobs-sub',
        createdTopic: true,
        createdSubscription: true,
      });

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec(),
        action: ensureAction('email-jobs', { ackDeadlineSeconds: 120 }),
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('unexpected provider identity');
      expect(parseQueueBindings(envRepo().findById(environment.id))['email-jobs']).toBeUndefined();
    });

    it('blocks Pub/Sub ensure when the connected provider project changes after planning', async () => {
      const { project, environment } = seedProject();
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      const { actions } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(actions[0].type).toBe('create');
      adapter.queueProviderScope.mockReturnValue({ projectId: 'other-project' });

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec(),
        action: actions[0],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('stale mutation authority');
      expect(adapter.ensureQueue).not.toHaveBeenCalled();
      expect(parseQueueBindings(envRepo().findById(environment.id))['email-jobs']).toBeUndefined();
    });

    it('rejects a queue action for a different provider before resolving an adapter', async () => {
      const { project } = seedProject();
      const getProviderAdapter = vi.spyOn(adapterFactory, 'getProviderAdapter');

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec(),
        action: {
          ...ensureAction('email-jobs'),
          resource: { kind: 'queue', name: 'email-jobs', provider: 'railway' },
        },
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('stale mutation authority');
      expect(getProviderAdapter).not.toHaveBeenCalled();
    });

    it('applies destroy via the adapter and clears the binding', async () => {
      const { project, environment } = seedProject();
      envRepo().updatePlatformBindings(environment.id, {
        queues: {
          'email-jobs': {
            backend: 'pubsub',
            topicName: 'projects/gcp-project/topics/gcp-project-email-jobs',
            subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
            providerScope: { projectId: 'gcp-project' },
          },
          keep: {
            backend: 'pubsub',
            topicName: 'projects/gcp-project/topics/gcp-project-keep',
            subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-keep-sub',
            providerScope: { projectId: 'gcp-project' },
          },
        },
      });
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec({ queues: undefined }),
        action: destroyAction('email-jobs'),
      });

      expect(result.success).toBe(true);
      expect(adapter.destroyQueue).toHaveBeenCalledWith(expect.objectContaining({ id: environment.id }), 'email-jobs');
      const bindings = parseQueueBindings(envRepo().findById(environment.id));
      expect(bindings['email-jobs']).toBeUndefined();
      expect(bindings.keep).toMatchObject({ backend: 'pubsub' });
    });

    it('blocks Pub/Sub deletion when the bound project scope changed after planning', async () => {
      const { project, environment } = seedProject();
      envRepo().updatePlatformBindings(environment.id, {
        queues: {
          'email-jobs': {
            backend: 'pubsub',
            topicName: 'projects/other-project/topics/gcp-project-email-jobs',
            subscriptionName: 'projects/other-project/subscriptions/gcp-project-email-jobs-sub',
            providerScope: { projectId: 'other-project' },
          },
        },
      });
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });

      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec({ queues: undefined }),
        action: destroyAction('email-jobs'),
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('stale mutation authority');
      expect(adapter.destroyQueue).not.toHaveBeenCalled();
      expect(parseQueueBindings(envRepo().findById(environment.id))['email-jobs']).toBeDefined();
    });

    it('blocks Pub/Sub deletion when the environment project changes after planning', async () => {
      const { project, environment } = seedProject();
      envRepo().updatePlatformBindings(environment.id, {
        queues: {
          'email-jobs': {
            backend: 'pubsub',
            topicName: 'projects/gcp-project/topics/gcp-project-email-jobs',
            subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
            providerScope: { projectId: 'gcp-project' },
          },
        },
      });
      const adapter = stubAdapter({ queues: { backend: 'pubsub' } });
      const { actions } = await planQueues({
        project,
        environmentSpec: pubsubSpec({ queues: undefined }),
        environment: envRepo().findById(environment.id),
      });
      const plannedDestroy = actions.find((action) => action.id === 'queue:email-jobs:destroy')!;

      envRepo().updatePlatformBindings(environment.id, { projectId: 'new-gcp-project' });
      const result = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: pubsubSpec({ queues: undefined }),
        action: plannedDestroy,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('stale mutation authority');
      expect(adapter.destroyQueue).not.toHaveBeenCalled();
      expect(parseQueueBindings(envRepo().findById(environment.id))['email-jobs']).toBeDefined();
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
      expect(destroy.metadata).toMatchObject({
        operation: QUEUE_OPERATIONS.destroy,
        queueName: 'email-jobs',
        backend: 'postgres',
      });
      expect(destroy.reason).toContain('app-managed');
    });

    it('applies ensure and destroy by persisting and clearing bindings only', async () => {
      const { project, environment } = seedProject({ platform: 'railway' });
      const adapter = stubAdapter({ queues: { backend: 'postgres' } });

      const ensured = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: postgresSpec(),
        action: ensureAction('email-jobs', {}, 'railway'),
      });
      expect(ensured.success).toBe(true);
      expect(parseQueueBindings(envRepo().findById(environment.id))['email-jobs']).toMatchObject({ backend: 'postgres' });
      expect(adapter.ensureQueue).not.toHaveBeenCalled();

      const destroyed = await applyQueueAction({
        project,
        envName: 'production',
        environmentSpec: postgresSpec({ queues: undefined }),
        action: destroyAction('email-jobs', 'railway'),
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

    it('returns unverified queue actions when the provider has no queue backend', async () => {
      const { project, environment } = seedProject();
      stubAdapter({});

      const { actions, warnings } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        id: 'queue:email-jobs',
        type: 'update',
        verified: false,
        metadata: {
          operation: QUEUE_OPERATIONS.ensure,
          queueName: 'email-jobs',
          unsupported: true,
          blockedReason: 'queue_observation_unavailable',
        },
      });
      expect(actions[0].reason).toContain('cannot be converged');
      expect(warnings.some((warning) => warning.includes('does not support queues'))).toBe(true);
    });

    it('returns unverified queue actions when the provider adapter is unavailable', async () => {
      const { project, environment } = seedProject();
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'missing cloudrun connection' });

      const { actions, warnings } = await planQueues({ project, environmentSpec: pubsubSpec(), environment });
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        id: 'queue:email-jobs',
        type: 'update',
        verified: false,
        metadata: {
          operation: QUEUE_OPERATIONS.ensure,
          queueName: 'email-jobs',
          unsupported: true,
          blockedReason: 'queue_observation_unavailable',
        },
      });
      expect(warnings).toEqual(['Cannot plan queues: missing cloudrun connection']);
    });
  });
});
