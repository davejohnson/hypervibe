import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/application/providers.js';
import { environmentSpecSchema, projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { validateProjectSpecProviders } from '../../src/domain/services/provider-spec-validation.js';
import { CloudRunAdapter } from '../../src/adapters/providers/gcp/cloudrun.adapter.js';
import { diffEnvironment } from '../../src/domain/plan/diff.engine.js';
import { specToBootstrapParams } from '../../src/domain/spec/spec-bootstrap.js';
import { fingerprintObservedState } from '../../src/domain/plan/converge.executor.js';
import type { ObservedState } from '../../src/domain/ports/observe.port.js';

const bounds = { min: 0, max: 1 };
const environment = { hosting: { provider: 'cloudrun' }, services: { web: { instanceBounds: bounds } } };
const providers = ['azure-container-apps', 'cloudrun', 'digitalocean', 'ecs', 'fly', 'railway', 'vercel'];
afterEach(() => vi.unstubAllGlobals());

describe('reviewed service instance bounds', () => {
  it('carries reviewed bounds through local configuration and detects live drift with confirmation', () => {
    const spec = environmentSpecSchema.parse(environment);
    expect(specToBootstrapParams('app', 'staging', spec).serviceConfig?.web.instanceBounds).toEqual(bounds);
    const observed: ObservedState = { provider: 'cloudrun', projectExists: true, projectId: 'bounds-project', environmentId: 'us-central1',
      observedAt: new Date().toISOString(), partial: false, warnings: [], databases: [], services: [{
        name: 'web', externalId: 'web', workloadKind: 'web', customDomains: [], status: 'running', envVarKeys: [], envVarHashes: {},
        config: { instanceBounds: { min: 0, max: 5 } },
      }] };
    const local = { projectExists: true, environmentExists: true, services: [{ id: 'local-web', projectId: 'app', name: 'web',
      buildConfig: {}, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() }], components: [], bindings: {
      provider: 'cloudrun', projectId: 'bounds-project', environmentId: 'us-central1', services: { web: { serviceId: 'web' } },
    } };
    const input = { spec, observed, local, envName: 'staging' };
    const action = diffEnvironment(input).actions.find(entry => entry.id === 'service:web');
    expect(action).toMatchObject({ type: 'update', verified: true, requiresConfirm: true,
      diff: [{ field: 'instanceBounds', from: '0–5', to: '0–1' }] });
    const before = fingerprintObservedState(observed);
    observed.services[0].config.instanceBounds = bounds;
    expect(fingerprintObservedState(observed)).not.toBe(before);
    expect(diffEnvironment(input).actions.find(entry => entry.id === 'service:web')).toMatchObject({ type: 'noop' });
    observed.partial = true;
    expect(diffEnvironment(input).actions.find(entry => entry.id === 'service:web')).toMatchObject({ type: 'update', verified: false,
      metadata: { blockedReason: 'service_instance_bounds_unknown' } });
    observed.partial = false;
    delete observed.services[0].config.instanceBounds;
    expect(diffEnvironment(input).actions.find(entry => entry.id === 'service:web')).toMatchObject({ verified: false,
      metadata: { blockedReason: 'service_instance_bounds_unknown' } });
    delete spec.services.web.instanceBounds;
    expect(diffEnvironment(input).actions.find(entry => entry.id === 'service:web')).toMatchObject({ type: 'noop' });
  });
  it('accepts the declared bounds without dropping them at the shared spec boundary', () => {
    expect(environmentSpecSchema.parse(environment).services.web).toMatchObject({ instanceBounds: bounds });
  });
  it.each([{ min: -1, max: 1 }, { min: 2, max: 1 }, { min: 0, max: 0 }, { min: 0.5, max: 1 }, { max: 1 }])('rejects invalid desired bounds %j', instanceBounds => {
    expect(environmentSpecSchema.safeParse({ ...environment, services: { web: { instanceBounds } } }).success).toBe(false);
  });
  it('requires a worker floor and rejects service bounds on scheduled jobs', () => {
    for (const service of [{ workloadKind: 'worker', instanceBounds: bounds },
      { workloadKind: 'cron', startCommand: 'npm run tick', cronSchedule: '* * * * *', instanceBounds: bounds }]) {
      expect(environmentSpecSchema.safeParse({ ...environment, services: { web: service } }).success).toBe(false);
    }
  });
  it('pins the named provider roster and rejects undeclared adapter support', () => {
    expect(providerRegistry.namesFor('hosting').sort()).toEqual(providers);
    for (const provider of providers) {
      const spec = projectSpecSchema.parse({ version: 1, project: 'bounds-contract', environments: {
        staging: { ...environment, hosting: { provider } },
      } });
      const issues = validateProjectSpecProviders(spec).filter(issue => issue.configuration?.path.endsWith('.instanceBounds'));
      expect(issues.length, provider).toBe(provider === 'cloudrun' ? 0 : 1);
    }
  });
  it.each([
    { scaling: { minInstanceCount: 0, maxInstanceCount: 1 }, expected: bounds },
    { scaling: { maxInstanceCount: 1 }, expected: bounds },
    { scaling: undefined, expected: { min: 0, max: 0 } },
    { scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 }, expected: undefined },
    { scaling: { maxInstanceCount: '1' }, invalid: true },
    { scaling: { minInstanceCount: 2, maxInstanceCount: 1 }, invalid: true },
    { scaling: { scalingMode: 'UNKNOWN_MODE', maxInstanceCount: 1 }, invalid: true },
  ])('observes native bounds and documented defaults, or rejects malformed evidence: %j', async ({ scaling, expected, invalid }) => {
    // Independently reconstructed from Cloud Run ServiceScaling, linked in the
    // shared contract. Service identity is synthetic; no request-derived reply.
    const native = { name: 'projects/bounds-project/locations/us-central1/services/web', uid: 'native-web-uid',
      generation: '1', observedGeneration: '1', reconciling: false,
      terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
      labels: { 'infraprint-environment': 'staging', 'infraprint-service': 'web' },
      scaling, template: { containers: [{ image: 'example.invalid/web@sha256:' + 'a'.repeat(64) }] } };
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init); expect(request.method).toBe('GET'); requests.push(request.url);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/services')) return Response.json({ services: [native] });
      if (url.pathname.endsWith('/web:getIamPolicy')) return Response.json({ bindings: [] });
      if (url.pathname.endsWith('/jobs')) return Response.json({ jobs: [] });
      if (url.pathname.includes('domainmappings')) return Response.json({ items: [] });
      throw new Error('Unexpected serialized observation endpoint');
    });
    const adapter = new CloudRunAdapter();
    await adapter.connect({ projectId: 'bounds-project', region: 'us-central1', credentials: JSON.stringify({
      type: 'service_account', project_id: 'bounds-project', client_email: 'deployer@bounds-project.iam.gserviceaccount.com', private_key: 'synthetic-key',
    }) });
    Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
    const observation = adapter.observe({ id: 'env-id', projectId: 'app-id', name: 'staging',
      platformBindings: { provider: 'cloudrun', projectId: 'bounds-project', environmentId: 'us-central1', region: 'us-central1',
        services: { web: { serviceId: 'web' } } }, createdAt: new Date(), updatedAt: new Date() });
    if (invalid) { await expect(observation).rejects.toThrow(/scaling|bounds/); return; }
    const result = await observation;
    expect(result.partial).toBe(false);
    expect(result.services[0]?.config.instanceBounds).toEqual(expected);
    expect(requests.length).toBeGreaterThan(0);
  });
  it.each(['applied', 'lost', 'manual', 'unmanaged', 'worker-unmanaged'] as const)('direct deployment verifies %s service limits through serialized transport', async outcome => {
    const path = 'projects/bounds-project/locations/us-central1/services/web';
    const image = 'us-central1-docker.pkg.dev/bounds-project/app/web@sha256:' + 'b'.repeat(64);
    const worker = outcome === 'worker-unmanaged', unmanaged = outcome === 'unmanaged' || worker;
    const original = { name: path, uid: 'web-lifetime', etag: 'etag-before', generation: '1', observedGeneration: '1',
      terminalCondition: { state: 'CONDITION_SUCCEEDED' },
      scaling: outcome === 'manual' ? { scalingMode: 'MANUAL', manualInstanceCount: 0 } : { minInstanceCount: 0, maxInstanceCount: 5 },
      template: { serviceAccount: 'runtime@bounds-project.iam.gserviceaccount.com', scaling: { maxInstanceCount: 3 },
        containers: [{ image, resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: !worker } }] } };
    let live: any = structuredClone(original);
    const writes: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/web:getIamPolicy') && request.method === 'GET') return Response.json({ bindings: [] });
      if (url.pathname === '/v2/' + path) {
        if (request.method === 'PATCH') {
          const body = await request.json();
          writes.push({ url: request.url, body });
          // Independently reconstructed native update: service scaling changes only
          // when named by the update mask, and protobuf zero min may be omitted.
          live = { ...original, template: body.template, annotations: body.annotations,
            ...(outcome === 'applied' && url.searchParams.get('updateMask')?.split(',').includes('scaling')
              ? { scaling: { maxInstanceCount: 1 } } : {}) };
          return Response.json({ name: 'projects/bounds-project/locations/us-central1/operations/update-web', done: true,
            response: { '@type': 'type.googleapis.com/google.cloud.run.v2.Service', name: path } });
        }
        expect(request.method).toBe('GET');
        return Response.json(live);
      }
      throw new Error('Unexpected serialized deployment endpoint');
    });
    const adapter = new CloudRunAdapter();
    await adapter.connect({ projectId: 'bounds-project', region: 'us-central1', credentials: JSON.stringify({ type: 'service_account',
      project_id: 'bounds-project', client_email: 'deploy@bounds-project.iam.gserviceaccount.com', private_key: 'synthetic-key' }) });
    Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
    const now = new Date();
    const result = await adapter.deploy({ id: 'web', projectId: 'app', name: 'web', envVarSpec: {}, createdAt: now, updatedAt: now,
      buildConfig: { workloadKind: worker ? 'worker' : 'web', public: false, ...(unmanaged ? {} : { instanceBounds: bounds }) } },
    { id: 'staging', projectId: 'app', name: 'staging', createdAt: now, updatedAt: now, platformBindings: {
      provider: 'cloudrun', projectId: 'bounds-project', environmentId: 'us-central1', region: 'us-central1', services: { web: { serviceId: 'web' } },
    } }, { IMAGE_URI: image });
    expect(result.receipt.success, result.receipt.error).toBe(outcome === 'applied' || unmanaged);
    expect(writes).toHaveLength(outcome === 'manual' ? 0 : 1);
    if (outcome === 'applied') expect(writes[0].body).toMatchObject({ scaling: { scalingMode: 'AUTOMATIC', minInstanceCount: 0, maxInstanceCount: 1 } });
    if (unmanaged) {
      expect(writes[0].body).not.toHaveProperty('scaling');
      expect(writes[0].url).not.toContain(',scaling');
      expect(writes[0].body.template.scaling).toEqual({ ...original.template.scaling, ...(worker ? { minInstanceCount: 1 } : {}) });
      expect(writes[0].body.template.containers[0].resources.cpuIdle).toBe(!worker);
    }
  });
});
