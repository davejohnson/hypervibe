import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
// Importing adapters registers providers in the registry.
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { registerConnectionsTools } from '../connections.tools.js';
import { createToolContext } from '../context.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-connections-tools-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HV_TEST_RAILWAY_TOKEN;
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'connections-tools-test', version: '0.0.0' });
  registerConnectionsTools(server, createToolContext());
  const client = new Client({ name: 'connections-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('hv_connect', () => {
  it('add stores credentials and auto-verifies in one call', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      email: 'dev@example.com',
      workspaceId: 'ws-1',
    });

    const t = await makeClient();
    const result = await t.call('hv_connect', {
      provider: 'railway',
      credentials: { apiToken: 'token-123' },
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.data.email).toBe('dev@example.com');

    const connection = new ConnectionRepository().findByProvider('railway');
    expect(connection?.status).toBe('verified');
    await t.close();
  });

  it('add can resolve a token from a local env ref without echoing it', async () => {
    process.env.HV_TEST_RAILWAY_TOKEN = 'token-from-env-ref';
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true });

    const t = await makeClient();
    const result = await t.call('hv_connect', {
      provider: 'railway',
      credentialsRef: 'env:HV_TEST_RAILWAY_TOKEN',
      credentialsKey: 'apiToken',
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.data.credentialsSource).toBe('env');
    expect(JSON.stringify(result)).not.toContain('token-from-env-ref');

    const connection = new ConnectionRepository().findByProvider('railway')!;
    const decrypted = getSecretStore().decryptObject<{ apiToken: string }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('token-from-env-ref');
    await t.close();
  });

  it('add can resolve a token directly from an existing .env file', async () => {
    const envPath = path.join(tempDir, '.env');
    writeFileSync(envPath, [
      '# local provider tokens',
      'export HYPERVIBE_RAILWAY_TOKEN=token-from-dotenv-ref',
      '',
    ].join('\n'));
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true });

    const t = await makeClient();
    const result = await t.call('hv_connect', {
      provider: 'railway',
      credentialsRef: `dotenv:${envPath}#HYPERVIBE_RAILWAY_TOKEN`,
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.data.credentialsSource).toBe('dotenv');
    expect(JSON.stringify(result)).not.toContain('token-from-dotenv-ref');

    const connection = new ConnectionRepository().findByProvider('railway')!;
    const decrypted = getSecretStore().decryptObject<{ apiToken: string }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('token-from-dotenv-ref');
    await t.close();
  });

  it('add can map multiple provider credential fields from an existing .env file', async () => {
    const envPath = path.join(tempDir, '.env');
    writeFileSync(envPath, [
      'HYPERVIBE_GITHUB_TOKEN=gh-api-token',
      'HYPERVIBE_GITHUB_PACKAGES_TOKEN=gh-package-token',
    ].join('\n'));
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
    });

    const t = await makeClient();
    const result = await t.call('hv_connect', {
      provider: 'github',
      credentialsRef: `dotenv:${envPath}`,
      credentialsMap: {
        apiToken: 'HYPERVIBE_GITHUB_TOKEN',
        packageReadToken: 'HYPERVIBE_GITHUB_PACKAGES_TOKEN',
      },
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('gh-api-token');
    expect(JSON.stringify(result)).not.toContain('gh-package-token');

    const connection = new ConnectionRepository().findByProvider('github')!;
    const decrypted = getSecretStore().decryptObject<{ apiToken: string; packageReadToken?: string }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('gh-api-token');
    expect(decrypted.packageReadToken).toBe('gh-package-token');
    await t.close();
  });

  it('stores the verified GitHub login for package pull credential sync', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'read:packages'],
    });

    const t = await makeClient();
    const result = await t.call('hv_connect', {
      provider: 'github',
      credentials: { apiToken: 'gh-token' },
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.data.login).toBe('davejohnson');

    const connection = new ConnectionRepository().findByProvider('github')!;
    const decrypted = getSecretStore().decryptObject<{ apiToken: string; login?: string; packageReadToken?: string }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('gh-token');
    expect(decrypted.login).toBe('davejohnson');
    expect(decrypted.packageReadToken).toBe('gh-token');
    await t.close();
  });

  it('surfaces provider verification warnings without failing the connection', async () => {
    vi.spyOn(CloudflareAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      warning: 'Token is valid, but zone access was not confirmed.',
    });

    const t = await makeClient();
    const result = await t.call('hv_connect', {
      provider: 'cloudflare',
      scope: 'apreskeys.com',
      credentials: { apiToken: 'cf-token' },
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.warnings).toEqual(['Token is valid, but zone access was not confirmed.']);

    const connection = new ConnectionRepository().findByProviderAndScope('cloudflare', 'apreskeys.com');
    expect(connection?.status).toBe('verified');
    await t.close();
  });

  it('add keeps the connection but returns PROVIDER_ERROR when verification fails', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({
      success: false,
      error: 'invalid token',
    });

    const t = await makeClient();
    const result = await t.call('hv_connect', {
      provider: 'railway',
      credentials: { apiToken: 'bad-token' },
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.message).toContain('invalid token');
    expect(result.hint).toContain('saved');

    const connection = new ConnectionRepository().findByProvider('railway');
    expect(connection).not.toBeNull();
    expect(connection?.status).toBe('failed');
    await t.close();
  });

  it('rejects add without credentials and rejects invalid credential shapes', async () => {
    const t = await makeClient();

    const missing = await t.call('hv_connect', { provider: 'railway' });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe('VALIDATION');

    const invalid = await t.call('hv_connect', { provider: 'railway', credentials: { nope: true } });
    expect(invalid.ok).toBe(false);
    expect(invalid.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('verify returns NOT_FOUND when no connection exists', async () => {
    const t = await makeClient();
    const result = await t.call('hv_connect', { provider: 'railway', action: 'verify' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    await t.close();
  });

  it('remove deletes the connection', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true });

    const t = await makeClient();
    await t.call('hv_connect', { provider: 'railway', credentials: { apiToken: 'token-123' } });

    const removed = await t.call('hv_connect', { provider: 'railway', action: 'remove' });
    expect(removed.ok).toBe(true);
    expect(removed.data.removed).toBe(true);
    expect(new ConnectionRepository().findByProvider('railway')).toBeNull();

    const again = await t.call('hv_connect', { provider: 'railway', action: 'remove' });
    expect(again.ok).toBe(false);
    expect(again.error.code).toBe('NOT_FOUND');
    await t.close();
  });
});

describe('hv_connections_list', () => {
  it('returns connections without credentials plus providers grouped by category', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true, email: 'dev@example.com' });

    const t = await makeClient();
    await t.call('hv_connect', { provider: 'railway', credentials: { apiToken: 'token-123' } });

    const result = await t.call('hv_connections_list', {});
    expect(result.ok).toBe(true);
    expect(result.data.connections).toHaveLength(1);
    expect(result.data.connections[0]).toMatchObject({
      provider: 'railway',
      scope: 'global',
      status: 'verified',
    });
    expect(result.data.connections[0].lastVerifiedAt).toBeTruthy();
    // Never leak credentials
    expect(JSON.stringify(result.data)).not.toContain('token-123');
    expect(result.data.connections[0].credentialsEncrypted).toBeUndefined();

    expect(result.data.availableProviders.deployment).toContainEqual(
      expect.objectContaining({ name: 'railway', displayName: 'Railway' })
    );
    await t.close();
  });
});
