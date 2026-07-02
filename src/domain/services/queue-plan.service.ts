import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { adapterFactory } from './adapter.factory.js';
import { isCloudPreparedForQueues } from './cloud-prepare.js';
import type { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec, QueueSpec } from '../spec/spec.schema.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { PlanAction, PlanFieldDiff } from '../plan/plan.types.js';

/**
 * Planner + apply handlers for the `queues` spec section, following the
 * two-function contract of appstore-plan.service.ts. The backend follows
 * the hosting provider: Cloud Run environments converge real Pub/Sub
 * topics + subscriptions (observed, verified); Railway environments are
 * postgres-backed (pg-boss model) — hypervibe wires env vars and records
 * bindings, apps own the tables, so nothing is provisioned or destroyed.
 */

export const QUEUE_OPERATIONS = {
  ensure: 'queueEnsure',
  destroy: 'queueDestroy',
} as const;

const QUEUE_OPERATION_SET = new Set<string>(Object.values(QUEUE_OPERATIONS));

const envRepo = new EnvironmentRepository();

export interface QueueBinding {
  backend: 'pubsub' | 'postgres';
  topicName?: string;
  subscriptionName?: string;
  updatedAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseQueueBindings(environment: Environment | null): Record<string, QueueBinding> {
  const queues = asRecord(environment?.platformBindings?.queues);
  return (queues ?? {}) as Record<string, QueueBinding>;
}

function persistQueueBindings(
  environmentId: string,
  patch: (current: Record<string, QueueBinding>) => Record<string, QueueBinding>
): void {
  const environment = envRepo.findById(environmentId);
  if (!environment) return;
  const next = patch(parseQueueBindings(environment));
  envRepo.updatePlatformBindings(environmentId, {
    queues: next as unknown as Record<string, unknown>,
  });
}

type QueueCapableAdapter = IProviderAdapter & Pick<CloudRunAdapter,
  'ensureQueue' | 'destroyQueue' | 'getQueueSubscription' | 'listQueueTopics' | 'queueResourceNames'
>;

function queueBackend(adapter: IProviderAdapter): 'pubsub' | 'postgres' | undefined {
  return adapter.capabilities.queues?.backend;
}

function queueAction(params: {
  id: string;
  type: PlanAction['type'];
  name: string;
  provider: string;
  operation: string;
  reason: string;
  verified: boolean;
  diff?: PlanFieldDiff[];
  dataBearing?: boolean;
  requiresConfirm?: boolean;
  metadata?: Record<string, unknown>;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'queue', name: params.name, provider: params.provider },
    verified: params.verified,
    reason: params.reason,
    ...(params.diff && params.diff.length > 0 ? { diff: params.diff } : {}),
    ...(params.dataBearing ? { dataBearing: true } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    metadata: { operation: params.operation, ...(params.metadata ?? {}) },
  };
}

export async function planQueues(params: {
  project: Project;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
}): Promise<{ actions: PlanAction[]; warnings: string[] }> {
  const declared = params.environmentSpec.queues ?? {};
  const declaredNames = Object.keys(declared);
  const bindings = parseQueueBindings(params.environment);
  const boundNames = Object.keys(bindings);
  if (declaredNames.length === 0 && boundNames.length === 0) {
    return { actions: [], warnings: [] };
  }

  const provider = params.environmentSpec.hosting.provider;
  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      actions: [],
      warnings: [`Cannot plan queues: ${adapterResult.error ?? `no ${provider} adapter`}`],
    };
  }
  const adapter = adapterResult.adapter as IProviderAdapter;
  const backend = queueBackend(adapter);
  if (!backend) {
    return {
      actions: [],
      warnings: [`Hosting provider ${provider} does not support queues.`],
    };
  }

  const warnings: string[] = [];
  const hasWorker = Object.values(params.environmentSpec.services)
    .some((service) => service.workloadKind === 'worker');
  if (declaredNames.length > 0 && !hasWorker) {
    warnings.push('queues are declared but no service has workloadKind "worker"; nothing will consume them unless a web service does.');
  }

  if (backend === 'postgres') {
    return { actions: planPostgresQueues(declared, bindings, provider), warnings };
  }

  // Pub/Sub backend.
  if (!isCloudPreparedForQueues(params.project, provider)) {
    warnings.push(
      'Pub/Sub queues need cloud preparation: re-run hv_connect provider="cloudrun" action="prepare" confirm=true (adds pubsub.googleapis.com and roles/pubsub.editor). Queue actions will fail until then.'
    );
  }

  const queueAdapter = adapter as QueueCapableAdapter;
  const actions: PlanAction[] = [];

  if (!params.environment) {
    // No local environment yet: plan the full desired set unverified.
    for (const [name, spec] of Object.entries(declared)) {
      actions.push(pubsubEnsureAction(name, spec, provider, {
        verified: false,
        reason: `Queue "${name}" is not provisioned`,
      }));
    }
    return { actions, warnings };
  }

  try {
    for (const [name, spec] of Object.entries(declared)) {
      const subscription = await queueAdapter.getQueueSubscription(params.environment, name);
      if (!subscription) {
        actions.push(pubsubEnsureAction(name, spec, provider, {
          verified: true,
          reason: `Pub/Sub topic/subscription for "${name}" does not exist`,
        }));
        continue;
      }
      const diff: PlanFieldDiff[] = [];
      if (spec.ackDeadlineSeconds !== undefined && subscription.ackDeadlineSeconds !== spec.ackDeadlineSeconds) {
        diff.push({
          field: 'ackDeadlineSeconds',
          from: String(subscription.ackDeadlineSeconds ?? 'default'),
          to: String(spec.ackDeadlineSeconds),
        });
      }
      actions.push(queueAction({
        id: `queue:${name}`,
        type: diff.length > 0 ? 'update' : 'noop',
        name,
        provider,
        operation: QUEUE_OPERATIONS.ensure,
        reason: diff.length > 0
          ? `Queue "${name}" config drifted (${diff.map((entry) => entry.field).join(', ')})`
          : `Queue "${name}" is in sync`,
        verified: true,
        diff,
        metadata: { queueName: name, ...(spec.ackDeadlineSeconds !== undefined ? { ackDeadlineSeconds: spec.ackDeadlineSeconds } : {}) },
      }));
    }

    // Bindings for queues no longer in the spec: destroy (undelivered
    // messages are data) — confirm-gated like database destroys.
    for (const name of boundNames) {
      if (declared[name] || bindings[name].backend !== 'pubsub') continue;
      actions.push(queueAction({
        id: `queue:${name}:destroy`,
        type: 'destroy',
        name,
        provider,
        operation: QUEUE_OPERATIONS.destroy,
        reason: `Queue "${name}" was removed from the spec; undelivered messages will be lost`,
        verified: true,
        dataBearing: true,
        requiresConfirm: true,
        metadata: { queueName: name },
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Could not observe Pub/Sub for queues: ${message}. Queue actions are unverified.`);
    const fallback = Object.entries(declared).map(([name, spec]) =>
      pubsubEnsureAction(name, spec, provider, {
        verified: false,
        reason: `Queue "${name}" state could not be observed`,
      }));
    return { actions: fallback, warnings };
  }

  return { actions, warnings };
}

function pubsubEnsureAction(
  name: string,
  spec: QueueSpec,
  provider: string,
  options: { verified: boolean; reason: string }
): PlanAction {
  return queueAction({
    id: `queue:${name}`,
    type: 'create',
    name,
    provider,
    operation: QUEUE_OPERATIONS.ensure,
    reason: options.reason,
    verified: options.verified,
    metadata: { queueName: name, ...(spec.ackDeadlineSeconds !== undefined ? { ackDeadlineSeconds: spec.ackDeadlineSeconds } : {}) },
  });
}

function planPostgresQueues(
  declared: Record<string, QueueSpec>,
  bindings: Record<string, QueueBinding>,
  provider: string
): PlanAction[] {
  const actions: PlanAction[] = [];
  for (const name of Object.keys(declared)) {
    const bound = bindings[name]?.backend === 'postgres';
    actions.push(queueAction({
      id: `queue:${name}`,
      type: bound ? 'noop' : 'create',
      name,
      provider,
      operation: QUEUE_OPERATIONS.ensure,
      reason: bound
        ? `Queue "${name}" is wired (postgres-backed)`
        : `Queue "${name}" is postgres-backed: hypervibe wires env vars only; tables are app-managed (pg-boss/graphile-worker ride DATABASE_URL)`,
      verified: false,
      metadata: { queueName: name },
    }));
  }
  for (const [name, binding] of Object.entries(bindings)) {
    if (declared[name] || binding.backend !== 'postgres') continue;
    actions.push(queueAction({
      id: `queue:${name}:destroy`,
      type: 'destroy',
      name,
      provider,
      operation: QUEUE_OPERATIONS.destroy,
      reason: `Queue "${name}" was removed from the spec; clearing the binding (postgres tables are app-managed and untouched)`,
      verified: false,
      metadata: { queueName: name },
    }));
  }
  return actions;
}

export function isQueueAction(action: PlanAction): boolean {
  const operation = action.metadata?.operation;
  return typeof operation === 'string' && QUEUE_OPERATION_SET.has(operation);
}

export async function applyQueueAction(params: {
  project: Project;
  envName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<{ success: boolean; message: string; error?: string; data?: Record<string, unknown> }> {
  const queueName = String(params.action.metadata?.queueName ?? params.action.resource.name);
  const environment = envRepo.findByProjectAndName(params.project.id, params.envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${params.envName}"` };
  }

  const provider = params.environmentSpec.hosting.provider;
  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Hosting adapter unavailable', error: adapterResult.error };
  }
  const adapter = adapterResult.adapter as IProviderAdapter;
  const backend = queueBackend(adapter);
  if (!backend) {
    return { success: false, message: `${provider} does not support queues`, error: `Hosting provider ${provider} has no queue backend.` };
  }

  const operation = String(params.action.metadata?.operation ?? '');

  if (backend === 'postgres') {
    if (operation === QUEUE_OPERATIONS.destroy) {
      persistQueueBindings(environment.id, (current) => {
        const next = { ...current };
        delete next[queueName];
        return next;
      });
      return { success: true, message: `Cleared queue binding "${queueName}" (postgres tables untouched)` };
    }
    persistQueueBindings(environment.id, (current) => ({
      ...current,
      [queueName]: { backend: 'postgres', updatedAt: new Date().toISOString() },
    }));
    return { success: true, message: `Queue "${queueName}" wired (postgres-backed via DATABASE_URL)` };
  }

  // Pub/Sub backend.
  if (!isCloudPreparedForQueues(params.project, provider)) {
    return {
      success: false,
      message: 'Pub/Sub is not prepared for queues',
      error: 'Re-run hv_connect provider="cloudrun" action="prepare" confirm=true (adds pubsub.googleapis.com and roles/pubsub.editor), then re-run hv_plan and hv_apply.',
    };
  }
  const queueAdapter = adapter as QueueCapableAdapter;

  try {
    if (operation === QUEUE_OPERATIONS.destroy) {
      await queueAdapter.destroyQueue(environment, queueName);
      persistQueueBindings(environment.id, (current) => {
        const next = { ...current };
        delete next[queueName];
        return next;
      });
      return { success: true, message: `Destroyed Pub/Sub topic and subscription for "${queueName}"` };
    }

    const ackDeadlineSeconds = typeof params.action.metadata?.ackDeadlineSeconds === 'number'
      ? params.action.metadata.ackDeadlineSeconds
      : params.environmentSpec.queues?.[queueName]?.ackDeadlineSeconds;
    const result = await queueAdapter.ensureQueue(environment, queueName, { ackDeadlineSeconds });
    persistQueueBindings(environment.id, (current) => ({
      ...current,
      [queueName]: {
        backend: 'pubsub',
        topicName: result.topicName,
        subscriptionName: result.subscriptionName,
        updatedAt: new Date().toISOString(),
      },
    }));
    return {
      success: true,
      message: result.createdTopic || result.createdSubscription
        ? `Created Pub/Sub queue "${queueName}"`
        : `Pub/Sub queue "${queueName}" configured`,
      data: { topicName: result.topicName, subscriptionName: result.subscriptionName },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Queue ${operation} failed for "${queueName}"`, error: message };
  }
}
