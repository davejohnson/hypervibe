import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunServiceVolumes } from '../cloudrun-service-volume.js';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { observeServiceVolumes, planServiceVolumes, applyServiceVolumeAction } from '../../../../domain/services/service-volume.service.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import type { ObservedState } from '../../../../domain/ports/observe.port.js';

// Synthetic REST shapes from official Filestore Instance/Operation, Compute
// Network/Subnetwork/Operation and Cloud Run v2 Service contracts (2026-09-17).
const target = {
  projectId: 'planner', environmentId: 'staging', serviceId: 'web-staging', mountPath: '/data',
  instanceScope: { projectId: 'cloud-project', projectNumber: '12345', region: 'us-central1', zone: 'us-central1-a',
    serviceName: 'web', network: 'volume-network', subnetwork: 'volume-subnet',
    instanceName: 'volume-data', shareName: 'data', capacityGb: '1024', tier: 'BASIC_HDD' },
};
const networkPath = 'projects/cloud-project/global/networks/volume-network';
const subnetPath = 'projects/cloud-project/regions/us-central1/subnetworks/volume-subnet';
const filesystemPath = 'projects/cloud-project/locations/us-central1-a/instances/volume-data';
const componentBindings = { network: { state: 'bound' as const, externalId: '1001' }, subnet: { state: 'bound' as const, externalId: '1002' } };
const network = { id: '1001', name: 'volume-network', selfLink: `https://www.googleapis.com/compute/v1/${networkPath}`, autoCreateSubnetworks: false };
const subnet = { id: '1002', name: 'volume-subnet', state: 'READY', selfLink: `https://www.googleapis.com/compute/v1/${subnetPath}`, network: network.selfLink, ipCidrRange: '10.42.0.0/26', privateIpGoogleAccess: true, region: 'https://www.googleapis.com/compute/v1/projects/cloud-project/regions/us-central1' };
const filesystem = { name: filesystemPath, state: 'READY', tier: 'BASIC_HDD',
  fileShares: [{ name: 'data', capacityGb: '1024' }],
  networks: [{ network: 'volume-network', modes: ['MODE_IPV4'], ipAddresses: ['10.80.0.2'] }] };
const zone = { name: 'us-central1-a', status: 'UP', region: 'https://www.googleapis.com/compute/v1/projects/cloud-project/regions/us-central1' };
const volumes = () => new CloudRunServiceVolumes(() => ({ projectId: 'cloud-project', region: 'us-central1' }), async () => 'test-token');

describe('Cloud Run staged retained Filestore volumes', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('lists individually authorized prerequisites, provisioned storage cost and attachment', () => {
    const components = volumes().staged.components(target);
    expect(components.map((component) => component.key)).toEqual(['compute-api', 'file-api', 'network', 'subnet', 'filesystem', 'attachment']);
    expect(components.find((component) => component.key === 'filesystem')).toMatchObject({ billable: true, description: expect.stringContaining('1024 GiB') });
    expect(components.find((component) => component.key === 'attachment')?.dependsOn).toContain('filesystem');
  });
  it('re-observes the API prerequisite before attempting a dependent resource write', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('serviceusage.googleapis.com')) return Response.json({ name: 'projects/12345/services/compute.googleapis.com', state: 'DISABLED' });
      if (init?.method === 'POST') return Response.json({ name: 'operation-1', targetId: '1001', targetLink: network.selfLink });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await volumes().staged.applyComponent(target, 'network', {})).toMatchObject({ success: false, mutationAttempted: false });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });
  it.each(['enabled', 'pending', 'lost'])('handles %s API enablement without inventing convergence or retrying a write', async (outcome) => {
    let enabled = false;
    const name = 'projects/12345/services/file.googleapis.com';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (outcome === 'lost') throw new Error('response lost');
        enabled = outcome === 'enabled';
        return Response.json({ name: 'operations/enable-1' });
      }
      return Response.json({ name, state: enabled ? 'ENABLED' : 'DISABLED' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await volumes().staged.applyComponent(target, 'file-api', {});
    expect(result.success).toBe(outcome === 'enabled');
    expect(result.externalId).toBe(outcome === 'lost' ? undefined : name);
    expect(result.mutationAttempted).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('blocks an unavailable reviewed zone instead of selecting another one', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ...zone, status: 'DOWN' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await volumes().staged.observeComponent(target, 'filesystem', {})).toMatchObject({ state: 'unknown', reason: expect.stringContaining('unavailable') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('will not resolve a bound consumer through another connected cloud project', async () => {
    const fetchMock = vi.fn(async () => Response.json({ name: 'projects/12345', projectId: 'cloud-project', state: 'ACTIVE' }));
    vi.stubGlobal('fetch', fetchMock);
    const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: { volume: { mountPath: '/data' } } }, deploy: { strategy: 'manual' } });
    await expect(volumes().staged.resolveTarget({ environment: { platformBindings: {
      provider: 'cloudrun', projectId: 'planner', environmentId: 'us-central1', services: { web: { serviceId: 'web-staging' } },
      providerScope: { projectId: 'other-cloud-project', region: 'us-central1' },
    } }, environmentSpec, serviceName: 'web', mountPath: '/data' })).rejects.toThrow(/scope|project/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('creates one Filestore instance, preserving the acknowledged operation target for recovery', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ name: 'projects/cloud-project/locations/us-central1-a/operations/create-1', metadata: { target: filesystemPath } });
      if (url.includes('/zones/')) return Response.json(zone);
      if (url.includes('serviceusage.googleapis.com')) return Response.json({ name: 'projects/12345/services/file.googleapis.com', state: 'ENABLED' });
      if (url.includes('/networks/')) return Response.json(network);
      if (url.includes('/subnetworks/')) return Response.json(subnet);
      return Response.json({ error: { code: 404 } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await volumes().staged.applyComponent(target, 'filesystem', componentBindings)).toEqual({ success: true, mutationAttempted: true, externalId: filesystemPath });
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe('https://file.googleapis.com/v1/projects/cloud-project/locations/us-central1-a/instances?instanceId=volume-data');
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toMatchObject({ tier: 'BASIC_HDD', fileShares: [{ name: 'data', capacityGb: '1024' }] });
  });
  it('does not manufacture a storage id when the create response is lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('connection closed');
      if (url.includes('/zones/')) return Response.json(zone);
      if (url.includes('serviceusage.googleapis.com')) return Response.json({ name: 'projects/12345/services/file.googleapis.com', state: 'ENABLED' });
      if (url.includes('/networks/')) return Response.json(network);
      if (url.includes('/subnetworks/')) return Response.json(subnet);
      return Response.json({}, { status: 404 });
    }));
    const result = await volumes().staged.applyComponent(target, 'filesystem', componentBindings);
    expect(result).toMatchObject({ success: false, mutationAttempted: true });
    expect(result.externalId).toBeUndefined();
  });
  it('unknown provider reads never become absence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 403 })));
    expect(await volumes().staged.observeComponent(target, 'filesystem', {})).toMatchObject({ state: 'unknown' });
  });
  it.each(['DRAINING', undefined])('does not call a subnet ready with native state %s', async (state) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...subnet, state })));
    expect(await volumes().staged.observeComponent(target, 'subnet', componentBindings)).toMatchObject({ state: 'present', ready: false });
  });
  it.each([
    { ip: '192.168.80.2', executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2', ready: true },
    { ip: '172.20.80.2', executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2', ready: true },
    { ip: '10.80.0.2', executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN1', ready: false },
  ])('verifies NFS address $ip and execution environment $executionEnvironment', async ({ ip, executionEnvironment, ready }) => {
    const servicePath = 'projects/cloud-project/locations/us-central1/services/web-staging';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('run.googleapis.com') ? {
      name: servicePath, terminalCondition: { state: 'CONDITION_SUCCEEDED' }, template: {
        executionEnvironment,
        containers: [{ image: 'image:current', volumeMounts: [{ name: 'hypervibe-files', mountPath: '/data' }] }],
        volumes: [{ name: 'hypervibe-files', nfs: { server: ip, path: '/data' } }],
        vpcAccess: { egress: 'PRIVATE_RANGES_ONLY', networkInterfaces: [{ network: networkPath, subnetwork: subnetPath }] },
      },
    } : { ...filesystem, networks: [{ ...filesystem.networks[0], ipAddresses: [ip] }] })));
    expect(await volumes().staged.observeComponent(target, 'attachment', {
      filesystem: { state: 'bound', externalId: filesystemPath }, attachment: { state: 'bound', externalId: servicePath },
    })).toMatchObject(ready ? { state: 'present', ready: true } : { state: 'unknown' });
  });
  it('verifies complete exact storage shape without declaring a still-creating instance ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/zones/') ? zone : { ...filesystem, state: 'CREATING' })));
    expect(await volumes().staged.observeComponent(target, 'filesystem', {
      filesystem: { state: 'identified', externalId: filesystemPath },
    })).toMatchObject({ state: 'present', externalId: filesystemPath, ready: false });
  });
  it('refuses to mutate a pre-existing unbound instance', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.includes('/zones/') ? zone : url.includes('/networks/') ? network : url.includes('/subnetworks/') ? subnet : filesystem));
    vi.stubGlobal('fetch', fetchMock);
    expect(await volumes().staged.applyComponent(target, 'filesystem', componentBindings)).toMatchObject({ success: false, mutationAttempted: false });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it.each([{ operation: 'delete', dropMount: false }, { operation: 'delete', dropMount: true }, { operation: 'set', dropMount: true }])(
    '$operation env verifies preserved filesystem with provider mount loss=$dropMount', async ({ operation, dropMount }) => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({ projectId: 'cloud-project', credentials: '{}' });
    vi.spyOn(adapter as unknown as { getAccessToken(): Promise<string> }, 'getAccessToken').mockResolvedValue('test-token');
    const vpcAccess = { networkInterfaces: [{ network: networkPath, subnetwork: subnetPath }], egress: 'PRIVATE_RANGES_ONLY' };
    const servicePath = 'projects/cloud-project/locations/us-central1/services/web-staging';
    let liveTemplate = {
      containers: [{ image: 'image:current', env: [{ name: 'KEEP', value: 'yes' }, { name: 'REDIS_URL', value: 'redis://old' }], volumeMounts: [{ name: 'hypervibe-files', mountPath: '/data' }] }],
      volumes: [{ name: 'hypervibe-files', nfs: { server: '10.80.0.2', path: '/data' } }], vpcAccess,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/services/web-staging') && init?.method === 'PATCH') {
        liveTemplate = { ...liveTemplate, ...JSON.parse(String(init.body)).template };
        if (dropMount) liveTemplate.containers[0]!.volumeMounts = [];
        return Response.json({ name: 'projects/cloud-project/locations/us-central1/operations/env-update', done: true, response: { name: servicePath } });
      }
      if (url.includes('/services/web-staging')) return Response.json({ name: servicePath, uid: 'service-uid', generation: '3', observedGeneration: '3', terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' }, template: liveTemplate });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const environment = { id: 'env', projectId: 'project', name: 'staging', createdAt: now, updatedAt: now,
      platformBindings: { provider: 'cloudrun', projectId: 'planner', environmentId: 'staging', services: { web: { serviceId: 'web-staging' } }, cacheNetwork: null,
        serviceVolumes: { web: { provider: 'cloudrun', target, state: 'staged', components: {
          ...componentBindings, filesystem: { state: 'bound', externalId: filesystemPath }, attachment: { state: 'bound', externalId: servicePath },
        } } } },
    };
    const service = { id: 'svc', projectId: 'project', name: 'web', buildConfig: { workloadKind: 'web' as const }, envVarSpec: {}, createdAt: now, updatedAt: now };
    const result = operation === 'delete' ? await adapter.deleteEnvVars(environment, service, ['REDIS_URL']) : await adapter.setEnvVars(environment, service, { KEEP: 'changed' });
    if (dropMount) {
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/mount|filesystem/i);
      return;
    }
    expect(result.success).toBe(true);
    expect(liveTemplate.vpcAccess).toEqual(vpcAccess);
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[0]).not.toContain('template.vpcAccess');
  });

  it('converges isolated production and staging filesystems through shared plan/apply and durable SQLite, then makes no writes', async () => {
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(':memory:').migrate();
    const project = new ProjectRepository().create({ name: 'filesystem-test', defaultPlatform: 'cloudrun' });
    const repo = new EnvironmentRepository();
    const resources = new Map<string, Record<string, any>>();
    const writes: string[] = [];
    let sequence = 1000;
    const driver = volumes();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/(?:compute\/v1|v1|v2|v3)\//, '');
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        writes.push(`${method} ${url}`);
        const body = JSON.parse(String(init?.body));
        if (parsed.hostname === 'compute.googleapis.com') {
          const fullPath = `${path}/${body.name}`;
          const id = String(++sequence);
          resources.set(fullPath, { ...body, id, state: 'READY', selfLink: `https://www.googleapis.com/compute/v1/${fullPath}` });
          return Response.json({ name: `operation-${id}`, targetId: id, targetLink: `https://www.googleapis.com/compute/v1/${fullPath}` });
        }
        if (parsed.hostname === 'file.googleapis.com') {
          const fullPath = `${path}/${parsed.searchParams.get('instanceId')}`;
          resources.set(fullPath, { ...body, name: fullPath, state: 'READY', networks: body.networks.map((network: Record<string, unknown>) => ({ ...network, ipAddresses: ['10.80.0.2'] })) });
          return Response.json({ name: `projects/cloud-project/locations/us-central1-a/operations/file-${++sequence}`, metadata: { target: fullPath } });
        }
        if (parsed.hostname === 'run.googleapis.com' && method === 'PATCH') {
          const current = resources.get(path)!;
          resources.set(path, { ...current, template: { ...current.template, ...body.template } });
          return Response.json({ name: `projects/cloud-project/locations/us-central1/operations/attach-${++sequence}`, done: true, response: { name: path } });
        }
        throw new Error(`Unexpected mutation ${method} ${url}`);
      }
      if (parsed.hostname === 'cloudresourcemanager.googleapis.com') return Response.json({ name: 'projects/12345', projectId: 'cloud-project', state: 'ACTIVE' });
      if (parsed.hostname === 'serviceusage.googleapis.com') return Response.json({ name: path, state: 'ENABLED' });
      if (path.includes('/zones/')) return Response.json(zone);
      return resources.has(path) ? Response.json(resources.get(path)) : Response.json({}, { status: 404 });
    }));
    const spec = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: { volume: { mountPath: '/data' } } }, deploy: { strategy: 'manual' } });
    try {
      const filesystemNames: string[] = [];
      for (const name of ['production', 'staging']) {
        const serviceId = `web-${name}`;
        const servicePath = `projects/cloud-project/locations/us-central1/services/${serviceId}`;
        resources.set(servicePath, { name: servicePath, etag: `etag-${name}`, terminalCondition: { state: 'CONDITION_SUCCEEDED' },
          template: { serviceAccount: 'runtime@cloud-project.iam.gserviceaccount.com', containers: [{ image: `image:${name}`, env: [{ name: 'KEEP', value: name }] }] } });
        const environment = repo.create({ projectId: project.id, name, platformBindings: { provider: 'cloudrun', projectId: 'planner', environmentId: 'us-central1', providerScope: { projectId: 'cloud-project', region: 'us-central1' }, services: { web: { serviceId } } } });
        let converged = false;
        for (let iteration = 0; iteration < 8; iteration++) {
          const fresh = repo.findById(environment.id)!;
          const observed = await observeServiceVolumes({ environment: fresh, environmentSpec: spec, volumes: driver });
          const actions = planServiceVolumes({ environment: fresh, environmentSpec: spec, observed: { serviceVolumes: observed } as ObservedState }).actions;
          const next = actions.find((action) => action.type !== 'noop');
          if (!next) { converged = true; break; }
          expect(next.metadata?.blockedReason, JSON.stringify(actions)).toBeUndefined();
          const result = await applyServiceVolumeAction({ environment: fresh, environmentSpec: spec, volumes: driver, action: next, confirmedActionIds: new Set([next.id]),
            save: (serviceVolumes) => { repo.updatePlatformBindings(environment.id, { serviceVolumes }); } });
          expect(result, JSON.stringify(next)).toMatchObject({ success: true });
        }
        expect(converged).toBe(true);
        const retained = repo.findById(environment.id)!.platformBindings.serviceVolumes as Record<string, any>;
        filesystemNames.push(retained.web.components.filesystem.externalId);
        expect(resources.get(servicePath)?.template.containers[0]).toMatchObject({ image: `image:${name}`, env: [{ name: 'KEEP', value: name }], volumeMounts: [{ name: 'hypervibe-files', mountPath: '/data' }] });
        expect(resources.get(servicePath)?.template.executionEnvironment).toBe('EXECUTION_ENVIRONMENT_GEN2');
        const beforeNoop = writes.length;
        await observeServiceVolumes({ environment: repo.findById(environment.id)!, environmentSpec: spec, volumes: driver });
        expect(writes).toHaveLength(beforeNoop);
      }
      expect(new Set(filesystemNames).size).toBe(2);
      expect(writes).toHaveLength(8); // network, subnet, filesystem, attachment per environment
    } finally { SqliteAdapter.resetInstance(); }
  });
});
