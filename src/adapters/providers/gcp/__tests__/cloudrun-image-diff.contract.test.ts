import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import '../../aws/ecs-express.adapter.js';
import '../../azure/azure-container-apps.adapter.js';
import '../../railway/railway.adapter.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { diffEnvironment } from '../../../../domain/plan/diff.engine.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

const image = `us-central1-docker.pkg.dev/gcp-project/apps/web@sha256:${'a'.repeat(64)}`;
const otherImage = image.replace(/a{64}$/, 'b'.repeat(64));
const resource = 'projects/gcp-project/locations/us-central1/services/gcp-project-web';

// Reconstructed native REST responses. Google documents Container.image separately
// from Container.env, and successful reconciliation separately from desired state:
// https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
async function observeAndPlan(options: {
  nativeImage?: string | null;
  envVars?: Record<string, string>;
  nativeEnv?: Array<{ name: string; value: string }>;
  extraContainer?: boolean;
  uid?: string | number;
  legacyBinding?: boolean;
  pending?: boolean;
  job?: boolean;
} = {}) {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-central1', credentials: JSON.stringify({
    type: 'service_account', project_id: 'gcp-project', private_key: 'synthetic',
    client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
  }) });
  Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60_000) });
  const native = {
    name: resource, uid: options.uid ?? 'service-lifetime', generation: '2', observedGeneration: '2',
    reconciling: options.pending === true,
    latestCreatedRevision: `${resource}/revisions/web-2`, latestReadyRevision: `${resource}/revisions/web-2`,
    terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
    labels: { 'infraprint-environment': 'production', 'infraprint-service': 'web' },
    template: { containers: [{
      ...(options.nativeImage === null ? {} : { image: options.nativeImage ?? image }),
      env: options.nativeEnv ?? [{ name: 'NODE_ENV', value: 'production' }],
    }, ...(options.extraContainer ? [{ image: otherImage, env: [] }] : [])] },
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('Observation must not mutate provider state');
    if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?')) return Response.json({ services: options.job ? [] : [native] });
    if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs?')) return Response.json({ jobs: options.job ? [{
      ...native, name: resource.replace('/services/', '/jobs/'), template: { template: native.template },
    }] : [] });
    if (options.job && url.includes('/jobs/gcp-project-web/executions?')) return Response.json({ executions: [] });
    if (options.job && url === 'https://cloudscheduler.googleapis.com/v1/projects/gcp-project/locations/us-central1/jobs/gcp-project-web-schedule') return Response.json({
      name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-web-schedule', schedule: '* * * * *', state: 'ENABLED',
    });
    if (url.startsWith('https://us-central1-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/gcp-project/domainmappings?')) return Response.json({ items: [] });
    if (url === `https://run.googleapis.com/v2/${resource}:getIamPolicy`) return Response.json({ bindings: [] });
    throw new Error(`Unexpected synthetic read: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const now = new Date();
  const environment: Environment = { id: 'env', projectId: 'project', name: 'production', createdAt: now, updatedAt: now,
    platformBindings: { provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'us-central1',
      services: { web: { serviceId: 'gcp-project-web', ...(options.job ? { jobName: 'gcp-project-web' } : {}),
        ...(!options.legacyBinding ? { resourceUid: 'service-lifetime' } : {}), imageUri: otherImage } } } };
  const observed = await adapter.observe(environment);
  const spec = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: { public: false } },
    envVars: { NODE_ENV: 'production', IMAGE_URI: image, ...options.envVars } });
  const local = { projectExists: true, environmentExists: true, services: [], components: [],
    bindings: { provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'us-central1', services: { web: { serviceId: 'gcp-project-web' } } } };
  const planned = diffEnvironment({ spec, envName: 'production', observed, local,
    providerBehavior: providerRegistry.getMetadata('cloudrun')?.orchestration?.diff });
  return { observed, planned, spec, local, fetchMock };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Cloud Run image selection is observed configuration, not runtime environment', () => {
  it('makes an exact ready image a noop without inventing IMAGE_URI runtime hashes', async () => {
    const { observed, planned, fetchMock } = await observeAndPlan();
    expect(observed.partial).toBe(false);
    expect(observed.services[0]?.config).toMatchObject({ imageUri: image });
    expect(observed.services[0]?.envVarKeys).not.toContain('IMAGE_URI');
    expect(observed.services[0]?.envVarHashes).not.toHaveProperty('IMAGE_URI');
    expect(planned.actions.find(action => action.id === 'service:web')).toMatchObject({ type: 'noop' });
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('compares the native image even when a misleading runtime variable matches the desired input', async () => {
    const { planned } = await observeAndPlan({ nativeImage: otherImage, nativeEnv: [
      { name: 'NODE_ENV', value: 'production' }, { name: 'IMAGE_URI', value: image },
    ] });
    expect(planned.actions.find(action => action.id === 'service:web')).toMatchObject({
      type: 'update', diff: [{ field: 'env:IMAGE_URI' }],
    });
  });

  it('observes the same separate native image field for an exact scheduled job', async () => {
    const { observed, fetchMock } = await observeAndPlan({ job: true });
    expect(observed.partial).toBe(false);
    expect(observed.services[0]).toMatchObject({ workloadKind: 'cron', config: { imageUri: image } });
    expect(observed.services[0]?.envVarHashes).not.toHaveProperty('IMAGE_URI');
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it.each([false, true])('withholds image evidence for a malformed native lifetime on a legacy binding (job=%s)', async job => {
    const { observed } = await observeAndPlan({ job, uid: 1, legacyBinding: true });
    expect(observed.services[0]?.config).not.toHaveProperty('imageUri');
  });

  it('uses the same specific-over-global priority as deployment and trims selector values', async () => {
    const { planned } = await observeAndPlan({ envVars: { IMAGE_URI: otherImage, IMAGE_URI_WEB: ` ${image} ` } });
    expect(planned.actions.find(action => action.id === 'service:web')).toMatchObject({ type: 'noop' });
  });

  it.each([
    { nativeImage: null }, { nativeImage: 'registry.example/app:latest' }, { extraContainer: true }, { uid: 'replacement-lifetime' },
  ])('blocks unknown or ambiguous native image evidence: %j', async options => {
    const { planned } = await observeAndPlan(options);
    expect(planned.actions.find(action => action.id === 'service:web')).toMatchObject({
      type: 'update', verified: false, metadata: { blockedReason: 'service_image_unknown' },
    });
  });

  it('does not turn a still-reconciling service into a noop', async () => {
    const { planned } = await observeAndPlan({ pending: true });
    expect(planned.actions.find(action => action.id === 'service:web')).toMatchObject({
      type: 'update', metadata: { blockedReason: 'service_status_unknown' },
    });
  });

  it('continues comparing ordinary runtime variables independently', async () => {
    const { planned } = await observeAndPlan({ envVars: { NODE_ENV: 'staging' } });
    expect(planned.actions.find(action => action.id === 'service:web')).toMatchObject({
      type: 'update', diff: [{ field: 'env:NODE_ENV' }],
    });
  });

  it.each(['railway', 'ecs', 'azure-container-apps'])('does not reinterpret %s environment keys without its registered selector contract', async provider => {
    const { observed, spec, local } = await observeAndPlan();
    expect(providerRegistry.getMetadata(provider)).toBeDefined();
    const result = diffEnvironment({ spec: { ...spec, hosting: { ...spec.hosting, provider } }, envName: 'production',
      observed: { ...observed, provider }, local: { ...local, bindings: { ...local.bindings, provider } },
      providerBehavior: providerRegistry.getMetadata(provider)?.orchestration?.diff });
    expect(result.actions.find(action => action.id === 'service:web')).toMatchObject({ type: 'update', diff: [{ field: 'env:IMAGE_URI' }] });
  });
});
