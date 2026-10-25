import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DestinationBudget, destinationJson } from '../../../src/adapters/providers/secret-destination-http.js';

/** Test-only candidate. It is not a product capability or an authorization grant.
 * The disposable app must already be created, owned, and bound by an independently
 * approved lifecycle action. No CLI, environment credentials or automatic setup.
 * A live owner-approved harness must supply the current action's beforeMutation.
 */
export interface AzureCreateOnlyProbeReview {
  appId: string;
  environmentId: string;
  hypervibeEnvironmentId: string;
  principalId: string;
  createdAt: string;
  image: string;
  location: string;
}
export async function probeAzureCreateOnlyContract(review: AzureCreateOnlyProbeReview, context: {
  getAccessToken(signal: AbortSignal): Promise<string>;
  beforeMutation(reviewDigest: string): Promise<void>;
  fetch: typeof fetch;
  signal: AbortSignal;
}): Promise<{ status: 'guard-verified' | 'guard-not-supported' | 'unknown'; reviewDigest: string }> {
  const reviewDigest = createHash('sha256').update(JSON.stringify(review)).digest('hex');
  const result = (status: 'guard-verified' | 'guard-not-supported' | 'unknown') => ({ status, reviewDigest });
  const app = review.appId.match(/^\/subscriptions\/([a-f0-9-]{36})\/resourceGroups\/([A-Za-z0-9_().-]+)\/providers\/Microsoft.App\/containerApps\/([a-z][a-z0-9-]{1,31})$/i);
  if (!app || !review.environmentId.toLowerCase().startsWith(`/subscriptions/${app[1]}/resourceGroups/${app[2]}/providers/Microsoft.App/managedEnvironments/`.toLowerCase())
    || !/^[a-f0-9-]{36}$/i.test(review.principalId) || !/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(review.image)
    || !/^[a-z0-9]+$/.test(review.location) || !review.hypervibeEnvironmentId || !Number.isFinite(Date.parse(review.createdAt))) return result('unknown');
  const body = { location: review.location, identity: { type: 'SystemAssigned' },
    tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': review.hypervibeEnvironmentId, 'hypervibe-purpose': 'disposable-create-only-probe' },
    properties: { managedEnvironmentId: review.environmentId,
      configuration: { activeRevisionsMode: 'Single', ingress: { external: false, targetPort: 8080, transport: 'auto', allowInsecure: false } },
      template: { containers: [{ name: 'probe', image: review.image, env: [], resources: { cpu: 0.25, memory: '0.5Gi' } }], scale: { minReplicas: 0, maxReplicas: 1 } } } };
  const select = (native: any) => {
    if (!native || native.id?.toLowerCase() !== review.appId.toLowerCase() || native.systemData?.createdAt !== review.createdAt
      || native.identity?.principalId?.toLowerCase() !== review.principalId.toLowerCase() || native.identity?.type !== 'SystemAssigned'
      || native.properties?.provisioningState !== 'Succeeded' || native.properties?.managedEnvironmentId !== review.environmentId
      || native.tags?.['hypervibe-purpose'] !== 'disposable-create-only-probe' || !isDeepStrictEqual(native.tags, body.tags)
      || native.properties.configuration?.secrets?.length || native.properties.template?.containers?.length !== 1) throw new Error('Unverified disposable app');
    const configuration = native.properties.configuration;
    const selected = { location: native.location, identity: { type: native.identity.type }, tags: native.tags, properties: {
      managedEnvironmentId: native.properties.managedEnvironmentId,
      configuration: { activeRevisionsMode: configuration.activeRevisionsMode, ingress: Object.fromEntries(Object.keys(body.properties.configuration.ingress).map(key => [key, configuration.ingress?.[key]])) },
      template: native.properties.template } };
    if (!isDeepStrictEqual(selected, body)) throw new Error('Disposable configuration changed');
    return { selected, revision: native.properties.latestRevisionName, readyRevision: native.properties.latestReadyRevisionName,
      principalId: native.identity.principalId, createdAt: native.systemData.createdAt };
  };
  const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
  try {
    const token = await budget.wait(context.getAccessToken(budget.signal));
    const url = `https://management.azure.com${review.appId}?api-version=2026-01-01`;
    const before = select(await destinationJson(context.fetch, budget, url, token));
    await budget.wait(context.beforeMutation(reviewDigest));
    const response = await budget.wait(context.fetch(url, { method: 'PUT', redirect: 'error', signal: budget.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'If-None-Match': '*' }, body: JSON.stringify(body) }));
    void response.body?.cancel().catch(() => {});
    const after = select(await destinationJson(context.fetch, budget, url, token));
    if (!isDeepStrictEqual(before, after)) return result('unknown');
    return result(response.status === 412 ? 'guard-verified' : response.ok ? 'guard-not-supported' : 'unknown');
  } catch { return result('unknown'); }
  finally { budget.close(); }
}
