import { describe, expect, it, vi } from 'vitest';
import { createAzureCloudInstallationDriver } from '../../src/adapters/providers/azure/azure-cloud-installation.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1, cloudInstallationDisconnectionIntentV1 } from '../../src/application/hosted/cloud-installation.js';
import type { CloudInstallationAttempt, CloudInstallationContext, CloudInstallationIntent, CloudInstallationProviderContext, CloudInstallationRecord } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed serialized responses from Microsoft.Resources deployments and
// deploymentOperations 2025-04-01, not live evidence. Native operation statusCode
// describes the resource provider response; provisioningOperation=Create alone
// does not distinguish an upsert update. See docs/connect-cloud-azure-arm.md.
const subscriptionId = '11111111-2222-4333-8444-555555555555';
const tenantId = '66666666-7777-4888-8999-000000000000';
const subscription = `/subscriptions/${subscriptionId}`;
const group = `${subscription}/resourceGroups/sequence-staging`;
const attemptId = '22222222-2222-4222-8222-222222222222';
const deploymentId = `${subscription}/providers/Microsoft.Resources/deployments/hv-${attemptId}`;
const correlationId = '33333333-3333-4333-8333-333333333333';
const writer = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/writer-5317585673`;
const vault = `${group}/providers/Microsoft.KeyVault/vaults/secrets-5317585673`;
const role = `${subscription}/providers/Microsoft.Authorization/roleDefinitions/16e04075-4e28-5e9f-83a7-9b2f36ed0428`;
const grant = `${vault}/providers/Microsoft.Authorization/roleAssignments/4632693b-185f-5b24-8241-49de864f54dd`;
const federation = `${writer}/federatedIdentityCredentials/hypervibe`;
const scopeDigest = 'd43ab870d5a04a4c84796ba63612aaf6404e9a2669a2ebd9d55e0dcf3e58a74a';
const principalId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', clientId = 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd';
const intent: CloudInstallationIntent = { schemaVersion: 1, installationId: '11111111-1111-4111-8111-111111111111',
  customerId: 'studio', appId: 'sequence', environment: 'staging', provider: 'azure', mode: 'connect',
  source: { repository: 'github.com/studio/sequence', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  nativeScope: { tenantId, subscriptionId, resourceGroup: 'sequence-staging', location: 'eastus' }, keys: ['API_TOKEN'],
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hypercloud-host', projectNumber: '123456789012',
    serviceAccountEmail: 'writer@hypercloud-host.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' } };
const attempt: CloudInstallationAttempt = { id: attemptId, actionId: 'azure:group', status: 'attempted',
  startedAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z' };
const nativeDeployment = { id: deploymentId, name: `hv-${attemptId}`, type: 'Microsoft.Resources/deployments', location: 'eastus',
  systemData: { createdAt: '2026-10-24T00:00:01Z' }, properties: { correlationId, templateHash: '18346877510509467325',
    provisioningState: 'Succeeded', outputResources: [{ id: group }] } };
const nativeOperation = { id: `${deploymentId}/operations/08586107869300282847`, operationId: '08586107869300282847',
  properties: { provisioningOperation: 'Create', provisioningState: 'Succeeded', statusCode: 'Created',
    serviceRequestId: '44444444-4444-4444-8444-444444444444', timestamp: '2026-10-24T00:00:02Z',
    targetResource: { id: group, resourceType: 'Microsoft.Resources/resourceGroups', resourceName: 'sequence-staging', apiVersion: '2022-09-01' } } };
function fixture(collection = false, migration = false) {
  const selectedVault = migration ? `${group}/providers/Microsoft.KeyVault/vaults/legacy-app-vault` : vault;
  const selectedGrant = migration ? `${selectedVault}/providers/Microsoft.Authorization/roleAssignments/4632693b-185f-5b24-8241-49de864f54dd` : grant;
  const resources = new Map<string, unknown>([
    [subscription, { subscriptionId, tenantId, state: 'Enabled' }],
    [`${subscription}/providers/Microsoft.Authorization/permissions`, { value: [{ actions: ['*'], notActions: [] }] }],
    ...['Microsoft.ManagedIdentity', 'Microsoft.KeyVault'].map(namespace => [`${subscription}/providers/${namespace}`,
      { id: `${subscription}/providers/${namespace}`, namespace, registrationState: 'Registered' }] as [string, unknown]),
  ]);
  const operations = [structuredClone(nativeOperation)];
  const nativeOperations = new Map<string, unknown>();
  let loseAcknowledgment = false;
  let rejectGrant = false;
  const events: Array<{ method: string; path: string; body?: any }> = [];
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET';
    if (new URL(String(url)).hostname === 'login.microsoftonline.com') return Response.json({ token_type: 'Bearer', expires_in: 3599, access_token: 'synthetic-writer-token' });
    events.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (collection && method === 'PUT' && /\/providers\/Microsoft.Resources\/deployments\/hv-/.test(path)) {
      const template = JSON.parse(String(init!.body)).properties.template;
      expect(template.resources).toHaveLength(1);
      const target = template.resources[0], attemptedId = path.split('/hv-').at(-1)!;
      if (rejectGrant && target.type === 'Microsoft.Authorization/roleAssignments') return Response.json({ error: { code: 'AuthorizationFailed' } }, { status: 403 });
      const owner = `Hypervibe installation ${intent.installationId}; scope ${scopeDigest}`;
      const tags = { hypervibeInstallation: intent.installationId, hypervibeScope: scopeDigest, hypervibeAttempt: attemptedId,
        hypervibeCustomerId: 'studio', hypervibeAppId: 'sequence', hypervibeEnvironment: 'staging' };
      const native: Record<string, any> = {
        'Microsoft.Resources/resourceGroups': { id: group, location: 'eastus', tags, properties: { provisioningState: 'Succeeded' } },
        'Microsoft.ManagedIdentity/userAssignedIdentities': { id: writer, location: 'eastus', tags, properties: { tenantId, clientId, principalId } },
        'Microsoft.KeyVault/vaults': { id: vault, location: 'eastus', tags, systemData: { createdAt: new Date().toISOString() },
          properties: { tenantId, vaultUri: 'https://secrets-5317585673.vault.azure.net/', enableRbacAuthorization: true, enableSoftDelete: true,
            enablePurgeProtection: true, softDeleteRetentionInDays: 90, sku: { family: 'A', name: 'standard' }, provisioningState: 'Succeeded' } },
        'Microsoft.Authorization/roleDefinitions': { id: role, properties: { type: 'CustomRole', description: owner, assignableScopes: [group], permissions: [{
          actions: ['Microsoft.KeyVault/vaults/read'], notActions: [], dataActions: ['Microsoft.KeyVault/vaults/secrets/readMetadata/action', 'Microsoft.KeyVault/vaults/secrets/setSecret/action'], notDataActions: [] }] } },
        'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials': { id: federation, properties: { issuer: 'https://accounts.google.com', subject: '123456789012345678901', audiences: ['api://AzureADTokenExchange'] } },
        'Microsoft.Authorization/roleAssignments': { id: selectedGrant, properties: { principalId, principalType: 'ServicePrincipal', roleDefinitionId: role, scope: selectedVault, description: owner } },
      };
      const value = native[target.type]; expect(value).toBeDefined(); resources.set(value.id, value);
      const envelope = { ...nativeDeployment, id: path, name: `hv-${attemptedId}`, systemData: { createdAt: new Date().toISOString() },
        properties: { ...nativeDeployment.properties, outputResources: [{ id: value.id }] } };
      resources.set(path, envelope);
      const operationPath = path.startsWith(`${group}/`) ? path.replace('/providers/Microsoft.Resources/deployments/', '/deployments/') : path;
      nativeOperations.set(`${operationPath}/operations`, { value: [{ ...nativeOperation, id: `${path}/operations/08586107869300282847`,
        properties: { ...nativeOperation.properties, targetResource: { id: value.id, resourceType: target.type, resourceName: target.name, apiVersion: target.apiVersion } } }] });
      if (loseAcknowledgment) throw new Error('synthetic-admin-token');
      return Response.json(envelope, { status: 201 });
    }
    if (method === 'DELETE') { resources.delete(path); return new Response(null, { status: 204 }); }
    if (nativeOperations.has(path)) return Response.json(nativeOperations.get(path));
    if (method === 'PUT' && path === deploymentId) {
      resources.set(deploymentId, structuredClone(nativeDeployment));
      resources.set(group, { id: group, location: 'eastus', properties: { provisioningState: 'Succeeded' },
        tags: { hypervibeInstallation: intent.installationId, hypervibeScope: 'd43ab870d5a04a4c84796ba63612aaf6404e9a2669a2ebd9d55e0dcf3e58a74a', hypervibeAttempt: attemptId } });
      if (loseAcknowledgment) throw new Error('synthetic-admin-token');
      return Response.json(nativeDeployment, { status: 201 });
    }
    if (path === `${deploymentId}/operations`) return Response.json({ value: operations });
    const value = resources.get(path);
    return value instanceof Response ? value : value ? Response.json(value) : Response.json({ error: { code: 'ResourceNotFound' } }, { status: 404 });
  });
  const context: CloudInstallationProviderContext = { intent, completed: {}, signal: new AbortController().signal,
    beforeMutation: vi.fn(async () => {}), authentication: {
      administrator: { getAccessToken: async () => 'synthetic-admin-token' }, host: { verifyIdentity: async () => intent.hostIdentity,
        getIdToken: async () => 'synthetic-google-token', getAccessToken: async () => 'synthetic-host-token' } } };
  if (migration) {
    context.intent = { ...intent, mode: 'migrate', migrationTargets: [{ key: 'API_TOKEN', destination: { provider: 'azure-key-vault',
      tenantId, subscriptionId, resourceGroup: 'sequence-staging', vaultName: 'legacy-app-vault', secretName: 'existing-key' } }] };
    resources.set(group, { id: group, location: 'eastus', properties: { provisioningState: 'Succeeded' } });
    resources.set(`${group}/providers/Microsoft.Authorization/permissions`, { value: [{ actions: ['*'], notActions: ['Microsoft.KeyVault/vaults/write'] }] });
    resources.set(selectedVault, { id: selectedVault, location: 'eastus', systemData: { createdAt: '2025-01-01T00:00:00Z' },
      tags: { hypervibeCustomerId: 'studio', hypervibeAppId: 'sequence', hypervibeEnvironment: 'staging', customerTag: 'keep' },
      properties: { tenantId, vaultUri: 'https://legacy-app-vault.vault.azure.net/', enableRbacAuthorization: true, enablePurgeProtection: false,
        softDeleteRetentionInDays: 30, provisioningState: 'Succeeded' } });
  }
  return { context, request, resources, operations, events, loseAck: () => { loseAcknowledgment = true; }, rejectGrant: () => { rejectGrant = true; },
    driver: createAzureCloudInstallationDriver({ fetch: request as typeof fetch }) };
}

function hosted(f: ReturnType<typeof fixture>) {
  const records = new Map<string, CloudInstallationRecord>();
  const context: CloudInstallationContext = { driver: f.driver, authentication: f.context.authentication, authorize: async () => true,
    store: { read: async id => records.has(id) ? structuredClone(records.get(id)!) : null,
      compareAndSwap: async (id, revision, next) => {
        if ((records.get(id)?.revision ?? null) !== revision) return false;
        records.set(id, structuredClone(next)); return true;
      } } };
  return { context, records };
}

describe('Azure reviewed exclusive namespace through ARM deployment provenance', () => {
  it('reviews an absent namespace without pretending ARM provides atomic create', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context);
    expect(plan.blockedReason).toBeUndefined();
    expect(plan.review.warnings.join(' ')).toMatch(/exclusive/i);
    expect(plan.review.warnings.join(' ')).toMatch(/concurrent.*overwrite/i);
    expect(plan.actions.every(action => action.verified)).toBe(true);
    expect(f.events.every(event => event.method === 'GET')).toBe(true);
  });
  it('records native deployment provenance and verifies the exact completed resource operation', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context), action = plan.actions.find(item => item.id === 'azure:group')!;
    const result = await f.driver.mutate({ ...f.context, action, attempt });
    expect(result.state).toBe('acknowledged');
    if (result.state !== 'acknowledged' || !result.evidence) throw new Error('Missing native acknowledgment');
    expect(result.evidence.native.deployment).toMatchObject({ id: deploymentId, correlationId });
    const recovered = await f.driver.recover({ ...f.context, action, attempt: { ...attempt, status: 'acknowledged', evidence: result.evidence } });
    expect(recovered.state).toBe('satisfied');
    expect(f.events.filter(event => event.method !== 'GET')).toEqual([expect.objectContaining({ method: 'PUT', path: deploymentId,
      body: expect.objectContaining({ properties: expect.objectContaining({ mode: 'Incremental', template: expect.objectContaining({ resources: [expect.objectContaining({ type: 'Microsoft.Resources/resourceGroups', name: 'sequence-staging' })] }) }) }) })]);
    expect(JSON.stringify(recovered)).not.toContain('synthetic-admin-token');
  });
  it('does not infer ownership from a same-name deployment after its acknowledgment is lost', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context), action = plan.actions.find(item => item.id === 'azure:group')!;
    f.loseAck();
    expect(await f.driver.mutate({ ...f.context, action, attempt })).toMatchObject({ state: 'uncertain' });
    expect(await f.driver.recover({ ...f.context, action, attempt: { ...attempt, status: 'uncertain' } })).toMatchObject({ state: 'unknown' });
    expect(f.events.filter(event => event.method !== 'GET')).toHaveLength(1);
  });
  it('records the actual upsert race: an unexpected update is not adopted or cleaned up', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context), action = plan.actions.find(item => item.id === 'azure:group')!;
    // Another authorized actor creates this exact ID after our absent read.
    // ARM can already have overwritten it. The later receipt is a veto, not a fence.
    f.operations[0].properties.statusCode = 'OK';
    const result = await f.driver.mutate({ ...f.context, action, attempt });
    expect(result.state).toBe('acknowledged');
    if (result.state !== 'acknowledged') throw new Error('Missing native acknowledgment');
    expect(await f.driver.recover({ ...f.context, action, attempt: { ...attempt, status: 'acknowledged', evidence: result.evidence } }))
      .toMatchObject({ state: 'conflict', reason: 'ownership_mismatch' });
    expect(f.events.filter(event => event.method !== 'GET')).toHaveLength(1);
  });
  it('completes a new collection through durable shared plan/apply and only disconnects hosted trust', async () => {
    const f = fixture(true), h = hosted(f);
    const planned = await planCloudInstallationV1({ ...h.context, intent });
    expect(planned.status).toBe('review-required');
    const applied = await applyCloudInstallationV1({ ...h.context, installationId: planned.installationId, planDigest: planned.plan.digest,
      confirmActions: planned.plan.actions.map(action => action.id) });
    expect(applied).toMatchObject({ status: 'ready', reason: undefined });
    expect(applied.attempts).toHaveLength(6);
    expect(f.driver.connections(applied)).toMatchObject([{ key: 'API_TOKEN', writerAuthorization: { clientId, principalId, identityResourceId: writer } }]);
    const writesBefore = f.events.filter(event => event.method !== 'GET').length;
    expect((await reconcileCloudInstallationV1({ ...h.context, installationId: planned.installationId, planDigest: planned.plan.digest })).status).toBe('ready');
    expect(f.events.filter(event => event.method !== 'GET')).toHaveLength(writesBefore);
    f.resources.set(`${group}/providers/Microsoft.Authorization/permissions`, { value: [{ actions: ['*'], notActions: [] }] });
    const cleanup = await planCloudInstallationV1({ ...h.context, intent: { ...intent, installationId: '55555555-5555-4555-8555-555555555555',
      mode: 'disconnect', installed: Object.values(applied.completed) } });
    const disconnected = await applyCloudInstallationV1({ ...h.context, installationId: cleanup.installationId, planDigest: cleanup.plan.digest,
      confirmActions: cleanup.plan.actions.map(action => action.id) });
    expect(disconnected.status).toBe('disconnected');
    expect(f.events.filter(event => event.method === 'DELETE').map(event => event.path)).toEqual([grant, federation]);
    expect(f.resources.has(vault)).toBe(true); expect(f.resources.has(writer)).toBe(true);
    expect(f.events.every(event => !event.path.includes('/secrets/') || event.method === 'GET')).toBe(true);
  });
  it.each(['missing status', 'wrong correlation', 'duplicate target', 'changed target', 'partial operation list'])('retains %s as unresolved without new writes', async variant => {
    const f = fixture(), plan = await f.driver.plan(f.context), action = plan.actions.find(item => item.id === 'azure:group')!;
    const result = await f.driver.mutate({ ...f.context, action, attempt });
    if (result.state !== 'acknowledged') throw new Error('Missing native acknowledgment');
    if (variant === 'missing status') delete (f.operations[0].properties as Record<string, unknown>).statusCode;
    if (variant === 'wrong correlation') f.resources.set(deploymentId, { ...nativeDeployment, properties: { ...nativeDeployment.properties, correlationId: principalId } });
    if (variant === 'duplicate target') f.operations.push(structuredClone(f.operations[0]));
    if (variant === 'changed target') f.operations[0].properties.targetResource.id = `${group}-other`;
    if (variant === 'partial operation list') f.operations.splice(0);
    expect((await f.driver.recover({ ...f.context, action, attempt: { ...attempt, status: 'acknowledged', evidence: result.evidence } })).state).not.toBe('satisfied');
    expect(f.events.filter(event => event.method !== 'GET')).toHaveLength(1);
  });
  it('never stores a credential echo even when it has a syntactically valid native GUID shape', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context), action = plan.actions.find(item => item.id === 'azure:group')!;
    f.context.authentication.administrator!.getAccessToken = async () => correlationId;
    const outcome = await f.driver.mutate({ ...f.context, action, attempt });
    expect(outcome).toEqual({ state: 'uncertain', reason: 'identity_mismatch' });
    expect(JSON.stringify(outcome)).not.toContain(correlationId);
  });
  it('pins the exact completed child operation instead of accepting rewritten deployment history', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context), action = plan.actions.find(item => item.id === 'azure:group')!;
    const written = await f.driver.mutate({ ...f.context, action, attempt });
    if (written.state !== 'acknowledged') throw new Error('Missing native acknowledgment');
    const first = await f.driver.recover({ ...f.context, action, attempt: { ...attempt, status: 'acknowledged', evidence: written.evidence } });
    if (first.state !== 'satisfied') throw new Error('Missing completed operation');
    f.operations[0].properties.serviceRequestId = principalId;
    expect(await f.driver.recover({ ...f.context, action, attempt: { ...attempt, status: 'succeeded', evidence: first.evidence } }))
      .toMatchObject({ state: 'conflict', reason: 'identity_mismatch' });
  });
  it('rejects a newly created resource whose observed region differs from the approved template', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context), action = plan.actions.find(item => item.id === 'azure:group')!;
    const written = await f.driver.mutate({ ...f.context, action, attempt });
    if (written.state !== 'acknowledged') throw new Error('Missing native acknowledgment');
    f.resources.set(group, { ...(f.resources.get(group) as object), location: 'westus' });
    expect(await f.driver.recover({ ...f.context, action, attempt: { ...attempt, status: 'acknowledged', evidence: written.evidence } }))
      .toMatchObject({ state: 'conflict', reason: 'identity_mismatch' });
  });
  it('checks subscription deployment recovery permissions before any migration resources are written', async () => {
    const f = fixture(true, true);
    f.resources.set(`${subscription}/providers/Microsoft.Authorization/permissions`, { value: [{ actions: [
      'Microsoft.Resources/deployments/write', 'Microsoft.Authorization/roleDefinitions/write'], notActions: [] }] });
    await expect(f.driver.plan(f.context)).rejects.toThrow('insufficient_permissions');
    expect(f.events.every(event => event.method === 'GET')).toBe(true);
  });
  it('revalidates source authority after native prerequisite reads and before the deployment PUT', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context), action = plan.actions.find(item => item.id === 'azure:group')!;
    f.context.beforeMutation = async () => { throw new Error('authorization_revoked'); };
    expect(await f.driver.mutate({ ...f.context, action, attempt })).toEqual({ state: 'rejected', reason: 'authorization_revoked' });
    expect(f.events.every(event => event.method === 'GET')).toBe(true);
  });
  it('keeps a lost acknowledgment pending across a new driver and never retries the native upsert', async () => {
    const f = fixture(true), h = hosted(f), planned = await planCloudInstallationV1({ ...h.context, intent }); f.loseAck();
    const input = { ...h.context, installationId: planned.installationId, planDigest: planned.plan.digest,
      confirmActions: planned.plan.actions.map(action => action.id) };
    expect((await applyCloudInstallationV1(input)).status).toBe('pending');
    expect((await applyCloudInstallationV1({ ...input, driver: createAzureCloudInstallationDriver({ fetch: f.request as typeof fetch }) })).status).toBe('pending');
    expect(f.events.filter(event => event.method !== 'GET')).toHaveLength(1);
  });
  it('migrates writer trust through native deployments while preserving the existing vault and target names', async () => {
    const f = fixture(true, true), h = hosted(f), existing = structuredClone(f.resources.get(`${group}/providers/Microsoft.KeyVault/vaults/legacy-app-vault`));
    const planned = await planCloudInstallationV1({ ...h.context, intent: f.context.intent });
    const result = await applyCloudInstallationV1({ ...h.context, installationId: planned.installationId, planDigest: planned.plan.digest,
      confirmActions: planned.plan.actions.map(action => action.id) });
    expect(result).toMatchObject({ status: 'ready', reason: undefined });
    expect(f.resources.get(`${group}/providers/Microsoft.KeyVault/vaults/legacy-app-vault`)).toEqual(existing);
    expect(f.events.filter(event => event.method === 'PUT').map(event => event.body.properties.template.resources[0].type))
      .toEqual(expect.arrayContaining(['Microsoft.ManagedIdentity/userAssignedIdentities', 'Microsoft.Authorization/roleDefinitions',
        'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials', 'Microsoft.Authorization/roleAssignments']));
    expect(f.events.filter(event => event.method === 'PUT')).toHaveLength(4);
    expect(f.driver.connections(result)[0].destination).toMatchObject({ vaultName: 'legacy-app-vault', secretName: 'existing-key' });
  });
  it('disconnects exactly the completed federation after a definitely rejected writer grant', async () => {
    const f = fixture(true), h = hosted(f); f.rejectGrant();
    const planned = await planCloudInstallationV1({ ...h.context, intent });
    const partial = await applyCloudInstallationV1({ ...h.context, installationId: planned.installationId, planDigest: planned.plan.digest,
      confirmActions: planned.plan.actions.map(action => action.id) });
    expect(partial).toMatchObject({ status: 'blocked', reason: 'insufficient_permissions' });
    expect(partial.completed['azure:federation']).toBeDefined(); expect(partial.completed['azure:grant']).toBeUndefined();
    const cleanupIntent = cloudInstallationDisconnectionIntentV1(partial, f.driver, '55555555-5555-4555-8555-555555555555');
    if (!cleanupIntent) throw new Error('Completed federation needs cleanup');
    f.resources.set(`${group}/providers/Microsoft.Authorization/permissions`, { value: [{ actions: ['*'], notActions: [] }] });
    const cleanup = await planCloudInstallationV1({ ...h.context, intent: cleanupIntent });
    expect(cleanup.plan.actions.map(action => action.id)).toEqual(['azure:federation']);
    const result = await applyCloudInstallationV1({ ...h.context, installationId: cleanup.installationId, planDigest: cleanup.plan.digest,
      confirmActions: cleanup.plan.actions.map(action => action.id) });
    expect(result.status).toBe('disconnected');
    expect(f.events.filter(event => event.method === 'DELETE').map(event => event.path)).toEqual([federation]);
    expect(f.resources.has(vault)).toBe(true); expect(f.resources.has(writer)).toBe(true);
  });
});
