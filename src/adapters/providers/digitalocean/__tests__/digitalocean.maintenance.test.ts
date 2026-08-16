import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { MaintenanceWorkloadSnapshot } from '../../../../domain/ports/maintenance.port.js';
import { DigitalOceanAdapter } from '../digitalocean.adapter.js';

const APP_ID = 'do-app-1';
const WEB_ID = `${APP_ID}:services:web`;
const WORKER_ID = `${APP_ID}:workers:worker`;
const CRON_ID = `${APP_ID}:jobs:nightly`;

function environment(
  projectId = APP_ID,
  services: Record<string, unknown> = {
    web: { serviceId: WEB_ID },
    worker: { serviceId: WORKER_ID },
    nightly: { serviceId: CRON_ID },
  }
): Environment {
  const now = new Date();
  return {
    id: 'environment-1',
    projectId: 'hypervibe-project-1',
    name: 'production',
    platformBindings: {
      provider: 'digitalocean',
      projectId,
      services,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FixtureOptions {
  archived?: boolean;
  convergenceLag?: number;
  maintenance?: Record<string, unknown>;
  duplicateWeb?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  let spec: Record<string, unknown> = {
    name: 'hv-app',
    region: 'sfo',
    features: ['preserve-this'],
    ingress: { rules: [{ match: { path: { prefix: '/' } }, component: { name: 'web' } }] },
    envs: [{
      key: 'APP_LEVEL_SECRET',
      value: 'EV[encrypted-app-secret]',
      type: 'SECRET',
      scope: 'RUN_TIME',
    }],
    services: [{
      name: 'web',
      instance_count: 2,
      run_command: 'npm start',
      envs: [{
        key: 'SESSION_SECRET',
        value: 'EV[encrypted-service-secret]',
        type: 'SECRET',
      }],
      routes: [{ path: '/' }],
    }],
    workers: [
      {
        name: 'worker',
        run_command: 'npm run worker',
        autoscaling: {
          min_instance_count: 1,
          max_instance_count: 4,
          metrics: { cpu: { percent: 70 } },
        },
      },
      ...(options.duplicateWeb ? [{ name: 'web', instance_count: 1 }] : []),
    ],
    jobs: [{
      name: 'nightly',
      kind: 'SCHEDULED',
      schedule: { cron: '0 3 * * *' },
    }],
    ...(options.maintenance
      ? { maintenance: options.maintenance }
      : options.archived
        ? { maintenance: { archive: true } }
        : {}),
  };
  let instancesRunning = !(options.archived ?? false);
  let pendingInstanceTarget: boolean | undefined;
  let remainingLag = 0;
  const mutationSpecs: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname === `/v2/apps/${APP_ID}` && method === 'GET') {
      return jsonResponse({
        app: {
          id: APP_ID,
          spec,
          live_url: 'https://hv-app.ondigitalocean.app',
          default_ingress: 'hv-app.ondigitalocean.app',
          ...(pendingInstanceTarget === undefined
            ? { active_deployment: { id: 'deployment-active', phase: 'ACTIVE' } }
            : { in_progress_deployment: { id: 'deployment-transition', phase: 'DEPLOYING' } }),
        },
      });
    }
    if (url.pathname === `/v2/apps/${APP_ID}/instances` && method === 'GET') {
      if (pendingInstanceTarget !== undefined) {
        if (remainingLag === 0) {
          instancesRunning = pendingInstanceTarget;
          pendingInstanceTarget = undefined;
        } else {
          remainingLag -= 1;
        }
      }
      return jsonResponse({
        instances: instancesRunning
          ? [
              { component_name: 'web', component_type: 'SERVICE', instance_name: 'web-0' },
              { component_name: 'worker', component_type: 'WORKER', instance_name: 'worker-0' },
            ]
          : [],
      });
    }
    if (url.pathname === `/v2/apps/${APP_ID}` && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { spec: Record<string, unknown> };
      mutationSpecs.push(body.spec);
      spec = body.spec;
      const maintenance = spec.maintenance as Record<string, unknown> | undefined;
      pendingInstanceTarget = maintenance?.archive !== true;
      remainingLag = options.convergenceLag ?? 0;
      return jsonResponse({
        app: {
          id: APP_ID,
          spec,
          in_progress_deployment: { id: 'deployment-transition', phase: 'DEPLOYING' },
        },
      });
    }
    throw new Error(`Unexpected DigitalOcean request: ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('HYPERVIBE_DIGITALOCEAN_MAINTENANCE_ATTEMPTS', '8');
  vi.stubEnv('HYPERVIBE_DIGITALOCEAN_MAINTENANCE_DELAY_MS', '0');

  const adapter = new DigitalOceanAdapter();
  await adapter.connect({
    apiToken: 'dop_v1_test-token',
    region: 'sfo3',
    appRegion: 'sfo',
  });
  return { adapter, fetchMock, mutationSpecs };
}

describe('DigitalOceanAdapter maintenance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('archives the exact app, waits for zero running instances, and restores the exact maintenance spec', async () => {
    const priorMaintenance = {
      enabled: true,
      archive: false,
      offline_page_url: 'https://status.example.com/offline.html',
    };
    const { adapter, mutationSpecs } = await fixture({
      maintenance: priorMaintenance,
      convergenceLag: 2,
    });
    const env = environment();
    const snapshot = await adapter.observeMaintenanceWorkload(env, WEB_ID, 'web');
    const workerSnapshot = await adapter.observeMaintenanceWorkload(env, WORKER_ID, 'worker');
    const cronSnapshot = await adapter.observeMaintenanceWorkload(env, CRON_ID, 'cron');

    expect(snapshot).toMatchObject({
      serviceId: WEB_ID,
      workloadKind: 'web',
      wasRunning: true,
      state: 'running',
      providerState: {
        appId: APP_ID,
        collection: 'services',
        componentName: 'web',
        maintenancePresent: true,
        maintenance: priorMaintenance,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('encrypted');

    await expect(adapter.suspendMaintenanceWorkload(env, cronSnapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 1, skipped: 0, appId: APP_ID },
      });
    await expect(adapter.suspendMaintenanceWorkload(env, workerSnapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 0, skipped: 1, appId: APP_ID },
      });
    await expect(adapter.suspendMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 0, skipped: 1, appId: APP_ID },
      });
    await expect(adapter.resumeMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 1, skipped: 0, appId: APP_ID },
      });
    await expect(adapter.resumeMaintenanceWorkload(env, workerSnapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 0, skipped: 1, appId: APP_ID },
      });
    await expect(adapter.resumeMaintenanceWorkload(env, cronSnapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 0, skipped: 1, appId: APP_ID },
      });

    expect(mutationSpecs).toHaveLength(2);
    expect(mutationSpecs[0]).toMatchObject({
      features: ['preserve-this'],
      ingress: { rules: [{ component: { name: 'web' } }] },
      services: [{ name: 'web', instance_count: 2, routes: [{ path: '/' }] }],
      workers: [{
        name: 'worker',
        run_command: 'npm run worker',
        autoscaling: {
          min_instance_count: 1,
          max_instance_count: 4,
          metrics: { cpu: { percent: 70 } },
        },
      }],
      jobs: [{
        name: 'nightly',
        kind: 'SCHEDULED',
        schedule: { cron: '0 3 * * *' },
      }],
      maintenance: { ...priorMaintenance, archive: true },
    });
    expect(mutationSpecs[1]?.maintenance).toEqual(priorMaintenance);
    expect(JSON.stringify(mutationSpecs[0])).toContain('encrypted-service-secret');
  });

  it('preserves an app that was already archived before Hypervibe maintenance', async () => {
    const { adapter, mutationSpecs } = await fixture({ archived: true });
    const env = environment();
    const snapshot = await adapter.observeMaintenanceWorkload(env, WEB_ID, 'web');

    expect(snapshot).toMatchObject({ wasRunning: false, state: 'suspended' });
    await expect(adapter.suspendMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    await expect(adapter.resumeMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    expect(mutationSpecs).toEqual([]);
  });

  it('treats ordinary App Platform maintenance mode as running, not suspended', async () => {
    const { adapter } = await fixture({ maintenance: { enabled: true, archive: false } });

    await expect(adapter.observeMaintenanceWorkload(environment(), WEB_ID, 'web'))
      .resolves.toMatchObject({
        state: 'running',
        wasRunning: true,
      });
  });

  it('observes idle scheduled jobs as running while the app is active', async () => {
    const { adapter } = await fixture();

    await expect(adapter.observeMaintenanceWorkload(environment(), CRON_ID, 'cron'))
      .resolves.toMatchObject({
        state: 'running',
        wasRunning: true,
        providerState: {
          appId: APP_ID,
          collection: 'jobs',
          componentName: 'nightly',
        },
      });
  });

  it('returns unknown without mutation for conflicting or ambiguous component identities', async () => {
    const { adapter, mutationSpecs } = await fixture({ duplicateWeb: true });

    await expect(adapter.observeMaintenanceWorkload(
      environment('do-app-other'),
      WEB_ID,
      'web'
    )).resolves.toMatchObject({
      state: 'unknown',
      reason: 'maintenance_workload_identity_unknown',
    });
    await expect(adapter.observeMaintenanceWorkload(environment(), WEB_ID, 'web'))
      .resolves.toMatchObject({
        state: 'unknown',
        reason: 'maintenance_workload_ambiguous',
      });
    expect(mutationSpecs).toEqual([]);
  });

  it('returns unknown when the provider omits the running-instance observation', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit
    ) => {
      const url = new URL(String(input));
      if (url.pathname === `/v2/apps/${APP_ID}`) {
        return jsonResponse({
          app: {
            id: APP_ID,
            spec: { name: 'hv-app', services: [{ name: 'web' }] },
            active_deployment: { id: 'deployment-active', phase: 'ACTIVE' },
          },
        });
      }
      if (url.pathname === `/v2/apps/${APP_ID}/instances`) {
        return jsonResponse({});
      }
      throw new Error(`Unexpected DigitalOcean request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new DigitalOceanAdapter();
    await adapter.connect({ apiToken: 'dop_v1_test-token', region: 'sfo3', appRegion: 'sfo' });

    await expect(adapter.observeMaintenanceWorkload(environment(), WEB_ID, 'web'))
      .resolves.toMatchObject({
        state: 'unknown',
        reason: 'maintenance_workload_observation_failed',
      });
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET'))
      .toBe(true);
  });

  it('treats an already completed restore as an interrupted-resume noop', async () => {
    const { adapter, mutationSpecs } = await fixture();
    const snapshot = await adapter.observeMaintenanceWorkload(environment(), WEB_ID, 'web');

    await expect(adapter.resumeMaintenanceWorkload(
      environment(),
      snapshot as MaintenanceWorkloadSnapshot
    )).resolves.toMatchObject({
      success: true,
      data: { applied: 0, skipped: 1 },
    });
    expect(mutationSpecs).toEqual([]);
  });

  it('does not claim archive success when running instances outlast the polling window', async () => {
    const { adapter, mutationSpecs } = await fixture({ convergenceLag: 50 });
    const env = environment();
    const snapshot = await adapter.observeMaintenanceWorkload(env, WEB_ID, 'web');

    await expect(adapter.suspendMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({
        success: false,
        message: 'DigitalOcean archive was not verified',
      });
    expect(mutationSpecs).toHaveLength(1);
  });
});
