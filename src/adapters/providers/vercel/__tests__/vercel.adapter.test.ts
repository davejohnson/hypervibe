import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import { VercelAdapter } from '../vercel.adapter.js';

const TEAM_ID = 'team_1234567890';
const SCOPE_BINDING = `team:${TEAM_ID}`;
const PROJECT_ID = 'prj_1234567890';
const SERVICE_BINDING = `${SCOPE_BINDING}:${PROJECT_ID}`;

function makeEnvironment(
  platformBindings: Record<string, unknown> = {}
): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function boundEnvironment(): Environment {
  return makeEnvironment({
    provider: 'vercel',
    projectId: SCOPE_BINDING,
    services: {
      web: { serviceId: SERVICE_BINDING },
    },
  });
}

function makeService(overrides: Partial<Service> = {}): Service {
  return {
    id: 'service-1',
    projectId: 'project-1',
    name: 'web',
    buildConfig: {
      workloadKind: 'web',
      healthCheckPath: '/health',
      public: true,
    },
    envVarSpec: {
      required: ['NODE_ENV'],
      optional: [],
      secrets: ['SESSION_SECRET'],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204
      ? {}
      : { 'Content-Type': 'application/json' },
  });
}

function user() {
  return {
    id: 'user_1234567890',
    email: 'owner@example.com',
    username: 'owner',
  };
}

function team() {
  return {
    id: TEAM_ID,
    slug: 'invoice-perfect',
    name: 'Invoice Perfect',
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    accountId: TEAM_ID,
    name: expectedServiceName(),
    ...overrides,
  };
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'dpl_1234567890',
    projectId: PROJECT_ID,
    name: expectedServiceName(),
    url: 'invoice-perfect.vercel.app',
    createdAt: 1_700_000_000_000,
    readyState: 'READY',
    target: 'production',
    meta: {
      hypervibeGitSha: 'a'.repeat(40),
    },
    ...overrides,
  };
}

function projectsResponse(projects: unknown[]) {
  return {
    projects,
    pagination: { next: null },
  };
}

function envResponse(envs: unknown[]) {
  return {
    envs,
    pagination: { next: null },
  };
}

function domainsResponse(domains: unknown[]) {
  return {
    domains,
    pagination: { next: null },
  };
}

async function connectedAdapter(): Promise<VercelAdapter> {
  const adapter = new VercelAdapter();
  await adapter.connect({
    accessToken: 'vercel-test-token',
    teamId: TEAM_ID,
  });
  return adapter;
}

function expectedPrefix(): string {
  const projectHash = createHash('sha256')
    .update('project-1')
    .digest('hex')
    .slice(0, 8);
  const environmentHash = createHash('sha256')
    .update('production')
    .digest('hex')
    .slice(0, 6);
  return `hv-${projectHash}-${environmentHash}-`;
}

function expectedServiceName(): string {
  const serviceHash = createHash('sha256')
    .update('web')
    .digest('hex')
    .slice(0, 8);
  return `${expectedPrefix()}${serviceHash}`;
}

function mutationCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) =>
    !['GET', 'HEAD'].includes(
      (call[1] as RequestInit | undefined)?.method ?? 'GET'
    )
  );
}

function identityResponse(
  url: URL
): Response | undefined {
  if (url.pathname === '/v2/user') return jsonResponse(user());
  if (url.pathname === `/v2/teams/${TEAM_ID}`) {
    return jsonResponse(team());
  }
  return undefined;
}

describe('VercelAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('binds a verified existing account scope without provider mutations', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const response = identityResponse(url);
      if (response) return response;
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.ensureProject('invoice-perfect', makeEnvironment())
    ).resolves.toMatchObject({
      success: true,
      data: {
        projectId: SCOPE_BINDING,
        projectName: 'invoice-perfect',
        created: false,
      },
    });
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('blocks a conflicting durable scope binding without mutations', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const response = identityResponse(url);
      if (response) return response;
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject(
      'invoice-perfect',
      makeEnvironment({
        provider: 'vercel',
        projectId: 'team:team_other',
        services: {},
      })
    );

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('will not silently rebind');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('attaches, observes, and detaches one exact project domain', async () => {
    let attached = false;
    const domain = {
      name: 'vercel.domain-test.hypervibe.dev',
      apexName: 'hypervibe.dev',
      projectId: PROJECT_ID,
      verified: false,
      verification: [{
        type: 'TXT',
        domain: '_vercel.vercel.domain-test.hypervibe.dev',
        value: 'verify-domain',
      }],
    };
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === `/v9/projects/${PROJECT_ID}`) return jsonResponse(project());
      if (url.pathname === `/v9/projects/${PROJECT_ID}/domains/${domain.name}`) {
        if (method === 'DELETE') {
          attached = false;
          return jsonResponse(undefined, 204);
        }
        return attached ? jsonResponse(domain) : jsonResponse({}, 404);
      }
      if (url.pathname === `/v10/projects/${PROJECT_ID}/domains` && method === 'POST') {
        attached = true;
        return jsonResponse(domain);
      }
      if (url.pathname === `/v6/domains/${domain.name}/config`) {
        return jsonResponse({ misconfigured: true });
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const created = await adapter.attachCustomDomain({
      projectId: SCOPE_BINDING,
      serviceId: SERVICE_BINDING,
      environmentId: 'env-1',
      domain: domain.name,
    });
    expect(created).toMatchObject({
      success: true,
      data: {
        customDomainId: `project-domain:${PROJECT_ID}:${domain.name}`,
        created: true,
        providerVerified: false,
        dnsRecords: [
          { name: domain.name, type: 'CNAME', value: 'cname.vercel-dns-0.com', purpose: 'traffic' },
          { name: domain.verification[0].domain, type: 'TXT', value: 'verify-domain', purpose: 'verification' },
        ],
      },
    });

    const detached = await adapter.detachCustomDomain({
      projectId: SCOPE_BINDING,
      serviceId: SERVICE_BINDING,
      environmentId: 'env-1',
      domain: domain.name,
      customDomainId: `project-domain:${PROJECT_ID}:${domain.name}`,
    });
    expect(detached).toMatchObject({ success: true, data: { deleted: true } });
    expect(attached).toBe(false);
  });

  it('creates only a source-less project, configures production vars, and defers deployment', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === '/v10/projects' && method === 'GET') {
        return jsonResponse(projectsResponse([]));
      }
      if (url.pathname === '/v11/projects' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        return jsonResponse(project({ name: body.name }), 201);
      }
      if (
        url.pathname === `/v10/projects/${PROJECT_ID}/env`
        && method === 'GET'
      ) {
        return jsonResponse(envResponse([]));
      }
      if (
        url.pathname === `/v10/projects/${PROJECT_ID}/env`
        && method === 'POST'
      ) {
        return jsonResponse({});
      }
      if (url.pathname === '/v7/deployments' && method === 'GET') {
        return jsonResponse({
          deployments: [],
          pagination: { next: null },
        });
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'vercel',
        projectId: SCOPE_BINDING,
        services: {},
      }),
      {
        HYPERVIBE_SOURCE_REPO_URL:
          'https://github.com/example/invoice-perfect.git',
        HYPERVIBE_START_COMMAND: 'must-not-cross-boundary',
        IMAGE_URI: 'ghcr.io/must-not-cross-boundary',
        NODE_ENV: 'production',
        SESSION_SECRET: 'session-secret-value',
      },
      { deferDeployment: true }
    );

    expect(result).toMatchObject({
      externalId: SERVICE_BINDING,
      status: 'configured',
      receipt: {
        success: true,
        data: {
          serviceId: SERVICE_BINDING,
          vercelProjectId: PROJECT_ID,
          serviceName: expectedServiceName(),
          resourceType: 'web',
          createdService: true,
          deploymentDeferred: true,
          pendingDeployment: true,
        },
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(
      'session-secret-value'
    );

    const createCall = fetchMock.mock.calls.find((call) =>
      new URL(String(call[0])).pathname === '/v11/projects'
    ) as [URL, RequestInit] | undefined;
    expect(JSON.parse(String(createCall![1].body))).toEqual({
      name: expectedServiceName(),
    });
    const envCall = fetchMock.mock.calls.find((call) =>
      new URL(String(call[0])).pathname.endsWith('/env')
      && (call[1] as RequestInit | undefined)?.method === 'POST'
    ) as [URL, RequestInit] | undefined;
    expect(new URL(String(envCall![0])).searchParams.get('upsert')).toBe(
      'true'
    );
    expect(JSON.parse(String(envCall![1].body))).toEqual([
      {
        key: 'HYPERVIBE_HEALTH_CHECK_PATH',
        value: '/health',
        type: 'sensitive',
        target: ['production'],
        comment: 'Managed by Hypervibe',
      },
      {
        key: 'NODE_ENV',
        value: 'production',
        type: 'sensitive',
        target: ['production'],
        comment: 'Managed by Hypervibe',
      },
      {
        key: 'SESSION_SECRET',
        value: 'session-secret-value',
        type: 'sensitive',
        target: ['production'],
        comment: 'Managed by Hypervibe',
      },
    ]);
    expect(fetchMock.mock.calls.some((call) =>
      new URL(String(call[0])).pathname === '/v13/deployments'
    )).toBe(false);
  });

  it('reports a newly created durable ID when later configuration fails', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === '/v10/projects') {
        return jsonResponse(projectsResponse([]));
      }
      if (url.pathname === '/v11/projects' && method === 'POST') {
        return jsonResponse(project(), 201);
      }
      if (url.pathname.endsWith('/env')) {
        return jsonResponse({}, 403);
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'vercel',
        projectId: SCOPE_BINDING,
        services: {},
      }),
      { SESSION_SECRET: 'secret-value' },
      { deferDeployment: true }
    );

    expect(result).toMatchObject({
      externalId: SERVICE_BINDING,
      status: 'failed',
      receipt: {
        success: false,
        data: {
          createdService: true,
          mutationAttempted: true,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('reports an unknown create outcome without inventing a project binding', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === '/v10/projects') {
        return jsonResponse(projectsResponse([]));
      }
      if (url.pathname === '/v11/projects' && method === 'POST') {
        throw new Error('network outcome unknown');
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'vercel',
        projectId: SCOPE_BINDING,
        services: {},
      }),
      {},
      { deferDeployment: true }
    );

    expect(result).toMatchObject({
      status: 'failed',
      receipt: {
        success: false,
        data: {
          createdService: false,
          mutationAttempted: true,
        },
      },
    });
    expect(result.externalId).toBeUndefined();
  });

  it('blocks deterministic-name adoption and stale durable bindings', async () => {
    const nameMatchFetch = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === '/v10/projects') {
        return jsonResponse(projectsResponse([project()]));
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', nameMatchFetch);
    const adapter = await connectedAdapter();
    const unboundEnvironment = makeEnvironment({
      provider: 'vercel',
      projectId: SCOPE_BINDING,
      services: {},
    });

    const nameMatch = await adapter.deploy(
      makeService(),
      unboundEnvironment,
      {},
      { deferDeployment: true }
    );
    expect(nameMatch.receipt.error).toContain('hv_import');
    expect(mutationCalls(nameMatchFetch)).toEqual([]);

    const staleFetch = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === `/v9/projects/${PROJECT_ID}`) {
        return jsonResponse({}, 404);
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', staleFetch);
    const stale = await adapter.deploy(
      makeService(),
      boundEnvironment(),
      {},
      { deferDeployment: true }
    );
    expect(stale.receipt.error).toContain('stale binding');
    expect(mutationCalls(staleFetch)).toEqual([]);
  });

  it('blocks native Git-linked projects before changing configuration', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === `/v9/projects/${PROJECT_ID}`) {
        return jsonResponse(project({
          link: {
            type: 'github',
            org: 'example',
            repo: 'invoice-perfect',
            productionBranch: 'main',
          },
        }));
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      boundEnvironment(),
      {},
      { deferDeployment: true }
    );

    expect(result.receipt.error).toContain('native Git source');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('observes durable IDs, domains, runtime status, and secret-safe hashes', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === '/v10/projects') {
        return jsonResponse(projectsResponse([project()]));
      }
      if (url.pathname === `/v10/projects/${PROJECT_ID}/env`) {
        return jsonResponse(envResponse([
          {
            id: 'env_session',
            key: 'SESSION_SECRET',
            value: 'secret-value',
            type: 'sensitive',
            target: ['production'],
            decrypted: true,
            comment: 'Managed by Hypervibe',
          },
          {
            id: 'env_health',
            key: 'HYPERVIBE_HEALTH_CHECK_PATH',
            value: '/health',
            type: 'sensitive',
            target: ['production'],
            decrypted: true,
            comment: 'Managed by Hypervibe',
          },
        ]));
      }
      if (url.pathname === '/v7/deployments') {
        return jsonResponse({
          deployments: [deployment()],
          pagination: { next: null },
        });
      }
      if (url.pathname === `/v9/projects/${PROJECT_ID}/domains`) {
        return jsonResponse(domainsResponse([
          {
            name: 'invoiceperfect.com',
            projectId: PROJECT_ID,
            verified: true,
          },
        ]));
      }
      if (url.pathname === '/v6/domains/invoiceperfect.com/config') {
        return jsonResponse({ misconfigured: false });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const observed = await adapter.observe(boundEnvironment());

    expect(observed).toMatchObject({
      projectExists: true,
      projectId: SCOPE_BINDING,
      partial: false,
      completeness: {
        services: 'complete',
        databases: 'unknown',
        caches: 'unknown',
      },
      services: [{
        name: 'web',
        externalId: SERVICE_BINDING,
        workloadKind: 'web',
        url: 'https://invoice-perfect.vercel.app',
        customDomains: ['invoiceperfect.com'],
        customDomainStatus: {
          'invoiceperfect.com': { providerVerified: true, dnsConfigured: true },
        },
        config: {
          healthCheckPath: '/health',
          public: true,
        },
        sourceState: 'disconnected',
        envVarKeys: ['SESSION_SECRET'],
        envVarHashes: {
          SESSION_SECRET: hashEnvValue('secret-value'),
        },
        status: 'running',
      }],
    });
    expect(JSON.stringify(observed)).not.toContain('secret-value');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('preserves unknown encrypted values as unknown instead of false absence', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === '/v10/projects') {
        return jsonResponse(projectsResponse([project()]));
      }
      if (url.pathname.endsWith('/env')) {
        return jsonResponse(envResponse([{
          id: 'env_secret',
          key: 'SESSION_SECRET',
          value: '',
          type: 'encrypted',
          target: ['production'],
          decrypted: false,
        }]));
      }
      if (url.pathname === '/v7/deployments') {
        return jsonResponse({
          deployments: [],
          pagination: { next: null },
        });
      }
      if (url.pathname.endsWith('/domains')) {
        return jsonResponse(domainsResponse([]));
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const observed = await adapter.observe(boundEnvironment());

    expect(observed.partial).toBe(true);
    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.services[0]?.envVarKeys).toEqual(['SESSION_SECRET']);
    expect(observed.services[0]?.envVarHashes).toEqual({});
    expect(observed.warnings[0]).toContain('web:SESSION_SECRET');
  });

  it('blocks unbound managed-name projects and propagates permission failures', async () => {
    const unboundFetch = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === '/v10/projects') {
        return jsonResponse(projectsResponse([project()]));
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', unboundFetch);
    const adapter = await connectedAdapter();

    await expect(adapter.observe(makeEnvironment({
      provider: 'vercel',
      projectId: SCOPE_BINDING,
      services: {},
    }))).rejects.toThrow(/hv_import/);
    expect(mutationCalls(unboundFetch)).toEqual([]);

    const failedFetch = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const identity = identityResponse(url);
      if (identity) return identity;
      if (url.pathname === '/v10/projects') {
        return jsonResponse({ error: { code: 'forbidden' } }, 403);
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', failedFetch);

    await expect(adapter.observe(makeEnvironment({
      provider: 'vercel',
      projectId: SCOPE_BINDING,
      services: {},
    }))).rejects.toThrow('Vercel REST API error: 403 (forbidden)');
    expect(mutationCalls(failedFetch)).toEqual([]);
  });

  it('deletes only explicitly retired mutable variables and verifies absence', async () => {
    let envReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const identity = identityResponse(url);
      if (identity) return identity;
      if (
        url.pathname === `/v9/projects/${PROJECT_ID}`
        && method === 'GET'
      ) {
        return jsonResponse(project());
      }
      if (
        url.pathname === `/v10/projects/${PROJECT_ID}/env`
        && method === 'GET'
      ) {
        envReads += 1;
        return jsonResponse(envResponse(envReads === 1
          ? [{
              id: 'env_old',
              key: 'OLD_VALUE',
              value: 'old-secret',
              type: 'sensitive',
              target: ['production'],
              decrypted: true,
            }]
          : []));
      }
      if (
        url.pathname === `/v9/projects/${PROJECT_ID}/env/env_old`
        && method === 'DELETE'
      ) {
        return jsonResponse({}, 204);
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HYPERVIBE_VERCEL_ENV_DELETE_DELAY_MS', '0');
    const adapter = await connectedAdapter();

    const receipt = await adapter.deleteEnvVars!(
      boundEnvironment(),
      makeService(),
      ['OLD_VALUE', 'OLD_VALUE', 'HYPERVIBE_HEALTH_CHECK_PATH']
    );

    expect(receipt).toMatchObject({
      success: true,
      data: {
        serviceId: SERVICE_BINDING,
        deletedKeys: ['OLD_VALUE'],
      },
    });
    expect(fetchMock.mock.calls.filter((call) =>
      (call[1] as RequestInit | undefined)?.method === 'DELETE'
    )).toHaveLength(1);
  });

  it('refuses to delete integration-owned or ambiguous variables', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const identity = identityResponse(url);
      if (identity) return identity;
      if (
        url.pathname === `/v9/projects/${PROJECT_ID}`
        && method === 'GET'
      ) {
        return jsonResponse(project());
      }
      if (
        url.pathname === `/v10/projects/${PROJECT_ID}/env`
        && method === 'GET'
      ) {
        return jsonResponse(envResponse([
          {
            id: 'env_owned',
            key: 'OLD_VALUE',
            value: '',
            type: 'encrypted',
            target: ['production'],
            configurationId: 'icfg_123',
          },
        ]));
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.deleteEnvVars!(
      boundEnvironment(),
      makeService(),
      ['OLD_VALUE']
    );

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('integration configuration');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('deletes projects idempotently and only succeeds after confirmed absence', async () => {
    let projectReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const identity = identityResponse(url);
      if (identity) return identity;
      if (
        url.pathname === `/v9/projects/${PROJECT_ID}`
        && method === 'GET'
      ) {
        projectReads += 1;
        return projectReads === 1
          ? jsonResponse(project())
          : jsonResponse({}, 404);
      }
      if (
        url.pathname === `/v9/projects/${PROJECT_ID}`
        && method === 'DELETE'
      ) {
        return jsonResponse({}, 204);
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HYPERVIBE_VERCEL_PROJECT_DELETE_DELAY_MS', '0');
    const adapter = await connectedAdapter();

    await expect(adapter.deleteService!(SERVICE_BINDING)).resolves.toEqual({
      success: true,
    });
    expect(fetchMock.mock.calls.filter((call) =>
      (call[1] as RequestInit | undefined)?.method === 'DELETE'
    )).toHaveLength(1);

    const absentFetch = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const identity = identityResponse(url);
      return identity ?? jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', absentFetch);
    await expect(adapter.deleteService!(SERVICE_BINDING)).resolves.toEqual({
      success: true,
    });
    expect(mutationCalls(absentFetch)).toEqual([]);
  });

  it('refuses deletion when the durable service scope differs from the verified token', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const identity = identityResponse(url);
      if (identity) return identity;
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.deleteService!(
        `team:team_other:${PROJECT_ID}`
      )
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(
        'does not match the verified token scope'
      ),
    });
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('rejects unsupported workloads before any provider request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService({
        name: 'worker',
        buildConfig: {
          workloadKind: 'worker',
          startCommand: 'npm run worker',
        },
      }),
      makeEnvironment({
        provider: 'vercel',
        projectId: SCOPE_BINDING,
        services: {},
      }),
      {},
      { deferDeployment: true }
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('Workers and cron jobs');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported command and build overrides before provider requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();
    const environment = makeEnvironment({
      provider: 'vercel',
      projectId: SCOPE_BINDING,
      services: {},
    });

    const startCommand = await adapter.deploy(
      makeService({
        buildConfig: {
          workloadKind: 'web',
          startCommand: 'node server.mjs',
          public: true,
        },
      }),
      environment,
      {},
      { deferDeployment: true }
    );
    expect(startCommand.receipt.error).toContain(
      'do not run an arbitrary long-lived startCommand'
    );

    const dockerfile = await adapter.deploy(
      makeService({
        buildConfig: {
          workloadKind: 'web',
          builder: 'dockerfile',
          dockerfilePath: 'Dockerfile',
          public: true,
        },
      }),
      environment,
      {},
      { deferDeployment: true }
    );
    expect(dockerfile.receipt.error).toContain(
      'does not apply buildCommand or Dockerfile overrides'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
