import { describe, expect, it } from 'vitest';
import { azureKeyVaultSecretStore } from '../azure-secret-store.js';

const access = { tenantId: 't', clientId: 'c', clientSecret: 'client-secret-value' };
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

describe('Azure Key Vault secret store', () => {
  it('writes under the Key Vault name the Container Apps reference, and observes presence without returning the value', async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const store = azureKeyVaultSecretStore(access, 'https://hv-app-test-abc123.vault.azure.net/', async (input, init) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.startsWith('https://login.microsoftonline.com/')) return json(200, { access_token: 'kv' });
      if (url.includes('/secrets/jwt-secret') && init?.method === 'GET') return json(200, { value: 'the-value' });
      if (url.includes('/secrets/missing-key')) return json(404, { error: { code: 'SecretNotFound' } });
      if (url.includes('/secrets/flaky')) return json(503);
      if (init?.method === 'PUT' && url.includes('/secrets/gone')) return json(409, { error: { code: 'ObjectIsDeletedButRecoverable' } });
      return json(200, {});
    });
    expect(await store.observe('JWT_SECRET')).toBe('present');
    expect(await store.observe('MISSING_KEY')).toBe('absent');
    expect(await store.observe('FLAKY')).toEqual({ unknown: 'Key Vault could not be read (HTTP 503).' });
    expect(await store.write('STRIPE_KEY', 'sk_live')).toBeUndefined();
    expect(await store.write('GONE', 'x')).toMatch(/deleted from Key Vault recently/);
    expect(calls.find((call) => call.method === 'PUT')?.url).toBe('https://hv-app-test-abc123.vault.azure.net/secrets/stripe-key?api-version=7.4');
    // One token for the store, scoped to Key Vault only.
    expect(calls.filter((call) => call.url.startsWith('https://login.'))).toHaveLength(1);
    expect(calls[0]!.body).toContain('scope=https%3A%2F%2Fvault.azure.net%2F.default');
  });
});
