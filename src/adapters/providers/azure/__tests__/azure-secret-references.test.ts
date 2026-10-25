import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../db/repositories/service.repository.js';
import { RunRepository } from '../../../db/repositories/run.repository.js';
import { executeBootstrap } from '../../../../domain/services/bootstrap.service.js';
import { specToBootstrapParams } from '../../../../domain/spec/spec-bootstrap.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { adapterFactory } from '../../../../domain/services/adapter.factory.js';
import { syncHostingEnvVars } from '../../../../domain/services/hosting-env.service.js';
import type { IHostingAdapter } from '../../../../domain/ports/hosting.port.js';
import { AzureContainerAppsAdapter } from '../azure-container-apps.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

// Synthetic real ARM transport: Secret.keyVaultUrl + identity and EnvVar.secretRef.
// https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/update
const tenantId = '11111111-1111-4111-8111-111111111111';
const subscriptionId = '22222222-2222-4222-8222-222222222222';
const group = `/subscriptions/${subscriptionId}/resourceGroups/staging`;
const managedEnvironment = `${group}/providers/Microsoft.App/managedEnvironments/staging`;
const appId = `${group}/providers/Microsoft.App/containerApps/web`;
const reference = { destination: { provider: 'azure-key-vault', tenantId, subscriptionId, resourceGroup: 'secrets', vaultName: 'credential-vault', secretName: 'api-token' }, version: 'a'.repeat(32) };
const url = 'https://credential-vault.vault.azure.net/secrets/api-token/' + reference.version;
const now = new Date();
const service: Service = { id: 'service', projectId: 'project', name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: now, updatedAt: now };
const environment: Environment = { id: 'environment', projectId: 'project', name: 'staging', createdAt: now, updatedAt: now, platformBindings: { provider: 'azure-container-apps', projectId: group, environmentId: managedEnvironment, services: { web: { serviceId: appId } } } };
async function fixture(options: { opaque?: boolean; corrupt?: boolean; environmentId?: string; preparedReader?: boolean; deployment?: boolean } = {}) {
  const adapter = new AzureContainerAppsAdapter();
  await adapter.connect({ tenantId, subscriptionId, clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'synthetic' });
  let revision = 1;
  const existingSecret = { name: 'existing-ref', keyVaultUrl: 'https://credential-vault.vault.azure.net/secrets/existing/' + 'b'.repeat(32), identity: 'system' };
  let live: any = { id: appId, name: 'web', location: 'canadacentral', identity: { type: 'SystemAssigned', principalId: '44444444-4444-4444-8444-444444444444' }, tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': environment.id }, properties: { managedEnvironmentId: managedEnvironment, provisioningState: 'Succeeded', latestRevisionName: 'rev-1', latestReadyRevisionName: 'rev-1', configuration: { secrets: [existingSecret], ingress: { fqdn: 'app.example.test' } }, template: { containers: [{ name: 'main', image: 'registry/app@sha256:' + 'a'.repeat(64), env: [{ name: 'EXISTING', secretRef: 'existing-ref' }] }] } } };
  const readerPrincipal = '66666666-6666-4666-8666-666666666666';
  const readerClient = '77777777-7777-4777-8777-777777777777';
  const owner = createHash('sha256').update(JSON.stringify([tenantId, subscriptionId, environment.projectId, environment.id, service.name])).digest('hex');
  const readerId = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime-0536d773be`;
  const readerVault = `/subscriptions/${subscriptionId}/resourceGroups/secrets/providers/Microsoft.KeyVault/vaults/credential-vault`;
  const readerGrant = `${readerVault}/providers/Microsoft.Authorization/roleAssignments/65798795-a4c4-5e6a-8aaa-bc97623807aa`;
  const writes: any[] = [];
  if (options.environmentId) live.tags['hypervibe-environment-id'] = options.environmentId;
  if (options.opaque) live.properties.configuration.secrets.push({ name: 'unknown-inline' });
  const principal = live.identity.principalId;
  const roles = ['8311e382-0749-4cb8-b61a-304f252e45ec', '7f951dda-4ed3-4680-a7ca-43fe172d538d'];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input), method = init?.method ?? 'GET';
    if (target.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 'header.' + Buffer.from(JSON.stringify({ oid: principal })).toString('base64url') + '.signature', expires_in: 3600 });
    const path = new URL(target).pathname;
    if (options.deployment && path.endsWith('/userAssignedIdentities/provision')) return Response.json({ id: path,
      properties: { tenantId, clientId: '33333333-3333-4333-8333-333333333333', principalId: '55555555-5555-4555-8555-555555555555' } });
    if (options.preparedReader && path.includes('/userAssignedIdentities/')) {
      expect(path).toBe(readerId);
      return Response.json({ id: readerId, properties: { tenantId, clientId: readerClient, principalId: readerPrincipal },
        tags: { hypervibeRuntime: owner, hypervibeAttempt: 'runtime-create-attempt' } });
    }
    if (options.preparedReader && path === readerVault) return Response.json({ id: readerVault, systemData: { createdAt: '2026-10-24T00:00:00Z' }, properties: { tenantId, enableRbacAuthorization: true, provisioningState: 'Succeeded' } });
    if (options.preparedReader && path === readerGrant) return Response.json({ id: readerGrant, properties: { principalId: readerPrincipal,
      roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`, scope: readerVault, principalType: 'ServicePrincipal', description: `Hypervibe runtime ${owner}` } });
    if (path === managedEnvironment) return Response.json({ id: managedEnvironment, name: 'staging', properties: { provisioningState: 'Succeeded' } });
    if (path.includes('/roleAssignments/')) {
      const scope = path.split('/providers/Microsoft.Authorization/')[0]!;
      const role = roles.find(candidate => {
        const hex = createHash('sha256').update(`${scope.toLowerCase()}:${principal.toLowerCase()}:${candidate}`).digest('hex').slice(0, 32);
        return path.endsWith(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`);
      });
      return Response.json({ id: path, properties: { principalId: principal, roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/' + role } });
    }
    if (path === group || path.includes('/providers/Microsoft.ContainerRegistry/registries/')) return Response.json({ id: path, name: path.split('/').at(-1), tags: live.tags });
    if (path === appId && method === 'GET') return Response.json(live);
    if (path === appId && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)); writes.push(body); revision += 1;
      // ARM accepts empty assignment objects, but native readback supplies the
      // independently assigned principal/client IDs; request bodies are not responses.
      const userAssignedIdentities = body.identity?.userAssignedIdentities && Object.fromEntries(Object.entries(body.identity.userAssignedIdentities).map(([id, value]) => {
        expect(value).toEqual({});
        expect(Object.hasOwn(live.identity.userAssignedIdentities, id)).toBe(true);
        return [id, { principalId: readerPrincipal, clientId: readerClient }];
      }));
      live = { ...live, ...body, identity: { ...live.identity, ...body.identity, ...(userAssignedIdentities ? { userAssignedIdentities } : {}) }, properties: { ...live.properties, ...body.properties, configuration: { ...live.properties.configuration, ...body.properties.configuration }, latestRevisionName: 'rev-' + revision, latestReadyRevisionName: 'rev-' + revision } };
      if (options.corrupt) live.properties.configuration.secrets = [existingSecret];
      return Response.json(live);
    }
    throw new Error('Unexpected request: ' + method + ' ' + target);
  });
  vi.stubGlobal('fetch', request);
  if (options.deployment) {
    // Synthetic retained broker receipt. Prepared installation has separate native coverage.
    const native = (name: string, digit: string) => ({ kind: 'azure-managed-identity' as const, tenantId, subscriptionId,
      clientId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      principalId: '55555555-5555-4555-8555-555555555555', identityResourceId: `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}` });
    const provision = native('provision', '3'), release = { ...native('release', '6'), principalId: '66666666-6666-4666-8666-666666666666' };
    const runtime = { ...native('runtime', '7'), principalId: '77777777-7777-4777-8777-777777777777' };
    await adapter.connectTransient({ capability: 'provision', connection: { schemaVersion: 1, purpose: 'deployment', installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      planDigest: 'a'.repeat(64), customerId: 'customer', appId: 'app', environment: 'staging', provider: 'azure', hostingProvider: 'azure-container-apps',
      source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
      nativeScope: { tenantId, subscriptionId, resourceGroup: 'staging', location: 'canadacentral' },
      deployment: { hostingProvider: 'azure-container-apps', region: 'canadacentral', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [{ key: 'API_TOKEN', reference: reference as any }] }] },
      hostIdentity: { kind: 'gcp-service-account', projectId: 'host-project', projectNumber: '123456789', serviceAccountEmail: 'delivery@host-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
      principals: { provision, release }, runtimeIdentities: [{ workload: 'web', installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner: 'b'.repeat(64), principal: runtime }] },
      authentication: { kind: 'azure-federation', principal: provision, getAccessToken: async () => ({ token: 'opaque-synthetic-deployment', expiresAt: new Date(Date.now() + 300000).toISOString() }) } });
    request.mockClear();
  }
  return { adapter, writes, request, existingSecret, attachReader: (id: string) => { live.identity = { ...live.identity, type: 'SystemAssigned, UserAssigned', userAssignedIdentities: { [id]: { principalId: readerPrincipal, clientId: readerClient } } }; }, owner, readerPrincipal, readerClient, readerId, readerVault, readerGrant };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('Azure immutable secret references', () => {
  it.each(['deploy-changed', 'sync-omitted', 'delete-approved'])('rejects %s under deployment access before any native mutation', async mode => {
    const f = await fixture({ deployment: true });
    const receipt = mode === 'deploy-changed' ? (await f.adapter.deploy(service, environment, {}, { secretVersionRefs: { API_TOKEN: { ...reference, version: 'f'.repeat(32) } } } as any)).receipt
      : mode === 'sync-omitted' ? await f.adapter.setEnvVars(environment, service, {}) : await f.adapter.deleteEnvVars(environment, service, ['API_TOKEN']);
    expect(receipt.success).toBe(false); expect(f.writes).toEqual([]); expect(f.request).not.toHaveBeenCalled();
  });
  it('writes a versioned Key Vault reference without reading values and retains existing references on later deploy', async () => {
    const f = await fixture();
    expect(await f.adapter.setEnvVars(environment, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ success: true });
    const secrets = f.writes[0]?.properties.configuration.secrets;
    expect(secrets).toContainEqual(f.existingSecret);
    const selected = secrets?.find((item: any) => item.keyVaultUrl === url);
    expect(selected).toEqual({ name: expect.any(String), keyVaultUrl: url, identity: 'system' });
    expect(f.writes[0].properties.template.containers[0].env).toContainEqual({ name: 'API_TOKEN', secretRef: selected.name });
    expect(await f.adapter.deploy(service, environment, { MODE: 'test' })).toMatchObject({ receipt: { success: true } });
    expect(f.writes[1]?.properties.configuration.secrets).toEqual(expect.arrayContaining([f.existingSecret, selected]));
    const observed = await f.adapter.observe(environment);
    expect(observed.services[0]?.envVarSecretRefs?.API_TOKEN).toEqual({ provider: 'azure-key-vault', resource: url.slice(0, -(reference.version.length + 1)), version: reference.version });
    expect(observed.services[0]?.envVarKeys).toContain('API_TOKEN');
    expect(observed.services[0]?.envVarHashes).not.toHaveProperty('API_TOKEN');
    expect(f.request.mock.calls.some(([target]) => String(target).includes('listSecrets'))).toBe(false);
  });
  it('uses and verifies the separately prepared UAMI in the immutable Key Vault reference', async () => {
    const f = await fixture({ preparedReader: true }); f.attachReader(f.readerId);
    const scoped = structuredClone(environment);
    scoped.platformBindings.runtimeIdentities = { web: { provider: 'azure-container-apps', evidence: {
      tenantId, subscriptionId, environmentId: environment.id, serviceName: 'web', owner: f.owner, workloadId: appId, kind: 'user',
      principalId: f.readerPrincipal, clientId: f.readerClient, identityId: f.readerId, creationAttempt: 'runtime-create-attempt',
      readerGrants: JSON.stringify([{ vaultId: f.readerVault, createdAt: '2026-10-24T00:00:00Z', assignmentId: f.readerGrant, principalId: f.readerPrincipal }]),
    } } };
    expect(await f.adapter.setEnvVars(scoped, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ success: true });
    expect(f.writes[0].properties.configuration.secrets).toContainEqual({ name: expect.any(String), keyVaultUrl: url, identity: f.readerId });
    expect(f.writes[0].identity).toEqual({ type: 'SystemAssigned, UserAssigned', userAssignedIdentities: { [f.readerId]: {} } });
    expect(f.request.mock.calls.every(([target, init]) => !String(target).includes('vault.azure.net') && (init?.method ?? 'GET') !== 'PUT')).toBe(true);
  });
  it('preserves user-assigned identities without echoing read-only principal metadata in ARM writes', async () => {
    const f = await fixture();
    const readerId = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/existing-reader`;
    f.attachReader(readerId);
    expect(await f.adapter.deploy(service, environment, {})).toMatchObject({ receipt: { success: true } });
    expect(f.writes[0].identity).toEqual({ type: 'SystemAssigned, UserAssigned', userAssignedIdentities: { [readerId]: {} } });
  });
  it('rejects a create-only request before any ARM access while the native precondition remains unverified', async () => {
    const f = await fixture();
    expect(await f.adapter.deploy(service, environment, {}, { requireNewWorkload: true, deferDeployment: true })).toMatchObject({ receipt: { success: false } });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('blocks an update requiring unknown inline secret bytes instead of reading or dropping them', async () => {
    const f = await fixture({ opaque: true });
    expect(await f.adapter.setEnvVars(environment, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ success: false });
    expect(f.writes).toEqual([]);
    expect(f.request.mock.calls.some(([target]) => String(target).includes('listSecrets'))).toBe(false);
  });
  it('rejects a ready app whose native secret reference was dropped', async () => {
    const f = await fixture({ corrupt: true });
    expect(await f.adapter.setEnvVars(environment, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ success: false });
  });
  it('rejects a literal overwrite of an existing Key Vault reference', async () => {
    const f = await fixture();
    expect(await f.adapter.setEnvVars(environment, service, { EXISTING: 'unexpected-literal' })).toMatchObject({ success: false });
    expect(f.writes).toEqual([]);
  });
  it.each(['conflict', 'scope', 'provider'])('rejects %s before any provider call', async (reason) => {
    const f = await fixture();
    const ref = reason === 'scope' ? { ...reference, destination: { ...reference.destination, tenantId: '55555555-5555-4555-8555-555555555555' } }
      : reason === 'provider' ? { destination: { provider: 'gcp-secret-manager', projectId: 'cloud-project', projectNumber: '123456789012', secretId: 'token' }, version: '7' } : reference;
    expect(await f.adapter.setEnvVars(environment, service, reason === 'conflict' ? { API_TOKEN: 'must-not-send' } : {}, { secretVersionRefs: { API_TOKEN: ref } } as any)).toMatchObject({ success: false });
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe('reviewed references through bootstrap and hosting synchronization', () => {
  async function withDatabase(run: (data: { project: any; environment: Environment; service: Service }) => Promise<void>) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-reference-bootstrap-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(directory, 'state.db'));
    try {
      const project = new ProjectRepository().create({ name: 'reference-bootstrap', defaultPlatform: 'azure-container-apps' });
      const scopedEnvironment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: environment.platformBindings });
      const workload = new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: service.buildConfig });
      await run({ project, environment: scopedEnvironment, service: workload });
    } finally { SqliteAdapter.resetInstance(); fs.rmSync(directory, { recursive: true, force: true }); }
  }
  it('carries reviewed spec references through pre-sync and service deploy to actual ARM JSON with value-free local run plans', async () => {
    await withDatabase(async data => {
      const f = await fixture({ environmentId: data.environment.id });
      vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: f.adapter as unknown as IHostingAdapter });
      const spec = environmentSpecSchema.parse({ hosting: { provider: 'azure-container-apps' }, services: { web: { workloadKind: 'web', public: true } }, secretDestinations: { API_TOKEN: reference } });
      const params = specToBootstrapParams(data.project.name, 'staging', spec);
      const result = await executeBootstrap({ ...params, ensureHostingProject: false });
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
      expect(f.writes.length).toBeGreaterThanOrEqual(2);
      for (const write of f.writes) expect(write.properties.configuration.secrets).toContainEqual({ name: expect.any(String), keyVaultUrl: url, identity: 'system' });
      const run = new RunRepository().findByProjectId(data.project.id)[0]!;
      expect(JSON.stringify(run.plan)).not.toContain('valueSource');
      expect(JSON.stringify(run.plan)).not.toContain('secretVarsEncrypted');
    });
  });
  it('carries reference-only selected-key synchronization through the shared service to ARM', async () => {
    await withDatabase(async data => {
      const f = await fixture({ environmentId: data.environment.id });
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: f.adapter });
      const result = await syncHostingEnvVars({ ...data, vars: {}, secretVersionRefs: { API_TOKEN: reference } } as any);
      expect(result).toMatchObject({ success: true });
      expect(f.writes[0]?.properties.configuration.secrets).toContainEqual({ name: expect.any(String), keyVaultUrl: url, identity: 'system' });
    });
  });
  it('blocks unsupported destination capability before any provider work', async () => {
    await withDatabase(async data => {
      const f = await fixture({ environmentId: data.environment.id });
      f.adapter.capabilities.runtimeSecretReferenceProviders = [];
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: f.adapter });
      expect(await syncHostingEnvVars({ ...data, vars: {}, secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ success: false });
      expect(f.request).not.toHaveBeenCalled();
    });
  });
});
