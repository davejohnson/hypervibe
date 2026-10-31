import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { DefaultAzureCredential } from '@azure/identity';
import { AzureContainerAppsAdapter } from '../azure-container-apps.adapter.js';
import { AzurePostgresAdapter } from '../azure-postgres.adapter.js';
import { AzureManagedRedisAdapter } from '../azure-managed-redis.adapter.js';
import { AzureBlobStorageAdapter } from '../azure-blob.adapter.js';
import { AzureResourceManagerClient, resolveAzureDefaultSubscription } from '../azure-resource-manager.client.js';

// Reconstructed ARM JSON from Microsoft's subscription API contract, not a live
// recording. Auth acquisition is stubbed; the real provider client serializes
// every HTTP request and validates scope before any provider mutation.
// https://learn.microsoft.com/rest/api/resources/subscriptions/list?view=rest-resources-2022-12-01
// https://learn.microsoft.com/javascript/api/@azure/identity/defaultazurecredential
const subscriptionId = '22222222-2222-4222-8222-222222222222';
const tenantId = '11111111-1111-4111-8111-111111111111';
const otherSubscription = '33333333-3333-4333-8333-333333333333';
const subscription = { id: `/subscriptions/${subscriptionId}`, subscriptionId, tenantId, state: 'Enabled' };
const native = { authMode: 'default', subscriptionId, tenantId } as const;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Azure native authentication contract', () => {
  it.each(['azure-container-apps', 'azure-postgres', 'azure-managed-redis', 'azureblob'])(
    '%s keeps local sessions outside unattended automation and rejects implicit or mixed credentials', provider => {
      const metadata = providerRegistry.getMetadata(provider)!;
      expect(metadata.credentials?.canUseForAutomation?.(native)).toBe(false);
      const servicePrincipal = { tenantId, subscriptionId, clientId: otherSubscription, clientSecret: 'explicit-private-credential' };
      expect(metadata.credentials?.canUseForAutomation?.(servicePrincipal)).toBe(true);
      expect(metadata.credentialsSchema.safeParse({}).success).toBe(false);
      expect(metadata.credentialsSchema.safeParse({ ...native, clientSecret: 'unexpected-private-credential' }).success).toBe(false);
    });

  it('reports the missing verified deploy principal before local runtime identity work', async () => {
    vi.spyOn(DefaultAzureCredential.prototype, 'getToken').mockResolvedValue({ token: 'native-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    const request = vi.fn(async () => Response.json(subscription));
    vi.stubGlobal('fetch', request);
    const adapter = new AzureContainerAppsAdapter();
    await adapter.connect(native);
    request.mockClear();
    expect(await adapter.runtimeIdentities.inspect({ mode: 'ensure', environment: {} as Environment, service: { name: 'web', buildConfig: {} } }))
      .toEqual({ state: 'unknown', reason: expect.stringMatching(/Local Azure authentication.*Connect Cloud/) });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([['Container Apps', AzureContainerAppsAdapter], ['PostgreSQL', AzurePostgresAdapter], ['Managed Redis', AzureManagedRedisAdapter], ['Blob Storage', AzureBlobStorageAdapter]] as const)(
    '%s connects using local authentication and exposes only pinned scope', async (_name, Adapter) => {
      const auth = vi.spyOn(DefaultAzureCredential.prototype, 'getToken').mockResolvedValue({ token: 'synthetic-native-token', expiresOnTimestamp: Date.now() + 3_600_000 });
      const requests: Array<{ url: string; method: string }> = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? 'GET' });
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-native-token');
        return url.includes('/subscriptions?') ? Response.json({ value: [subscription] }) : Response.json(subscription);
      }));
      const adapter = new Adapter();
      await adapter.connect({ authMode: 'default' });
      expect(await adapter.verify()).toMatchObject({ success: true });
      expect((adapter as any).getConnectionIdentity()).toEqual(native);
      expect(JSON.stringify((adapter as any).getConnectionIdentity())).not.toContain('synthetic-native-token');
      expect(requests.every(request => request.method === 'GET')).toBe(true);
      expect(requests.some(request => request.url.includes(`/subscriptions/${subscriptionId}?`))).toBe(true);
      expect(auth).toHaveBeenCalledWith('https://management.azure.com/.default', expect.objectContaining({ tenantId }));
    }
  );

  it('follows all subscription pages before accepting one enabled scope', async () => {
    const nextLink = 'https://management.azure.com/subscriptions?api-version=2022-12-01&$skiptoken=page2';
    const request = vi.fn().mockResolvedValueOnce(Response.json({ value: [subscription], nextLink }))
      .mockResolvedValueOnce(Response.json({ value: [{ ...subscription, id: `/subscriptions/${otherSubscription}`, subscriptionId: otherSubscription }] }));
    await expect(resolveAzureDefaultSubscription(undefined, { tokenProvider: async () => 'synthetic-token', fetch: request })).rejects.toThrow(/multiple subscriptions/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    {}, { value: null }, { value: [subscription, subscription] },
    { value: [{ ...subscription, tenantId: undefined }] },
    { value: [{ ...subscription, state: undefined }] },
    { value: [subscription], nextLink: 'https://attacker.invalid/subscriptions' },
    { value: [subscription], nextLink: `https://management.azure.com/subscriptions/${subscriptionId}` },
  ])('rejects unknown or inconsistent subscription observation: %j', async body => {
    const request = vi.fn(async () => Response.json(body));
    await expect(resolveAzureDefaultSubscription(undefined, { tokenProvider: async () => 'private-token', fetch: request })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('checks a selected subscription and rejects a different observed tenant', async () => {
    const request = vi.fn(async () => Response.json({ ...subscription, tenantId: otherSubscription }));
    await expect(resolveAzureDefaultSubscription(subscriptionId, {
      tenantId, tokenProvider: async () => 'synthetic-token', fetch: request,
    } as any)).rejects.toThrow(/tenant/i);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps Blob Storage on the explicitly selected tenant', async () => {
    vi.spyOn(DefaultAzureCredential.prototype, 'getToken').mockResolvedValue({ token: 'native-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...subscription, tenantId: otherSubscription })));
    const adapter = new AzureBlobStorageAdapter();
    await adapter.connect(native);
    expect(await adapter.verify()).toMatchObject({ success: false, error: expect.stringMatching(/tenant/i) });
  });

  it('rejects a changed subscription identity on subsequent verification', async () => {
    vi.spyOn(DefaultAzureCredential.prototype, 'getToken').mockResolvedValue({ token: 'native-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...subscription, subscriptionId: otherSubscription })));
    await expect(new AzureResourceManagerClient(native).verifySubscription()).rejects.toThrow(/subscription identity/);
  });

  it('refreshes expired native tokens without persisting or replaying them', async () => {
    const auth = vi.spyOn(DefaultAzureCredential.prototype, 'getToken')
      .mockResolvedValueOnce({ token: 'first-native-token', expiresOnTimestamp: Date.now() + 100 })
      .mockResolvedValue({ token: 'next-native-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    const request = vi.fn(async () => Response.json(subscription));
    vi.stubGlobal('fetch', request);
    const client = new AzureResourceManagerClient(native);
    await client.verifySubscription();
    await client.verifySubscription();
    expect(auth).toHaveBeenCalledTimes(2);
    expect(new Headers((request.mock.calls as any)[1][1].headers).get('Authorization')).toBe('Bearer next-native-token');
  });
});
