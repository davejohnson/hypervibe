import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import {
  formatFlyEnvironmentBinding,
  formatFlyServiceBinding,
  parseFlyEnvironmentBinding,
  parseFlyServiceBinding,
} from '../fly.binding.js';
import { FlyAdapter } from '../fly.adapter.js';

const FLY_ENVIRONMENT_ID = formatFlyEnvironmentBinding({
  organizationSlug: 'hypervibe-test',
  projectName: 'invoiceperfect.com',
  environmentName: 'production',
});

function environment(
  platformBindings: Record<string, unknown> = {
    provider: 'fly',
    projectId: 'flyorg:hypervibe-test',
    environmentId: FLY_ENVIRONMENT_ID,
    services: {},
  }
): Environment {
  const now = new Date();
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings,
    createdAt: now,
    updatedAt: now,
  };
}

function service(overrides: Partial<Service['buildConfig']> = {}): Service {
  const now = new Date();
  return {
    id: 'service-1',
    projectId: 'project-1',
    name: 'web',
    buildConfig: {
      workloadKind: 'web',
      builder: 'dockerfile',
      startCommand: 'node server.mjs',
      healthCheckPath: '/health',
      public: true,
      ...overrides,
    },
    envVarSpec: {},
    createdAt: now,
    updatedAt: now,
  };
}

async function connected(): Promise<FlyAdapter> {
  const adapter = new FlyAdapter();
  await adapter.connect({
    apiToken: 'flyv1-test-token',
    organizationSlug: 'hypervibe-test',
  });
  adapter.configureTarget({ region: 'yyz' });
  return adapter;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe('FlyAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('preserves provider errors in deployment-status observations', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => json(
      { error: 'deployment observation denied' },
      403
    ));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();
    const serviceBinding = formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-production',
      appName: 'invoice-perfect-production-web',
      machineId: 'machine-production-web',
    });

    const result = await adapter.getDeployStatus(environment({
      provider: 'fly',
      projectId: 'flyorg:hypervibe-test',
      environmentId: FLY_ENVIRONMENT_ID,
      services: { web: { serviceId: serviceBinding } },
    }), serviceBinding);

    expect(result).toMatchObject({
      status: 'unknown',
      reason: expect.stringMatching(/403.*deployment observation denied/i),
    });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      '/v1/apps/invoice-perfect-production-web'
    );
  });

  it('keeps organization scope in credentials and placement in desired state', async () => {
    const adapter = new FlyAdapter();
    await expect(adapter.connect({ apiToken: 'token', region: 'yyz' }))
      .rejects.toThrow(/organizationSlug|organization slug/i);
    await expect(adapter.connect({
      apiToken: 'token',
      organizationSlug: 'hypervibe-test',
      region: 'yyz',
    })).rejects.toThrow();
  });

  it('persists a repo-stable logical environment identity instead of local UUIDs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ apps: [] })));
    const adapter = await connected();

    const receipt = await adapter.ensureProject('invoiceperfect.com', environment({}));

    expect(receipt.success).toBe(true);
    expect(receipt.data?.environmentId).toBe(FLY_ENVIRONMENT_ID);
    expect(parseFlyEnvironmentBinding(String(receipt.data?.environmentId))).toEqual({
      version: 1,
      organizationSlug: 'hypervibe-test',
      projectName: 'invoiceperfect.com',
      environmentName: 'production',
    });
    expect(String(receipt.data?.environmentId)).not.toContain('env-1');
  });

  it('fails closed when pre-create app observation is unknown', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => json({ error: 'unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.deploy(service(), environment(), {});

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('503');
    expect(fetchMock.mock.calls.filter((call) => (
      !['GET', 'HEAD'].includes((call[1] as RequestInit | undefined)?.method ?? 'GET')
    ))).toEqual([]);
  });

  it('returns the provider App identity when post-create observation stays unknown', async () => {
    vi.stubEnv('HYPERVIBE_FLY_APP_READY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_FLY_APP_READY_DELAY_MS', '0');
    let appName = '';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/apps' && method === 'GET') return json({ apps: [] });
      if (url.pathname === '/v1/apps' && method === 'POST') {
        appName = JSON.parse(String(init?.body)).app_name;
        return json({ id: 'fly-app-created' }, 201);
      }
      if (url.pathname === `/v1/apps/${appName}` && method === 'GET') {
        return json({ error: 'temporarily unavailable' }, 503);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.deploy(service(), environment(), {});

    expect(result.receipt).toMatchObject({
      success: false,
      data: { createdService: true, mutationAttempted: true },
    });
    expect(parseFlyServiceBinding(result.externalId!)).toMatchObject({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-created',
      appName,
    });
  });

  it('creates a stopped source-less Machine and verifies all child identities before returning a binding', async () => {
    let appName = '';
    let machineConfig: Record<string, unknown> = {};
    const assignments: Array<{ ip: string; shared: boolean }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/apps' && method === 'GET') return json({ apps: [] });
      if (url.pathname === '/v1/apps' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        appName = body.app_name;
        expect(body).not.toHaveProperty('name');
        expect(body.org_slug).toBe('hypervibe-test');
        return json({ id: 'fly-app-1' }, 201);
      }
      if (url.pathname === `/v1/apps/${appName}` && method === 'GET') {
        return json({
          id: 'fly-app-1',
          name: appName,
          organization: { slug: 'hypervibe-test' },
          status: 'deployed',
        });
      }
      if (url.pathname === `/v1/apps/${appName}/secrets` && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          values: { APP_SECRET: 'secret-value' },
        });
        return json({ version: 3 });
      }
      if (url.pathname === `/v1/apps/${appName}/secrets` && method === 'GET') {
        expect(url.searchParams.get('show_secrets')).toBe('false');
        return json({ secrets: [{ name: 'APP_SECRET', digest: 'provider-digest' }] });
      }
      if (url.pathname === `/v1/apps/${appName}/ip_assignments` && method === 'GET') {
        return json({ ips: assignments });
      }
      if (url.pathname === `/v1/apps/${appName}/ip_assignments` && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        if (body.type === 'v6') assignments.push({ ip: '2a09:8280::1', shared: false });
        if (body.type === 'shared_v4') assignments.push({ ip: '66.241.124.1', shared: true });
        return json(assignments.at(-1));
      }
      if (url.pathname === `/v1/apps/${appName}/machines` && method === 'GET') {
        return json([]);
      }
      if (url.pathname === `/v1/apps/${appName}/machines` && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body.region).toBe('yyz');
        expect(body.skip_launch).toBe(true);
        expect(body.min_secrets_version).toBe(3);
        machineConfig = body.config;
        expect(machineConfig).toMatchObject({
          image: 'flyio/hellofly:latest',
          init: { cmd: ['/bin/sh', '-lc', 'node server.mjs'] },
          metadata: {
            hypervibe_managed: 'true',
            hypervibe_project_id: 'invoiceperfect.com',
            hypervibe_environment_id: FLY_ENVIRONMENT_ID,
            hypervibe_service_name: 'web',
            hypervibe_workload_kind: 'web',
          },
        });
        return json({
          id: 'machine-1',
          instance_id: 'version-1',
          state: 'created',
          region: 'yyz',
          config: machineConfig,
        });
      }
      if (url.pathname === `/v1/apps/${appName}/machines/machine-1` && method === 'GET') {
        return json({
          id: 'machine-1',
          instance_id: 'version-1',
          state: 'created',
          region: 'yyz',
          config: machineConfig,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.deploy(
      service(),
      environment(),
      { APP_SECRET: 'secret-value', IMAGE_URI: 'must-not-be-a-secret' },
      { deferDeployment: true }
    );

    expect(result.receipt.success).toBe(true);
    expect(result.status).toBe('configured');
    expect(result.url).toBe(`https://${appName}.fly.dev`);
    const binding = parseFlyServiceBinding(result.externalId!);
    expect(binding).toEqual({
      version: 1,
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName,
      machineId: 'machine-1',
    });
    expect(result.receipt.data).toMatchObject({
      flyAppId: 'fly-app-1',
      machineId: 'machine-1',
      createdService: true,
      pendingDeployment: true,
    });
    expect(result.receipt.data?.runtimeRolloutRequired).toBeUndefined();
    expect(JSON.stringify(result.receipt)).not.toContain('secret-value');
    expect(machineConfig).not.toHaveProperty('env.APP_SECRET');
  });

  it('observes encrypted secret names through Hypervibe-owned hashes without requesting values', async () => {
    const appName = 'hv-app';
    const binding = formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName,
      machineId: 'machine-1',
    });
    const hash = createHash('sha256').update('secret-value').digest('hex');
    const hashKey = `hypervibe_env_${Buffer.from('APP_SECRET').toString('base64url')}`;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/apps' && method === 'GET') {
        expect(url.searchParams.get('org_slug')).toBe('hypervibe-test');
        return json({ apps: [{
          id: 'fly-app-1', name: appName,
        }] });
      }
      if (url.pathname === `/v1/apps/${appName}/machines` && method === 'GET') {
        return json([{
          id: 'machine-1',
          state: 'started',
          config: {
            image: 'registry.fly.io/hv-app@sha256:abc',
            services: [{ internal_port: 8080 }],
            init: { cmd: ['/bin/sh', '-lc', 'node server.mjs'] },
            metadata: {
              hypervibe_managed: 'true',
              hypervibe_project_id: 'invoiceperfect.com',
              hypervibe_environment_id: FLY_ENVIRONMENT_ID,
              hypervibe_service_name: 'web',
              hypervibe_workload_kind: 'web',
              hypervibe_health_check_path: '/health',
              [hashKey]: hash,
            },
          },
          checks: [{ name: 'hypervibe', status: 'passing' }],
        }]);
      }
      if (url.pathname === `/v1/apps/${appName}/secrets` && method === 'GET') {
        expect(url.searchParams.get('show_secrets')).toBe('false');
        return json({ secrets: [{ name: 'APP_SECRET', digest: 'opaque-provider-digest' }] });
      }
      if (url.pathname === `/v1/apps/${appName}/certificates` && method === 'GET') {
        return json({ certificates: [] });
      }
      if (url.pathname === `/v1/apps/${appName}/ip_assignments` && method === 'GET') {
        return json({ ips: [
          { ip: '66.241.124.1', shared: true },
          { ip: '2a09:8280::1', shared: false },
        ] });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const observed = await adapter.observe(environment({
      provider: 'fly',
      projectId: 'flyorg:hypervibe-test',
      environmentId: FLY_ENVIRONMENT_ID,
      services: { web: { serviceId: binding } },
    }));

    expect(observed.partial).toBe(false);
    expect(observed.services).toEqual([expect.objectContaining({
      name: 'web',
      externalId: binding,
      url: 'https://hv-app.fly.dev',
      envVarKeys: ['APP_SECRET'],
      envVarHashes: { APP_SECRET: hash },
      status: 'running',
      sourceState: 'disconnected',
    })]);
  });

  it('releases exact App IP assignments when a service becomes private', async () => {
    const appName = 'hv-app';
    const binding = formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName,
      machineId: 'machine-1',
    });
    const assignments = new Set(['66.241.124.1', '2a09:8280::1']);
    let machineConfig: Record<string, unknown> = {
      image: 'registry.fly.io/hv-app@sha256:abc',
      services: [{ internal_port: 8080 }],
      metadata: {
        hypervibe_managed: 'true',
        hypervibe_project_id: 'invoiceperfect.com',
        hypervibe_environment_id: FLY_ENVIRONMENT_ID,
        hypervibe_service_name: 'web',
        hypervibe_workload_kind: 'web',
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === `/v1/apps/${appName}` && method === 'GET') {
        return json({
          id: 'fly-app-1',
          name: appName,
          organization: { slug: 'hypervibe-test' },
        });
      }
      if (url.pathname === `/v1/apps/${appName}/ip_assignments` && method === 'GET') {
        return json({ ips: Array.from(assignments, (ip) => ({ ip })) });
      }
      if (
        url.pathname.startsWith(`/v1/apps/${appName}/ip_assignments/`)
        && method === 'DELETE'
      ) {
        const encodedIp = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
        assignments.delete(decodeURIComponent(encodedIp));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/v1/apps/${appName}/machines` && method === 'GET') {
        return json([{
          id: 'machine-1',
          instance_id: 'version-1',
          state: 'started',
          config: machineConfig,
        }]);
      }
      if (url.pathname === `/v1/apps/${appName}/machines/machine-1` && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body.current_version).toBe('version-1');
        expect(body.skip_launch).toBe(false);
        expect(body.config.services).toEqual([]);
        machineConfig = body.config;
        return json({
          id: 'machine-1',
          instance_id: 'version-2',
          state: 'started',
          config: machineConfig,
        });
      }
      if (url.pathname === `/v1/apps/${appName}/machines/machine-1` && method === 'GET') {
        return json({
          id: 'machine-1',
          instance_id: 'version-2',
          state: 'started',
          config: machineConfig,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.deploy(
      service({ public: false }),
      environment({
        provider: 'fly',
        projectId: 'flyorg:hypervibe-test',
        environmentId: FLY_ENVIRONMENT_ID,
        services: { web: { serviceId: binding } },
      }),
      {}
    );

    expect(result.receipt.success).toBe(true);
    expect(assignments.size).toBe(0);
    expect(fetchMock.mock.calls.filter((call) => (
      (call[1] as RequestInit | undefined)?.method === 'DELETE'
    ))).toHaveLength(2);
  });

  it('refuses to delete when a bound App durable ID no longer matches', async () => {
    const serviceId = formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName: 'hv-app',
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/apps/hv-app' && (init?.method ?? 'GET') === 'GET') {
        return json({
          id: 'different-app-id',
          name: 'hv-app',
          organization: { slug: 'hypervibe-test' },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.deleteService(serviceId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('identity changed');
    expect(fetchMock.mock.calls.some((call) => (
      (call[1] as RequestInit | undefined)?.method === 'DELETE'
    ))).toBe(false);
  });

  it('does not delete a replacement that reuses the App name during teardown', async () => {
    vi.stubEnv('HYPERVIBE_FLY_APP_DELETE_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_FLY_APP_DELETE_DELAY_MS', '0');
    const serviceId = formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName: 'hv-app',
    });
    let deleted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/apps/hv-app' && method === 'GET') {
        return json({
          id: deleted ? 'replacement-app' : 'fly-app-1',
          name: 'hv-app',
          organization: { slug: 'hypervibe-test' },
        });
      }
      if (url.pathname === '/v1/apps/hv-app' && method === 'DELETE') {
        expect(url.searchParams.get('force')).toBe('true');
        deleted = true;
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.deleteService(serviceId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('will not delete the replacement');
    expect(fetchMock.mock.calls.filter((call) => (
      (call[1] as RequestInit | undefined)?.method === 'DELETE'
    ))).toHaveLength(1);
  });

  it('inspects bounded Managed Postgres identities and stale access peers without secrets', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        return json({
          data: [{
            id: 'pg-cluster-1',
            name: 'production-postgres',
            status: 'ready',
            region: 'iad',
            plan: 'basic',
            organization: { slug: 'hypervibe-test' },
          }],
        });
      }
      if (url.href === 'https://api.fly.io/graphql' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes('HypervibeFlyWireGuardPeers')) {
          return json({
            data: {
              organization: {
                slug: 'hypervibe-test',
                wireGuardPeers: {
                  nodes: [{
                    id: 'peer-1',
                    name: 'hv-db-stale-peer',
                    pubkey: 'public-key',
                    region: 'iad',
                    peerip: 'fdaa:1:2::100',
                  }],
                },
              },
            },
          });
        }
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const inspected = await adapter.inspectEnvironmentResources({
      resource: 'database',
      limit: 25,
    });

    expect(inspected).toMatchObject({
      resource: 'database',
      observation: 'present',
      databases: [{
        id: 'pg-cluster-1',
        organizationSlug: 'hypervibe-test',
      }],
      temporaryAccessPeers: [{
        id: 'peer-1',
        name: 'hv-db-stale-peer',
        organizationSlug: 'hypervibe-test',
      }],
    });
    expect(JSON.stringify(inspected)).not.toContain('pubkey');
    expect(JSON.stringify(inspected)).not.toContain('public-key');
  });

  it('uses only provider-returned DNS requirements and verifies exact certificate detachment', async () => {
    const serviceId = formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName: 'hv-app',
    });
    let certificatePresent = false;
    const certificate = {
      hostname: 'app.example.com',
      status: 'Awaiting certificates',
      configured: false,
      validation: { dns_configured: false },
      dns_requirements: {
        a: ['66.241.124.1'],
        aaaa: ['2a09:8280::1'],
        cname: 'hv-app.fly.dev',
        acme_challenge: {
          name: '_acme-challenge.app.example.com',
          target: 'app.example.com.flydns.net',
        },
        ownership: {
          name: '_fly-ownership.app.example.com',
          app_value: 'ownership-proof',
        },
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/apps/hv-app' && method === 'GET') {
        return json({
          id: 'fly-app-1',
          name: 'hv-app',
          organization: { slug: 'hypervibe-test' },
        });
      }
      if (
        url.pathname === '/v1/apps/hv-app/certificates/app.example.com'
        && method === 'GET'
      ) {
        return certificatePresent
          ? json(certificate)
          : json({ error: 'not found' }, 404);
      }
      if (url.pathname === '/v1/apps/hv-app/certificates/acme' && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ hostname: 'app.example.com' });
        certificatePresent = true;
        return json(certificate, 201);
      }
      if (
        url.pathname === '/v1/apps/hv-app/certificates/app.example.com'
        && method === 'DELETE'
      ) {
        certificatePresent = false;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const attached = await adapter.attachCustomDomain({
      projectId: 'flyorg:hypervibe-test',
      environmentId: 'env-1',
      serviceId,
      domain: 'app.example.com',
    });

    expect(attached.success).toBe(true);
    expect(attached.data?.customDomainId).toBe(
      'fly-certificate:fly-app-1:app.example.com'
    );
    expect(attached.data?.dnsRecords).toEqual([
      { name: 'app.example.com', type: 'CNAME', value: 'hv-app.fly.dev', purpose: 'traffic' },
      { name: '_acme-challenge.app.example.com', type: 'CNAME', value: 'app.example.com.flydns.net', purpose: 'verification' },
      { name: '_fly-ownership.app.example.com', type: 'TXT', value: 'ownership-proof', purpose: 'verification' },
    ]);

    const detached = await adapter.detachCustomDomain({
      projectId: 'flyorg:hypervibe-test',
      environmentId: 'env-1',
      serviceId,
      domain: 'app.example.com',
      customDomainId: String(attached.data?.customDomainId),
    });

    expect(detached).toMatchObject({
      success: true,
      data: { deleted: true },
    });
    expect(certificatePresent).toBe(false);
  });
});
