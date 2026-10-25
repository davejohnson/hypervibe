import { describe, expect, it, vi } from 'vitest';
import { createAzureFederatedTokenProvider } from '../../src/adapters/providers/azure/azure-federated-auth.js';

// Reconstructed from Microsoft's federated client-credentials wire contract,
// not copied from our transport implementation or a live Azure recording:
// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow#third-case-access-token-request-with-a-federated-credential
const tenantId = '11111111-2222-4333-8444-555555555555';
const clientId = '66666666-7777-4888-8999-000000000000';
const assertion = 'synthetic.google.assertion';

describe('Azure hosted federation serialized contract', () => {
  it('exchanges a transient Google assertion for the exact Azure resource without a client secret', async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`);
      expect(init?.redirect).toBe('error');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(form)).toEqual({ client_id: clientId,
        scope: 'https://vault.azure.net/.default', grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion });
      return Response.json({ token_type: 'Bearer', expires_in: 3599, access_token: 'synthetic-access-token' });
    });
    const getGoogleIdToken = vi.fn(async () => assertion);
    const provider = createAzureFederatedTokenProvider({ tenantId, clientId, getGoogleIdToken }, { fetch: request as typeof fetch });
    expect(await provider('https://vault.azure.net/.default', new AbortController().signal)).toBe('synthetic-access-token');
    expect(getGoogleIdToken).toHaveBeenCalledWith('api://AzureADTokenExchange', expect.any(AbortSignal));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('permits only the two reviewed writer audiences and never falls back to local credentials', async () => {
    const request = vi.fn(); const getGoogleIdToken = vi.fn();
    const provider = createAzureFederatedTokenProvider({ tenantId, clientId, getGoogleIdToken }, { fetch: request });
    await expect(provider('https://graph.microsoft.com/.default', new AbortController().signal)).rejects.toThrow('invalid_input');
    expect(getGoogleIdToken).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it('discards Entra errors that echo assertions, and never retries a rejected exchange implicitly', async () => {
    const request = vi.fn(async () => Response.json({ error: 'invalid_client', error_description: assertion }, { status: 400 }));
    const provider = createAzureFederatedTokenProvider({ tenantId, clientId, getGoogleIdToken: async () => assertion }, { fetch: request });
    await expect(provider('https://management.azure.com/.default', new AbortController().signal)).rejects.toThrow('access_denied');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { token_type: 'Bearer', access_token: 'synthetic-access-token' },
    { token_type: 'Bearer', expires_in: 0, access_token: 'synthetic-access-token' },
    { token_type: 'Other', expires_in: 3599, access_token: 'synthetic-access-token' },
    { token_type: 'Bearer', expires_in: 3599, access_token: 'bad\r\ntoken' },
  ])('rejects malformed/expired issuance without surfacing its response', async response => {
    const provider = createAzureFederatedTokenProvider({ tenantId, clientId, getGoogleIdToken: async () => assertion },
      { fetch: vi.fn(async () => Response.json(response)) });
    await expect(provider('https://vault.azure.net/.default', new AbortController().signal)).rejects.toThrow('invalid_response');
  });

  it('bounds a stalled response body as well as token acquisition', async () => {
    const provider = createAzureFederatedTokenProvider({ tenantId, clientId, getGoogleIdToken: async () => assertion },
      { fetch: vi.fn(async () => new Response(new ReadableStream({ start() {} }))), deadlineMs: 5 });
    await expect(provider('https://vault.azure.net/.default', new AbortController().signal)).rejects.toThrow('deadline_exceeded');
  });
});
