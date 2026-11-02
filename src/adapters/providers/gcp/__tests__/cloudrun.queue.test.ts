import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

const PROJECT = 'gcp-project';
const TOKEN = 'token';

const environment: Environment = {
  id: 'env-1',
  projectId: 'project-1',
  name: 'production',
  platformBindings: {
    provider: 'cloudrun',
    projectId: PROJECT,
    queues: {
      'email-jobs': {
        backend: 'pubsub',
        topicName: 'projects/gcp-project/topics/gcp-project-email-jobs',
        subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
        providerScope: { projectId: PROJECT },
      },
    },
  },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

async function connectedAdapter(): Promise<CloudRunAdapter> {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: PROJECT, credentials: '{}' });
  vi.spyOn(
    adapter as unknown as { getAccessToken(): Promise<string> },
    'getAccessToken'
  ).mockResolvedValue(TOKEN);
  return adapter;
}

function queueResources(adapter: CloudRunAdapter) {
  const ids = adapter.queueResourceNames(environment, 'email-jobs');
  return {
    ...ids,
    topicName: `projects/${PROJECT}/topics/${ids.topicId}`,
    subscriptionName: `projects/${PROJECT}/subscriptions/${ids.subscriptionId}`,
    labels: {
      'infraprint-environment': 'production',
      'infraprint-queue': 'email-jobs',
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('CloudRunAdapter Pub/Sub queue identity safety', () => {
  it.each(['present', 'absent'] as const)('rejects a changed %s action precondition at the native mutation boundary', async expectedState => {
    const adapter = await connectedAdapter(); const resource = queueResources(adapter);
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected mutation after action state changed');
      if (expectedState === 'present') return new Response(null, { status: 404 });
      if (String(input).includes('/subscriptions/')) return Response.json({ name: resource.subscriptionName, topic: resource.topicName, labels: resource.labels });
      return Response.json({ name: resource.topicName, labels: resource.labels });
    });
    vi.stubGlobal('fetch', transport);
    await expect(adapter.ensureQueue(environment, 'email-jobs', { expectedState })).rejects.toThrow(/reviewed.*state.*changed/);
    expect(transport.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('never adopts a topic that appears during a reviewed absent-state create', async () => {
    const adapter = await connectedAdapter(); const resource = queueResources(adapter); let topicRaced = false;
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/topics/')) {
        if (init?.method === 'PUT') { topicRaced = true; return Response.json({}, { status: 409 }); }
        if (topicRaced) return Response.json({ name: resource.topicName, labels: resource.labels });
      }
      if (init?.method === 'PUT') throw new Error('Unexpected dependent subscription creation');
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', transport);
    await expect(adapter.ensureQueue(environment, 'email-jobs', { expectedState: 'absent' })).rejects.toThrow(/creation.*ownership.*unverified/);
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });

  // Topic and subscription have separate GET identities in the official REST
  // contract. A 404 for one is not evidence that the other is absent.
  // https://cloud.google.com/pubsub/docs/reference/rest/v1/projects.topics/get
  // https://cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions/get
  it.each([
    ['bound', 'topic'], ['bound', 'subscription'], ['unbound', 'topic'], ['unbound', 'subscription'],
  ])('preserves %s partial %s state as unknown and never ensures a replacement', async (binding, present) => {
    const adapter = await connectedAdapter();
    const target = binding === 'bound' ? environment : { ...environment, platformBindings: { provider: 'cloudrun', projectId: PROJECT } };
    const ids = adapter.queueResourceNames(target, 'email-jobs');
    const topicName = `projects/${PROJECT}/topics/${ids.topicId}`;
    const subscriptionName = `projects/${PROJECT}/subscriptions/${ids.subscriptionId}`;
    const labels = { 'infraprint-environment': 'production', 'infraprint-queue': 'email-jobs' };
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected mutation of a partial queue');
      const resource = new URL(String(input)).pathname.slice('/v1/'.length);
      if (present === 'topic' && resource === topicName) return Response.json({ name: topicName, labels });
      if (present === 'subscription' && resource === subscriptionName) return Response.json({ name: subscriptionName, topic: topicName, labels });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', transport);
    await expect(adapter.getQueueSubscription(target, 'email-jobs')).rejects.toThrow(/observation is incomplete/);
    await expect(adapter.ensureQueue(target, 'email-jobs')).rejects.toThrow(/observation is incomplete/);
    expect(transport.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('preserves an acknowledged topic after subscription creation fails and blocks a blind retry', async () => {
    const adapter = await connectedAdapter(); const target = { ...environment, platformBindings: { provider: 'cloudrun', projectId: PROJECT } };
    const ids = adapter.queueResourceNames(target, 'email-jobs'); let topicCreated = false;
    const labels = { 'infraprint-environment': 'production', 'infraprint-queue': 'email-jobs' };
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      if (url.endsWith(`/topics/${ids.topicId}`)) {
        if (method === 'PUT') { topicCreated = true; return Response.json({ name: `projects/${PROJECT}/topics/${ids.topicId}` }); }
        return topicCreated ? Response.json({ name: `projects/${PROJECT}/topics/${ids.topicId}`, labels }) : new Response(null, { status: 404 });
      }
      if (url.endsWith(`/subscriptions/${ids.subscriptionId}`) && method === 'PUT') return Response.json({ error: { code: 503 } }, { status: 503 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', transport);
    await expect(adapter.ensureQueue(target, 'email-jobs')).rejects.toThrow(/503/);
    expect(topicCreated).toBe(true);
    const count = transport.mock.calls.filter(([, init]) => init?.method === 'PUT').length;
    await expect(adapter.getQueueSubscription(target, 'email-jobs')).rejects.toThrow(/observation is incomplete/);
    await expect(adapter.ensureQueue(target, 'email-jobs')).rejects.toThrow(/observation is incomplete/);
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(count);
    expect(transport.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it.each(['topic', 'subscription', 'unknown'])('blocks unbound legacy %s evidence before creating a queue', async (evidence) => {
    const adapter = await connectedAdapter();
    const unbound = { ...environment, platformBindings: { provider: 'cloudrun', projectId: PROJECT } };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const url = String(input);
      if (evidence === 'unknown') return new Response('denied', { status: 403 });
      if (evidence === 'topic' && url.endsWith('/topics/gcp-project-email-jobs')) {
        return Response.json({ name: 'projects/gcp-project/topics/gcp-project-email-jobs' });
      }
      if (evidence === 'subscription' && url.endsWith('/subscriptions/gcp-project-email-jobs-sub')) {
        return Response.json({ name: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
          topic: 'projects/gcp-project/topics/gcp-project-email-jobs' });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(adapter.ensureQueue(unbound, 'email-jobs')).rejects.toThrow(evidence === 'unknown' ? /403/ : /Legacy.*binding/);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it.each([
    ['subscription observation', (adapter: CloudRunAdapter, target: Environment) => adapter.getQueueSubscription(target, 'email-jobs')],
    ['ensure', (adapter: CloudRunAdapter, target: Environment) => adapter.ensureQueue(target, 'email-jobs')],
    ['destroy', (adapter: CloudRunAdapter, target: Environment) => adapter.destroyQueue(target, 'email-jobs')],
  ])('blocks %s before provider access when the queue binding is scoped to another project', async (_label, invoke) => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const wrongProjectEnvironment: Environment = {
      ...environment,
      platformBindings: {
        ...environment.platformBindings,
        queues: {
          'email-jobs': {
            backend: 'pubsub',
            topicName: 'projects/other-project/topics/gcp-project-email-jobs',
            subscriptionName: 'projects/other-project/subscriptions/gcp-project-email-jobs-sub',
            providerScope: { projectId: 'other-project' },
          },
        },
      },
    };

    await expect(invoke(adapter, wrongProjectEnvironment)).rejects.toThrow(/different project/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((adapter as unknown as { getAccessToken: ReturnType<typeof vi.fn> }).getAccessToken)
      .not.toHaveBeenCalled();
  });

  it('uses connected provider scope when the environment project id is only a logical namespace', async () => {
    const adapter = await connectedAdapter();
    const logicalEnvironment: Environment = {
      ...environment,
      platformBindings: { provider: 'cloudrun', projectId: 'logical-production' },
    };
    const ids = adapter.queueResourceNames(logicalEnvironment, 'email-jobs');
    const topicName = `projects/${PROJECT}/topics/${ids.topicId}`;
    const subscriptionName = `projects/${PROJECT}/subscriptions/${ids.subscriptionId}`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/topics/logical-production-email-jobs') || url.endsWith('/subscriptions/logical-production-email-jobs-sub')) {
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith(`/topics/${ids.topicId}`)) {
        return Response.json({
          name: topicName,
          labels: { 'infraprint-environment': 'production', 'infraprint-queue': 'email-jobs' },
        });
      }
      if (url.endsWith(`/subscriptions/${ids.subscriptionId}`)) {
        return Response.json({
          name: subscriptionName,
          topic: topicName,
          labels: { 'infraprint-environment': 'production', 'infraprint-queue': 'email-jobs' },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    await expect(adapter.getQueueSubscription(logicalEnvironment, 'email-jobs'))
      .resolves.toMatchObject({ name: subscriptionName, topic: topicName });
    expect(adapter.queueProviderScope()).toEqual({ projectId: PROJECT });
  });

  it('refuses to adopt an unmanaged topic after a create race returns 409', async () => {
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    let topicReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/topics/${resource.topicId}`) && (init?.method ?? 'GET') === 'GET') {
        topicReads += 1;
        return topicReads === 1
          ? new Response('missing', { status: 404 })
          : Response.json({ name: resource.topicName, labels: { owner: 'someone-else' } });
      }
      if (url.endsWith(`/topics/${resource.topicId}`) && init?.method === 'PUT') {
        return new Response('already exists', { status: 409 });
      }
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`) && (init?.method ?? 'GET') === 'GET') return new Response(null, { status: 404 });
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.ensureQueue(environment, 'email-jobs')).rejects.toThrow(/not owned by Hypervibe/);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/subscriptions/') && (init?.method ?? 'GET') !== 'GET')).toBe(false);
  });

  it('treats a subscription attached to another topic as unknown, not in sync', async () => {
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/topics/${resource.topicId}`)) {
        return Response.json({ name: resource.topicName, labels: resource.labels });
      }
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`)) {
        return Response.json({
          name: resource.subscriptionName,
          topic: `projects/${PROJECT}/topics/unmanaged`,
          labels: resource.labels,
          ackDeadlineSeconds: 120,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    await expect(adapter.getQueueSubscription(environment, 'email-jobs'))
      .rejects.toThrow(/does not match exact queue subscription/);
  });

  it('validates all destroy targets before issuing the first delete', async () => {
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith(`/topics/${resource.topicId}`)) {
        return Response.json({ name: resource.topicName, labels: { owner: 'someone-else' } });
      }
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`)) {
        return new Response('missing', { status: 404 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.destroyQueue(environment, 'email-jobs')).rejects.toThrow(/not owned by Hypervibe/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  });

  it('does not report destroy success while an acknowledged topic remains observable', async () => {
    vi.stubEnv('HYPERVIBE_PUBSUB_DELETE_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_PUBSUB_POLL_INTERVAL_MS', '0');
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`)) {
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith(`/topics/${resource.topicId}`) && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith(`/topics/${resource.topicId}`)) {
        return Response.json({ name: resource.topicName, labels: resource.labels });
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.destroyQueue(environment, 'email-jobs'))
      .rejects.toThrow(/remained observable after its delete acknowledgement/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });

  it('re-observes exact owned resources before reporting create convergence', async () => {
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    let topicReads = 0;
    let subscriptionReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/topics/${resource.topicId}`) && (init?.method ?? 'GET') === 'GET') {
        topicReads += 1;
        return topicReads === 1
          ? new Response('missing', { status: 404 })
          : Response.json({ name: resource.topicName, labels: resource.labels });
      }
      if (url.endsWith(`/topics/${resource.topicId}`) && init?.method === 'PUT') {
        return Response.json({ name: resource.topicName });
      }
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`) && (init?.method ?? 'GET') === 'GET') {
        subscriptionReads += 1;
        return subscriptionReads === 1
          ? new Response('missing', { status: 404 })
          : Response.json({
              name: resource.subscriptionName,
              topic: resource.topicName,
              labels: resource.labels,
              ackDeadlineSeconds: 120,
            });
      }
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`) && init?.method === 'PUT') {
        return Response.json({ name: resource.subscriptionName });
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.ensureQueue(environment, 'email-jobs', { ackDeadlineSeconds: 120 }))
      .resolves.toMatchObject({ createdTopic: true, createdSubscription: true });
    expect(topicReads).toBe(2);
    expect(subscriptionReads).toBe(2);
  });
});
