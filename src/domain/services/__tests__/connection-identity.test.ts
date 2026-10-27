import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { saveConnection, verifyConnection } from '../connection-ops.service.js';

// Shared connection boundary: a verified local identity must keep the same
// selected account on later runs, and must never persist a provider's token.
// Provider-specific suites separately exercise real native credential clients.
let dir: string;
let identity: Record<string, string>;
let success: boolean;
const identityRead = vi.fn(() => identity);
const provider = 'connection-identity-test';
providerRegistry.register({ metadata: { name: provider, displayName: 'Identity test', category: 'deployment',
  credentialsSchema: z.object({ authMode: z.literal('default'), accountId: z.string().regex(/^\d{12}$/).optional(), profile: z.string().optional(), connectionString: z.string().optional() }).strict(),
  credentials: { supportsNativeCliAuth: true, verifiedIdentityKeys: ['accountId', 'profile'] } },
  factory: async () => ({ verify: async () => ({ success }), getConnectionIdentity: identityRead }),
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hv-connection-identity-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(dir, 'state.db')).migrate();
  identity = { accountId: '123456789012', profile: 'studio' };
  success = true;
  identityRead.mockClear();
});
afterEach(() => { SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true }); });
const stored = () => getSecretStore().decryptObject<Record<string, unknown>>(new ConnectionRepository().findByProviderAndScope(provider, 'owner/app')!.credentialsEncrypted);

describe('verified native connection identity', () => {
  it('pins verified account/profile inside encrypted credentials without exposing the descriptor as a credential result', async () => {
    await saveConnection(provider, { authMode: 'default' }, 'owner/app');
    const result = await verifyConnection(provider, 'owner/app');
    expect(result.kind).toBe('verified');
    expect(stored()).toEqual({ authMode: 'default', ...identity });
    expect(result).not.toHaveProperty('credentials');
  });
  it('rejects a different account instead of rewriting selected authorization', async () => {
    await saveConnection(provider, { authMode: 'default', accountId: '987654321098' }, 'owner/app');
    expect((await verifyConnection(provider, 'owner/app')).kind).toBe('threw');
    expect(stored()).toEqual({ authMode: 'default', accountId: '987654321098' });
  });
  it.each([{ accountId: 'invalid' }, { accessToken: 'never-output-provider-token' }])('rejects invalid or undeclared descriptor fields without leaking values', async data => {
    identity = Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    await saveConnection(provider, { authMode: 'default' }, 'owner/app');
    const result = await verifyConnection(provider, 'owner/app');
    expect(result.kind).toBe('threw');
    expect(stored()).toEqual({ authMode: 'default' });
    expect(JSON.stringify(result)).not.toContain('never-output-provider-token');
  });
  it('does not read or persist identity after failed verification', async () => {
    success = false;
    await saveConnection(provider, { authMode: 'default' }, 'owner/app');
    await verifyConnection(provider, 'owner/app');
    expect(identityRead).not.toHaveBeenCalled();
    expect(stored()).toEqual({ authMode: 'default' });
  });
  it('rejects credential-shaped runtime identities even if a registration is later mutated', async () => {
    const metadata = providerRegistry.getMetadata(provider)!;
    metadata.credentials!.verifiedIdentityKeys!.push('connectionString');
    try {
      identity = { connectionString: 'private-provider-connection-value' };
      await saveConnection(provider, { authMode: 'default' }, 'owner/app');
      const result = await verifyConnection(provider, 'owner/app');
      expect(result.kind).toBe('threw');
      expect(stored()).toEqual({ authMode: 'default' });
      expect(JSON.stringify(result)).not.toContain('private-provider-connection-value');
    } finally { metadata.credentials!.verifiedIdentityKeys!.pop(); }
  });
  it('does not claim a pinned identity if a schema transform removes its descriptor', async () => {
    const metadata = providerRegistry.getMetadata(provider)!;
    const originalSchema = metadata.credentialsSchema;
    metadata.credentialsSchema = originalSchema.transform(value => { const { accountId: _accountId, profile: _profile, ...rest } = value as Record<string, unknown>; return rest; });
    try {
      await saveConnection(provider, { authMode: 'default' }, 'owner/app');
      expect((await verifyConnection(provider, 'owner/app')).kind).toBe('threw');
      expect(stored()).toEqual({ authMode: 'default' });
    } finally { metadata.credentialsSchema = originalSchema; }
  });
});
