import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type {
  AzureBlobDataPlane,
  AzureStorageAccount,
  AzureStorageControlPlane,
} from '../azure-blob.adapter.js';
import { AzureBlobStorageAdapter } from '../azure-blob.adapter.js';

const credentials = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333',
  clientSecret: 'secret-value',
};

function environment(): Environment {
  return {
    id: 'environment-1', projectId: 'project-1', name: 'production', platformBindings: {},
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function account(overrides: Partial<AzureStorageAccount> = {}): AzureStorageAccount {
  return {
    id: `/subscriptions/${credentials.subscriptionId}/resourceGroups/friend-app-production/providers/Microsoft.Storage/storageAccounts/hvfriendapp1234567890`,
    name: 'hvfriendapp1234567890',
    location: 'westus2',
    tags: { 'hypervibe-environment-id': 'environment-1', 'hypervibe-storage-name': 'documents' },
    ...overrides,
  };
}

function controlPlane(overrides: Partial<AzureStorageControlPlane> = {}): AzureStorageControlPlane {
  return {
    verifySubscription: vi.fn(async () => {}),
    listAccounts: vi.fn(async () => []),
    listContainers: vi.fn(async () => []),
    getAccount: vi.fn(async () => null),
    getContainer: vi.fn(async () => null),
    listKeys: vi.fn(async () => 'account-key'),
    ...overrides,
  };
}

function dataPlane(overrides: Partial<AzureBlobDataPlane> = {}): AzureBlobDataPlane {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ body: Readable.from(['pdf']), size: 3, contentType: 'application/pdf' })),
    put: vi.fn(async () => {}),
    deleteAll: vi.fn(async () => {}),
    destroy: vi.fn(),
    ...overrides,
  };
}

describe('AzureBlobStorageAdapter', () => {

  it.each([404, 403, 200])('handles legacy resource-group evidence (%s) through the real ARM HTTP client', async (status) => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token' });
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.pathname.includes('/resourceGroups/hv-')) {
        if (url.pathname.endsWith('/storageAccounts')) return Response.json({ value: [account()] });
        return status === 200 ? Response.json({ id: url.pathname }) : new Response(null, { status });
      }
      if (url.pathname === `/subscriptions/${credentials.subscriptionId}`) {
        return Response.json({ subscriptionId: credentials.subscriptionId, state: 'Enabled' });
      }
      throw new Error(`Unexpected ARM read ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const adapter = new AzureBlobStorageAdapter();
      await adapter.connect(credentials);
      const resolved = await adapter.resolveObservationContext('friend-app', environment(), 'westus2');
      expect(resolved.receipt.success).toBe(status === 404);
      if (status !== 404) expect(resolved.receipt.error).toMatch(status === 403 ? /403/ : /Legacy.*import/);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('management.azure.com'))
        .every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('inventories containers across the subscription with durable Azure scope', async () => {
    const storageAccount = account();
    const container = {
      id: `${storageAccount.id}/blobServices/default/containers/customer-documents`,
      name: 'customer-documents',
    };
    const control = controlPlane({
      listAccounts: vi.fn(async () => [storageAccount]),
      listContainers: vi.fn(async () => [container]),
    });
    const adapter = new AzureBlobStorageAdapter({
      controlPlaneFactory: () => control,
      dataPlaneFactory: () => dataPlane(),
    });
    await adapter.connect(credentials);

    await expect(adapter.inspectStorageResources({ resource: 'storage', limit: 1 }))
      .resolves.toMatchObject({
        observation: 'present',
        resource: 'storage',
        storage: [{
          id: container.id,
          name: 'customer-documents',
          providerScope: {
            subscriptionId: credentials.subscriptionId,
            resourceGroup: 'friend-app-production',
          },
        }],
        partial: false,
      });
  });

  it('uses the Azure default credential chain without requiring a service-principal key', async () => {
    const control = controlPlane();
    const defaultCredentialProvider = vi.fn(async () => ({
      authMode: 'default' as const,
      subscriptionId: credentials.subscriptionId,
    }));
    const controlPlaneFactory = vi.fn(() => control);
    const adapter = new AzureBlobStorageAdapter({
      defaultCredentialProvider,
      controlPlaneFactory,
      dataPlaneFactory: () => dataPlane(),
    });
    await adapter.connect({ authMode: 'default' });

    await expect(adapter.resolveObservationContext(
      'friend-app', environment(), 'westus2'
    )).resolves.toMatchObject({
      receipt: { success: true },
      context: { subscriptionId: credentials.subscriptionId },
    });
    expect(defaultCredentialProvider).toHaveBeenCalledOnce();
    expect(controlPlaneFactory).toHaveBeenCalledWith(
      { authMode: 'default', subscriptionId: credentials.subscriptionId },
      expect.stringMatching(/^production-[a-f0-9]{10}$/)
    );
  });

  it('observes only tagged environment accounts and includes usage', async () => {
    const managed = account();
    const control = controlPlane({
      listAccounts: vi.fn(async () => [managed, account({ name: 'unmanaged', tags: {} })]),
      listContainers: vi.fn(async (storageAccount) => storageAccount.name === managed.name
        ? [{ id: `${storageAccount.id}/blobServices/default/containers/documents`, name: 'documents' }]
        : []),
    });
    const plane = dataPlane({ list: vi.fn(async () => [{ key: 'a.pdf', size: 42 }]) });
    const adapter = new AzureBlobStorageAdapter({ controlPlaneFactory: () => control, dataPlaneFactory: () => plane });
    await adapter.connect(credentials);
    const context = (await adapter.ensureContext(
      'friend-app', environment(), { resourceGroup: 'friend-app-production' }, 'westus2'
    )).context!;

    await expect(adapter.observe(environment(), context)).resolves.toEqual([expect.objectContaining({
      provider: 'azureblob', name: 'documents', region: 'westus2', objectCount: 1, sizeBytes: 42,
      instanceScope: expect.objectContaining({ subscriptionId: credentials.subscriptionId, resourceGroup: 'friend-app-production' }),
    })]);
  });

  it('provides Azure-native runtime environment variables', async () => {
    const control = controlPlane({ getAccount: vi.fn(async () => account()) });
    const adapter = new AzureBlobStorageAdapter({ controlPlaneFactory: () => control });
    await adapter.connect(credentials);
    const context = { subscriptionId: credentials.subscriptionId, resourceGroup: 'friend-app-production' };
    const externalId = `${account().id}/blobServices/default/containers/documents`;

    expect(adapter.runtimeEnvKeys('documents')).toEqual([
      'OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'AZURE_STORAGE_ACCOUNT_NAME',
      'AZURE_STORAGE_CONTAINER_NAME', 'AZURE_STORAGE_CONNECTION_STRING',
    ]);
    await expect(adapter.getRuntimeEnv(environment(), context, externalId, 'documents')).resolves.toMatchObject({
      OBJECT_STORAGE_PROVIDER: 'azureblob', AZURE_STORAGE_CONTAINER_NAME: 'documents',
      AZURE_STORAGE_ACCOUNT_NAME: account().name,
    });
  });
});
