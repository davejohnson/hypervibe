import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import { adapterFactory } from './adapter.factory.js';

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

function sanitizeResourceName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
}

export function pubsubQueueResourceIds(
  environment: Pick<Environment, 'platformBindings'> | null,
  queueName: string
): { topicId: string; subscriptionId: string } {
  const bindings = environment?.platformBindings as { projectId?: string } | undefined;
  const prefix = bindings?.projectId || 'hypervibe';
  const topicId = sanitizeResourceName(`${prefix}-${queueName}`);
  return { topicId, subscriptionId: `${topicId}-sub` };
}

export function buildQueueEnvVars(params: {
  environmentSpec: EnvironmentSpec;
  environment: Pick<Environment, 'platformBindings'> | null;
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

  if (params.backend === 'pubsub' && params.gcpProjectId) {
    for (const name of names) {
      const { topicId, subscriptionId } = pubsubQueueResourceIds(params.environment, name);
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
  environment: Pick<Environment, 'platformBindings'> | null
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
