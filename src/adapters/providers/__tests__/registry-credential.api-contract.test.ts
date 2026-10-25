import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ECSClient } from '@aws-sdk/client-ecs';
import { EcsExpressAdapter } from '../aws/ecs-express.adapter.js';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { AwsSecretsAdapter } from '../secretmanagers/aws-secrets.adapter.js';
import { AzureResourceManagerClient } from '../azure/azure-resource-manager.client.js';
import { DigitalOceanClient } from '../digitalocean/digitalocean.client.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';

// Synthetic documented provider observations, exercised through serialized clients.
// Sources and the challenged assumptions are recorded in docs/credential-registry-rotation.md.
const now = new Date();
const env = (platformBindings: Record<string, unknown>): Environment => ({ id: 'local-env', projectId: 'local-project', name: 'production', platformBindings, createdAt: now, updatedAt: now });
const replacement = { username: 'package-reader', token: 'replacement-private-token' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('ECS registered capability resolves the actual bound container reference and rejects a changed account before secret writes', async () => {
  const region = 'us-west-2'; const account = '123456789012';
  const cluster = `arn:aws:ecs:${region}:${account}:cluster/existing`;
  const serviceArn = `arn:aws:ecs:${region}:${account}:service/existing/web`;
  let secretArn = `arn:aws:secretsmanager:${region}:${account}:secret:pull-AbCdEf`;
  const ecs = new ECSClient({ region, credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' }, requestHandler: { handle: async (request: { body?: unknown; headers: Record<string, string> }) => {
    expect(request.headers['x-amz-target']).toContain('DescribeExpressGatewayService');
    expect(JSON.parse(String(request.body)).serviceArn).toBe(serviceArn);
    return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify({ service: { serviceArn, cluster,
      tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: 'local-env' }], currentDeployment: `${serviceArn}/revision/old`,
      activeConfigurations: [{ serviceRevisionArn: `${serviceArn}/revision/old`, primaryContainer: { image: 'ghcr.io/acme/app:stable', repositoryCredentials: { credentialsParameter: secretArn } } }] } })]) } };
  } } });
  const adapter = new EcsExpressAdapter();
  await adapter.connect({ accessKeyId: 'AKIAEXAMPLE12345678', secretAccessKey: 'synthetic-secret-that-is-long-enough-for-schema', region });
  Object.assign(adapter, { clients: { ecs }, accountId: account });
  const environment = env({ provider: 'ecs', projectId: cluster, environmentId: cluster, services: { web: { serviceId: serviceArn } } });
  const target = await adapter.registryCredentialLifecycle.inspect(environment, 'web');
  expect(target).toMatchObject({ credentialReference: secretArn, serviceId: serviceArn, image: 'ghcr.io/acme/app:stable' });
  secretArn = secretArn.replace(account, '999999999999');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await adapter.registryCredentialLifecycle.update(environment, 'web', target, replacement, { operationId: 'a'.repeat(64) })).toMatchObject({ success: false, data: { mutationAttempted: false } });
  expect(fetch).not.toHaveBeenCalled(); ecs.destroy();
});

it('Cloud Run registered capability resolves the exact bound resource and UID, without writing a workload or selecting a namesake', async () => {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-west1', credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
  const name = 'projects/gcp-project/locations/us-west1/services/existing'; let uid = 'original-uid';
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    expect(init?.method ?? 'GET').toBe('GET');
    const url = new URL(String(input));
    if (url.hostname === 'run.googleapis.com') { expect(url.pathname).toBe(`/v2/${name}`); return Response.json({ name, uid, template: { containers: [{ image: 'us-west1-docker.pkg.dev/gcp-project/remote/acme/app:stable' }, { image: 'sidecar/public:stable' }] } }); }
    expect(url.pathname).toBe('/v1/projects/gcp-project/locations/us-west1/repositories/remote');
    return Response.json({ name: 'projects/gcp-project/locations/us-west1/repositories/remote', mode: 'REMOTE_REPOSITORY', format: 'DOCKER', remoteRepositoryConfig: { dockerRepository: { publicRepository: 'DOCKER_HUB' }, upstreamCredentials: { usernamePasswordCredentials: { username: 'reader', passwordSecretVersion: 'projects/gcp-project/secrets/pull/versions/1' } } } });
  }));
  const environment = env({ provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'us-west1', services: { web: { serviceId: 'existing', resourceUid: uid } } });
  expect(await adapter.registryCredentialLifecycle.inspect(environment, 'web')).toMatchObject({ serviceId: name, instanceId: uid });
  uid = 'replacement-namesake-uid';
  await expect(adapter.registryCredentialLifecycle.inspect(environment, 'web')).rejects.toThrow('cannot be verified');
});

it('ECS updates the exact existing repositoryCredentials secret, preserves JSON fields, and reuses the operation token', async () => {
  const { createEcsRegistryCredentialLifecycle } = await import('../aws/ecs-registry-credential.js');
  const secretArn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:pull-AbCdEf';
  let current = { username: 'old-user', password: 'old-password', preserve: 'unrelated' };
  const writes: Record<string, unknown>[] = [];
  const client = new AwsSecretsAdapter();
  await client.connect({ region: 'us-west-2', accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' });
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.SecretId).toBe(secretArn);
    const operation = new Headers(init?.headers).get('X-Amz-Target')!.split('.').at(-1);
    if (operation === 'PutSecretValue') { writes.push(body); current = JSON.parse(body.SecretString); }
    else expect(operation).toBe('GetSecretValue');
    return Response.json({ ARN: secretArn, VersionId: 'version-accepted', ...(operation === 'GetSecretValue' ? { SecretString: JSON.stringify(current) } : {}) });
  }));
  const target = { provider: 'ecs', projectId: 'cluster', environmentId: 'cluster', serviceId: 'service', instanceId: 'service', image: 'ghcr.io/acme/app@sha256:unchanged', credentialReference: secretArn, registry: 'ghcr.io', activation: 'deferred' as const };
  const lifecycle = createEcsRegistryCredentialLifecycle(async () => target, () => client);
  expect(await lifecycle.inspect(env({}), 'web')).toEqual(target);
  expect(writes).toHaveLength(0);
  const result = await lifecycle.update(env({}), 'web', target, replacement, { operationId: 'a'.repeat(64) });
  expect(result).toMatchObject({ success: true, data: { credentialValueEvidence: 'readback', runtimeRolloutRequired: true } });
  expect(writes).toHaveLength(1);
  expect(writes[0]!.ClientRequestToken).toBe('a'.repeat(64));
  expect(current).toEqual({ username: replacement.username, password: replacement.token, preserve: 'unrelated' });
  expect(await lifecycle.update(env({}), 'web', target, replacement, { operationId: 'a'.repeat(64) })).toMatchObject({ success: true });
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(replacement.token);
});

it('DigitalOcean preserves the entire app spec and encrypted unrelated credentials while changing one image credential', async () => {
  const { createDigitalOceanRegistryCredentialLifecycle } = await import('../digitalocean/digitalocean-registry-credential.js');
  const original = { name: 'app', services: [{ name: 'web', image: { registry_type: 'GHCR', registry: 'acme', repository: 'app', digest: 'sha256:unchanged', registry_credentials: 'EV[1:old-encrypted]' }, envs: [{ key: 'KEEP', type: 'SECRET', value: 'EV[1:keep-encrypted]' }] }], workers: [{ name: 'other', image: { registry_type: 'DOCKER_HUB', repository: 'other', registry_credentials: 'EV[1:other-encrypted]' } }], domains: [{ name: 'example.invalid' }] };
  let spec = structuredClone(original); const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    expect(init?.redirect).toBe('error');
    if (init?.method === 'PUT') { spec = JSON.parse(String(init.body)).spec; writes.push(spec); }
    return Response.json({ app: { id: 'app-id', spec, in_progress_deployment: { id: 'new-deployment' } } });
  }));
  const lifecycle = createDigitalOceanRegistryCredentialLifecycle(() => new DigitalOceanClient('synthetic-token'));
  const environment = env({ provider: 'digitalocean', projectId: 'app-id', environmentId: 'app-id', services: { web: { serviceId: 'app-id:services:web' } } });
  const target = await lifecycle.inspect(environment, 'web');
  expect(writes).toHaveLength(0);
  expect(target.activation).toBe('provider-rollout');
  const result = await lifecycle.update(environment, 'web', target, replacement);
  expect(result).toMatchObject({ success: true, data: { credentialValueEvidence: 'acknowledgement', credentialUpdateActivation: 'provider-rollout' } });
  const expected = structuredClone(original); expected.services[0]!.image.registry_credentials = `${replacement.username}:${replacement.token}`;
  expect(writes).toEqual([expected]);
  expect(JSON.stringify(result)).not.toContain(replacement.token);
  expect(await lifecycle.update(environment, 'web', { ...target, image: 'changed' }, replacement)).toMatchObject({ success: false, data: { mutationAttempted: false } });
  expect(writes).toHaveLength(1);
});

it('Azure rotates an existing registry passwordSecretRef while preserving all other secret references and app configuration', async () => {
  const { createAzureRegistryCredentialLifecycle } = await import('../azure/azure-registry-credential.js');
  const subscription = '22222222-2222-4222-8222-222222222222';
  const group = `/subscriptions/${subscription}/resourceGroups/existing`;
  const managed = `${group}/providers/Microsoft.App/managedEnvironments/environment`;
  const appId = `${group}/providers/Microsoft.App/containerApps/web`;
  const client = new AzureResourceManagerClient({ authMode: 'default', subscriptionId: subscription, resourceGroup: 'existing' });
  Object.assign(client, { accessToken: 'synthetic-token' });
  let secrets: Array<{ name: string; value?: string; keyVaultUrl?: string; identity?: string }> = [{ name: 'pull', value: 'old-password' }, { name: 'keep', keyVaultUrl: 'https://vault.vault.azure.net/secrets/keep', identity: 'system' }];
  let configuration = { registries: [{ server: 'ghcr.io', username: 'old-user', passwordSecretRef: 'pull' }], secrets: secrets.map(({ value, ...rest }) => rest), ingress: { external: true }, activeRevisionsMode: 'Multiple' };
  const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    if (String(input).includes('/listSecrets')) return Response.json({ value: secrets });
    if (init?.method === 'PATCH') { const body = JSON.parse(String(init.body)); writes.push(body); configuration = body.properties.configuration; secrets = configuration.secrets; }
    return Response.json({ id: appId, properties: { managedEnvironmentId: managed, configuration, template: { containers: [{ name: 'web', image: 'ghcr.io/acme/app:unchanged', env: [{ name: 'KEEP', secretRef: 'keep' }] }] } } });
  }));
  const lifecycle = createAzureRegistryCredentialLifecycle(() => client);
  const environment = env({ provider: 'azure-container-apps', projectId: group, environmentId: managed, services: { web: { serviceId: appId } } });
  const target = await lifecycle.inspect(environment, 'web');
  expect(writes).toHaveLength(0);
  const result = await lifecycle.update(environment, 'web', target, replacement);
  expect(result).toMatchObject({ success: true, data: { credentialValueEvidence: 'readback', credentialUpdateActivation: 'deferred' } });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual({ properties: { configuration: { ...configuration, secrets: [{ name: 'pull', value: replacement.token }, secrets[1]] } } });
  expect(writes[0].properties.template).toBeUndefined();
  expect(configuration.registries).toEqual([{ server: 'ghcr.io', username: replacement.username, passwordSecretRef: 'pull' }]);
  expect(JSON.stringify(result)).not.toContain(replacement.token);
});

it.each([false, true])('Azure preserves an existing Key Vault registry reference and rotates its backing version; pinned=%s', async pinned => {
  const { createAzureRegistryCredentialLifecycle } = await import('../azure/azure-registry-credential.js');
  const subscription = '22222222-2222-4222-8222-222222222222';
  const group = `/subscriptions/${subscription}/resourceGroups/existing`;
  const managed = `${group}/providers/Microsoft.App/managedEnvironments/environment`;
  const appId = `${group}/providers/Microsoft.App/containerApps/web`;
  const vaultSecret = 'https://exact-vault.vault.azure.net/secrets/pull';
  const client = new AzureResourceManagerClient({ authMode: 'servicePrincipal', tenantId: 'tenant', clientId: 'client', clientSecret: 'synthetic-client-secret', subscriptionId: subscription, resourceGroup: 'existing' });
  Object.assign(client, { accessToken: 'synthetic-arm-token' });
  let secret = { name: 'pull', keyVaultUrl: pinned ? `${vaultSecret}/old-version` : vaultSecret, identity: 'system' };
  let currentValue = 'old-password'; let vaultWrites = 0; let configurationWrites = 0;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe('error');
    if (url.hostname === 'login.microsoftonline.com') { expect(String(init?.body)).toContain(encodeURIComponent('https://vault.azure.net/.default')); return Response.json({ access_token: 'synthetic-vault-token' }); }
    if (url.hostname.endsWith('.vault.azure.net')) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-vault-token');
      if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); expect(body).toEqual({ value: replacement.token, contentType: 'registry-password', tags: { keep: 'yes' }, attributes: { enabled: true, exp: 1999999999 } }); currentValue = body.value; vaultWrites++; }
      return Response.json({ id: `${vaultSecret}/${vaultWrites ? 'new-version' : 'old-version'}`, value: currentValue, contentType: 'registry-password', tags: { keep: 'yes' }, attributes: { enabled: true, exp: 1999999999, created: 1, updated: 2 } });
    }
    if (url.pathname.endsWith('/listSecrets')) return Response.json({ value: [secret] });
    if (init?.method === 'PATCH') { const body = JSON.parse(String(init.body)); secret = body.properties.configuration.secrets[0]; configurationWrites++; expect(body.properties.template).toBeUndefined(); }
    return Response.json({ id: appId, properties: { managedEnvironmentId: managed, configuration: { registries: [{ server: 'ghcr.io', username: replacement.username, passwordSecretRef: 'pull' }], secrets: [secret] }, template: { containers: [{ image: 'ghcr.io/acme/app:stable' }] } } });
  }));
  const lifecycle = createAzureRegistryCredentialLifecycle(() => client);
  const environment = env({ provider: 'azure-container-apps', projectId: group, environmentId: managed, services: { web: { serviceId: appId } } });
  const target = await lifecycle.inspect(environment, 'web');
  const result = await lifecycle.update(environment, 'web', target, replacement);
  expect(result).toMatchObject({ success: true, data: { credentialValueEvidence: 'readback' } });
  expect(vaultWrites).toBe(1); expect(configurationWrites).toBe(pinned ? 1 : 0);
  expect(secret).toEqual({ name: 'pull', keyVaultUrl: pinned ? `${vaultSecret}/new-version` : vaultSecret, identity: 'system' });
  expect(await lifecycle.inspect(environment, 'web')).toEqual(target);
  expect(await lifecycle.update(environment, 'web', target, replacement)).toMatchObject({ success: true });
  expect(vaultWrites).toBe(1);
  expect(JSON.stringify(result)).not.toContain(replacement.token);
});

it('Cloud Run updates the existing remote repository secret version, keeps the reviewed target stable and recovers an interrupted version write', async () => {
  const { createCloudRunRegistryCredentialLifecycle } = await import('../gcp/cloudrun-registry-credential.js');
  const workload = 'projects/project/locations/us-west1/services/web';
  const repository = 'projects/project/locations/us-west1/repositories/remote';
  const secret = 'projects/project/secrets/pull';
  let passwordSecretVersion = `${secret}/versions/1`; let username = replacement.username;
  const versions: Record<string, string> = { '1': 'old-password' }; let additions = 0; let patches = 0; let interrupt = true; let latestLag = false;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'run.googleapis.com') return Response.json({ name: workload, uid: 'stable-uid', template: { containers: [{ image: 'us-west1-docker.pkg.dev/project/remote/acme/app@sha256:unchanged' }] } });
    if (url.hostname === 'artifactregistry.googleapis.com') {
      if (init?.method === 'PATCH') { patches++; const body = JSON.parse(String(init.body)); ({ passwordSecretVersion, username } = body.remoteRepositoryConfig.upstreamCredentials.usernamePasswordCredentials); }
      return Response.json({ name: repository, format: 'DOCKER', mode: 'REMOTE_REPOSITORY', remoteRepositoryConfig: { upstreamCredentials: { usernamePasswordCredentials: { username, passwordSecretVersion } }, dockerRepository: { customRepository: { uri: 'https://ghcr.io' } } } });
    }
    if (url.pathname.endsWith(':addVersion')) {
      additions++; versions['2'] = Buffer.from(JSON.parse(String(init?.body)).payload.data, 'base64').toString('utf8');
      if (interrupt) { interrupt = false; throw new Error('response lost'); }
      return Response.json({ name: `${secret}/versions/2`, state: 'ENABLED' });
    }
    const version = url.pathname.includes('/latest:access') ? (versions['2'] && !latestLag ? '2' : '1') : url.pathname.split('/').at(-1)!.split(':')[0]!;
    return Response.json({ name: `${secret}/versions/${version}`, payload: { data: Buffer.from(versions[version]!).toString('base64') } });
  }));
  const lifecycle = createCloudRunRegistryCredentialLifecycle(async () => ({ name: workload, projectId: 'project', environmentId: 'us-west1' }), async () => 'synthetic-token');
  const target = await lifecycle.inspect(env({}), 'web');
  expect(target).toMatchObject({ credentialReference: secret, registry: repository, activation: 'deferred' });
  expect(additions + patches).toBe(0);
  expect(await lifecycle.update(env({}), 'web', target, replacement)).toMatchObject({ success: false, data: { mutationAttempted: true } });
  latestLag = true;
  expect(await lifecycle.reconcile!(env({}), 'web', target, replacement, { operationId: 'operation' })).toMatchObject({ success: false });
  expect(additions).toBe(1); expect(patches).toBe(0);
  latestLag = false;
  const result = await lifecycle.reconcile!(env({}), 'web', target, replacement, { operationId: 'operation' });
  expect(result).toMatchObject({ success: true, data: { credentialValueEvidence: 'readback' } });
  expect(additions).toBe(1); expect(patches).toBe(1); expect(passwordSecretVersion).toBe(`${secret}/versions/2`);
  expect(await lifecycle.inspect(env({}), 'web')).toEqual(target);
  expect(JSON.stringify(result)).not.toContain(replacement.token);
});
