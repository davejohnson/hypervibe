import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AzureApiError,
  AzureContainerAppsClient,
} from '../azure-container-apps.client.js';
import type { AzureContainerAppsCredentials } from '../azure-container-apps.credentials.js';

const credentials: AzureContainerAppsCredentials = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333',
  clientSecret: 'azure-client-secret',
  resourceGroup: 'hypervibe-test',
  location: 'canadacentral',
  registryId:
    '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/registry-rg/providers/Microsoft.ContainerRegistry/registries/hypervibetest',
  registryServer: 'hypervibetest.azurecr.io',
  cpu: 0.25,
  memory: '0.5Gi',
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function tokenResponse(): Response {
  return jsonResponse({ access_token: 'safe-access-token' });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AzureContainerAppsClient', () => {
  it('uses the client-credentials flow and follows every ARM nextLink', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        value: [{
          id:
            '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/hypervibe-test/providers/Microsoft.App/managedEnvironments/one',
          name: 'one',
          location: 'canadacentral',
        }],
        nextLink:
          'https://management.azure.com/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/hypervibe-test/providers/Microsoft.App/managedEnvironments?api-version=2026-01-01&$skiptoken=next',
      }))
      .mockResolvedValueOnce(jsonResponse({
        value: [{
          id:
            '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/hypervibe-test/providers/Microsoft.App/managedEnvironments/two',
          name: 'two',
          location: 'canadacentral',
        }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AzureContainerAppsClient(credentials);
    await expect(client.listManagedEnvironments()).resolves.toHaveLength(2);

    const tokenBody = String(fetchMock.mock.calls[0]![1]?.body);
    expect(tokenBody).toContain('grant_type=client_credentials');
    expect(tokenBody).toContain(
      'scope=https%3A%2F%2Fmanagement.azure.com%2F%2F.default'
    );
    expect(fetchMock.mock.calls[1]![0]).toContain(
      'api-version=2026-01-01'
    );
    expect(fetchMock.mock.calls[2]![0]).toContain('$skiptoken=next');
  });

  it('rejects untrusted pagination URLs instead of following them', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        value: [],
        nextLink: 'https://example.invalid/steal-token',
      })));

    const client = new AzureContainerAppsClient(credentials);
    await expect(client.listContainerApps()).rejects.toThrow(
      /untrusted continuation URL/
    );
  });

  it('rejects same-origin pagination that escapes the observed collection', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        value: [],
        nextLink:
          'https://management.azure.com/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/other/providers/Microsoft.App/containerApps?api-version=2026-01-01',
      })));

    const client = new AzureContainerAppsClient(credentials);
    await expect(client.listContainerApps()).rejects.toThrow(
      /different collection/
    );
  });

  it('blocks duplicate durable identities returned across a complete collection', async () => {
    const duplicate = {
      id:
        '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/hypervibe-test/providers/Microsoft.App/containerApps/hv-app',
      name: 'hv-app',
      location: 'canadacentral',
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        value: [duplicate, { ...duplicate }],
      })));

    const client = new AzureContainerAppsClient(credentials);
    await expect(client.listContainerApps()).rejects.toThrow(
      /duplicate containerApps identity/
    );
  });

  it('treats only a confirmed 404 as absence', async () => {
    const appId =
      '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/hypervibe-test/providers/Microsoft.App/containerApps/hv-app';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error: 'missing' }, 404)));
    const absent = new AzureContainerAppsClient(credentials);
    await expect(absent.getContainerApp(appId)).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(
        { error: { message: 'secret provider detail' } },
        403
      )));
    const unknown = new AzureContainerAppsClient(credentials);
    await expect(unknown.getContainerApp(appId)).rejects.toMatchObject({
      name: 'AzureApiError',
      status: 403,
    });
  });

  it('never includes Azure response bodies in safe API errors', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(
        { error: { message: 'contains-super-secret-value' } },
        500
      )));

    const client = new AzureContainerAppsClient(credentials);
    const error = await client.listManagedEnvironments().catch(
      (value: unknown) => value
    );
    expect(error).toBeInstanceOf(AzureApiError);
    expect(String(error)).not.toContain('contains-super-secret-value');
  });

  it('rejects durable bindings outside the configured resource group before a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new AzureContainerAppsClient(credentials);

    await expect(client.getContainerApp(
      '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/other/providers/Microsoft.App/containerApps/hv-app'
    )).rejects.toThrow(/not the configured resource group/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes deletion retry-safe when the resource disappears after observation', async () => {
    const appId =
      '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/hypervibe-test/providers/Microsoft.App/containerApps/hv-app';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error: 'gone' }, 404)));

    const client = new AzureContainerAppsClient(credentials);
    await expect(client.deleteContainerApp(appId)).resolves.toBeUndefined();
  });
});
