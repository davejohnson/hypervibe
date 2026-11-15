import { afterEach, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';

// Synthetic documented provider observations, exercised through serialized clients.
// Sources and the challenged assumptions are recorded in docs/credential-registry-rotation.md.
const now = new Date();
const env = (platformBindings: Record<string, unknown>): Environment => ({ id: 'local-env', projectId: 'local-project', name: 'production', platformBindings, createdAt: now, updatedAt: now });
const replacement = { username: 'package-reader', token: 'replacement-private-token' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
