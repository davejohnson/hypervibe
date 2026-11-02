import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

// Synthetic responses at the real REST boundary, reconstructed from Cloud Run v2
// EnvVar.valueSource.secretKeyRef, not successful live credential/IAM evidence.
// https://cloud.google.com/run/docs/reference/rest/v2/Container#SecretKeySelector
const reference = { destination: { provider: 'gcp-secret-manager', projectId: 'cloud-project', projectNumber: '123456789012', secretId: 'api-token' }, version: '7' };
const native = { name: 'API_TOKEN', valueSource: { secretKeyRef: { secret: 'projects/123456789012/secrets/api-token', version: '7' } } };
const now = new Date();
const service: Service = { id: 'service', projectId: 'project', name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: now, updatedAt: now };
const environment: Environment = { id: 'environment', projectId: 'project', name: 'staging', createdAt: now, updatedAt: now, platformBindings: {
  provider: 'cloudrun', projectId: 'cloud-project', environmentId: 'us-central1', services: { web: { serviceId: 'web' } },
} };
async function fixture(corrupt = false, project: unknown = { name: 'projects/123456789012', projectId: 'cloud-project', state: 'ACTIVE' }) {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'cloud-project', credentials: JSON.stringify({ type: 'service_account', project_id: 'cloud-project', client_email: 'deployer@cloud-project.iam.gserviceaccount.com', private_key: 'synthetic' }) });
  Object.assign(adapter, { accessToken: 'synthetic', tokenExpiry: new Date(Date.now() + 60_000) });
  const name = 'projects/cloud-project/locations/us-central1/services/web';
  let live: any = { name, terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' }, template: { containers: [{ image: 'registry/app@sha256:' + 'a'.repeat(64), env: [{ name: 'EXISTING', value: 'retained' }] }] } };
  const writes: any[] = [];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    if (url.startsWith('https://cloudresourcemanager.googleapis.com/v3/projects/')) return project === null
      ? new Response('unavailable', { status: 403 }) : Response.json(project);
    if (url.startsWith('https://run.googleapis.com/v2/' + name)) {
      if (method === 'GET') return Response.json(live);
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)); writes.push(body);
        live = { ...live, template: body.template };
        if (corrupt) live.template.containers[0].env = [{ ...native, valueSource: { secretKeyRef: { ...native.valueSource.secretKeyRef, version: '6' } } }];
        return Response.json({ name: 'projects/cloud-project/locations/us-central1/operations/update', done: true, response: { name } });
      }
    }
    throw new Error('Unexpected request: ' + method + ' ' + url);
  });
  vi.stubGlobal('fetch', request);
  return { adapter, writes, request };
}
afterEach(() => vi.unstubAllGlobals());
describe('Cloud Run immutable secret references', () => {
  it.each([
    { name: 'projects/123456789012', projectId: 'other-project', state: 'ACTIVE' },
    { name: 'projects/999999999999', projectId: 'cloud-project', state: 'ACTIVE' },
    { name: 'projects/123456789012', projectId: 'cloud-project', state: 'DELETE_REQUESTED' },
    {}, null,
  ])('rejects mismatched or unavailable native project identity before workload access: %j', async project => {
    const f = await fixture(false, project);
    expect(await f.adapter.setEnvVars(environment, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ success: false });
    expect(f.writes).toEqual([]);
    expect(f.request.mock.calls.every(([url, init]) => String(url).startsWith('https://cloudresourcemanager.googleapis.com/v3/projects/') && (init?.method ?? 'GET') === 'GET')).toBe(true);
  });
  it('rejects a cross-project-capable token before deploy/build writes when a manually pinned numeric parent is foreign', async () => {
    const f = await fixture(false, { name: 'projects/999999999999', projectId: 'foreign-project', state: 'ACTIVE' });
    const foreignNumber = { ...reference, destination: { ...reference.destination, projectNumber: '999999999999' } };
    expect(await f.adapter.deploy(service, environment, {}, { secretVersionRefs: { API_TOKEN: foreignNumber }, deferDeployment: true } as any)).toMatchObject({ receipt: { success: false } });
    expect(f.request.mock.calls.every(([url, init]) => String(url).startsWith('https://cloudresourcemanager.googleapis.com/v3/projects/') && (init?.method ?? 'GET') === 'GET')).toBe(true);
  });
  it('enforces explicit creation-only authority before touching an already bound workload', async () => {
    const f = await fixture();
    expect(await f.adapter.deploy(service, environment, {}, { deferDeployment: true, requireNewWorkload: true, secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ receipt: { success: false } });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('refuses an unbound same-name workload during creation-only reference setup', async () => {
    const f = await fixture();
    const unbound = { ...environment, platformBindings: { ...environment.platformBindings, services: {} } };
    expect(await f.adapter.deploy(service, unbound, {}, { deferDeployment: true, requireNewWorkload: true, secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ receipt: { success: false } });
    expect(f.writes).toEqual([]);
    expect(f.request).toHaveBeenCalled();
  });
  it('writes a pinned native reference without values and preserves it through a subsequent literal update', async () => {
    const f = await fixture();
    expect(await f.adapter.setEnvVars(environment, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ success: true });
    expect(String(f.request.mock.calls[0][0])).toBe('https://cloudresourcemanager.googleapis.com/v3/projects/123456789012');
    expect(f.writes[0]?.template.containers[0].env).toEqual(expect.arrayContaining([native, { name: 'EXISTING', value: 'retained' }]));
    expect(await f.adapter.setEnvVars(environment, service, { MODE: 'test' })).toMatchObject({ success: true });
    expect(f.writes[1]?.template.containers[0].env).toContainEqual(native);
  });
  it('does not accept a ready revision that points at another secret version', async () => {
    const f = await fixture(true);
    expect(await f.adapter.setEnvVars(environment, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ success: false });
  });
  it('pins a scheduled job reference through the job update boundary', async () => {
    const f = await fixture();
    const name = 'projects/cloud-project/locations/us-central1/jobs/web';
    let live: any = { name, uid: 'job-uid', etag: 'job-etag', generation: '1', observedGeneration: '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
      template: { template: { serviceAccount: 'runtime@cloud-project.iam.gserviceaccount.com', containers: [{ image: 'registry/app@sha256:' + 'a'.repeat(64), command: ['/bin/sh'], args: ['-lc', 'run-cron'], env: [{ name: 'EXISTING', value: 'retained' }] }] } } };
    const writes: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === 'https://cloudresourcemanager.googleapis.com/v3/projects/123456789012') return Response.json({ name: 'projects/123456789012', projectId: 'cloud-project', state: 'ACTIVE' });
      expect(String(input)).toBe('https://run.googleapis.com/v2/' + name);
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)); writes.push(body); live = { ...live, ...body };
        return Response.json({ name: 'projects/cloud-project/locations/us-central1/operations/update', done: true, response: { name } });
      }
      return Response.json(live);
    }));
    const env = { ...environment, platformBindings: { ...environment.platformBindings, services: { web: { jobName: 'web', resourceUid: 'job-uid' } } } };
    const cron = { ...service, buildConfig: { workloadKind: 'cron' as const, startCommand: 'run-cron' } };
    const result = await f.adapter.setEnvVars(env, cron, {}, { secretVersionRefs: { API_TOKEN: reference } } as any);
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    expect(writes[0]?.template.template.containers[0].env).toContainEqual(native);
    expect(writes[0]?.template.template.containers[0].env).toContainEqual({ name: 'EXISTING', value: 'retained' });
  });
  it('does not overwrite an existing native reference with an unrelated literal synchronization', async () => {
    const f = await fixture();
    await f.adapter.setEnvVars(environment, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any);
    f.writes.length = 0;
    expect(await f.adapter.setEnvVars(environment, service, { API_TOKEN: 'unexpected-literal' })).toMatchObject({ success: false });
    expect(f.writes).toEqual([]);
  });
  it.each([
    { ref: { ...reference, destination: { provider: 'aws-secrets', accountId: '123456789012', region: 'us-east-1', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-AbCdEf' } }, values: {} },
    { ref: reference, values: { API_TOKEN: 'must-not-send' } },
    { ref: { ...reference, version: 'latest' }, values: {} },
    { ref: { ...reference, destination: { ...reference.destination, projectId: 'other-project' } }, values: {} },
  ])('rejects invalid scope, mutable version, unsupported pair or literal conflict before network ($ref.version)', async ({ ref, values }) => {
    const f = await fixture();
    const result = await f.adapter.setEnvVars(environment, service, values as Record<string, string>, { secretVersionRefs: { API_TOKEN: ref } } as any);
    expect(result.success).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });
});
