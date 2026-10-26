import { DefaultAzureCredential } from '@azure/identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { IStorageAdapter } from '../../../../domain/ports/storage.port.js';
import type { StorageRuntimeAccessTarget } from '../../../../domain/ports/storage-runtime-access.port.js';
import { AzureBlobStorageAdapter } from '../azure-blob.adapter.js';

// Reconstructed Azure REST responses, real ARM transport serialization. No live
// RBAC propagation or application SDK acceptance is claimed by these fixtures.
// https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/create?view=rest-authorization-2022-04-01
// https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/delete-by-id?view=rest-authorization-2022-04-01
// https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/storage#storage-blob-data-contributor
const subscriptionId = '22222222-2222-4222-8222-222222222222';
const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '33333333-3333-4333-8333-333333333333';
const callerId = '44444444-4444-4444-8444-444444444444';
const resourceGroupId = `/subscriptions/${subscriptionId}/resourceGroups/production`;
const accountId = `${resourceGroupId}/providers/Microsoft.Storage/storageAccounts/hvdocuments`;
const externalId = `${accountId}/blobServices/default/containers/documents`;
const appId = `${resourceGroupId}/providers/Microsoft.App/containerApps/web`;
const managedEnvironmentId = `${resourceGroupId}/providers/Microsoft.App/managedEnvironments/runtime`;
const roleDefinitionId = `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe`;
const identityResourceId = `${resourceGroupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime-web`;
const runtimeClientId = '66666666-6666-4666-8666-666666666666';
let userIdentity: any;
const attemptId = '55555555-5555-4555-8555-555555555555';
let environment: Environment;
let target: StorageRuntimeAccessTarget;
let assignment: any;
let app: any;
let failRead: boolean;
let lostWrite: boolean;
let retainedDelete: boolean;
let accountOwner: string;
let accountName: string;
let containerName: string;
let calls: Array<{ method: string; path: string; body?: any }>;

beforeEach(() => {
  environment = { id: 'production-id', projectId: 'project-id', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'azure-container-apps', projectId: resourceGroupId, environmentId: managedEnvironmentId, services: { web: { serviceId: appId } } } };
  target = { environment, serviceName: 'web', storageName: 'documents', externalId, context: { subscriptionId, resourceGroup: 'production' }, identity: { provider: 'azure', principal: principalId, source: 'observed', scope: { tenantId, subscriptionId, serviceName: 'web', workloadResource: appId, environmentId: environment.id } } };
  app = { id: appId, identity: { type: 'SystemAssigned', principalId, tenantId }, tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': environment.id }, properties: { environmentId: managedEnvironmentId, configuration: {} } };
  userIdentity = undefined;
  assignment = undefined; failRead = false; lostWrite = false; retainedDelete = false; accountOwner = environment.id; accountName = 'hvdocuments'; containerName = 'documents'; calls = [];
  const payload = Buffer.from(JSON.stringify({ oid: callerId, tid: tenantId, scp: 'user_impersonation' })).toString('base64url');
  vi.spyOn(DefaultAzureCredential.prototype, 'getToken').mockResolvedValue({ token: `header.${payload}.signature`, expiresOnTimestamp: Date.now() + 3_600_000 });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });
    if (path === `/subscriptions/${subscriptionId}`) return Response.json({ subscriptionId, tenantId, state: 'Enabled' });
    if (path === accountId) return Response.json({ id: accountId, name: accountName, location: 'canadacentral', tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': accountOwner, 'hypervibe-storage-name': 'documents' } });
    if (path === externalId) return Response.json({ id: externalId, name: containerName, properties: { publicAccess: 'None' } });
    if (path === appId) return Response.json(app);
    if (path === identityResourceId) return Response.json(userIdentity);
    if (!path.startsWith(`${externalId}/providers/Microsoft.Authorization/roleAssignments/`)) throw new Error('Unexpected provider operation');
    if (method === 'GET' && failRead) return Response.json({ error: { code: 'AuthorizationFailed' } }, { status: 403 });
    if (method === 'PUT') {
      expect(body.properties).toMatchObject({ principalId, principalType: 'ServicePrincipal', roleDefinitionId });
      assignment = { id: path, name: path.split('/').at(-1), type: 'Microsoft.Authorization/roleAssignments', properties: { principalId, principalType: 'ServicePrincipal', roleDefinitionId, scope: externalId, description: body.properties.description } };
      if (lostWrite) throw new Error('Connection lost after provider commit');
      return Response.json(assignment, { status: 201 });
    }
    if (method === 'DELETE') {
      if (!retainedDelete) assignment = undefined;
      return new Response(null, { status: 204 });
    }
    return assignment ? Response.json(assignment) : Response.json({ error: { code: 'RoleAssignmentNotFound' } }, { status: 404 });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function connected(): Promise<IStorageAdapter> {
  const adapter = new AzureBlobStorageAdapter();
  await adapter.connect({ authMode: 'default', subscriptionId, tenantId });
  return adapter;
}
const writes = () => calls.filter(call => call.method !== 'GET');

describe('Azure container-scoped workload Blob access', () => {
  it.each(['ready', 'unavailable', 'replaced'] as const)('checks the current user-assigned identity and container availability: %s', async state => {
    const adapter = await connected();
    target.identity.scope.identityResourceId = identityResourceId;
    target.identity.scope.clientId = runtimeClientId;
    userIdentity = { id: identityResourceId, properties: { principalId, clientId: runtimeClientId, tenantId }, systemData: { createdAt: '2026-10-01T00:00:00Z' } };
    environment.platformBindings.runtimeIdentities = { web: { provider: 'azure-container-apps', evidence: {
      kind: 'user', workloadId: appId, identityId: identityResourceId, principalId, clientId: runtimeClientId,
      createdAt: userIdentity.systemData.createdAt, tenantId, subscriptionId, environmentId: environment.id, serviceName: 'web',
    } } };
    app.identity = { type: 'UserAssigned', userAssignedIdentities: { [identityResourceId]: { principalId, clientId: runtimeClientId } } };
    app.properties.configuration.identitySettings = [{ identity: identityResourceId, lifecycle: state === 'unavailable' ? 'None' : 'Main' }];
    if (state === 'replaced') userIdentity.systemData.createdAt = '2026-10-02T00:00:00Z';
    const grant = await adapter.runtimeAccess!.grant(target, attemptId);
    expect(grant.receipt.success).toBe(state === 'ready');
    if (state === 'ready') {
      const vars = await adapter.getRuntimeEnv(environment, target.context, externalId, 'documents', { hostingProvider: 'azure-container-apps', identity: target.identity, serviceName: 'web', runtimeAccessBinding: grant.binding });
      expect(vars).toMatchObject({ AZURE_CLIENT_ID: runtimeClientId, AZURE_STORAGE_CONNECTION_STRING: '' });
    } else expect(writes()).toEqual([]);
  });

  it('grants exact container access, verifies ownership and exports no account key', async () => {
    const adapter = await connected();
    expect(await adapter.runtimeAccess!.observe(target)).toEqual({ state: 'absent' });
    const grant = await adapter.runtimeAccess!.grant(target, attemptId);
    expect(grant).toMatchObject({ receipt: { success: true }, binding: { attemptId } });
    expect(writes()).toHaveLength(1);
    expect(writes()[0].path).toMatch(new RegExp('/containers/documents/providers/Microsoft.Authorization/roleAssignments/[a-f0-9-]{36}$'));
    expect(await adapter.runtimeAccess!.observe(target, grant.binding)).toMatchObject({ state: 'present', binding: grant.binding });
    const vars = await adapter.getRuntimeEnv(environment, target.context, externalId, 'documents', { hostingProvider: 'azure-container-apps', connectionProvider: 'azure-container-apps', identity: target.identity, serviceName: target.serviceName, runtimeAccessBinding: grant.binding });
    expect(vars).toMatchObject({ OBJECT_STORAGE_PROVIDER: 'azureblob', AZURE_STORAGE_ACCOUNT_NAME: 'hvdocuments', AZURE_STORAGE_CONTAINER_NAME: 'documents', AZURE_STORAGE_BLOB_ENDPOINT: 'https://hvdocuments.blob.core.windows.net', AZURE_STORAGE_CONNECTION_STRING: '' });
    expect(calls.some(call => call.path.endsWith('/listKeys'))).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it('does not turn env projection into an implicit IAM grant', async () => {
    const adapter = await connected();
    await expect(adapter.getRuntimeEnv(environment, target.context, externalId, 'documents', { hostingProvider: 'azure-container-apps', identity: target.identity })).rejects.toThrow(/access|grant|permission/i);
    expect(writes()).toEqual([]);
  });

  it('requires the recorded approved binding even when an owned assignment is discoverable', async () => {
    const adapter = await connected();
    await adapter.runtimeAccess!.grant(target, attemptId);
    await expect(adapter.getRuntimeEnv(environment, target.context, externalId, 'documents', { hostingProvider: 'azure-container-apps', identity: target.identity, serviceName: target.serviceName })).rejects.toThrow(/approved access binding/);
    expect(writes()).toHaveLength(1);
  });

  it('recovers only the persisted attempt after a lost creation response', async () => {
    const adapter = await connected();
    lostWrite = true;
    expect((await adapter.runtimeAccess!.grant(target, attemptId)).receipt.success).toBe(false);
    const recovered = await adapter.runtimeAccess!.grant(target, attemptId);
    expect(recovered).toMatchObject({ receipt: { success: true }, binding: { attemptId } });
    expect(writes()).toHaveLength(1);
    expect((await adapter.runtimeAccess!.grant(target, callerId)).receipt.success).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it.each(['principal', 'scope', 'role', 'marker'] as const)('blocks an assignment with changed %s before revoke', async change => {
    const adapter = await connected();
    const grant = await adapter.runtimeAccess!.grant(target, attemptId);
    if (change === 'principal') assignment.properties.principalId = callerId;
    if (change === 'scope') assignment.properties.scope = accountId;
    if (change === 'role') assignment.properties.roleDefinitionId = roleDefinitionId.replace('ba92f5b4', 'aaaaaaaa');
    if (change === 'marker') assignment.properties.description = 'not-owned';
    expect(await adapter.runtimeAccess!.observe(target, grant.binding)).toMatchObject({ state: 'unknown' });
    expect(await adapter.runtimeAccess!.revoke(target, grant.binding!)).toMatchObject({ success: false });
    expect(writes()).toHaveLength(1);
  });

  it('keeps authorization failures unknown without a create', async () => {
    const adapter = await connected(); failRead = true;
    expect(await adapter.runtimeAccess!.observe(target)).toMatchObject({ state: 'unknown' });
    expect((await adapter.runtimeAccess!.grant(target, attemptId)).receipt.success).toBe(false);
    expect(writes()).toEqual([]);
  });

  it.each(['scope', 'owner', 'caller', 'changed-workload', 'account-name', 'container-name'] as const)('rejects %s mismatch without copying credentials or granting access', async change => {
    const adapter = await connected();
    if (change === 'scope') target.identity.scope.environmentId = 'staging-id';
    if (change === 'owner') accountOwner = 'staging-id';
    if (change === 'caller') { target.identity.principal = callerId; app.identity.principalId = callerId; }
    if (change === 'changed-workload') app.identity.principalId = callerId;
    if (change === 'account-name') accountName = 'differentaccount';
    if (change === 'container-name') containerName = 'another-container';
    expect(await adapter.runtimeAccess!.observe(target)).toMatchObject({ state: 'unknown' });
    expect((await adapter.runtimeAccess!.grant(target, attemptId)).receipt.success).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('removes only its exact owned assignment and verifies terminal absence', async () => {
    const adapter = await connected();
    const grant = await adapter.runtimeAccess!.grant(target, attemptId);
    expect(await adapter.runtimeAccess!.revoke(target, grant.binding!)).toMatchObject({ success: true });
    expect(await adapter.runtimeAccess!.revoke(target, grant.binding!)).toMatchObject({ success: true });
    expect(writes().map(call => call.method)).toEqual(['PUT', 'DELETE']);
  });

  it('does not claim revoked access on an acknowledged but retained assignment', async () => {
    const adapter = await connected();
    const grant = await adapter.runtimeAccess!.grant(target, attemptId);
    retainedDelete = true;
    expect(await adapter.runtimeAccess!.revoke(target, grant.binding!)).toMatchObject({ success: false });
  });
});
