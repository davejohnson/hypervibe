import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createAzureCloudInstallationDriver } from '../../../src/adapters/providers/azure/azure-cloud-installation.js';
import { applyCloudInstallationV1, planCloudInstallationV1 } from '../../../src/application/hosted/cloud-installation.js';
import type { CloudInstallationAction, CloudInstallationContext, CloudInstallationIntent, CloudInstallationRecord } from '../../../src/domain/ports/cloud-installation.port.js';

// Reconstructed native fields from the official ARM 2025-04-01 deployment,
// ManagedIdentity 2024-11-30, App 2026-01-01, ContainerRegistry 2025-11-01 and
// Authorization 2022-04-01 contracts. Values are synthetic. Resource responses
// below are authored independently of the submitted template body.
export const azurePreparedFixtureSubscription = '11111111-2222-4333-8444-555555555555';
export const azurePreparedFixtureTenant = '66666666-7777-4888-8999-000000000000';
export const azurePreparedFixtureGroup = `/subscriptions/${azurePreparedFixtureSubscription}/resourceGroups/sequence-staging`;
const subscription = `/subscriptions/${azurePreparedFixtureSubscription}`;
const ownerDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rolePermissions: Record<string, string[]> = {
  inspect: ['Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.App/managedEnvironments/read', 'Microsoft.App/containerApps/read',
    'Microsoft.ContainerRegistry/registries/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/read',
    'Microsoft.Authorization/roleAssignments/read', 'Microsoft.Authorization/roleDefinitions/read', 'Microsoft.Resources/deployments/read', 'Microsoft.Resources/deployments/operations/read'],
  provision: ['Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write', 'Microsoft.App/containerApps/delete'],
  release: ['Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write'],
  assign: ['Microsoft.ManagedIdentity/userAssignedIdentities/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'],
  join: ['Microsoft.App/managedEnvironments/read', 'Microsoft.App/managedEnvironments/join/action'],
  vault: ['Microsoft.KeyVault/vaults/read', 'Microsoft.Authorization/roleAssignments/read'],
};
export async function azurePreparedFixture(secret = false) {
  const holdingImage = `us-central1-docker.pkg.dev/holding-project/public/holding@sha256:${'a'.repeat(64)}`;
  const vault = `${subscription}/resourceGroups/collection-staging/providers/Microsoft.KeyVault/vaults/reviewed-secrets`;
  const intent: CloudInstallationIntent = { schemaVersion: 1, purpose: 'deployment', stage: 'deployment', mode: 'connect', provider: 'azure',
    installationId: '11111111-1111-4111-8111-111111111111', customerId: 'studio', appId: 'sequence', environment: 'staging', keys: [],
    source: { repository: 'github.com/studio/sequence', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
    nativeScope: { tenantId: azurePreparedFixtureTenant, subscriptionId: azurePreparedFixtureSubscription, resourceGroup: 'sequence-staging', location: 'eastus' },
    hostIdentity: { kind: 'gcp-service-account', projectId: 'hypercloud-host', projectNumber: '123456789012', serviceAccountEmail: 'writer@hypercloud-host.iam.gserviceaccount.com',
      subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
    deployment: { hostingProvider: 'azure-container-apps', region: 'eastus', preparation: { kind: 'holding-workloads', image: holdingImage },
      workloads: [{ name: 'web', kind: 'web', public: true, runtimeSecrets: secret ? [{ key: 'API_TOKEN', reference: { destination: {
        provider: 'azure-key-vault', tenantId: azurePreparedFixtureTenant, subscriptionId: azurePreparedFixtureSubscription,
        resourceGroup: 'collection-staging', vaultName: 'reviewed-secrets', secretName: 'api-token' }, version: 'b'.repeat(32) } }] : [] }] } };
  const owner = ownerDigest([intent.customerId, intent.appId, intent.environment, intent.installationId, intent.nativeScope]);
  const resources = new Map<string, any>([[subscription, { subscriptionId: azurePreparedFixtureSubscription, tenantId: azurePreparedFixtureTenant, state: 'Enabled' }],
    [`${subscription}/providers/Microsoft.Authorization/permissions`, { value: [{ actions: ['*'], notActions: [] }] }],
    ...['Microsoft.ManagedIdentity', 'Microsoft.App', 'Microsoft.ContainerRegistry'].map(namespace => [`${subscription}/providers/${namespace}`,
      { id: `${subscription}/providers/${namespace}`, namespace, registrationState: 'Registered' }] as [string, unknown])]);
  if (secret) resources.set(vault, { id: vault, location: 'eastus', systemData: { createdAt: '2025-01-01T00:00:00Z' },
    tags: { hypervibeCustomerId: 'studio', hypervibeAppId: 'sequence', hypervibeEnvironment: 'staging' },
    properties: { tenantId: azurePreparedFixtureTenant, enableRbacAuthorization: true, provisioningState: 'Succeeded' } });
  const events: Array<{ method: string; path: string; body?: any }> = [], records = new Map<string, CloudInstallationRecord>();
  let planned: CloudInstallationRecord | undefined;
  let sequence = 0;
  const find = (key: string) => planned!.plan.actions.find(action => action.metadata.native.key === key)!;
  const identityNumber: Record<string, number> = { provision: 1, release: 2, holding: 3, 'runtime-web': 4 };
  const principal = (purpose: string) => ({ tenantId: azurePreparedFixtureTenant,
    clientId: `${identityNumber[purpose]}1111111-1111-4111-8111-111111111111`, principalId: `${identityNumber[purpose]}2222222-2222-4222-8222-222222222222` });
  function responseFor(action: CloudInstallationAction, attemptId: string) {
    const n = action.metadata.native, id = String(n.resourceId), kind = n.kind, purpose = String(n.purpose ?? n.key), key = String(n.key);
    const common = { id, name: id.split('/').at(-1), location: 'eastus', tags: { hypervibeInstallation: intent.installationId, hypervibeDeployment: owner,
      hypervibePurpose: purpose, hypervibeAttempt: attemptId }, systemData: { createdAt: new Date().toISOString() } };
    if (kind === 'group') return { ...common, properties: { provisioningState: 'Succeeded' } };
    if (kind === 'identity') return { ...common, properties: principal(purpose) };
    if (kind === 'registry') return { ...common, sku: { name: 'Basic' }, properties: { provisioningState: 'Succeeded', adminUserEnabled: false, loginServer: `${id.split('/').at(-1)}.azurecr.io` } };
    if (kind === 'environment') return { ...common, properties: { provisioningState: 'Succeeded', appLogsConfiguration: { destination: 'none' }, zoneRedundant: false,
      workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }] } };
    if (kind === 'app') return { ...common, identity: { type: 'UserAssigned', userAssignedIdentities: {
      [String(find('identity:holding').metadata.native.resourceId)]: principal('holding') } }, properties: {
      managedEnvironmentId: String(find('environment').metadata.native.resourceId), workloadProfileName: 'Consumption', provisioningState: 'Succeeded', latestRevisionName: 'web--holding', latestReadyRevisionName: 'web--holding',
      configuration: { activeRevisionsMode: 'Single', ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false, fqdn: 'web.example.test' }, secrets: [], registries: [],
        identitySettings: [{ identity: String(find('identity:holding').metadata.native.resourceId), lifecycle: 'None' }] },
      template: { containers: [{ name: 'main', image: holdingImage, env: [], resources: { cpu: 0.25, memory: '0.5Gi' } }], scale: { minReplicas: 0, maxReplicas: 1 } } } };
    if (kind === 'federation') return { id, properties: { issuer: 'https://accounts.google.com', subject: intent.hostIdentity.subject, audiences: ['api://AzureADTokenExchange'] } };
    if (kind === 'role') return { id, properties: { type: 'CustomRole', description: `Hypervibe deployment ${owner}; ${ownerDigest(key)}`, assignableScopes: [subscription],
      permissions: [{ actions: rolePermissions[key.slice(5)], notActions: [], dataActions: [], notDataActions: [] }] } };
    if (kind === 'grant') {
      const parts = key.slice(6).split(':'), identity = parts[0];
      const role = parts[1] === 'pull' ? `${subscription}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d`
        : parts[1] === 'push' ? `${subscription}/providers/Microsoft.Authorization/roleDefinitions/8311e382-0749-4cb8-b61a-304f252e45ec`
        : identity.startsWith('runtime-') ? `${subscription}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`
        : String(find(`role:${parts[1] === 'app' ? identity : parts[1]}`).metadata.native.resourceId);
      return { id, properties: { principalId: principal(identity).principalId, principalType: 'ServicePrincipal', roleDefinitionId: role,
        scope: id.slice(0, id.lastIndexOf('/providers/Microsoft.Authorization/roleAssignments/')), description: `Hypervibe deployment ${owner}; ${ownerDigest(key)}` } };
    }
    throw new Error(`Unexpected synthetic native kind ${kind}`);
  }
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, method = init?.method ?? 'GET';
    if (url.hostname === 'artifactregistry.googleapis.com') return Response.json({ name: `projects/holding-project/locations/us-central1/repositories/public/dockerImages/holding@sha256:${'a'.repeat(64)}`, uri: holdingImage });
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'synthetic-private-arm-token', token_type: 'Bearer', expires_in: 3599 });
    events.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'PUT' && path.includes('/providers/Microsoft.Resources/deployments/')) {
      const body = JSON.parse(String(init?.body)), template = body.properties.template.resources;
      if (template.length !== 1 || body.properties.mode !== 'Incremental') throw new Error('Unexpected template shape');
      const item = template[0];
      const action = planned!.plan.actions.find(action => {
        const id = String(action.metadata.native.resourceId), expected = item.scope ? `${item.scope}/providers/${item.type}/${item.name}`
          : item.type === 'Microsoft.Resources/resourceGroups' ? `${subscription}/resourceGroups/${item.name}`
          : item.type === 'Microsoft.Authorization/roleDefinitions' ? `${subscription}/providers/${item.type}/${item.name}`
          : `${azurePreparedFixtureGroup}/providers/${item.type.split('/').slice(0, 2).join('/')}/${item.name.split('/')[0]}${item.type.split('/').length > 2 ? `/${item.type.split('/')[2]}/${item.name.split('/')[1]}` : ''}`;
        return id.toLowerCase() === expected.toLowerCase();
      });
      if (!action) throw new Error('Unexpected native target');
      const targetId = String(action.metadata.native.resourceId), attemptId = path.split('hv-').at(-1)!;
      const native = responseFor(action, attemptId); resources.set(targetId, native); sequence++;
      const acknowledgment = { id: path, name: `hv-${attemptId}`, type: 'Microsoft.Resources/deployments', systemData: { createdAt: new Date().toISOString() }, properties: {
        correlationId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence).padStart(12, '0')}`, templateHash: String(10000000000000000n + BigInt(sequence)), provisioningState: 'Succeeded', outputResources: [{ id: targetId }] } };
      resources.set(path, acknowledgment);
      const operationsPath = path.includes('/resourceGroups/') ? path.replace('/providers/Microsoft.Resources/deployments/', '/deployments/') : path;
      resources.set(`${operationsPath}/operations`, { value: [{ id: `${path}/operations/${sequence}`, operationId: String(sequence), properties: {
        provisioningOperation: 'Create', provisioningState: 'Succeeded', statusCode: 'Created', serviceRequestId: `request-${sequence}`,
        targetResource: { id: targetId, resourceType: item.type, resourceName: item.name, apiVersion: item.apiVersion } } }] });
      return Response.json(acknowledgment, { status: 201 });
    }
    if (method === 'DELETE') { resources.delete(path); return new Response(null, { status: 204 }); }
    const value = resources.get(path); return value ? Response.json(value) : Response.json({ error: { code: 'ResourceNotFound' } }, { status: 404 });
  });
  const driver = createAzureCloudInstallationDriver({ fetch: request as typeof fetch, holdingImage });
  const context: CloudInstallationContext = { driver, authorize: async () => true, authentication: {
    administrator: { getAccessToken: async () => 'synthetic-private-admin-token' }, host: { verifyIdentity: async () => intent.hostIdentity,
      getIdToken: async () => 'synthetic-google-assertion', getAccessToken: async () => 'synthetic-host-token' } }, store: {
    read: async id => records.has(id) ? structuredClone(records.get(id)!) : null,
    compareAndSwap: async (id, revision, next) => { if ((records.get(id)?.revision ?? null) !== revision) return false; records.set(id, structuredClone(next)); return true; } } };
  planned = await planCloudInstallationV1({ ...context, intent });
  const installed = await applyCloudInstallationV1({ ...context, installationId: planned.installationId, planDigest: planned.plan.digest, confirmActions: planned.plan.actions.map(action => action.id) });
  return { driver, context, intent, planned, installed, resources, events, request, records, principal };
}
