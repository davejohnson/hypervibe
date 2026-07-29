import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import { AzureContainerAppsAdapter } from '../azure-container-apps.adapter.js';

const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const RESOURCE_GROUP = 'hypervibe-test';
const ENVIRONMENT_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/managedEnvironments/hv-env`;
const APP_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/containerApps/hv-app`;
const CREATED_ENVIRONMENT_NAME =
  `hv-${createHash('sha256').update('project-local').digest('hex').slice(0, 8)}`
  + `-${createHash('sha256').update('production').digest('hex').slice(0, 8)}`;
const CREATED_ENVIRONMENT_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/managedEnvironments/${CREATED_ENVIRONMENT_NAME}`;
const CREATED_APP_NAME =
  `hv-${createHash('sha256').update('project-local').digest('hex').slice(0, 7)}`
  + `-${createHash('sha256').update('production').digest('hex').slice(0, 6)}`
  + `-${createHash('sha256').update('web').digest('hex').slice(0, 8)}`;
const CREATED_APP_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/containerApps/${CREATED_APP_NAME}`;
const CLIENT_SECRET = 'azure-client-secret-never-output';
const OLD_SECRET_NAME =
  `hv-env-${createHash('sha256').update('OLD_KEY').digest('hex').slice(0, 20)}`;
const PORT_SECRET_NAME =
  `hv-env-${createHash('sha256').update('PORT').digest('hex').slice(0, 20)}`;

const credentials = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: SUBSCRIPTION_ID,
  clientId: '33333333-3333-4333-8333-333333333333',
  clientSecret: CLIENT_SECRET,
  resourceGroup: RESOURCE_GROUP,
  location: 'canadacentral',
  registryId:
    `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/registry-rg/providers/Microsoft.ContainerRegistry/registries/hypervibetest`,
  registryServer: 'hypervibetest.azurecr.io',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function noContent(status = 204): Response {
  return new Response(null, { status });
}

function managedEnvironment(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: ENVIRONMENT_ID,
    name: 'hv-env',
    location: 'canadacentral',
    properties: { provisioningState: 'Succeeded' },
    ...overrides,
  };
}

function containerApp(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: APP_ID,
    name: 'hv-app',
    location: 'canadacentral',
    tags: {
      'hypervibe-service': 'web',
      'hypervibe-workload-kind': 'web',
    },
    properties: {
      environmentId: ENVIRONMENT_ID,
      provisioningState: 'Succeeded',
      runningStatus: 'Running',
      latestRevisionName: 'hv-app--release',
      latestReadyRevisionName: 'hv-app--release',
      configuration: {
        activeRevisionsMode: 'Single',
        ingress: {
          external: true,
          targetPort: 8080,
          fqdn: 'hv-app.example.azurecontainerapps.io',
          customDomains: [],
        },
        secrets: [
          { name: 'hypervibe-acr-password' },
          { name: OLD_SECRET_NAME },
          { name: PORT_SECRET_NAME },
        ],
        registries: [{
          server: credentials.registryServer,
          username: credentials.clientId,
          passwordSecretRef: 'hypervibe-acr-password',
        }],
      },
      template: {
        containers: [{
          name: 'web',
          image: `${credentials.registryServer}/hypervibe/repo@sha256:${'a'.repeat(64)}`,
          command: ['/bin/sh'],
          args: ['-lc', 'exec sh -lc "$HYPERVIBE_START_COMMAND"'],
          env: [
            { name: 'HYPERVIBE_START_COMMAND', value: 'npm start' },
            { name: 'HYPERVIBE_HEALTH_CHECK_PATH', value: '/health' },
            { name: 'OLD_KEY', secretRef: OLD_SECRET_NAME },
            { name: 'PORT', secretRef: PORT_SECRET_NAME },
          ],
          resources: { cpu: 0.25, memory: '0.5Gi' },
        }],
        scale: { minReplicas: 0, maxReplicas: 10 },
      },
    },
    ...overrides,
  };
}

function revision(): Record<string, unknown> {
  return {
    id: `${APP_ID}/revisions/hv-app--release`,
    name: 'hv-app--release',
    properties: {
      active: true,
      provisioningState: 'Provisioned',
      healthState: 'Healthy',
      runningState: 'Running',
      template: {
        containers: [
          (containerApp().properties as {
            template: { containers: unknown[] };
          }).template.containers[0],
        ],
      },
    },
  };
}

function makeEnvironment(
  platformBindings: Record<string, unknown> = {}
): Environment {
  return {
    id: 'env-local',
    projectId: 'project-local',
    name: 'production',
    platformBindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeService(
  overrides: Partial<Service['buildConfig']> = {}
): Service {
  return {
    id: 'service-local',
    projectId: 'project-local',
    name: 'web',
    buildConfig: {
      builder: 'dockerfile',
      workloadKind: 'web',
      startCommand: 'npm start',
      healthCheckPath: '/health',
      public: true,
      ...overrides,
    },
    envVarSpec: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function installAzureFetch(
  handler: (
    url: URL,
    method: string,
    body: unknown
  ) => Response | Promise<Response>
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') {
      return jsonResponse({ access_token: 'safe-access-token' });
    }
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body)
      : undefined;
    return handler(url, method, body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function serviceBindings(): Record<string, unknown> {
  return {
    provider: 'azure-container-apps',
    projectId: ENVIRONMENT_ID,
    services: {
      web: { serviceId: APP_ID },
    },
  };
}

async function connectedAdapter(): Promise<AzureContainerAppsAdapter> {
  const adapter = new AzureContainerAppsAdapter();
  await adapter.connect(credentials);
  return adapter;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AzureContainerAppsAdapter', () => {
  it('creates and binds only a managed environment for the project action', async () => {
    const requests: Array<{ method: string; pathname: string; body: unknown }> = [];
    installAzureFetch((url, method, body) => {
      requests.push({ method, pathname: url.pathname, body });
      if (method === 'GET' && url.pathname.endsWith('/managedEnvironments')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT') {
        return jsonResponse(managedEnvironment({
          id: CREATED_ENVIRONMENT_ID,
          name: CREATED_ENVIRONMENT_NAME,
        }), 201);
      }
      if (
        method === 'GET'
        && url.pathname.endsWith(
          `/managedEnvironments/${CREATED_ENVIRONMENT_NAME}`
        )
      ) {
        return jsonResponse(managedEnvironment({
          id: CREATED_ENVIRONMENT_ID,
          name: CREATED_ENVIRONMENT_NAME,
        }));
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject(
      'invoice-perfect',
      makeEnvironment()
    );

    expect(receipt.success).toBe(true);
    expect(receipt.data).toMatchObject({
      projectId: CREATED_ENVIRONMENT_ID,
      created: true,
    });
    const create = requests.find((request) => request.method === 'PUT');
    expect(create?.body).toMatchObject({
      location: 'canadacentral',
      properties: { zoneRedundant: false },
    });
    expect(requests.some((request) =>
      request.pathname.includes('/containerApps')
    )).toBe(false);
  });

  it('preserves the deterministic environment identity when the create request outcome is unknown', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/managedEnvironments')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject(
      'invoice-perfect',
      makeEnvironment()
    );

    expect(receipt.success).toBe(false);
    expect(receipt.data).toMatchObject({
      projectId: CREATED_ENVIRONMENT_ID,
      created: true,
      mutationAttempted: true,
    });
  });

  it('blocks a stale managed-environment binding without creating a replacement', async () => {
    const fetchMock = installAzureFetch((_url, method) => {
      if (method === 'GET') return jsonResponse({ error: 'missing' }, 404);
      throw new Error('unexpected mutation');
    });
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject(
      'invoice-perfect',
      makeEnvironment({
        provider: 'azure-container-apps',
        projectId: ENVIRONMENT_ID,
        services: {},
      })
    );

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('stale binding');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'))
      .toBe(false);
  });

  it('creates only an empty bootstrap app and returns a secret-safe receipt', async () => {
    let createBody: any;
    installAzureFetch((url, method, body) => {
      if (method === 'GET' && url.pathname.endsWith('/managedEnvironments/hv-env')) {
        return jsonResponse(managedEnvironment());
      }
      if (method === 'GET' && url.pathname.endsWith('/containerApps')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT' && url.pathname.includes('/containerApps/')) {
        createBody = body;
        return jsonResponse(containerApp({
          id: CREATED_APP_ID,
          name: CREATED_APP_NAME,
        }), 201);
      }
      if (
        method === 'GET'
        && url.pathname.endsWith(`/containerApps/${CREATED_APP_NAME}`)
      ) {
        return jsonResponse(containerApp({
          id: CREATED_APP_ID,
          name: CREATED_APP_NAME,
        }));
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'azure-container-apps',
        projectId: ENVIRONMENT_ID,
        services: {},
      }),
      { DATABASE_URL: 'postgres://secret', PORT: '8080' },
      { deferDeployment: true }
    );

    expect(result.status).toBe('configured');
    expect(result.externalId).toBe(CREATED_APP_ID);
    expect(result.receipt.data).toMatchObject({
      createdService: true,
      deploymentDeferred: true,
    });
    expect(createBody.properties.template.containers[0]).toMatchObject({
      image: 'mcr.microsoft.com/k8se/quickstart:latest',
      command: ['/bin/sh'],
      args: ['-lc', 'while true; do sleep 3600; done'],
    });
    expect(createBody.properties.configuration.ingress.targetPort).toBe(8080);
    expect(createBody.properties.configuration.registries[0]).toMatchObject({
      server: credentials.registryServer,
      username: credentials.clientId,
      passwordSecretRef: 'hypervibe-acr-password',
    });
    expect(JSON.stringify(createBody)).toContain('postgres://secret');
    expect(JSON.stringify(result)).not.toContain('postgres://secret');
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });

  it('preserves the created app identity when readiness observation fails', async () => {
    let appGetCount = 0;
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/managedEnvironments/hv-env')) {
        return jsonResponse(managedEnvironment());
      }
      if (method === 'GET' && url.pathname.endsWith('/containerApps')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT') {
        return jsonResponse(containerApp({
          id: CREATED_APP_ID,
          name: CREATED_APP_NAME,
        }), 201);
      }
      if (
        method === 'GET'
        && url.pathname.endsWith(`/containerApps/${CREATED_APP_NAME}`)
      ) {
        appGetCount += 1;
        return jsonResponse({ error: 'unknown' }, 500);
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'azure-container-apps',
        projectId: ENVIRONMENT_ID,
        services: {},
      }),
      {}
    );

    expect(appGetCount).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.externalId).toBe(CREATED_APP_ID);
    expect(result.receipt.data).toMatchObject({
      createdService: true,
      mutationAttempted: true,
    });
  });

  it('preserves the deterministic app identity when the create request outcome is unknown', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/managedEnvironments/hv-env')) {
        return jsonResponse(managedEnvironment());
      }
      if (method === 'GET' && url.pathname.endsWith('/containerApps')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'azure-container-apps',
        projectId: ENVIRONMENT_ID,
        services: {},
      }),
      {}
    );

    expect(result.status).toBe('failed');
    expect(result.externalId).toBe(CREATED_APP_ID);
    expect(result.receipt.data).toMatchObject({
      createdService: true,
      mutationAttempted: true,
    });
  });

  it('blocks a stale service binding without creating a replacement', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      if (url.pathname.endsWith('/managedEnvironments/hv-env')) {
        return jsonResponse(managedEnvironment());
      }
      if (url.pathname.endsWith('/containerApps/hv-app')) {
        return jsonResponse({ error: 'missing' }, 404);
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();
    const environment = makeEnvironment({
      provider: 'azure-container-apps',
      projectId: ENVIRONMENT_ID,
      services: { web: { serviceId: APP_ID } },
    });

    const stale = await adapter.deploy(makeService(), environment, {});
    expect(stale.receipt.error).toContain('stale binding');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'))
      .toBe(false);
  });

  it('blocks exact-name adoption candidates without mutating either app', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      if (url.pathname.endsWith('/managedEnvironments/hv-env')) {
        return jsonResponse(managedEnvironment());
      }
      if (url.pathname.endsWith('/containerApps')) {
        return jsonResponse({
          value: [containerApp({
            id: CREATED_APP_ID,
            name: CREATED_APP_NAME,
          })],
        });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService(),
      makeEnvironment({
        provider: 'azure-container-apps',
        projectId: ENVIRONMENT_ID,
        services: {},
      }),
      {}
    );

    expect(result.status).toBe('failed');
    expect(result.receipt.error).toContain('hv_import');
    expect(fetchMock.mock.calls.some(([, init]) =>
      ['PUT', 'PATCH'].includes(init?.method ?? 'GET')
    )).toBe(false);
  });

  it('blocks cron and missing start commands before any provider request', async () => {
    const fetchMock = installAzureFetch(() => {
      throw new Error('provider request should not occur');
    });
    const adapter = await connectedAdapter();
    const environment = makeEnvironment(serviceBindings());

    const cron = await adapter.deploy(
      makeService({ workloadKind: 'cron', cronSchedule: '0 * * * *' }),
      environment,
      {}
    );
    const missing = await adapter.deploy(
      makeService({ startCommand: undefined }),
      environment,
      {}
    );

    expect(cron.status).toBe('failed');
    expect(cron.receipt.error).toContain('distinct lifecycle resource');
    expect(missing.status).toBe('failed');
    expect(missing.receipt.error).toContain('require startCommand');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('merges env vars without changing the deployed image or erasing omitted secrets', async () => {
    let patchBody: any;
    installAzureFetch((url, method, body) => {
      if (method === 'GET' && url.pathname.endsWith('/managedEnvironments/hv-env')) {
        return jsonResponse(managedEnvironment());
      }
      if (method === 'GET' && url.pathname.endsWith('/containerApps/hv-app')) {
        return jsonResponse(containerApp());
      }
      if (method === 'POST' && url.pathname.endsWith('/listSecrets')) {
        return jsonResponse({
          value: [
            { name: 'hypervibe-acr-password', value: CLIENT_SECRET },
            { name: OLD_SECRET_NAME, value: 'preserved-old-value' },
            { name: PORT_SECRET_NAME, value: '8080' },
          ],
        });
      }
      if (method === 'PATCH') {
        patchBody = body;
        return jsonResponse(containerApp());
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const result = await adapter.deploy(
      makeService({ startCommand: 'node server.js' }),
      makeEnvironment(serviceBindings()),
      { NEW_KEY: 'new-secret-value' },
      { deferDeployment: true }
    );

    expect(result.status).toBe('configured');
    const container = patchBody.properties.template.containers[0];
    expect(container.image).toContain('@sha256:');
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'OLD_KEY', secretRef: OLD_SECRET_NAME },
      { name: 'PORT', secretRef: PORT_SECRET_NAME },
      { name: 'HYPERVIBE_START_COMMAND', value: 'node server.js' },
    ]));
    expect(patchBody.properties.configuration.secrets).toEqual(
      expect.arrayContaining([
        { name: OLD_SECRET_NAME, value: 'preserved-old-value' },
        { name: PORT_SECRET_NAME, value: '8080' },
      ])
    );
    expect(patchBody.properties.configuration.ingress.targetPort).toBe(8080);
  });

  it('blocks updates when Azure cannot return an existing secret value', async () => {
    let mutated = false;
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/containerApps/hv-app')) {
        return jsonResponse(containerApp());
      }
      if (method === 'POST' && url.pathname.endsWith('/listSecrets')) {
        return jsonResponse({
          value: [
            { name: 'hypervibe-acr-password', value: CLIENT_SECRET },
            { name: OLD_SECRET_NAME },
            { name: PORT_SECRET_NAME, value: '8080' },
          ],
        });
      }
      if (method === 'PATCH') mutated = true;
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const receipt = await adapter.setEnvVars(
      makeEnvironment(serviceBindings()),
      makeService(),
      { NEW_KEY: 'value' }
    );

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('refused an update that could erase');
    expect(mutated).toBe(false);
  });

  it('deletes only explicitly retired env vars and their deterministic secrets', async () => {
    let patchBody: any;
    installAzureFetch((url, method, body) => {
      if (method === 'GET' && url.pathname.endsWith('/containerApps/hv-app')) {
        return jsonResponse(containerApp());
      }
      if (method === 'POST' && url.pathname.endsWith('/listSecrets')) {
        return jsonResponse({
          value: [
            { name: 'hypervibe-acr-password', value: CLIENT_SECRET },
            { name: OLD_SECRET_NAME, value: 'preserved-old-value' },
            { name: PORT_SECRET_NAME, value: '8080' },
          ],
        });
      }
      if (method === 'PATCH') {
        patchBody = body;
        return jsonResponse(containerApp());
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const receipt = await adapter.deleteEnvVars(
      makeEnvironment(serviceBindings()),
      makeService(),
      ['OLD_KEY', 'PORT', 'HYPERVIBE_DEPLOY_SHA']
    );

    expect(receipt.success).toBe(true);
    expect(receipt.data?.deletedKeys).toEqual(['OLD_KEY', 'PORT']);
    expect(patchBody.properties.template.containers[0].env)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'OLD_KEY' }),
        expect.objectContaining({ name: 'PORT' }),
      ]));
    expect(patchBody.properties.configuration.secrets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: OLD_SECRET_NAME }),
        expect.objectContaining({ name: PORT_SECRET_NAME }),
      ])
    );
    expect(patchBody.properties.configuration.ingress.targetPort).toBe(80);
  });

  it('observes durable identities, safe hashes, runtime state, and source control', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/managedEnvironments')) {
        return jsonResponse({ value: [managedEnvironment()] });
      }
      if (method === 'GET' && url.pathname.endsWith('/containerApps')) {
        return jsonResponse({ value: [containerApp()] });
      }
      if (method === 'POST' && url.pathname.endsWith('/listSecrets')) {
        return jsonResponse({
          value: [
            { name: 'hypervibe-acr-password', value: CLIENT_SECRET },
            { name: OLD_SECRET_NAME, value: 'preserved-old-value' },
            { name: PORT_SECRET_NAME, value: '8080' },
          ],
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/revisions')) {
        return jsonResponse({ value: [revision()] });
      }
      if (method === 'GET' && url.pathname.endsWith('/sourcecontrols')) {
        return jsonResponse({
          value: [{
            id: `${APP_ID}/sourcecontrols/current`,
            name: 'current',
            properties: {
              repoUrl: 'https://github.com/example/app',
              branch: 'main',
            },
          }],
        });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const observed = await adapter.observe(
      makeEnvironment(serviceBindings())
    );

    expect(observed.projectId).toBe(ENVIRONMENT_ID);
    expect(observed.completeness?.services).toBe('complete');
    expect(observed.services).toEqual([
      expect.objectContaining({
        name: 'web',
        externalId: APP_ID,
        workloadKind: 'web',
        url: 'https://hv-app.example.azurecontainerapps.io',
        sourceState: 'connected',
        source: {
          repo: 'https://github.com/example/app',
          branch: 'main',
        },
        envVarKeys: ['OLD_KEY', 'PORT'],
        envVarHashes: {
          OLD_KEY: hashEnvValue('preserved-old-value'),
          PORT: hashEnvValue('8080'),
        },
        status: 'running',
      }),
    ]);
    expect(JSON.stringify(observed)).not.toContain('preserved-old-value');
    expect(JSON.stringify(observed)).not.toContain(CLIENT_SECRET);
  });

  it('marks service observation unknown instead of treating unavailable secrets as empty', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/managedEnvironments')) {
        return jsonResponse({ value: [managedEnvironment()] });
      }
      if (method === 'GET' && url.pathname.endsWith('/containerApps')) {
        return jsonResponse({ value: [containerApp()] });
      }
      if (method === 'POST' && url.pathname.endsWith('/listSecrets')) {
        return jsonResponse({ value: [{ name: OLD_SECRET_NAME }] });
      }
      if (method === 'GET' && url.pathname.endsWith('/revisions')) {
        return jsonResponse({ value: [revision()] });
      }
      if (method === 'GET' && url.pathname.endsWith('/sourcecontrols')) {
        return jsonResponse({ value: [] });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const observed = await adapter.observe(
      makeEnvironment(serviceBindings())
    );

    expect(observed.partial).toBe(true);
    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.warnings.join(' ')).toContain('service configuration is unknown');
  });

  it('blocks unbound resources in a managed environment with import guidance', async () => {
    installAzureFetch((url, method) => {
      if (url.pathname.endsWith('/managedEnvironments')) {
        return jsonResponse({ value: [managedEnvironment()] });
      }
      if (url.pathname.endsWith('/containerApps')) {
        return jsonResponse({ value: [containerApp()] });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    await expect(adapter.observe(makeEnvironment({
      provider: 'azure-container-apps',
      projectId: ENVIRONMENT_ID,
      services: {},
    }))).rejects.toThrow(/hv_import/);
  });

  it('disconnects every observed native source control and verifies absence', async () => {
    let deleted = false;
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/containerApps/hv-app')) {
        return jsonResponse(containerApp());
      }
      if (method === 'GET' && url.pathname.endsWith('/sourcecontrols')) {
        return jsonResponse({
          value: deleted
            ? []
            : [{
                id: `${APP_ID}/sourcecontrols/current`,
                name: 'current',
              }],
        });
      }
      if (method === 'DELETE' && url.pathname.endsWith('/sourcecontrols/current')) {
        deleted = true;
        return noContent();
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const receipt = await adapter.disconnectDeploySource({
      serviceId: APP_ID,
    });

    expect(receipt.success).toBe(true);
    expect(receipt.data?.disconnectedCount).toBe(1);
  });

  it('makes service deletion idempotent and verifies terminal 404 absence', async () => {
    let deleted = false;
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/containerApps/hv-app')) {
        return deleted
          ? jsonResponse({ error: 'gone' }, 404)
          : jsonResponse(containerApp());
      }
      if (method === 'DELETE') {
        deleted = true;
        return noContent(202);
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    await expect(adapter.deleteService(APP_ID)).resolves.toEqual({
      success: true,
    });
    await expect(adapter.deleteService(APP_ID)).resolves.toEqual({
      success: true,
    });
  });

  it('refuses to delete the managed environment while dependent apps remain', async () => {
    let deleteAttempted = false;
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/managedEnvironments/hv-env')) {
        return jsonResponse(managedEnvironment());
      }
      if (method === 'GET' && url.pathname.endsWith('/containerApps')) {
        return jsonResponse({ value: [containerApp()] });
      }
      if (method === 'DELETE') deleteAttempted = true;
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connectedAdapter();

    const result = await adapter.deleteProject(ENVIRONMENT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('dependent service actions first');
    expect(deleteAttempted).toBe(false);
  });
});
