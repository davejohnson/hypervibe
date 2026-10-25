import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureResourceManagerClient } from '../../src/adapters/providers/azure/azure-resource-manager.client.js';

// Reconstructed ARM UAMI GET response from the official 2024-11-30 contract:
// https://learn.microsoft.com/en-us/rest/api/managedidentity/user-assigned-identities/get
// Access tokens are deliberately opaque, per Microsoft's access-token contract.
// The trusted callback represents authenticated broker issuance, not caller-supplied credentials.
const tenantId = 'b6c948ef-f6b5-4384-8354-da3a15eca969';
const subscriptionId = '12345678-1234-5678-9012-123456789012';
const clientId = '4024ab25-56a8-4370-aea6-6389221caf29';
const principalId = '25cc773c-7f05-40fc-a104-32d2300754ad';
const resourceGroup = 'isolated-production';
const identityResourceId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/provision`;
const nativeIdentity = { id: identityResourceId, name: 'provision', type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
  location: 'canadacentral', properties: { tenantId, clientId, principalId, isolationScope: 'None' } };
const expiresAt = () => new Date(Date.now() + 300_000).toISOString();
afterEach(() => vi.unstubAllGlobals());

describe('Azure transient deployment ARM authentication', () => {
  it('uses only the bound refresh callback and native UAMI evidence, including opaque tokens', async () => {
    const tokens = ['opaque-first', 'opaque-second'];
    const getAccessToken = vi.fn(async () => ({ token: tokens.shift()!, expiresAt: expiresAt() }));
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`https://management.azure.com${identityResourceId}?api-version=2024-11-30`);
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Bearer opaque-(first|second)$/);
      return Response.json(nativeIdentity);
    });
    vi.stubGlobal('fetch', request);
    const client = new AzureResourceManagerClient({ authMode: 'federated', tenantId, subscriptionId,
      clientId, principalId, identityResourceId, resourceGroup, getAccessToken } as any);
    await expect(client.servicePrincipalId()).resolves.toBe(principalId);
    await expect(client.servicePrincipalId()).resolves.toBe(principalId);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenNthCalledWith(1, 'resource-manager', expect.any(AbortSignal));
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(client)).not.toMatch(/opaque-first|opaque-second/);
  });

  it('rejects native replacement, expired callbacks and echoed callback errors without credential fallback', async () => {
    const getAccessToken = vi.fn(async () => ({ token: 'sensitive-token', expiresAt: expiresAt() }));
    const request = vi.fn(async () => Response.json({ ...nativeIdentity, properties: { ...nativeIdentity.properties,
      principalId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } }));
    vi.stubGlobal('fetch', request);
    const client = new AzureResourceManagerClient({ authMode: 'federated', tenantId, subscriptionId,
      clientId, principalId, identityResourceId, resourceGroup, getAccessToken } as any);
    await expect(client.servicePrincipalId()).rejects.toThrow('Azure transient identity could not be verified.');
    getAccessToken.mockResolvedValueOnce({ token: 'sensitive-token', expiresAt: new Date(0).toISOString() });
    await expect(client.servicePrincipalId()).rejects.toThrow('Azure transient authorization is unavailable.');
    getAccessToken.mockRejectedValueOnce(new Error('sensitive-token'));
    await expect(client.servicePrincipalId()).rejects.toThrow('Azure transient authorization is unavailable.');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-scope requests and credential-bearing redirects before a second dispatch', async () => {
    const getAccessToken = vi.fn(async () => ({ token: 'sensitive-token', expiresAt: expiresAt() }));
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://outside.invalid' } }));
    vi.stubGlobal('fetch', request);
    const client = new AzureResourceManagerClient({ authMode: 'federated', tenantId, subscriptionId,
      clientId, principalId, identityResourceId, resourceGroup, getAccessToken } as any);
    await expect(client.request('GET', `/subscriptions/${subscriptionId}/resourceGroups/other/providers/Microsoft.App/containerApps/web`, '2026-01-01')).rejects.toThrow();
    expect(getAccessToken).not.toHaveBeenCalled();
    await expect(client.servicePrincipalId()).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('removes echoed bearer material from successful provider metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...nativeIdentity, tags: { label: 'echo opaque-sensitive-token' } })));
    const client = new AzureResourceManagerClient({ authMode: 'federated', tenantId, subscriptionId, clientId, principalId,
      identityResourceId, resourceGroup, getAccessToken: async () => ({ token: 'opaque-sensitive-token', expiresAt: expiresAt() }) });
    const native = await client.request('GET', identityResourceId, '2024-11-30');
    expect(JSON.stringify(native)).not.toContain('opaque-sensitive-token');
  });

  it('bounds transient token acquisition and response bodies even when transport ignores abort', async () => {
    const credentials = { authMode: 'federated' as const, tenantId, subscriptionId, clientId, principalId, identityResourceId,
      resourceGroup, getAccessToken: async () => ({ token: 'opaque-sensitive-token', expiresAt: expiresAt() }) };
    const stalledBody = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    vi.stubGlobal('fetch', stalledBody);
    const bodyClient = new AzureResourceManagerClient(credentials, { deadlineMs: 5 });
    await expect(bodyClient.servicePrincipalId()).rejects.toThrow('Azure transient response could not be verified.');
    const waitingClient = new AzureResourceManagerClient({ ...credentials, getAccessToken: () => new Promise(() => {}) }, { deadlineMs: 5 });
    await expect(waitingClient.servicePrincipalId()).rejects.toThrow('Azure transient authorization is unavailable.');
    expect(stalledBody).toHaveBeenCalledTimes(1);
  });
});
