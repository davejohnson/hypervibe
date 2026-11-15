import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
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
  it('forensically inventories an abandoned environment from logical context only', async () => {
    const adapter = await connectedAdapter();
    const internal = adapter as any;
    vi.spyOn(internal, 'getResource').mockImplementation(async (...args: unknown[]) => String(args[0]).includes('/resourceGroups/hv-') ? null : ({
      id: String(args[0]),
      name: String(args[0]).split('/').at(-1),
      tags: { 'managed-by': 'hypervibe' },
      properties: {},
    }));
    vi.spyOn(internal, 'listApps').mockResolvedValue([{
      id: APP_ID,
      name: 'hv-web',
      tags: { 'managed-by': 'hypervibe' },
      properties: { runningStatus: 'Running' },
    }]);

    await expect(adapter.inspectEnvironmentResources({
      resource: 'environment',
      limit: 25,
      project: { id: 'project-local', name: 'app' },
      environment: { id: 'environment-local', projectId: 'project-local', name: 'production' },
    })).resolves.toMatchObject({
      observation: 'present',
      resource: 'environment',
      managedByHypervibe: true,
      services: [{ id: APP_ID, managedByHypervibe: true }],
    });
  });

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
});

describe('AzureContainerAppsAdapter maintenance', () => {
  it('stops and restarts the exact bound Container App with terminal verification', async () => {
    const adapter = await connectedAdapter();
    let runningStatus = 'Running';
    const calls: Array<{ method: string; url: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) return json({ access_token: token() });
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.includes(encodeURI(APP_ID)) && method === 'GET') {
        return json({
          id: APP_ID,
          name: 'hv-web',
          tags: {
            'managed-by': 'hypervibe',
            'hypervibe-environment-id': 'environment-local',
          },
          properties: { runningStatus },
        });
      }
      if (url.includes(`${encodeURI(APP_ID)}/stop`) && method === 'POST') {
        runningStatus = 'Stopped';
        return json({});
      }
      if (url.includes(`${encodeURI(APP_ID)}/start`) && method === 'POST') {
        runningStatus = 'Running';
        return json({});
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      ...environment(),
      platformBindings: {
        provider: 'azure-container-apps',
        projectId: RESOURCE_GROUP_ID,
        services: { web: { serviceId: APP_ID } },
      },
    };

    const snapshot = await adapter.observeMaintenanceWorkload(env, APP_ID, 'web');
    await expect(adapter.suspendMaintenanceWorkload(env, snapshot)).resolves.toMatchObject({ success: true });
    await expect(adapter.resumeMaintenanceWorkload(env, snapshot)).resolves.toMatchObject({ success: true });

    expect(calls.some(({ method, url }) => method === 'POST' && url.includes(`${encodeURI(APP_ID)}/stop`))).toBe(true);
    expect(calls.some(({ method, url }) => method === 'POST' && url.includes(`${encodeURI(APP_ID)}/start`))).toBe(true);
    expect(runningStatus).toBe('Running');
  });
});
