import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import the actual packaged entrypoint, not application/providers. This catches
// providers available in MCP/local tests but absent inside the isolated image.
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('This registration test must not call a provider.'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const cases: Array<{ provider: string; mapping: Record<string, string>; secrets: Record<string, string> }> = [
  { provider: 's3', mapping: { AWS_ACCESS_KEY_ID: 'accessKeyId', AWS_SECRET_ACCESS_KEY: 'secretAccessKey' },
    secrets: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE0000000000', AWS_SECRET_ACCESS_KEY: 'synthetic-secret-key-with-at-least-32-characters' } },
  { provider: 'gcs', mapping: { GCP_SERVICE_ACCOUNT_JSON: 'credentials' },
    secrets: { GCP_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', project_id: 'example-project',
      client_email: 'recovery@example-project.iam.gserviceaccount.com', private_key: 'synthetic-key-no-token-request' }) } },
  { provider: 'azureblob', mapping: { AZURE_TENANT_ID: 'tenantId', AZURE_SUBSCRIPTION_ID: 'subscriptionId',
    AZURE_CLIENT_ID: 'clientId', AZURE_CLIENT_SECRET: 'clientSecret' },
    secrets: { AZURE_TENANT_ID: '11111111-1111-4111-8111-111111111111', AZURE_SUBSCRIPTION_ID: '22222222-2222-4222-8222-222222222222',
      AZURE_CLIENT_ID: '33333333-3333-4333-8333-333333333333', AZURE_CLIENT_SECRET: 'synthetic-client-secret' } },
];

describe('packaged backup controller provider and credential boundary', () => {
  it.each(cases)('registers $provider and constructs its existing adapter from only mapped CI credentials', async ({ provider, mapping, secrets }) => {
    await import('../backup-controller.js');
    const { providerRegistry } = await import('../../domain/registry/provider.registry.js');
    const { managedBackupCredentialKeys } = await import('../../domain/services/managed-backup-target.service.js');
    const actual = managedBackupCredentialKeys(provider);
    expect(actual).toEqual(mapping);
    const selected = Object.fromEntries(Object.entries(actual!).map(([name, property]) => [property, secrets[name]]));
    const adapter = await providerRegistry.createAdapter<{ name: string; capabilities: { recoveryCredentialScope?: string }; openObjectTransfer?: unknown; disconnect(): Promise<void> }>(provider, selected);
    expect(adapter.name).toBe(provider);
    expect(adapter.capabilities.recoveryCredentialScope).toBeUndefined();
    expect(typeof adapter.openObjectTransfer).toBe('function');
    await adapter.disconnect();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('attests private worker credential scope only for Railway native bucket credentials', async () => {
    await import('../backup-controller.js');
    const { providerRegistry } = await import('../../domain/registry/provider.registry.js');
    const railway = await providerRegistry.createAdapter('railway', { apiToken: 'synthetic-railway-token' });
    const storage = await providerRegistry.get('railway')!.derivedAdapters!.storage!(railway, {}) as { capabilities: { recoveryCredentialScope?: string } };
    expect(storage.capabilities.recoveryCredentialScope).toBe('bucket');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires hosting credentials only when a private database worker is used', async () => {
    await import('../backup-controller.js');
    const module = await import('../../domain/services/managed-backup-target.service.js');
    const target = { hosting: { provider: 'vercel' }, destination: { identity: { provider: 's3' } },
      objects: [{ identity: { provider: 'gcs' } }, { identity: { provider: 'azureblob' } }, { identity: { provider: 's3' } }] };
    const selected = module.managedBackupProviderNames;
    expect(typeof selected).toBe('function');
    expect(selected(target)).toEqual(['azureblob', 'gcs', 's3']);
    expect(selected({ ...target, hosting: { provider: 'railway' }, database: {} })).toEqual(['azureblob', 'gcs', 'railway', 's3']);
  });
});
