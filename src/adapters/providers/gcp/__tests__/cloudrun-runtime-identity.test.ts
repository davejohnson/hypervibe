import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import { CloudRunAdapter } from '../cloudrun.adapter.js';

// Reconstructed Cloud Run v2 response fields; real adapter/request boundary.
// https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
// https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs
const projectId = 'cloud-project';
const principal = `runtime@${projectId}.iam.gserviceaccount.com`;
const now = new Date();
const service: Service = { id: 'service-1', projectId: 'project-1', name: 'web',
  buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: now, updatedAt: now };
function environment(bound = true): Environment {
  return { id: 'env-1', projectId: 'project-1', name: 'test', createdAt: now, updatedAt: now,
    platformBindings: { projectId, environmentId: 'us-central1', region: 'us-central1', ...(bound ? { services: { web: { serviceId: 'bound-web' } } } : {}) } };
}
async function adapter() {
  const result = new CloudRunAdapter();
  await result.connect({ projectId, runtimeServiceAccountEmail: principal,
    credentials: JSON.stringify({ type: 'service_account', project_id: projectId,
      client_email: `deploy@${projectId}.iam.gserviceaccount.com`, private_key: 'synthetic-key' }) });
  Object.assign(result, { accessToken: 'synthetic-access-token', tokenExpiry: new Date(Date.now() + 60_000) });
  return result;
}
afterEach(() => vi.unstubAllGlobals());

describe('Cloud Run provider-owned runtime identity', () => {
  it.each(['web', 'cron'] as const)('observes exact bound %s identity without writes', async (kind) => {
    const env = environment();
    const workload = { ...service, buildConfig: { workloadKind: kind } };
    if (kind === 'cron') env.platformBindings.services = { web: { jobName: 'bound-web' } };
    const path = `projects/${projectId}/locations/us-central1/${kind === 'cron' ? 'jobs' : 'services'}/bound-web`;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`https://run.googleapis.com/v2/${path}`);
      expect(init?.method ?? 'GET').toBe('GET');
      return Response.json({ name: path, template: kind === 'cron'
        ? { template: { serviceAccount: principal } } : { serviceAccount: principal } });
    });
    vi.stubGlobal('fetch', request);
    await expect((await adapter()).resolveRuntimeIdentity(env, workload)).resolves.toEqual({
      provider: 'gcp', principal, scope: { projectId }, source: 'observed',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('labels provider-confirmed absence on an unbound target as configured, not observed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
    await expect((await adapter()).resolveRuntimeIdentity(environment(false), service)).resolves.toEqual({
      provider: 'gcp', principal, scope: { projectId }, source: 'configured',
    });
  });

  it.each([
    { label: 'bound but missing', status: 404, bound: true, body: {} },
    { label: 'unknown read', status: 403, bound: false, body: {} },
    { label: 'unbound lookalike', status: 200, bound: false,
      body: { name: 'projects/cloud-project/locations/us-central1/services/web', template: { serviceAccount: principal } } },
    { label: 'other principal', status: 200, bound: true,
      body: { name: 'projects/cloud-project/locations/us-central1/services/bound-web', template: { serviceAccount: 'other@cloud-project.iam.gserviceaccount.com' } } },
    { label: 'other resource scope', status: 200, bound: true,
      body: { name: 'projects/other-project/locations/us-central1/services/bound-web', template: { serviceAccount: principal } } },
    { label: 'missing principal', status: 200, bound: true,
      body: { name: 'projects/cloud-project/locations/us-central1/services/bound-web', template: {} } },
  ])('rejects $label', async ({ status, bound, body }) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
    await expect((await adapter()).resolveRuntimeIdentity(environment(bound), service)).rejects.toThrow();
  });

  it('rejects a mismatched bound project before provider access', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const env = environment();
    env.platformBindings.projectId = 'other-project';
    await expect((await adapter()).resolveRuntimeIdentity(env, service)).rejects.toThrow(/scope|project/i);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['europe-west1', undefined])('rejects canonical region %s before accepting a same-name workload elsewhere', async (boundRegion) => {
    const request = vi.fn(async () => Response.json({
      name: 'projects/cloud-project/locations/us-central1/services/bound-web', template: { serviceAccount: principal },
    }));
    vi.stubGlobal('fetch', request);
    const env = environment();
    env.platformBindings.environmentId = boundRegion;
    await expect((await adapter()).resolveRuntimeIdentity(env, service)).rejects.toThrow(/scope|region/i);
    expect(request).not.toHaveBeenCalled();
  });
});
