import { describe, expect, it, vi } from 'vitest';
import { createAzureCloudInstallationDriver } from '../../src/adapters/providers/azure/azure-cloud-installation.js';
import type { CloudInstallationIntent, CloudInstallationProviderContext } from '../../src/domain/ports/cloud-installation.port.js';
import { azurePreparedFixture } from './helpers/azure-prepared-fixture.js';

// Offline reconstructed Microsoft.Resources/ManagedIdentity/App/ContainerRegistry
// envelopes. The ARM/native contract sources are listed in the Azure ARM evidence.
const subscriptionId = '11111111-2222-4333-8444-555555555555', tenantId = '66666666-7777-4888-8999-000000000000';
const subscription = `/subscriptions/${subscriptionId}`, group = `${subscription}/resourceGroups/sequence-staging`;
const holdingImage = `us-central1-docker.pkg.dev/holding-project/public/holding@sha256:${'a'.repeat(64)}`;
const intent: CloudInstallationIntent = { schemaVersion: 1, purpose: 'deployment', stage: 'deployment', mode: 'connect', provider: 'azure',
  installationId: '11111111-1111-4111-8111-111111111111', customerId: 'studio', appId: 'sequence', environment: 'staging', keys: [],
  source: { repository: 'github.com/studio/sequence', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  nativeScope: { tenantId, subscriptionId, resourceGroup: 'sequence-staging', location: 'eastus' },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hypercloud-host', projectNumber: '123456789012',
    serviceAccountEmail: 'writer@hypercloud-host.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
  deployment: { hostingProvider: 'azure-container-apps', region: 'eastus', preparation: { kind: 'holding-workloads', image: holdingImage },
    workloads: [{ name: 'web', kind: 'web', public: true, runtimeSecrets: [] }] } };
function fixture() {
  const resources = new Map<string, unknown>([[subscription, { subscriptionId, tenantId, state: 'Enabled' }],
    [`${subscription}/providers/Microsoft.Authorization/permissions`, { value: [{ actions: ['*'], notActions: [] }] }],
    ...['Microsoft.ManagedIdentity', 'Microsoft.App', 'Microsoft.ContainerRegistry'].map(namespace => [`${subscription}/providers/${namespace}`,
      { id: `${subscription}/providers/${namespace}`, namespace, registrationState: 'Registered' }] as [string, unknown])]);
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (new URL(String(url)).hostname === 'artifactregistry.googleapis.com') return Response.json({ name: `projects/holding-project/locations/us-central1/repositories/public/dockerImages/holding@sha256:${'a'.repeat(64)}`, uri: holdingImage });
    const value = resources.get(new URL(String(url)).pathname);
    return value instanceof Response ? value : value ? Response.json(value) : Response.json({ error: { code: 'ResourceNotFound' } }, { status: 404 });
  });
  const context: CloudInstallationProviderContext = { intent, completed: {}, signal: new AbortController().signal, beforeMutation: async () => {},
    authentication: { administrator: { getAccessToken: async () => 'synthetic-admin-token' }, host: { verifyIdentity: async () => intent.hostIdentity,
      getIdToken: async () => 'synthetic-google-token', getAccessToken: async () => 'synthetic-host-token' } } };
  return { resources, request, context, driver: createAzureCloudInstallationDriver({ fetch: request as typeof fetch }) };
}
describe('Azure separately authorized prepared deployment installation', () => {
  it('requires anonymous exact holding-image metadata before installation review', async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) => new URL(String(url)).hostname === 'artifactregistry.googleapis.com' ? new Response('', { status: 403 }) : original(url, init));
    let failed = false; try { await f.driver.plan(f.context); } catch { failed = true; }
    expect(failed).toBe(true);
  });
  it('reviews explicit no-secret holding resources and separate provision, release and runtime principals', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context);
    expect(plan.blockedReason).toBeUndefined();
    expect(plan.actions.some(action => action.metadata.native.kind === 'app')).toBe(true);
    expect(plan.actions.some(action => action.metadata.native.kind === 'registry')).toBe(true);
    expect(plan.actions.some(action => action.metadata.native.purpose === 'holding')).toBe(true);
    expect(plan.actions.every(action => action.verified)).toBe(true);
    expect(plan.review.warnings.join(' ')).toMatch(/exclusive/i);
  });
  it('blocks a known existing app/environment namespace before any native writes', async () => {
    const f = fixture(); f.resources.set(group, { id: group, location: 'eastus', properties: { provisioningState: 'Succeeded' } });
    expect((await f.driver.plan(f.context)).blockedReason).toBe('ownership_mismatch');
  });
  it('verifies managed-environment join authority before reviewing creation', async () => {
    const f = fixture(); f.resources.set(`${subscription}/providers/Microsoft.Authorization/permissions`, { value: [{ actions: ['*'], notActions: ['Microsoft.App/managedEnvironments/join/action'] }] });
    await expect(f.driver.plan(f.context)).rejects.toMatchObject({ reason: 'insufficient_permissions' });
  });
  it('installs narrowly scoped managed-environment join grants for both deployment principals', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context);
    for (const purpose of ['provision', 'release']) expect(plan.actions.some(action => action.metadata.native.key === `grant:${purpose}:join`)).toBe(true);
  });
  it('installs a no-secret holding app and separate runtime readers through the actual durable engine', async () => {
    const f = await azurePreparedFixture(true);
    expect(f.installed).toMatchObject({ status: 'ready', reason: undefined });
    const connection = f.driver.deployment!.connection(f.installed);
    const app = f.resources.get(connection.preparedResources!.workloads[0].id);
    expect(app.properties.configuration.secrets).toEqual([]);
    expect(app.properties.template.containers[0].env).toEqual([]);
    const holder = connection.preparedResources!.workloads[0].holding.principal;
    if (holder.kind !== 'azure-managed-identity') throw new Error('Missing native holding identity');
    expect(Object.keys(app.identity.userAssignedIdentities)).toEqual([holder.identityResourceId]);
    const creation = f.events.find(event => event.method === 'PUT' && event.body.properties.template.resources[0].type === 'Microsoft.App/containerApps')!;
    expect(creation.body.properties.template.resources[0].properties.configuration.identitySettings).toEqual([{ identity: holder.identityResourceId, lifecycle: 'None' }]);
    expect(connection.runtimeIdentities[0].principal).not.toEqual(holder);
    expect([...f.resources.values()].filter(value => value.properties?.principalId === holder.principalId && value.properties?.roleDefinitionId)).toEqual([]);
    expect(f.events.filter(event => event.method === 'PUT').every(event => event.path.includes('/providers/Microsoft.Resources/deployments/'))).toBe(true);
  });
  it('rejects value-bearing or extra native evidence fields before exposing a receipt', async () => {
    const f = await azurePreparedFixture();
    const evidence = structuredClone(f.installed.completed['azure:prepared:identity:provision']);
    evidence.resources[0].identity.clientSecret = 'synthetic-secret-must-not-escape';
    expect(() => f.driver.parseEvidence(evidence, f.intent)).toThrow();
  });
});
