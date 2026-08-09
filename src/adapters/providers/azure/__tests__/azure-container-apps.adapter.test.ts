import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import {
  AzureContainerAppsAdapter,
  AzureContainerAppsCredentialsSchema,
} from '../azure-container-apps.adapter.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL_ID = '44444444-4444-4444-8444-444444444444';
const RESOURCE_GROUP_ID = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/hv-app-production`;
const APP_ID = `${RESOURCE_GROUP_ID}/providers/Microsoft.App/containerApps/hv-web`;

const credentials = {
  tenantId: TENANT_ID,
  subscriptionId: SUBSCRIPTION_ID,
  clientId: CLIENT_ID,
  clientSecret: 'azure-client-secret-value',
  location: 'canadacentral',
};

function token(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ oid: PRINCIPAL_ID })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function environment(): Environment {
  return {
    id: 'environment-local',
    projectId: 'project-local',
    name: 'production',
    platformBindings: {
      provider: 'azure-container-apps',
      projectId: RESOURCE_GROUP_ID,
      services: {},
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function service(): Service {
  return {
    id: 'service-local',
    projectId: 'project-local',
    name: 'web',
    buildConfig: {
      builder: 'dockerfile',
      workloadKind: 'web',
      startCommand: 'node server.mjs',
      healthCheckPath: '/health',
      public: true,
    },
    envVarSpec: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function connectedAdapter(): Promise<AzureContainerAppsAdapter> {
  const adapter = new AzureContainerAppsAdapter();
  await adapter.connect(credentials);
  return adapter;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AzureContainerAppsAdapter lifecycle boundaries', () => {
  it('keeps location out of credentials while accepting a legacy value during migration', () => {
    expect(AzureContainerAppsCredentialsSchema.parse(credentials)).toEqual({
      tenantId: TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      clientId: CLIENT_ID,
      clientSecret: credentials.clientSecret,
    });
    expect(() => AzureContainerAppsCredentialsSchema.parse({
      ...credentials,
      resourceGroup: 'precreated-group',
      registryServer: 'precreated.azurecr.io',
    })).toThrow();
  });

  it('uses explicit desired-state location instead of the legacy connection value', async () => {
    const adapter = await connectedAdapter();
    adapter.configureTarget({ region: 'westus2' });
    const runtime = (adapter as unknown as { credentials: { location: string } }).credentials;
    expect(runtime.location).toBe('westus2');
  });

  it('preserves an unknown project observation and performs no mutations', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'login.microsoftonline.com') return json({ access_token: token() });
      const method = init?.method ?? 'GET';
      methods.push(method);
      return json({ error: { code: 'TooManyRequests', message: 'try later' } }, 429);
    }));
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject('app', environment());

    expect(receipt).toMatchObject({ success: false });
    expect(receipt.error).toContain('429');
    expect(methods).toEqual(['GET']);
  });

  it('does not create a replacement for a missing bound resource group', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'login.microsoftonline.com') return json({ access_token: token() });
      const method = init?.method ?? 'GET';
      methods.push(method);
      return json({ error: { code: 'ResourceNotFound', message: 'absent' } }, 404);
    }));
    const adapter = await connectedAdapter();

    const receipt = await adapter.ensureProject('app', environment());

    expect(receipt).toMatchObject({ success: false });
    expect(receipt.error).toContain('will not create a replacement');
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('refuses to delete an exact but unowned Container App binding', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'login.microsoftonline.com') return json({ access_token: token() });
      const method = init?.method ?? 'GET';
      methods.push(method);
      return json({
        id: APP_ID,
        name: 'hv-web',
        tags: { 'managed-by': 'someone-else' },
        properties: {},
      });
    }));
    const adapter = await connectedAdapter();

    const result = await adapter.deleteService(APP_ID);

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('not Hypervibe-managed');
    expect(methods).toEqual(['GET']);
  });

  it('creates, observes without mutation, and tears down one owned project boundary', async () => {
    const tags = {
      'managed-by': 'hypervibe',
      'hypervibe-environment-id': 'environment-local',
    };
    const calls: Array<{ method: string; path: string }> = [];
    let group: Record<string, any> | null = null;
    let registry: Record<string, any> | null = null;
    let managedEnvironment: Record<string, any> | null = null;
    let app: Record<string, any> | null = null;
    const roleAssignments = new Map<string, Record<string, any>>();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'login.microsoftonline.com') return json({ access_token: token() });
      const method = init?.method ?? 'GET';
      const path = url.pathname;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, any> : undefined;
      calls.push({ method, path });

      if (method === 'GET' && /^\/subscriptions\/[^/]+\/providers\/Microsoft\.(App|ContainerRegistry)$/i.test(path)) {
        return json({ id: path, name: path.split('/').at(-1), properties: { registrationState: 'Registered' } });
      }
      if (method === 'GET' && path.includes('/providers/Microsoft.Authorization/roleAssignments/')) {
        const assignment = roleAssignments.get(path.toLowerCase());
        return assignment ? json(assignment) : json({ error: {} }, 404);
      }
      if (method === 'GET' && /\/providers\/Microsoft\.App\/containerApps\/[^/]+$/i.test(path)) {
        return app ? json(app) : json({ error: {} }, 404);
      }
      if (method === 'GET' && path.endsWith('/providers/Microsoft.App/containerApps')) {
        return json({ value: app ? [app] : [] });
      }
      if (method === 'GET' && path.endsWith('/resources')) {
        return json({ value: [registry, managedEnvironment].filter(Boolean) });
      }
      if (method === 'GET' && path.includes('/providers/Microsoft.ContainerRegistry/registries/')) {
        return registry ? json(registry) : json({ error: {} }, 404);
      }
      if (method === 'GET' && path.includes('/providers/Microsoft.App/managedEnvironments/')) {
        return managedEnvironment ? json(managedEnvironment) : json({ error: {} }, 404);
      }
      if (method === 'GET' && /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+$/i.test(path)) {
        return group ? json(group) : json({ error: {} }, 404);
      }

      if (method === 'PUT' && /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+$/i.test(path)) {
        group = { id: path, name: path.split('/').at(-1), location: body?.location, tags, properties: {} };
        return json(group, 201);
      }
      if (method === 'PUT' && path.includes('/providers/Microsoft.Authorization/roleAssignments/')) {
        const assignment = { id: path, name: path.split('/').at(-1), properties: body?.properties };
        roleAssignments.set(path.toLowerCase(), assignment);
        return json(assignment, 201);
      }
      if (method === 'PUT' && path.includes('/providers/Microsoft.ContainerRegistry/registries/')) {
        const name = path.split('/').at(-1)!;
        registry = {
          id: path,
          name,
          location: body?.location,
          tags,
          properties: { loginServer: `${name}.azurecr.io`, provisioningState: 'Succeeded' },
        };
        return json(registry, 201);
      }
      if (method === 'PUT' && path.includes('/providers/Microsoft.App/managedEnvironments/')) {
        managedEnvironment = {
          id: path,
          name: path.split('/').at(-1),
          location: body?.location,
          tags,
          properties: { provisioningState: 'Succeeded', staticIp: '203.0.113.10' },
        };
        return json(managedEnvironment, 201);
      }
      if (method === 'PUT' && /\/providers\/Microsoft\.App\/containerApps\/[^/]+$/i.test(path)) {
        app = {
          id: path,
          name: path.split('/').at(-1),
          location: body?.location,
          identity: { type: 'SystemAssigned', principalId: '55555555-5555-4555-8555-555555555555' },
          tags: body?.tags,
          properties: {
            ...body?.properties,
            provisioningState: 'Succeeded',
            customDomainVerificationId: 'verification-id',
            configuration: {
              ...body?.properties?.configuration,
              ingress: {
                ...body?.properties?.configuration?.ingress,
                fqdn: 'hv-web.example.azurecontainerapps.io',
                customDomains: [],
              },
            },
          },
        };
        return json(app, 201);
      }
      if (method === 'PATCH' && /\/providers\/Microsoft\.App\/containerApps\/[^/]+$/i.test(path)) {
        app = {
          ...app,
          ...body,
          id: path,
          name: path.split('/').at(-1),
          identity: app?.identity,
          properties: {
            ...app?.properties,
            ...body?.properties,
            provisioningState: 'Succeeded',
            configuration: {
              ...body?.properties?.configuration,
              ingress: {
                ...body?.properties?.configuration?.ingress,
                fqdn: 'hv-web.example.azurecontainerapps.io',
                customDomains: body?.properties?.configuration?.ingress?.customDomains ?? [],
              },
            },
          },
        };
        return json(app);
      }
      if (method === 'POST' && path.endsWith('/listSecrets')) {
        return json({
          value: (app?.properties?.configuration?.secrets ?? []).map(
            (secret: any) => ({ name: secret.name, value: secret.value })
          ),
        });
      }
      if (method === 'DELETE' && path.includes('/providers/Microsoft.Authorization/roleAssignments/')) {
        roleAssignments.delete(path.toLowerCase());
        return new Response(null, { status: 204 });
      }
      if (method === 'DELETE' && /\/providers\/Microsoft\.App\/containerApps\/[^/]+$/i.test(path)) {
        app = null;
        return new Response(null, { status: 204 });
      }
      if (method === 'DELETE' && /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+$/i.test(path)) {
        group = null;
        registry = null;
        managedEnvironment = null;
        app = null;
        roleAssignments.clear();
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected ${method} ${path}`);
    }));
    const adapter = await connectedAdapter();

    const created = await adapter.ensureProject('app', {
      ...environment(),
      platformBindings: {},
    });
    expect(created).toMatchObject({ success: true, data: { created: true } });
    const projectId = String(created.data?.projectId);
    const environmentId = String(created.data?.environmentId);
    expect(projectId).toBe((group as Record<string, any> | null)?.id);
    expect(environmentId).toBe((managedEnvironment as Record<string, any> | null)?.id);
    expect(registry).not.toBeNull();
    expect(roleAssignments.size).toBe(1);
    const deployed = await adapter.deploy(service(), {
      ...environment(),
      platformBindings: {
        provider: 'azure-container-apps',
        projectId,
        environmentId,
        services: {},
      },
    }, { APP_MODE: 'test' }, { deferDeployment: true });
    expect(deployed).toMatchObject({
      status: 'configured',
      receipt: { success: true, data: { createdService: true } },
    });
    const serviceId = String(deployed.externalId);
    expect((app as Record<string, any> | null)?.id).toBe(serviceId);
    expect(roleAssignments.size).toBe(2);
    const mutationCount = calls.filter(({ method }) => ['PUT', 'PATCH', 'DELETE'].includes(method)).length;

    await expect(adapter.observe({
      ...environment(),
      platformBindings: {
        provider: 'azure-container-apps',
        projectId,
        environmentId,
        services: { web: { serviceId } },
      },
    })).resolves.toMatchObject({
      projectExists: true,
      services: [{ name: 'web', externalId: serviceId, status: 'empty' }],
    });
    expect(calls.filter(({ method }) => ['PUT', 'PATCH', 'DELETE'].includes(method))).toHaveLength(mutationCount);

    await expect(adapter.deleteService(serviceId)).resolves.toEqual({ success: true });
    expect(app).toBeNull();
    expect(roleAssignments.size).toBe(1);
    await expect(adapter.deleteProject(projectId)).resolves.toEqual({ success: true });
    expect(group).toBeNull();
    expect(registry).toBeNull();
    expect(managedEnvironment).toBeNull();
    expect(roleAssignments.size).toBe(0);
  });
});
