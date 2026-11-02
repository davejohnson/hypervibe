import { afterEach, describe, expect, it, vi } from 'vitest';
import { gcpAccountPolicyGetContractResponse } from '../../../../test/gcp-iam-policy-contract.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import type { CloudRunAdapter } from '../cloudrun.adapter.js';
import '../cloudrun.adapter.js';
import { observeRuntimeAccess, planRuntimeAccess, applyRuntimeAccessAction } from '../../../../domain/services/runtime-access.service.js';
import type { CloudDeploymentConnectionV1 } from '../../../../domain/ports/cloud-deployment.port.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { resourceName } from '../../../../domain/services/resource-names.js';
import type { DeploymentMutationOptions } from '../../../../domain/ports/provider.port.js';

// Reconstructed native responses: Google token-types documents aud/azp as
// the service-account UID; email is optional without userinfo.email scope.
// google-auth-library OAuth2Client#getTokenInfo sends POST + bearer header.
// Only serialized HTTP is replaced; no adapter/auth method is mocked.
const uid = '111111111111111111111';
const projectId = 'customer-project';
const projectNumber = '987654321';
const principal = (name: string, id: string) => ({ kind: 'gcp-service-account' as const, projectId, projectNumber,
  serviceAccountEmail: `${name}@${projectId}.iam.gserviceaccount.com`, serviceAccountUniqueId: id });
const connection: CloudDeploymentConnectionV1 = {
  schemaVersion: 1 as const, purpose: 'deployment' as const, provider: 'gcp' as const, hostingProvider: 'cloudrun',
  installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', planDigest: 'c'.repeat(64), customerId: 'customer-a', appId: 'app-a', environment: 'production',
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  nativeScope: { projectId, projectNumber },
  deployment: { hostingProvider: 'cloudrun', region: 'us-central1', workloads: [{ name: 'web', kind: 'web' as const, runtimeSecrets: [] }] },
  hostIdentity: { kind: 'gcp-service-account' as const, projectId: 'hosting-project', projectNumber: '123456789',
    serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' as const },
  principals: { provision: principal('provision', uid), release: principal('release', '222222222222222222222') },
  runtimeIdentities: [{ workload: 'web', installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner: 'd'.repeat(64),
    principal: principal('runtime', '444444444444444444444') }],
};
function fixture(options: { tokenUid?: string; accountUid?: string; projectNumber?: string; failure?: boolean; echo?: boolean; installedRuntime?: boolean; replacedRuntime?: boolean; withSecret?: boolean; missingReader?: boolean; deployService?: boolean; missingServiceUid?: boolean; existingService?: boolean; conflictServiceWrite?: boolean; missingServiceEtag?: boolean } = {}) {
  const selectedConnection = structuredClone(connection);
  if (options.withSecret) selectedConnection.deployment.workloads[0]!.runtimeSecrets = [{ key: 'API_TOKEN', reference: { destination: { provider: 'gcp-secret-manager', projectId, projectNumber, secretId: 'production-api' }, version: '7' } }];
  const token = 'synthetic-opaque-deployment-token';
  const expiresAt = new Date(Date.now() + 900_000).toISOString();
  const getAccessToken = vi.fn(async () => ({ token, expiresAt }));
  let serviceCreated = options.existingService ?? false;
  const serviceUid = 'be22d91a-f126-4e44-8962-9f347d40fa69';
  const imageUri = `us-central1-docker.pkg.dev/${projectId}/images/web@sha256:${'a'.repeat(64)}`;
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url).not.toContain(token);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    if (url === 'https://oauth2.googleapis.com/tokeninfo') {
      expect(init?.method).toBe('POST');
      return options.failure ? Response.json({ error: { message: token } }, { status: 403 }) : Response.json({
        azp: options.tokenUid ?? uid, aud: options.tokenUid ?? uid,
        scope: 'https://www.googleapis.com/auth/cloud-platform', expires_in: '899', exp: String(Math.floor(Date.parse(expiresAt) / 1000)), access_type: 'online',
      });
    }
    if (url === `https://cloudresourcemanager.googleapis.com/v3/projects/${projectNumber}`)
      return Response.json({ name: `projects/${options.projectNumber ?? projectNumber}`, projectId, state: 'ACTIVE' });
    if (url === `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${uid}`)
      return Response.json({ name: `projects/${projectId}/serviceAccounts/${(connection.principals.provision as Extract<CloudDeploymentConnectionV1['principals']['provision'], {kind: 'gcp-service-account'}>).serviceAccountEmail}`,
        projectId, uniqueId: options.accountUid ?? uid, email: (connection.principals.provision as Extract<CloudDeploymentConnectionV1['principals']['provision'], {kind: 'gcp-service-account'}>).serviceAccountEmail });
    if (options.withSecret && url.startsWith('https://secretmanager.googleapis.com/v1/')) {
      const resource = `projects/${projectNumber}/secrets/production-api`;
      if (url.endsWith(':getIamPolicy?options.requestedPolicyVersion=3')) return Response.json({ etag: 'secret-policy', bindings: options.missingReader ? [] : [
        { role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:runtime@${projectId}.iam.gserviceaccount.com`] } ] });
      if (url.endsWith('/versions/7')) return Response.json({ name: `${resource}/versions/7`, state: 'ENABLED' });
      if (url.endsWith('/secrets/production-api')) return Response.json({ name: resource, createTime: '2026-10-24T12:00:00Z' });
      throw new Error('Unexpected value request');
    }
    if (options.installedRuntime) {
      const runtime = connection.runtimeIdentities[0]!.principal;
      if (runtime.kind !== 'gcp-service-account') throw new Error('fixture');
      if (url === `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${runtime.serviceAccountUniqueId}`)
        return Response.json({ name: `projects/${projectId}/serviceAccounts/${runtime.serviceAccountEmail}`, projectId,
          email: runtime.serviceAccountEmail, uniqueId: options.replacedRuntime ? '555555555555555555555' : runtime.serviceAccountUniqueId,
          description: `hypervibe:deployment:v1:${connection.runtimeIdentities[0]!.owner}:${connection.installationId}` });
      if (new URL(url).pathname.endsWith(`${runtime.serviceAccountUniqueId}:getIamPolicy`)) {
        const invalidPolicyRead = gcpAccountPolicyGetContractResponse(new URL(url), init?.method ?? 'GET', init?.body);
        if (invalidPolicyRead) return invalidPolicyRead;
        return Response.json({ etag: 'sa-policy', bindings: [
        { role: 'roles/iam.serviceAccountUser', members: Object.values(connection.principals).map(p => { if (p.kind !== 'gcp-service-account') throw new Error('fixture'); return `serviceAccount:${p.serviceAccountEmail}`; }) } ] });
      }
      const services = `https://run.googleapis.com/v2/projects/${projectId}/locations/us-central1/services`;
      if (options.deployService && url.startsWith(`${services}?serviceId=`) && init?.method === 'POST') {
        serviceCreated = true;
        return Response.json({ name: `projects/${projectId}/locations/us-central1/operations/create-web`, done: true,
          response: { name: `${services.slice('https://run.googleapis.com/v2/'.length)}/${new URL(url).searchParams.get('serviceId')}` } });
      }
      if (url.startsWith(`${services}/`)) {
        // Reconstructed Service response from the official Cloud Run v2 contract:
        // uid is server assigned and remains unchanged until deletion.
        if (!serviceCreated) return Response.json({}, { status: 404 });
        if (options.conflictServiceWrite && init?.method === 'PATCH') return Response.json({ error: { code: 409 } }, { status: 409 });
        return Response.json({ name: url.slice('https://run.googleapis.com/v2/'.length),
          ...(options.missingServiceUid ? {} : { uid: serviceUid }), generation: '1', observedGeneration: '1',
          ...(options.missingServiceEtag ? {} : { etag: 'native-revision-etag' }),
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
          template: { serviceAccount: runtime.serviceAccountEmail, containers: [{ image: imageUri, env: [] }] } });
      }
    }
    if (url.startsWith('https://artifactregistry.googleapis.com/v1/'))
      return Response.json({ repositories: options.echo ? [{ name: token, format: 'DOCKER' }] : [] });
    throw new Error('Unexpected Google request');
  });
  vi.stubGlobal('fetch', request);
  const create = () => providerRegistry.createTransientAdapter<CloudRunAdapter>('cloudrun', {
    connection: selectedConnection, capability: 'provision', authentication: { kind: 'gcp-impersonation', principal: connection.principals.provision as Extract<CloudDeploymentConnectionV1['principals']['provision'], {kind: 'gcp-service-account'}>, getAccessToken },
  });
  return { create, request, getAccessToken, token, connection: selectedConnection, serviceUid, imageUri };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('Cloud Run deployment access through native token and identity contracts', () => {
  it('does not treat hosted deployment access as authority to inspect, rotate or recover registry credentials', async () => {
    const f = fixture({ installedRuntime: true, existingService: true });
    const adapter = await f.create();
    const now = new Date();
    const environment = { id: 'local-env', projectId: 'app-a', name: 'production', createdAt: now, updatedAt: now,
      platformBindings: { provider: 'cloudrun', projectId, environmentId: 'us-central1', services: { web: { serviceId: 'web' } } } };
    const target = { provider: 'cloudrun', projectId, environmentId: 'us-central1', serviceId: `projects/${projectId}/locations/us-central1/services/web`,
      instanceId: f.serviceUid, image: f.imageUri, registry: `projects/${projectId}/locations/us-central1/repositories/images`,
      credentialReference: `projects/${projectId}/secrets/pull`, activation: 'deferred' as const };
    f.request.mockClear(); f.getAccessToken.mockClear();
    await expect(adapter.registryCredentialLifecycle.inspect(environment, 'web')).rejects.toThrow('cannot be verified');
    expect(await adapter.registryCredentialLifecycle.update(environment, 'web', target, { username: 'reader', token: 'synthetic-candidate' }))
      .toMatchObject({ success: false, data: { mutationAttempted: false } });
    expect(await adapter.registryCredentialLifecycle.reconcile!(environment, 'web', target, { username: 'reader', token: 'synthetic-candidate' }, { operationId: 'a'.repeat(64) }))
      .toMatchObject({ success: false, data: { mutationAttempted: false } });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.getAccessToken).not.toHaveBeenCalled();
  });

  it('uses a short-lived opaque token without a private key, ambient ADC, or required email claim', async () => {
    const f = fixture(); const adapter = await f.create();
    expect(await adapter.inspectArtifactResources({ resource: 'artifact', region: 'us-central1', limit: 1 })).toMatchObject({ artifacts: [], partial: false });
    expect(f.request.mock.calls.some(([url]) => String(url).endsWith('/tokeninfo'))).toBe(true);
    expect(f.request.mock.calls.some(([url]) => String(url).includes('metadata.google.internal') || String(url).endsWith('/token'))).toBe(false);
  });
  it.each([{ tokenUid: '333333333333333333333' }, { accountUid: '333333333333333333333' }, { projectNumber: '123123123' }])(
    'rejects a token or native identity from another lifetime/scope before workload access: %j', async options => {
      const f = fixture(options);
      await expect(f.create()).rejects.toThrow();
      expect(f.getAccessToken).toHaveBeenCalledOnce();
      expect(f.request.mock.calls.some(([url]) => String(url).includes('artifactregistry.googleapis.com'))).toBe(false);
    }
  );
  it('keeps echoed temporary credentials out of both failure and successful provider output', async () => {
    const denied = fixture({ failure: true });
    const error = await denied.create().catch(error => error);
    expect(denied.getAccessToken).toHaveBeenCalledOnce();
    expect(String(error)).not.toContain(denied.token);
    const echoed = fixture({ echo: true }); const adapter = await echoed.create();
    const result = await adapter.inspectArtifactResources({ resource: 'artifact', region: 'us-central1', limit: 1 }).catch(error => ({ error: String(error) }));
    expect(JSON.stringify(result)).not.toContain(echoed.token);
    expect(result).not.toMatchObject({ observation: 'present' });
  });
  it('refreshes through the approved broker and fails closed after revocation without ambient fallback', async () => {
    const f = fixture(); const adapter = await f.create();
    const initialRequests = f.request.mock.calls.length;
    f.getAccessToken.mockRejectedValue(new Error(`revoked ${f.token}`));
    const advanced = Date.now() + 841_000;
    vi.spyOn(Date, 'now').mockReturnValue(advanced);
    const result = await adapter.inspectArtifactResources({ resource: 'artifact', region: 'us-central1', limit: 1 }).catch(error => ({ error: String(error) }));
    expect(f.getAccessToken).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenCalledTimes(initialRequests);
    expect(JSON.stringify(result)).not.toContain(f.token);
    expect(result).not.toMatchObject({ observation: 'present' });
  });
  it('preserves the reviewed region and never repairs administrator IAM during project binding', async () => {
    const f = fixture(); const adapter = await f.create();
    expect(() => adapter.configureTarget({ region: 'europe-west1' })).toThrow('reviewed');
    const result = await adapter.ensureProject('app-a', { platformBindings: { projectId } } as any);
    expect(result.success).toBe(true);
    expect(f.request.mock.calls.some(([url]) => String(url).includes('IamPolicy') || String(url).includes(':enable'))).toBe(false);
    await expect(adapter.ensureProject('app-a', { platformBindings: { projectId: 'another-project' } } as any)).rejects.toThrow('reviewed');
  });
});

describe('administrator-installed Cloud Run runtime handoff', () => {
  function input(hosting: CloudRunAdapter) {
    const now = new Date();
    return { environment: { id: 'different-local-environment-id', projectId: 'local-app', name: 'production', createdAt: now, updatedAt: now,
      platformBindings: { provider: 'cloudrun', projectId, environmentId: 'us-central1' } as Record<string, any> },
      environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'cloudrun', region: 'us-central1' }, services: { web: {} } }),
      hosting, storageAdapters: {} };
  }
  it('binds the exact preinstalled identity through plan/apply without cloud IAM writes or local-ID renaming', async () => {
    const f = fixture({ installedRuntime: true, withSecret: true }); const adapter = await f.create(); const scope = input(adapter);
    scope.environmentSpec.secretDestinations = Object.fromEntries(f.connection.deployment.workloads[0]!.runtimeSecrets.map(item => [item.key, item.reference]));
    expect(planRuntimeAccess(await observeRuntimeAccess({ ...scope, environment: null }))).toEqual([]);
    const actions = planRuntimeAccess(await observeRuntimeAccess(scope));
    expect(actions).toEqual([expect.objectContaining({ id: 'runtime-identity:web', verified: true })]);
    const applied = await applyRuntimeAccessAction({ ...scope, action: actions[0]!, confirmedActionIds: new Set([actions[0]!.id]),
      save: async bindings => { scope.environment.platformBindings = { ...scope.environment.platformBindings, ...bindings }; } });
    expect(applied.success).toBe(true);
    expect(planRuntimeAccess(await observeRuntimeAccess(scope))).toEqual([]);
    expect(scope.environment.platformBindings.runtimeIdentities.web.evidence).toMatchObject({ uniqueId: '444444444444444444444',
      email: `runtime@${projectId}.iam.gserviceaccount.com`, environmentId: scope.environment.id });
    expect(f.request.mock.calls.some(([url]) => String(url).includes(':access'))).toBe(false);
    expect(f.request.mock.calls.filter(([url, init]) => init?.method && init.method !== 'GET'
      && !String(url).endsWith('tokeninfo') && !String(url).includes(':getIamPolicy'))).toEqual([]);
  });
  it('blocks a missing runtime reader grant instead of repairing IAM with deployment authority', async () => {
    const f = fixture({ installedRuntime: true, withSecret: true, missingReader: true }); const scope = input(await f.create());
    scope.environmentSpec.secretDestinations = Object.fromEntries(f.connection.deployment.workloads[0]!.runtimeSecrets.map(item => [item.key, item.reference]));
    expect((await observeRuntimeAccess(scope)).identities[0]!.observation.state).toBe('unknown');
    expect(f.request.mock.calls.some(([url]) => String(url).includes(':setIamPolicy') || String(url).includes(':access'))).toBe(false);
  });
  it.each([false, true])('retains the native workload lifetime after first creation; missing UID=%s', async missingServiceUid => {
    const f = fixture({ installedRuntime: true, deployService: true, missingServiceUid });
    const adapter = await f.create(), scope = input(adapter);
    const actions = planRuntimeAccess(await observeRuntimeAccess(scope));
    expect((await applyRuntimeAccessAction({ ...scope, action: actions[0]!, confirmedActionIds: new Set([actions[0]!.id]),
      save: async bindings => { scope.environment.platformBindings = { ...scope.environment.platformBindings, ...bindings }; } })).success).toBe(true);
    const now = new Date();
    const result = await adapter.deploy({ id: 'web', projectId: 'local-app', name: 'web', buildConfig: { builder: 'dockerfile', public: false },
      envVarSpec: {}, createdAt: now, updatedAt: now }, scope.environment, { IMAGE_URI: f.imageUri });
    if (missingServiceUid) {
      expect(result.receipt.success).toBe(false);
      expect(result.receipt.error).toMatch(/identity/i);
      return;
    }
    expect(result.receipt.success).toBe(true);
    expect(result.receipt.data?.resourceUid).toBe(f.serviceUid);
    scope.environment.platformBindings.services = { web: { serviceId: result.externalId, resourceUid: result.receipt.data?.resourceUid } };
    expect(planRuntimeAccess(await observeRuntimeAccess(scope))).toEqual([]);
    scope.environment.platformBindings.services.web.resourceUid = '64c991d7-37ac-46a5-b371-e8dd879e7fba';
    expect((await observeRuntimeAccess(scope)).identities[0]!.observation.state).toBe('unknown');
  });
  it.each(['deploy', 'setEnvVars'] as const)('rejects changed or omitted reviewed references before %s writes', async operation => {
    for (const version of [undefined, '8']) {
      const f = fixture({ installedRuntime: true, withSecret: true, deployService: true, existingService: true });
      const adapter = await f.create(), scope = input(adapter), now = new Date();
      scope.environment.platformBindings.services = { web: { serviceId: resourceName('web', { maxLength: 49, scope: [projectId, 'production'] }), resourceUid: f.serviceUid } };
      const service = { id: 'web', projectId: 'local-app', name: 'web', buildConfig: { builder: 'dockerfile' as const, public: false }, envVarSpec: {}, createdAt: now, updatedAt: now };
      const reference = f.connection.deployment.workloads[0]!.runtimeSecrets[0]!.reference;
      const options: DeploymentMutationOptions = { secretVersionRefs: version ? { API_TOKEN: { ...reference, version } } : {} };
      const vars = { IMAGE_URI: f.imageUri, SETTING: 'nonsecret' };
      if (operation === 'deploy') await adapter.deploy(service, scope.environment, vars, options);
      else await adapter.setEnvVars(scope.environment, service, vars, options);
      expect(f.request.mock.calls.filter(([url, init]) => String(url).includes('run.googleapis.com') && ['POST', 'PATCH', 'DELETE'].includes(init?.method ?? 'GET'))).toEqual([]);
    }
  });
  it('rejects deleting an approved reference even when a stale observation reports it absent', async () => {
    const f = fixture({ installedRuntime: true, withSecret: true, existingService: true });
    const adapter = await f.create(), scope = input(adapter), now = new Date();
    const result = await adapter.deleteEnvVars(scope.environment, { id: 'web', projectId: 'local-app', name: 'web', buildConfig: { builder: 'dockerfile', public: false },
      envVarSpec: {}, createdAt: now, updatedAt: now }, ['API_TOKEN']);
    expect(result.success).toBe(false);
    expect(f.request.mock.calls.some(([url]) => String(url).includes('run.googleapis.com'))).toBe(false);
  });
  it.each(['deploy', 'setEnvVars'] as const)('rejects a replaced bound service before %s mutation', async operation => {
    const f = fixture({ installedRuntime: true, existingService: true });
    const adapter = await f.create(), scope = input(adapter), now = new Date();
    scope.environment.platformBindings.services = { web: { serviceId: resourceName('web', { maxLength: 49, scope: [projectId, 'production'] }), resourceUid: 'a8f92ed1-6b65-47cc-a671-7c5dbeed6645' } };
    const service = { id: 'web', projectId: 'local-app', name: 'web', buildConfig: { builder: 'dockerfile' as const, public: false }, envVarSpec: {}, createdAt: now, updatedAt: now };
    const vars = { IMAGE_URI: f.imageUri, SETTING: 'nonsecret' };
    if (operation === 'deploy') await adapter.deploy(service, scope.environment, vars);
    else await adapter.setEnvVars(scope.environment, service, vars);
    expect(f.request.mock.calls.filter(([url, init]) => String(url).includes('run.googleapis.com') && ['POST', 'PATCH', 'DELETE'].includes(init?.method ?? 'GET'))).toEqual([]);
  });
  it.each(['deploy', 'setEnvVars'] as const)('uses the native etag for %s without replaying a conflict', async operation => {
    for (const missingServiceEtag of [true, false]) {
      const f = fixture({ installedRuntime: true, existingService: true, conflictServiceWrite: true, missingServiceEtag });
      const adapter = await f.create(), scope = input(adapter), now = new Date();
      scope.environment.platformBindings.services = { web: { serviceId: resourceName('web', { maxLength: 49, scope: [projectId, 'production'] }), resourceUid: f.serviceUid } };
      const service = { id: 'web', projectId: 'local-app', name: 'web', buildConfig: { builder: 'dockerfile' as const, public: false }, envVarSpec: {}, createdAt: now, updatedAt: now };
      const vars = { IMAGE_URI: f.imageUri, SETTING: 'nonsecret' };
      const receipt = operation === 'deploy' ? (await adapter.deploy(service, scope.environment, vars)).receipt : await adapter.setEnvVars(scope.environment, service, vars);
      expect(receipt.success).toBe(false);
      const writes = f.request.mock.calls.filter(([url, init]) => String(url).includes('run.googleapis.com') && init?.method === 'PATCH');
      expect(writes).toHaveLength(missingServiceEtag ? 0 : 1);
      if (!missingServiceEtag) expect(JSON.parse(String(writes[0]![1]?.body)).etag).toBe('native-revision-etag');
    }
  });
  it('keeps a replaced native runtime account unknown before any local binding or cloud mutation', async () => {
    const f = fixture({ installedRuntime: true, replacedRuntime: true }); const scope = input(await f.create());
    const observed = await observeRuntimeAccess(scope);
    expect(observed.identities).toEqual([expect.objectContaining({ observation: { state: 'unknown', reason: expect.any(String) } })]);
  });
});
