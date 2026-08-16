import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { VercelAdapter } from '../vercel.adapter.js';

const TEAM_ID = 'team_1234567890';
const SCOPE_BINDING = `team:${TEAM_ID}`;
const PROJECT_ID = 'prj_1234567890';
const SERVICE_BINDING = `${SCOPE_BINDING}:${PROJECT_ID}`;
const CUSTOM_DOMAIN = 'www.example.com';
const PROJECT_DOMAIN = 'example.vercel.app';
const DEPLOYMENT_DOMAIN = 'example-deployment.vercel.app';

function environment(
  serviceId = SERVICE_BINDING,
  projectId = SCOPE_BINDING
): Environment {
  const now = new Date();
  return {
    id: 'environment-1',
    projectId: 'hypervibe-project-1',
    name: 'production',
    platformBindings: {
      provider: 'vercel',
      projectId,
      services: { web: { serviceId } },
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

interface VercelFixtureOptions {
  initiallyPaused?: boolean;
  pauseObservationLag?: number;
  unpauseObservationLag?: number;
  originLag?: number;
  failedOrigin?: string;
}

async function fixture(options: VercelFixtureOptions = {}) {
  let paused = options.initiallyPaused ?? false;
  let pending: { target: boolean; remaining: number } | undefined;
  let remainingOriginLag = 0;
  const mutations: string[] = [];
  const originChecks: string[] = [];
  const fetchMock = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.hostname === 'api.vercel.com') {
      if (url.pathname === '/v2/user') {
        return jsonResponse({
          id: 'user_1234567890',
          email: 'owner@example.com',
          username: 'owner',
        });
      }
      if (url.pathname === `/v2/teams/${TEAM_ID}`) {
        return jsonResponse({ id: TEAM_ID, slug: 'example', name: 'Example' });
      }
      if (url.pathname === `/v9/projects/${PROJECT_ID}` && method === 'GET') {
        if (pending) {
          if (pending.remaining === 0) {
            paused = pending.target;
            pending = undefined;
            remainingOriginLag = options.originLag ?? 0;
          } else {
            pending.remaining -= 1;
          }
        }
        return jsonResponse({
          id: PROJECT_ID,
          accountId: TEAM_ID,
          name: 'example',
          paused,
          alias: [
            {
              domain: PROJECT_DOMAIN,
              environment: 'production',
              target: 'PRODUCTION',
            },
            {
              domain: 'preview.example.vercel.app',
              environment: 'preview',
              target: 'PREVIEW',
            },
          ],
        });
      }
      if (url.pathname === `/v9/projects/${PROJECT_ID}/domains`) {
        return jsonResponse({
          domains: [{
            name: CUSTOM_DOMAIN,
            projectId: PROJECT_ID,
            verified: true,
          }],
          pagination: { next: null },
        });
      }
      if (url.pathname === '/v7/deployments') {
        return jsonResponse({
          deployments: [{
            uid: 'dpl_1234567890',
            projectId: PROJECT_ID,
            name: 'example',
            url: DEPLOYMENT_DOMAIN,
            createdAt: 1_700_000_000_000,
            readyState: 'READY',
            target: 'production',
          }],
          pagination: { next: null },
        });
      }
      if (
        method === 'POST'
        && url.pathname === `/v1/projects/${PROJECT_ID}/pause`
      ) {
        mutations.push('pause');
        pending = {
          target: true,
          remaining: options.pauseObservationLag ?? 0,
        };
        return new Response(null, { status: 200 });
      }
      if (
        method === 'POST'
        && url.pathname === `/v1/projects/${PROJECT_ID}/unpause`
      ) {
        mutations.push('unpause');
        pending = {
          target: false,
          remaining: options.unpauseObservationLag ?? 0,
        };
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected Vercel request: ${method} ${url.pathname}`);
    }

    originChecks.push(url.hostname);
    const servesPausedMarker = paused && remainingOriginLag === 0;
    if (remainingOriginLag > 0) remainingOriginLag -= 1;
    if (
      servesPausedMarker
      && url.hostname === CUSTOM_DOMAIN
      && url.hostname !== options.failedOrigin
    ) {
      return new Response('Temporarily unavailable for maintenance', {
        status: 503,
        headers: { 'x-hypervibe-maintenance': 'maintenance-content-hash' },
      });
    }
    if (servesPausedMarker && url.hostname !== options.failedOrigin) {
      return new Response('DEPLOYMENT_PAUSED', {
        status: 503,
        headers: { 'x-vercel-error': 'DEPLOYMENT_PAUSED' },
      });
    }
    return new Response('ok', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('HYPERVIBE_VERCEL_MAINTENANCE_ATTEMPTS', '8');
  vi.stubEnv('HYPERVIBE_VERCEL_MAINTENANCE_DELAY_MS', '0');

  const adapter = new VercelAdapter();
  await adapter.connect({
    accessToken: 'vercel-test-token',
    teamId: TEAM_ID,
  });
  return { adapter, fetchMock, mutations, originChecks };
}

describe('VercelAdapter maintenance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('pauses the exact project, verifies every production origin, noops on retry, and unpauses without deploying', async () => {
    const { adapter, fetchMock, mutations, originChecks } = await fixture({
      pauseObservationLag: 2,
      unpauseObservationLag: 1,
      originLag: 2,
    });
    const env = environment();
    const snapshot = await adapter.observeMaintenanceWorkload(
      env,
      SERVICE_BINDING,
      'web'
    );

    expect(snapshot).toMatchObject({
      serviceId: SERVICE_BINDING,
      workloadKind: 'web',
      wasRunning: true,
      state: 'running',
      providerState: {
        scopeBinding: SCOPE_BINDING,
        projectId: PROJECT_ID,
        accountId: TEAM_ID,
      },
    });
    await expect(adapter.suspendMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 1, skipped: 0 },
      });
    await expect(adapter.suspendMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 0, skipped: 1 },
      });
    await expect(adapter.resumeMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 1, skipped: 0 },
      });

    expect(mutations).toEqual(['pause', 'unpause']);
    expect(new Set(originChecks)).toEqual(new Set([
      CUSTOM_DOMAIN,
      PROJECT_DOMAIN,
      DEPLOYMENT_DOMAIN,
    ]));
    const providerMutations = fetchMock.mock.calls.filter(([input, init]) => (
      new URL(String(input)).hostname === 'api.vercel.com'
      && (init?.method ?? 'GET') !== 'GET'
    ));
    expect(providerMutations).toHaveLength(2);
    expect(providerMutations.every(([input]) => (
      new URL(String(input)).searchParams.get('teamId') === TEAM_ID
    ))).toBe(true);
  });

  it('preserves a project that was already paused before Hypervibe maintenance', async () => {
    const { adapter, mutations } = await fixture({ initiallyPaused: true });
    const env = environment();
    const snapshot = await adapter.observeMaintenanceWorkload(
      env,
      SERVICE_BINDING,
      'web'
    );

    expect(snapshot).toMatchObject({ wasRunning: false, state: 'suspended' });
    await expect(adapter.suspendMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    await expect(adapter.resumeMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    expect(mutations).toEqual([]);
  });

  it('treats an already completed unpause as an interrupted-resume noop', async () => {
    const { adapter, mutations } = await fixture();
    const env = environment();
    const running = await adapter.observeMaintenanceWorkload(
      env,
      SERVICE_BINDING,
      'web'
    );

    await expect(adapter.resumeMaintenanceWorkload(env, running))
      .resolves.toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    expect(mutations).toEqual([]);
  });

  it('returns unknown without mutation when the requested workload is not exactly bound', async () => {
    const { adapter, mutations } = await fixture();
    const other = `${SCOPE_BINDING}:prj_other1234567890`;

    await expect(adapter.observeMaintenanceWorkload(environment(), other, 'web'))
      .resolves.toMatchObject({
        serviceId: other,
        state: 'unknown',
        reason: 'maintenance_workload_unbound',
      });
    expect(mutations).toEqual([]);
  });

  it('returns unknown without mutation when the environment scope conflicts with the connected team', async () => {
    const { adapter, mutations } = await fixture();

    await expect(adapter.observeMaintenanceWorkload(
      environment(SERVICE_BINDING, 'team:team_other1234567890'),
      SERVICE_BINDING,
      'web'
    )).resolves.toMatchObject({
      serviceId: SERVICE_BINDING,
      state: 'unknown',
      reason: 'maintenance_workload_identity_unknown',
    });
    expect(mutations).toEqual([]);
  });

  it('fails suspension when even one direct production origin lacks the provider pause marker', async () => {
    const { adapter, mutations } = await fixture({ failedOrigin: DEPLOYMENT_DOMAIN });
    const env = environment();
    const snapshot = await adapter.observeMaintenanceWorkload(
      env,
      SERVICE_BINDING,
      'web'
    );

    await expect(adapter.suspendMaintenanceWorkload(env, snapshot))
      .resolves.toMatchObject({
        success: false,
        message: 'Vercel suspension was not verified',
      });
    expect(mutations).toEqual(['pause']);
  });
});
