import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlyClient } from '../fly.client.js';
import { FlyServiceVolumes } from '../fly-service-volume.js';
import { FlyAdapter } from '../fly.adapter.js';
import type { FlyMachine } from '../fly.client.js';
import { formatFlyEnvironmentBinding, formatFlyServiceBinding } from '../fly.binding.js';

const app = { id: 'app-staging', name: 'staging-web', organization: { slug: 'example' } };
const target = {
  projectId: 'flyorg:example',
  environmentId: formatFlyEnvironmentBinding({ organizationSlug: 'example', projectName: 'planner', environmentName: 'staging' }),
  serviceId: formatFlyServiceBinding({ organizationSlug: 'example', appId: app.id, appName: app.name }),
  mountPath: '/data', instanceScope: { region: 'ord', sizeGb: '1', serviceName: 'web' },
};
const disk = { id: 'vol_staging', name: 'data', region: 'ord', size_gb: 1, encrypted: true, state: 'created', attached_machine_id: null };

function fixture(options: { volumes?: unknown; machines?: unknown; createError?: boolean; observedApp?: unknown } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === 'POST') {
      if (options.createError) throw new Error('response lost');
      return Response.json(disk);
    }
    if (path.endsWith('/machines')) return Response.json(options.machines ?? []);
    if (path.endsWith('/volumes')) return Response.json(options.volumes ?? []);
    if (path.endsWith('/volumes/vol_staging')) return Response.json(disk);
    if (path.endsWith('/staging-web')) return Response.json(options.observedApp ?? app);
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const volumes = new FlyServiceVolumes(() => new FlyClient('test-token', 'example'), () => 'ord');
  return { volumes, fetchMock };
}

describe('Fly staged filesystem boundary (synthetic official HTTP shapes)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('declares a separate explicitly sized retained filesystem step', () => {
    const { volumes } = fixture();
    expect(volumes.staged.components(target)).toEqual([expect.objectContaining({
      key: 'filesystem', dependsOn: [], operation: 'create', billable: true,
      description: expect.stringContaining('1 GB'),
    })]);
  });

  it('creates only the disk, returning its acknowledgement for durable recovery', async () => {
    const { volumes, fetchMock } = fixture();
    expect(await volumes.staged.applyComponent(target, 'filesystem', {})).toEqual({
      success: true, externalId: disk.id, mutationAttempted: true,
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toMatch(/\/volumes$/);
  });

  it('never infers create ownership from a name after a lost response', async () => {
    const { volumes, fetchMock } = fixture({ createError: true });
    const result = await volumes.staged.applyComponent(target, 'filesystem', {});
    expect(result).toMatchObject({ success: false, mutationAttempted: true });
    expect(result.externalId).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('does not adopt an existing unbound disk', async () => {
    const { volumes, fetchMock } = fixture({ volumes: [disk] });
    expect(await volumes.staged.applyComponent(target, 'filesystem', {})).toMatchObject({ success: false, mutationAttempted: false });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('blocks attaching storage to an existing diskless Machine before any mutation', async () => {
    const { volumes, fetchMock } = fixture({ machines: [{ id: 'old-machine', config: {} }] });
    expect(await volumes.staged.applyComponent(target, 'filesystem', {})).toMatchObject({ success: false, mutationAttempted: false });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('observes exact retained backing storage without claiming runtime attachment', async () => {
    const { volumes } = fixture({ volumes: [disk] });
    expect(await volumes.staged.observeComponent(target, 'filesystem', {
      filesystem: { state: 'identified', externalId: disk.id },
    })).toEqual({ state: 'present', externalId: disk.id, pendingDeletion: false, ready: true });
  });

  it('preserves unknown cross-organization scope instead of absence', async () => {
    const { volumes, fetchMock } = fixture({ observedApp: { ...app, organization: { slug: 'other' } } });
    expect(await volumes.observe(target)).toMatchObject({ state: 'unknown' });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('rejects a different known component before any request', async () => {
    const { volumes, fetchMock } = fixture();
    expect(await volumes.staged.applyComponent(target, 'network', {})).toMatchObject({ success: false, mutationAttempted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an app-only binding stage makes no Machine, disk, IP or secret writes', async () => {
    const { fetchMock } = fixture();
    const adapter = new FlyAdapter();
    await adapter.connect({ apiToken: 'test-token', organizationSlug: 'example' });
    const result = await adapter.deploy({
      id: 'svc', projectId: 'project', name: 'web', buildConfig: { workloadKind: 'web', builder: 'dockerfile' },
      envVarSpec: {}, createdAt: new Date(), updatedAt: new Date(),
    }, {
      id: 'env', projectId: 'project', name: 'staging', createdAt: new Date(), updatedAt: new Date(),
      platformBindings: { provider: 'fly', projectId: target.projectId, environmentId: target.environmentId,
        services: { web: { serviceId: target.serviceId } } },
    }, {}, { deferWorkload: true });
    expect(result.receipt.success).toBe(true);
    expect(result.externalId).toBe(target.serviceId);
    expect(result.receipt.data).toMatchObject({ workloadDeferred: true });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('does not reinterpret a lost bound Machine as a new empty app', async () => {
    fixture();
    const adapter = new FlyAdapter();
    await adapter.connect({ apiToken: 'test-token', organizationSlug: 'example' });
    const now = new Date();
    const result = await adapter.deploy({ id: 'svc', projectId: 'project', name: 'web', buildConfig: {}, envVarSpec: {}, createdAt: now, updatedAt: now }, {
      id: 'env', projectId: 'project', name: 'staging', createdAt: now, updatedAt: now,
      platformBindings: { provider: 'fly', projectId: target.projectId, environmentId: target.environmentId, services: {
        web: { serviceId: formatFlyServiceBinding({ organizationSlug: 'example', appId: app.id, appName: app.name, machineId: 'lost-machine' }) },
      } },
    }, {}, { deferWorkload: true });
    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toMatch(/bound.*Machine|Machine.*missing/i);
  });

  it('observes an exact empty app as identity-only, distinct from a created bootstrap Machine', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/apps') return Response.json({ apps: [app] });
      if (path.endsWith('/ip_assignments')) return Response.json({ ips: [] });
      if (path.endsWith('/secrets')) return Response.json({ secrets: [] });
      if (path.endsWith('/certificates')) return Response.json({ certificates: [] });
      if (path.endsWith('/machines')) return Response.json([]);
      throw new Error(`Unexpected observation ${path}`);
    }));
    const adapter = new FlyAdapter();
    await adapter.connect({ apiToken: 'test-token', organizationSlug: 'example' });
    const result = await adapter.observe({
      id: 'env', projectId: 'project', name: 'staging', createdAt: new Date(), updatedAt: new Date(),
      platformBindings: { provider: 'fly', projectId: target.projectId, environmentId: target.environmentId,
        services: { web: { serviceId: target.serviceId } } },
    });
    expect(result.services[0]).toMatchObject({ externalId: target.serviceId, status: 'empty', identityOnly: true });
  });

  it('creates the first Machine with the exact separately bound disk and never creates storage', async () => {
    let machine: FlyMachine | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (init?.method === 'POST') {
        expect(path).toBe('/v1/apps/staging-web/machines');
        machine = { id: 'machine-staging', instance_id: 'version-1', state: 'created', config: JSON.parse(String(init.body)).config };
        expect(machine.config?.mounts).toEqual([{ volume: disk.id, path: '/data' }]);
        return Response.json(machine);
      }
      if (path.endsWith('/machines')) return Response.json(machine ? [machine] : []);
      if (path.endsWith('/machines/machine-staging')) return Response.json(machine);
      if (path.endsWith('/volumes')) return Response.json([disk]);
      if (path.endsWith('/volumes/vol_staging')) return Response.json(disk);
      if (path.endsWith('/ip_assignments')) return Response.json({ ips: [] });
      if (path.endsWith('/staging-web')) return Response.json(app);
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new FlyAdapter();
    await adapter.connect({ apiToken: 'test-token', organizationSlug: 'example' });
    adapter.configureTarget({ region: 'ord' });
    const result = await adapter.deploy({
      id: 'svc', projectId: 'project', name: 'web', buildConfig: { workloadKind: 'web', public: false, builder: 'dockerfile' },
      envVarSpec: {}, createdAt: new Date(), updatedAt: new Date(),
    }, {
      id: 'env', projectId: 'project', name: 'staging', createdAt: new Date(), updatedAt: new Date(),
      platformBindings: { provider: 'fly', projectId: target.projectId, environmentId: target.environmentId,
        services: { web: { serviceId: target.serviceId } } },
    }, {}, { serviceVolume: { externalId: disk.id, mountPath: '/data', target } });
    expect(result.receipt.success).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each(['set', 'delete'])('does not report %s env success when the provider drops a retained mount', async (operation) => {
    const before: FlyMachine = { id: 'machine-staging', instance_id: 'version-1', state: 'started', config: {
      image: 'image:current', mounts: [{ volume: disk.id, path: '/data' }], metadata: {
        hypervibe_managed: 'true', hypervibe_project_id: 'planner', hypervibe_environment_id: target.environmentId,
        hypervibe_service_name: 'web', hypervibe_workload_kind: 'web',
      },
    } };
    let current = before;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/secrets')) return Response.json(init?.method === 'POST' ? { version: 2 } : { secrets: operation === 'set' ? [{ name: 'KEY' }] : [] });
      if (path.endsWith('/machines/machine-staging')) {
        if (init?.method === 'POST') current = { ...before, instance_id: 'version-2', config: { ...JSON.parse(String(init.body)).config, mounts: [] } };
        return Response.json(current);
      }
      if (path.endsWith('/machines')) return Response.json([current]);
      if (path.endsWith('/staging-web')) return Response.json(app);
      throw new Error(`Unexpected request ${path}`);
    }));
    const adapter = new FlyAdapter();
    await adapter.connect({ apiToken: 'test-token', organizationSlug: 'example' });
    const now = new Date();
    const environment = { id: 'env', projectId: 'project', name: 'staging', createdAt: now, updatedAt: now, platformBindings: {
      provider: 'fly', projectId: target.projectId, environmentId: target.environmentId,
      services: { web: { serviceId: formatFlyServiceBinding({ organizationSlug: 'example', appId: app.id, appName: app.name, machineId: before.id }) } },
    } };
    const service = { id: 'svc', projectId: 'project', name: 'web', buildConfig: {}, envVarSpec: {}, createdAt: now, updatedAt: now };
    const result = operation === 'set' ? await adapter.setEnvVars(environment, service, { KEY: 'value' }) : await adapter.deleteEnvVars(environment, service, ['KEY']);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mount|filesystem/i);
  });
});
