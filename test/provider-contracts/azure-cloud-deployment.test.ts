import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createAzureCloudInstallationDriver } from '../../src/adapters/providers/azure/azure-cloud-installation.js';
import { planCloudInstallationV1, applyCloudInstallationV1 } from '../../src/application/hosted/cloud-installation.js';
import { resourceName } from '../../src/domain/services/resource-names.js';
import type { CloudDeploymentConnectionV1 } from '../../src/domain/ports/cloud-deployment.port.js';
import type { CloudInstallationIntent, CloudInstallationRecord } from '../../src/domain/ports/cloud-installation.port.js';
import { AzureContainerAppsAdapter } from '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
import '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { environmentSpecSchema } from '../../src/domain/spec/spec.schema.js';
import { observeRuntimeAccess, planRuntimeAccess, applyRuntimeAccessAction } from '../../src/domain/services/runtime-access.service.js';

// Reconstructed Microsoft UAMI/FIC GET and client-credentials wire responses.
// https://learn.microsoft.com/en-us/rest/api/managedidentity/user-assigned-identities/get?view=rest-managedidentity-2024-11-30
// https://learn.microsoft.com/en-us/rest/api/managedidentity/federated-identity-credentials/get?view=rest-managedidentity-2024-11-30
// Synthetic retained receipt; new Azure installation is deliberately blocked.
const tenantId = 'b6c948ef-f6b5-4384-8354-da3a15eca969';
const subscriptionId = '12345678-1234-5678-9012-123456789012';
const intent: CloudInstallationIntent = { schemaVersion: 1, purpose: 'deployment', stage: 'deployment', mode: 'connect', provider: 'azure', keys: [],
  installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer', appId: 'app', environment: 'production',
  nativeScope: { tenantId, subscriptionId, resourceGroup: 'isolated-production', location: 'canadacentral' },
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  deployment: { hostingProvider: 'azure-container-apps', region: 'canadacentral', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'host-project', projectNumber: '123456789', serviceAccountEmail: 'delivery@host-project.iam.gserviceaccount.com',
    subject: '123456789012345678901', issuer: 'https://accounts.google.com' } };
const group = `/subscriptions/${subscriptionId}/resourceGroups/isolated-production`;
const scopeDigest = createHash('sha256').update(JSON.stringify([intent.customerId, intent.appId, intent.environment, intent.installationId, intent.nativeScope])).digest('hex');
function principal(purpose: string, clientId: string, principalId: string) {
  const name = resourceName(purpose, { scope: [intent.customerId, intent.appId, intent.environment, intent.installationId], minLength: 3, maxLength: 128 });
  return { kind: 'azure-managed-identity' as const, tenantId, subscriptionId, clientId, principalId,
    identityResourceId: `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}` };
}
const provision = principal('provision', '4024ab25-56a8-4370-aea6-6389221caf29', '25cc773c-7f05-40fc-a104-32d2300754ad');
const release = principal('release', '5024ab25-56a8-4370-aea6-6389221caf29', '35cc773c-7f05-40fc-a104-32d2300754ad');
const runtime = principal('runtime-web', '6024ab25-56a8-4370-aea6-6389221caf29', '45cc773c-7f05-40fc-a104-32d2300754ad');
const connection: CloudDeploymentConnectionV1 = { schemaVersion: 1, purpose: 'deployment', installationId: intent.installationId, planDigest: 'c'.repeat(64),
  customerId: intent.customerId, appId: intent.appId, environment: intent.environment, source: intent.source, provider: 'azure', hostingProvider: 'azure-container-apps',
  nativeScope: intent.nativeScope, deployment: intent.deployment!, hostIdentity: intent.hostIdentity, principals: { provision, release },
  runtimeIdentities: [{ workload: 'web', installationId: intent.installationId, owner: scopeDigest, principal: runtime }] };
function fixture(change?: (path: string, body: Record<string, any>) => Record<string, any>) {
  const calls: Array<{ url: string; method: string; form?: Record<string, string> }> = [];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    const form = url.hostname === 'login.microsoftonline.com' ? Object.fromEntries(new URLSearchParams(String(init?.body))) : undefined;
    calls.push({ url: url.href, method, form });
    let body: Record<string, any>;
    if (form) body = { access_token: 'opaque-azure-token', token_type: 'Bearer', expires_in: 3599 };
    else if (url.pathname === `/subscriptions/${subscriptionId}`) body = { subscriptionId, tenantId, state: 'Enabled' };
    else if (url.pathname.endsWith('/permissions')) body = { value: [{ actions: ['*'], notActions: [], dataActions: [], notDataActions: [] }] };
    else if (url.pathname.endsWith('/federatedIdentityCredentials/hypervibe')) body = { id: url.pathname,
      properties: { issuer: intent.hostIdentity.issuer, subject: intent.hostIdentity.subject, audiences: ['api://AzureADTokenExchange'] } };
    else {
      const purpose = url.pathname === provision.identityResourceId ? 'provision' : url.pathname === release.identityResourceId ? 'release' : 'runtime-web';
      const id = purpose === 'provision' ? provision : purpose === 'release' ? release : runtime;
      body = { id: url.pathname, properties: { tenantId, clientId: id.clientId, principalId: id.principalId },
        tags: { hypervibeInstallation: intent.installationId, hypervibeDeployment: scopeDigest, hypervibePurpose: purpose } };
    }
    return Response.json(change?.(url.pathname, body) ?? body);
  });
  const host = { verifyIdentity: vi.fn(async () => intent.hostIdentity), getAccessToken: vi.fn(async () => { throw new Error('No Google OAuth token belongs at Azure.'); }),
    getIdToken: vi.fn(async () => 'synthetic-host-assertion') };
  return { driver: createAzureCloudInstallationDriver({ fetch: request as typeof fetch }), host, calls, request };
}
describe('Azure purpose-specific deployment installation and issuance', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([false, true])('binds the independently observed precreated runtime identity and reviewed reader grants through the shared frontier (reference=%s)', async withReference => {
    const managed = `${group}/providers/Microsoft.App/managedEnvironments/runtime`;
    const environment: any = { id: 'local-environment-id', projectId: 'local-project-id', name: 'production',
      platformBindings: { provider: 'azure-container-apps', projectId: group, environmentId: managed } };
    const reference = { destination: { provider: 'azure-key-vault' as const, tenantId, subscriptionId, resourceGroup: 'isolated-collection', vaultName: 'app-secrets', secretName: 'api-token' }, version: 'a'.repeat(32) };
    const approved = structuredClone(connection);
    if (withReference) approved.deployment.workloads[0].runtimeSecrets = [{ key: 'API_TOKEN', reference }];
    const resources = new Map<string, any>([
      [provision.identityResourceId, { id: provision.identityResourceId, properties: { tenantId, clientId: provision.clientId, principalId: provision.principalId } }],
      [runtime.identityResourceId, { id: runtime.identityResourceId, properties: { tenantId, clientId: runtime.clientId, principalId: runtime.principalId },
        tags: { hypervibeInstallation: connection.installationId, hypervibeDeployment: scopeDigest, hypervibePurpose: 'runtime-web' } }],
      ...[group, managed].map(id => [id, { id, properties: { provisioningState: 'Succeeded' }, tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': environment.id } }] as const),
    ]);
    const vault = `/subscriptions/${subscriptionId}/resourceGroups/isolated-collection/providers/Microsoft.KeyVault/vaults/app-secrets`;
    const grantHash = createHash('sha256').update(JSON.stringify([scopeDigest, vault.toLowerCase(), runtime.principalId.toLowerCase()])).digest('hex');
    const assignment = `${vault}/providers/Microsoft.Authorization/roleAssignments/${grantHash.slice(0, 8)}-${grantHash.slice(8, 12)}-5${grantHash.slice(13, 16)}-8${grantHash.slice(17, 20)}-${grantHash.slice(20, 32)}`;
    resources.set(vault, { id: vault, systemData: { createdAt: '2026-10-24T00:00:00Z' }, properties: { tenantId, enableRbacAuthorization: true, provisioningState: 'Succeeded' } });
    resources.set(assignment, { id: assignment, properties: { principalId: runtime.principalId, scope: vault,
      roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`,
      principalType: 'ServicePrincipal', description: `Hypervibe runtime ${scopeDigest}` } });
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const id = new URL(String(input)).pathname;
      return resources.has(id) ? Response.json(resources.get(id)) : new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', request);
    const hosting = await providerRegistry.createTransientAdapter<AzureContainerAppsAdapter>('azure-container-apps', {
      connection: approved, capability: 'provision', authentication: { kind: 'azure-federation', principal: provision,
        getAccessToken: async () => ({ token: 'opaque-broker-token', expiresAt: new Date(Date.now() + 300_000).toISOString() }) } });
    const input = { environment, environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'azure-container-apps', region: 'canadacentral' }, services: { web: {} },
      ...(withReference ? { secretDestinations: { API_TOKEN: reference } } : {}) }), hosting, storageAdapters: {} };
    const observed = await observeRuntimeAccess(input);
    const actions = planRuntimeAccess(observed);
    expect(actions).toHaveLength(1);
    expect(actions[0].metadata?.step).toMatchObject({ operation: 'attach', target: { phase: 'bind-existing', identityId: runtime.identityResourceId, owner: scopeDigest } });
    const save = (bindings: Record<string, unknown>) => { environment.platformBindings = { ...environment.platformBindings, ...bindings }; };
    expect(await applyRuntimeAccessAction({ ...input, action: actions[0], confirmedActionIds: new Set([actions[0].id]), save })).toMatchObject({ success: true });
    expect(planRuntimeAccess(await observeRuntimeAccess(input))).toEqual([]);
    expect(JSON.stringify(environment)).not.toContain('opaque-broker-token');
    if (withReference) {
      const retainedGrant = resources.get(assignment); resources.delete(assignment);
      expect((await observeRuntimeAccess(input)).identities).toMatchObject([{ serviceName: 'web', observation: { state: 'unknown' } }]);
      resources.set(assignment, retainedGrant);
    }
    resources.set(runtime.identityResourceId, { ...resources.get(runtime.identityResourceId), properties: { tenantId, clientId: runtime.clientId, principalId: release.principalId } });
    expect((await observeRuntimeAccess(input)).identities).toMatchObject([{ serviceName: 'web', observation: { state: 'unknown' } }]);
    expect(request.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('reviews an explicitly blocked new installation and performs zero cloud mutations even with every confirmation', async () => {
    const f = fixture(); let saved: CloudInstallationRecord | null = null;
    const context = { driver: f.driver, authorize: async () => true, authentication: { host: f.host,
      administrator: { getAccessToken: async () => 'transient-admin' } }, store: { read: async () => saved,
      compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord) => {
        if ((saved?.revision ?? null) !== revision) return false; saved = structuredClone(next); return true;
      } } };
    const plan = await planCloudInstallationV1({ ...context, intent });
    expect(plan.plan.blockedReason).toBe('create_ownership_unverified');
    expect(plan.plan.review.permissions.map(item => item.purpose)).toContain('deployment-release');
    const result = await applyCloudInstallationV1({ ...context, installationId: intent.installationId, planDigest: plan.plan.digest,
      confirmActions: plan.plan.actions.map(action => action.id) });
    expect(result.status).toBe('blocked');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('verifies immutable UAMI and exact FIC, rechecks authority, then issues only the selected target and purpose', async () => {
    const f = fixture(); const beforeIssue = vi.fn(async () => {});
    const session = await f.driver.deployment!.issueSession!({ connection, capability: 'release', target: 'container-registry', host: f.host,
      signal: new AbortController().signal, beforeIssue });
    expect(session).toMatchObject({ kind: 'azure-federation', principal: release, target: 'container-registry', token: 'opaque-azure-token' });
    expect(beforeIssue).toHaveBeenCalledTimes(2);
    expect(f.calls.filter(call => call.form).map(call => [call.form!.client_id, call.form!.scope])).toEqual([
      [release.clientId, 'https://management.azure.com/.default'], [release.clientId, 'https://containerregistry.azure.net/.default'],
    ]);
    expect(f.host.getAccessToken).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.url.includes('/secrets'))).toBe(false);
  });

  it.each(['identity', 'federation', 'authority'])('rejects %s changes before final issuance', async kind => {
    const f = fixture((path, body) => kind === 'identity' && path === release.identityResourceId
      ? { ...body, properties: { ...body.properties, principalId: provision.principalId } }
      : kind === 'federation' && path.endsWith('/hypervibe') ? { ...body, properties: { ...body.properties, subject: '999999999999999999999' } } : body);
    let checks = 0;
    await expect(f.driver.deployment!.issueSession!({ connection, capability: 'release', target: 'container-registry', host: f.host,
      signal: new AbortController().signal, beforeIssue: async () => { if (++checks === 2 && kind === 'authority') throw new Error('revoked synthetic-token'); } })).rejects.toThrow();
    expect(f.calls.filter(call => call.form)).toHaveLength(1);
  });
});
