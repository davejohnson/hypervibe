import type { RuntimeIdentityRequest } from '../../../domain/ports/runtime-identity.port.js';
import { pubsubQueueResourceIds } from '../../../domain/services/queue-env.js';
import { GcpRuntimeError, gcpRuntimeRequest, parseGcpRuntimePolicy } from './gcp-runtime-client.js';

export interface GcpRuntimeQueue { queueName: string; topicName: string; subscriptionName: string }
export function serializeRuntimeQueues(queues: GcpRuntimeQueue[]): string {
  const result = JSON.stringify([...queues].sort((left, right) => left.queueName.localeCompare(right.queueName)));
  if (result.length > 8192) throw new GcpRuntimeError('Runtime queue permissions exceed the bounded reviewed target size.');
  return result;
}
export function parseRuntimeQueues(raw: string | undefined, projectId: string): GcpRuntimeQueue[] {
  if (raw === undefined) return [];
  if (raw.length > 8192) throw new GcpRuntimeError('Runtime queue permissions exceed the bounded reviewed target size.');
  let values: unknown;
  try { values = JSON.parse(raw); } catch { throw new GcpRuntimeError('The retained runtime queue permission scope is invalid.'); }
  if (!Array.isArray(values) || values.length > 100) throw new GcpRuntimeError('The retained runtime queue permission scope is invalid.');
  const names = new Set<string>(); const resources = new Set<string>();
  const result = values.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'queueName,subscriptionName,topicName'
      || typeof value.queueName !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.queueName) || names.has(value.queueName)) {
      throw new GcpRuntimeError('Runtime queue permissions contain an invalid or duplicate queue identity.');
    }
    names.add(value.queueName);
    for (const [key, kind] of [['topicName', 'topics'], ['subscriptionName', 'subscriptions']] as const) {
      const resource = value[key]; const prefix = `projects/${projectId}/${kind}/`;
      if (typeof resource !== 'string' || !resource.startsWith(prefix) || !/^[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(resource.slice(prefix.length)) || resources.has(resource)) {
        throw new GcpRuntimeError('Runtime queue permissions contain an invalid, duplicate, or cross-project resource.');
      }
      resources.add(resource);
    }
    return { queueName: value.queueName, topicName: value.topicName, subscriptionName: value.subscriptionName };
  });
  serializeRuntimeQueues(result);
  return result;
}
export function desiredRuntimeQueues(request: RuntimeIdentityRequest, projectId: string): GcpRuntimeQueue[] | null {
  if (!request.environmentSpec) return parseRuntimeQueues(request.binding?.evidence.queueGrants, projectId);
  const queues = request.environment.platformBindings.queues as Record<string, unknown> | undefined;
  if (queues !== undefined && (!queues || typeof queues !== 'object' || Array.isArray(queues))) throw new GcpRuntimeError('Runtime queue lifecycle bindings are malformed.');
  const targets: GcpRuntimeQueue[] = [];
  for (const queueName of Object.keys(request.environmentSpec.queues ?? {}).sort()) {
    if (!queues || queues[queueName] === undefined) return null;
    if (!queues[queueName] || typeof queues[queueName] !== 'object' || Array.isArray(queues[queueName])) throw new GcpRuntimeError('The declared runtime queue binding is malformed.');
    const names = pubsubQueueResourceIds(request.environment, queueName, projectId);
    targets.push({ queueName, topicName: `projects/${projectId}/topics/${names.topicId}`, subscriptionName: `projects/${projectId}/subscriptions/${names.subscriptionId}` });
  }
  return parseRuntimeQueues(serializeRuntimeQueues(targets), projectId);
}
export function unionRuntimeQueues(...groups: GcpRuntimeQueue[][]): GcpRuntimeQueue[] {
  const combined = new Map<string, GcpRuntimeQueue>();
  for (const group of groups) for (const target of group) {
    const previous = combined.get(target.queueName);
    if (previous && (previous.topicName !== target.topicName || previous.subscriptionName !== target.subscriptionName)) {
      throw new GcpRuntimeError('A declared queue replaced its retained permission scope; reconcile the original queue before granting another identity.');
    }
    combined.set(target.queueName, target);
  }
  return [...combined.values()].sort((left, right) => left.queueName.localeCompare(right.queueName));
}

/** Only exact bound queues are read. This helper never creates queues or grants. */
export async function readRuntimeQueuePolicies(request: RuntimeIdentityRequest, targets: GcpRuntimeQueue[], token: string, required: GcpRuntimeQueue[]) {
  const label = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 63) || 'unknown';
  const requiredNames = new Set(required.map(target => target.queueName));
  const results: Array<{ resource: string; url: string; role: string; desired: boolean; policy: ReturnType<typeof parseGcpRuntimePolicy> | null }> = [];
  for (const target of targets) {
    for (const [resource, role] of [[target.topicName, 'roles/pubsub.publisher'], [target.subscriptionName, 'roles/pubsub.subscriber']] as const) {
      const url = 'https://pubsub.googleapis.com/v1/' + resource.split('/').map(encodeURIComponent).join('/');
      const value = await gcpRuntimeRequest(url, token) as Record<string, any> | null;
      if (!value) {
        if (requiredNames.has(target.queueName)) throw new GcpRuntimeError('The exact declared Pub/Sub queue is missing; reconcile its lifecycle before runtime permissions.');
        results.push({ resource, url, role, desired: false, policy: null }); continue;
      }
      if (value.name !== resource || value.labels?.['infraprint-environment'] !== label(request.environment.name)
        || value.labels?.['infraprint-queue'] !== label(target.queueName)
        || (resource === target.subscriptionName && value.topic !== target.topicName)) {
        throw new GcpRuntimeError('Pub/Sub runtime permissions require the exact owned topic, subscription, and environment.');
      }
      const policy = parseGcpRuntimePolicy(await gcpRuntimeRequest(`${url}:getIamPolicy?options.requestedPolicyVersion=3`, token));
      results.push({ resource, url, role, desired: requiredNames.has(target.queueName), policy });
    }
  }
  return results;
}
