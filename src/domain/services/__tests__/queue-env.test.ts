import { describe, expect, it } from 'vitest';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { buildQueueEnvVars, pubsubQueueResourceIds, queueEnvVarSuffix } from '../queue-env.js';

function environmentSpec(overrides: Record<string, unknown> = {}) {
  return environmentSpecSchema.parse({
    hosting: { provider: 'cloudrun' },
    ...overrides,
  });
}

const boundEnvironment = { platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' } };

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
  it('derives deterministic ids from the bindings projectId', () => {
    expect(pubsubQueueResourceIds(boundEnvironment, 'email-jobs')).toEqual({
      topicId: 'gcp-project-email-jobs',
      subscriptionId: 'gcp-project-email-jobs-sub',
    });
  });

  it('falls back to the hypervibe prefix without an environment binding', () => {
    expect(pubsubQueueResourceIds(null, 'email-jobs')).toEqual({
      topicId: 'hypervibe-email-jobs',
      subscriptionId: 'hypervibe-email-jobs-sub',
    });
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
      QUEUE_TOPIC_ALERTS: 'projects/gcp-project/topics/gcp-project-alerts',
      QUEUE_SUBSCRIPTION_ALERTS: 'projects/gcp-project/subscriptions/gcp-project-alerts-sub',
      QUEUE_TOPIC_EMAIL_JOBS: 'projects/gcp-project/topics/gcp-project-email-jobs',
      QUEUE_SUBSCRIPTION_EMAIL_JOBS: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
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
