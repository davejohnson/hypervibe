import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import { adapterFactory } from './adapter.factory.js';
import { resourceName } from './resource-names.js';

/**
 * Env var contract for spec queues, mirroring database-env.ts. Every
 * environment with queues gets QUEUE_BACKEND and QUEUE_NAMES; Pub/Sub
 * environments additionally get fully-qualified topic/subscription
 * resource names per queue. Postgres-backed queues (Railway) need
 * nothing further — DATABASE_URL is already injected and libraries
 * like pg-boss/graphile-worker ride it.
 *
 * Names are deterministic (mirroring CloudRunAdapter.queueResourceNames)
 * so vars are correct at deploy time regardless of apply ordering.
 */

export function queueEnvVarSuffix(queueName: string): string {
  return queueName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function pubsubQueueResourceIds(
  environment: (Pick<Environment, 'platformBindings'> & { name?: string }) | null,
  queueName: string,
  providerProjectId?: string
): { topicId: string; subscriptionId: string } {
  const bindings = environment?.platformBindings as {
    projectId?: string;
    queues?: Record<string, { backend?: string; topicName?: string; subscriptionName?: string; providerScope?: { projectId?: string } }>;
  } | undefined;
  const binding = bindings?.queues?.[queueName];
  if (binding) {
    if (binding.backend !== 'pubsub') throw new Error(`Queue "${queueName}" is not bound to Pub/Sub.`);
    const topic = binding.topicName?.split('/');
    const subscription = binding.subscriptionName?.split('/');
    const projectId = providerProjectId ?? binding.providerScope?.projectId;
    if (!projectId || binding.providerScope?.projectId !== projectId
      || topic?.length !== 4 || topic[0] !== 'projects' || topic[1] !== projectId || topic[2] !== 'topics' || !topic[3]
      || subscription?.length !== 4 || subscription[0] !== 'projects' || subscription[1] !== projectId || subscription[2] !== 'subscriptions' || !subscription[3]) {
      throw new Error(`Pub/Sub queue "${queueName}" has an incomplete or cross-project binding.`);
    }
    return { topicId: topic[3], subscriptionId: subscription[3] };
  }
  const projectId = providerProjectId ?? bindings?.projectId;
  if (!environment?.name || !projectId) throw new Error('Pub/Sub naming requires a project/environment scope.');
  const topicId = resourceName(queueName, { scope: [projectId, environment.name], reservedPrefixes: ['goog'] });
  // Topics and subscriptions already occupy different provider namespaces.
  return { topicId, subscriptionId: topicId };
}

export function buildQueueEnvVars(params: {
  environmentSpec: EnvironmentSpec;
  environment: (Pick<Environment, 'platformBindings'> & { name?: string }) | null;
  backend: 'pubsub' | 'postgres' | undefined;
  gcpProjectId?: string;
}): Record<string, string> {
  const queues = params.environmentSpec.queues;
  const names = Object.keys(queues ?? {}).sort();
  if (!queues || names.length === 0 || !params.backend) {
    return {};
  }

  const vars: Record<string, string> = {
    QUEUE_BACKEND: params.backend,
    QUEUE_NAMES: names.join(','),
  };

  if (params.backend === 'pubsub' && params.gcpProjectId && params.environment) {
    for (const name of names) {
      const { topicId, subscriptionId } = pubsubQueueResourceIds(params.environment, name, params.gcpProjectId);
      const suffix = queueEnvVarSuffix(name);
      vars[`QUEUE_TOPIC_${suffix}`] = `projects/${params.gcpProjectId}/topics/${topicId}`;
      vars[`QUEUE_SUBSCRIPTION_${suffix}`] = `projects/${params.gcpProjectId}/subscriptions/${subscriptionId}`;
    }
  }

  return vars;
}

/**
 * Resolve the environment's queue env vars end-to-end: look up the hosting
 * adapter for its queue backend (and GCP project for Pub/Sub names), then
 * build the vars. Returns undefined when the spec declares no queues or the
 * adapter is unavailable. Shared by plan diffing and apply-time deploys.
 */
export async function resolveQueueEnvVars(
  project: Project,
  environmentSpec: EnvironmentSpec,
  environment: (Pick<Environment, 'platformBindings'> & { name?: string }) | null
): Promise<Record<string, string> | undefined> {
  if (!environmentSpec.queues || Object.keys(environmentSpec.queues).length === 0) {
    return undefined;
  }
  const adapterResult = await adapterFactory.getProviderAdapter(environmentSpec.hosting.provider, project);
  const adapter = adapterResult.success ? adapterResult.adapter as IProviderAdapter : null;
  const backend = adapter?.capabilities.queues?.backend;
  const gcpProjectId = backend === 'pubsub'
    ? (adapter as unknown as { credentials?: { projectId?: string } }).credentials?.projectId
    : undefined;
  const vars = buildQueueEnvVars({ environmentSpec, environment, backend, gcpProjectId });
  return Object.keys(vars).length > 0 ? vars : undefined;
}
