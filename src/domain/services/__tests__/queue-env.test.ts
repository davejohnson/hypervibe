import { describe, expect, it } from 'vitest';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { buildQueueEnvVars, pubsubQueueResourceIds, queueEnvVarSuffix } from '../queue-env.js';

function environmentSpec(overrides: Record<string, unknown> = {}) {
  return environmentSpecSchema.parse({
    hosting: { provider: 'cloudrun' },
    ...overrides,
  });
}

const boundEnvironment = { name: 'production', platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' } };

describe('queueEnvVarSuffix', () => {
  it.each([
    ['email-jobs', 'EMAIL_JOBS'],
    ['emails', 'EMAILS'],
    ['a1-b2-c3', 'A1_B2_C3'],
  ])('sanitizes %s to %s', (name, expected) => {
    expect(queueEnvVarSuffix(name)).toBe(expected);
  });
});

describe('pubsubQueueResourceIds', () => {
  it('keeps same-name queues isolated across environments inside one provider project', () => {
    const production = pubsubQueueResourceIds(boundEnvironment, 'email-jobs');
    const staging = pubsubQueueResourceIds({ ...boundEnvironment, name: 'staging' }, 'email-jobs');
    expect(production.topicId).toMatch(/^email-jobs-[a-f0-9]{10}$/);
    expect(staging.topicId).not.toBe(production.topicId);
    expect(production.subscriptionId).toBe(production.topicId);
  });

  it('requires an environment scope instead of guessing one', () => {
    expect(() => pubsubQueueResourceIds(null, 'email-jobs')).toThrow(/scope/i);
  });

  it('preserves exact legacy topic/subscription names and rejects partial bindings', () => {
    const queue = { backend: 'pubsub', topicName: 'projects/gcp-project/topics/old-topic',
      subscriptionName: 'projects/gcp-project/subscriptions/old-sub', providerScope: { projectId: 'gcp-project' } };
    const env = { ...boundEnvironment, platformBindings: { ...boundEnvironment.platformBindings, queues: { 'email-jobs': queue } } };
    expect(pubsubQueueResourceIds(env, 'email-jobs')).toEqual({ topicId: 'old-topic', subscriptionId: 'old-sub' });
    expect(() => pubsubQueueResourceIds({ ...env, platformBindings: { ...env.platformBindings,
      queues: { 'email-jobs': { ...queue, subscriptionName: undefined } } } }, 'email-jobs')).toThrow(/binding/i);
  });
});

describe('buildQueueEnvVars', () => {
  it('emits fully-qualified pubsub names and sorted QUEUE_NAMES', () => {
    const vars = buildQueueEnvVars({
      environmentSpec: environmentSpec({ queues: { 'email-jobs': {}, alerts: {} } }),
      environment: boundEnvironment,
      backend: 'pubsub',
      gcpProjectId: 'gcp-project',
    });
    expect(vars).toEqual({
      QUEUE_BACKEND: 'pubsub',
      QUEUE_NAMES: 'alerts,email-jobs',
      QUEUE_TOPIC_ALERTS: expect.stringMatching(/^projects\/gcp-project\/topics\/alerts-[a-f0-9]{10}$/),
      QUEUE_SUBSCRIPTION_ALERTS: expect.stringMatching(/^projects\/gcp-project\/subscriptions\/alerts-[a-f0-9]{10}$/),
      QUEUE_TOPIC_EMAIL_JOBS: expect.stringMatching(/^projects\/gcp-project\/topics\/email-jobs-[a-f0-9]{10}$/),
      QUEUE_SUBSCRIPTION_EMAIL_JOBS: expect.stringMatching(/^projects\/gcp-project\/subscriptions\/email-jobs-[a-f0-9]{10}$/),
    });
  });

  it('emits only QUEUE_BACKEND and QUEUE_NAMES on the postgres backend', () => {
    const vars = buildQueueEnvVars({
      environmentSpec: environmentSpec({
        hosting: { provider: 'railway' },
        database: { provider: 'railway' },
        queues: { 'email-jobs': {} },
      }),
      environment: null,
      backend: 'postgres',
    });
    expect(vars).toEqual({
      QUEUE_BACKEND: 'postgres',
      QUEUE_NAMES: 'email-jobs',
    });
  });

  it('returns {} when no queues are declared or no backend is known', () => {
    expect(buildQueueEnvVars({
      environmentSpec: environmentSpec(),
      environment: boundEnvironment,
      backend: 'pubsub',
      gcpProjectId: 'gcp-project',
    })).toEqual({});

    expect(buildQueueEnvVars({
      environmentSpec: environmentSpec({ queues: { 'email-jobs': {} } }),
      environment: boundEnvironment,
      backend: undefined,
    })).toEqual({});
  });
});
