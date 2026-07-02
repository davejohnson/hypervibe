/**
 * Pure Pub/Sub REST request helpers used by CloudRunAdapter's queue
 * methods. Token + project in, fetch out — tests stub global fetch.
 * Topic/subscription create uses PUT and treats 409 ALREADY_EXISTS as
 * success so converge stays idempotent.
 */

const PUBSUB_API = 'https://pubsub.googleapis.com/v1';

export interface PubSubTopic {
  /** Fully-qualified: projects/<pid>/topics/<id> */
  name: string;
  labels?: Record<string, string>;
}

export interface PubSubSubscription {
  /** Fully-qualified: projects/<pid>/subscriptions/<id> */
  name: string;
  topic: string;
  ackDeadlineSeconds?: number;
  labels?: Record<string, string>;
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function fail(operation: string, response: Response): Promise<never> {
  const text = await response.text();
  throw new Error(`Pub/Sub ${operation} failed: ${response.status} ${text}`);
}

export async function listTopics(token: string, gcpProjectId: string): Promise<PubSubTopic[]> {
  const topics: PubSubTopic[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/topics?${params}`, {
      headers: headers(token),
    });
    if (!response.ok) return fail('listTopics', response);
    const body = await response.json() as { topics?: PubSubTopic[]; nextPageToken?: string };
    topics.push(...(body.topics ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return topics;
}

export async function ensureTopic(
  token: string,
  gcpProjectId: string,
  topicId: string,
  labels: Record<string, string>
): Promise<{ created: boolean }> {
  const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/topics/${topicId}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ labels }),
  });
  if (response.ok) return { created: true };
  if (response.status === 409) return { created: false };
  return fail('ensureTopic', response);
}

export async function getSubscription(
  token: string,
  gcpProjectId: string,
  subscriptionId: string
): Promise<PubSubSubscription | null> {
  const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/subscriptions/${subscriptionId}`, {
    headers: headers(token),
  });
  if (response.status === 404) return null;
  if (!response.ok) return fail('getSubscription', response);
  return await response.json() as PubSubSubscription;
}

export async function ensureSubscription(
  token: string,
  gcpProjectId: string,
  subscriptionId: string,
  topicId: string,
  options: { ackDeadlineSeconds?: number; labels?: Record<string, string> }
): Promise<{ created: boolean }> {
  const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/subscriptions/${subscriptionId}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({
      topic: `projects/${gcpProjectId}/topics/${topicId}`,
      ...(options.ackDeadlineSeconds !== undefined ? { ackDeadlineSeconds: options.ackDeadlineSeconds } : {}),
      ...(options.labels ? { labels: options.labels } : {}),
    }),
  });
  if (response.ok) return { created: true };
  if (response.status === 409) return { created: false };
  return fail('ensureSubscription', response);
}

export async function patchSubscriptionAckDeadline(
  token: string,
  gcpProjectId: string,
  subscriptionId: string,
  ackDeadlineSeconds: number
): Promise<void> {
  const response = await fetch(
    `${PUBSUB_API}/projects/${gcpProjectId}/subscriptions/${subscriptionId}?updateMask=ackDeadlineSeconds`,
    {
      method: 'PATCH',
      headers: headers(token),
      body: JSON.stringify({ subscription: { ackDeadlineSeconds } }),
    }
  );
  if (!response.ok) return fail('patchSubscription', response);
}

export async function deleteTopic(token: string, gcpProjectId: string, topicId: string): Promise<void> {
  const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/topics/${topicId}`, {
    method: 'DELETE',
    headers: headers(token),
  });
  if (!response.ok && response.status !== 404) return fail('deleteTopic', response);
}

export async function deleteSubscription(token: string, gcpProjectId: string, subscriptionId: string): Promise<void> {
  const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: headers(token),
  });
  if (!response.ok && response.status !== 404) return fail('deleteSubscription', response);
}
