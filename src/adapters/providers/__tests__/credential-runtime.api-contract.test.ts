import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { afterEach, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';

// Reconstructed documented REST/SDK transport observations. This proves local
// request preservation and exact scope, not live permissions or application use.
// Cloud Run service PATCH supports updateMask; job PATCH has no updateMask or implicit create.
// https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch
// https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/patch
const now = new Date();
const service: Service = { id: 'service-local', projectId: 'project-local', name: 'web', buildConfig: { workloadKind: 'web', healthCheckPath: '/different-desired-probe' }, envVarSpec: {}, createdAt: now, updatedAt: now };
const environment = (platformBindings: Record<string, unknown>): Environment => ({ id: 'environment-local', projectId: 'project-local', name: 'production', platformBindings, createdAt: now, updatedAt: now });
const options = { requireCredentialUpdate: true, deferDeployment: true };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([RailwayAdapter, CloudRunAdapter])('declares selected credential effects separately from ordinary deployment (%s)', Adapter => {
  const adapter = new Adapter();
  expect(['deferred', 'provider-rollout']).toContain((adapter.capabilities as any).credentialUpdateActivation);
  expect(['readback', 'acknowledgement']).toContain((adapter.capabilities as any).credentialValueEvidence);
});

it.each([false, true])('Cloud Run changes only selected env entries in an exact existing workload; job=%s', async job => {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-west1', credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
  const resource = `projects/gcp-project/locations/us-west1/${job ? 'jobs' : 'services'}/bound-web`;
  const container = { name: 'main', image: `registry/image@sha256:${'a'.repeat(64)}`, args: ['keep'], env: [{ name: 'API_KEY', value: 'old' }, { name: 'KEEP_REFERENCE', valueSource: { secretKeyRef: { secret: 'unrelated-secret', version: '7' } } }], volumeMounts: [{ name: 'data', mountPath: '/data' }] };
  const extra = { serviceAccount: 'workload@gcp-project.iam.gserviceaccount.com', volumes: [{ name: 'data', emptyDir: {} }], containers: [container, { name: 'sidecar', image: 'registry/sidecar:stable', env: [{ name: 'KEEP', value: 'yes' }] }] };
  let current: any = { name: resource, uid: 'workload-uid', etag: 'etag-before', generation: '1', observedGeneration: '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' }, latestReadyRevision: 'old', template: job ? { template: extra } : extra };
  const writes: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/v2/${resource}`);
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); writes.push({ body, mask: url.searchParams.get('updateMask') });
      current = { ...current, template: job ? { ...current.template, template: { ...extra, containers: body.template.template.containers } } : { ...extra, containers: body.template.containers }, latestReadyRevision: 'new' };
      return Response.json({ name: 'projects/gcp-project/locations/us-west1/operations/update', done: true, response: current });
    }
    return Response.json(current);
  }));
  const bound = environment({ provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'us-west1', providerScope: { projectId: 'gcp-project', region: 'us-west1' }, services: { web: { [job ? 'jobName' : 'serviceId']: 'bound-web', resourceUid: 'workload-uid' } } });
  const receipt = await adapter.setEnvVars(bound, { ...service, buildConfig: { ...service.buildConfig, workloadKind: job ? 'cron' : 'web', ...(job ? { cronSchedule: '* * * * *', cronCommand: 'do-not-change-command' } : {}) } }, { API_KEY: 'replacement' }, options);
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ success: true, data: { credentialValueEvidence: 'readback' } });
  if (!job) expect(receipt.data).toMatchObject({ deploymentId: `${resource}/revisions/new`, rolloutBaseline: { deploymentId: `${resource}/revisions/old` } });
  expect(writes).toHaveLength(1);
  expect(writes[0].mask).toBe(job ? null : 'template.containers');
  const actual = job ? writes[0].body.template.template.containers : writes[0].body.template.containers;
  expect(actual).toEqual([{ ...container, env: [{ name: 'API_KEY', value: 'replacement' }, container.env[1]] }, extra.containers[1]]);
  expect(writes[0].body.etag).toBe('etag-before');
  expect(await adapter.readProviderEnvironmentVariables({ environment: bound, service })).toEqual({ success: true, variables: { API_KEY: 'replacement' }, unresolvedKeys: ['KEEP_REFERENCE'] });
  const wrongScope = { ...bound, platformBindings: { ...bound.platformBindings, environmentId: 'other-region' } };
  expect((await adapter.readProviderEnvironmentVariables({ environment: wrongScope, service })).success).toBe(false);
  expect(JSON.stringify(receipt)).not.toContain('replacement');
});


// A same-name workload in another region is not the accepted target.
it('Cloud Run refuses a bound region mismatch before any provider request', async () => {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-west1', credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
  const requests = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', requests);
  const result = await adapter.setEnvVars(environment({ provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'europe-west1', services: { web: { serviceId: 'bound-web' } } }), service, { API_KEY: 'replacement' }, options);
  expect(result.success).toBe(false);
  expect(requests).not.toHaveBeenCalled();
});

it('Cloud Run refuses ordinary environment reconciliation without credential-update authority', async () => {
  const adapter = new CloudRunAdapter();
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  const result = await adapter.setEnvVars(environment({ provider: 'cloudrun' }), service, { API_KEY: 'unreviewed' });
  expect(result).toMatchObject({ success: false });
  expect(request).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('unreviewed');
});
