import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { createToolContext } from '../context.js';
import { registerHvDomainsTools } from '../hv-domains.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-domains-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-domains-test', version: '1.0.0' });
  registerHvDomainsTools(server, createToolContext());
  const client = new Client({ name: 'hv-domains-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function seedCloudflareConnection(credentials: Record<string, unknown> = { apiToken: 'cf-token' }, scope?: string) {
  const repo = new ConnectionRepository();
  const encrypted = getSecretStore().encryptObject(credentials);
  const conn = repo.create({ provider: 'cloudflare', credentialsEncrypted: encrypted, scope });
  repo.updateStatus(conn.id, 'verified');
}

describe('hv_dns_record', () => {
  it('errors without a Cloudflare connection', async () => {
    const t = await makeClient();
    const result = await t.call('hv_dns_record', { action: 'zones' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('MISSING_CONNECTION');
    await t.close();
  });

  it('lists zones via a mocked Cloudflare adapter', async () => {
    seedCloudflareConnection();
    vi.spyOn(CloudflareAdapter.prototype, 'listZones').mockResolvedValue([
      { id: 'zone-1', name: 'example.com', status: 'active' } as never,
    ]);
    const t = await makeClient();
    const result = await t.call('hv_dns_record', { action: 'zones' });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain('example.com');
    await t.close();
  });

  it('lists zones using a verified scoped Cloudflare connection when no global connection exists', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'invoiceperfect.com');
    vi.spyOn(CloudflareAdapter.prototype, 'listZones').mockResolvedValue([
      { id: 'zone-1', name: 'invoiceperfect.com', status: 'active', paused: false, name_servers: [] } as never,
    ]);
    const t = await makeClient();
    const result = await t.call('hv_dns_record', { action: 'zones' });
    expect(result.ok).toBe(true);
    expect(result.data.tokenScope).toBe('invoiceperfect.com');
    expect(result.data.zones).toContainEqual(expect.objectContaining({ name: 'invoiceperfect.com' }));
    await t.close();
  });

  it('requires a zone for record actions', async () => {
    seedCloudflareConnection();
    const t = await makeClient();
    const result = await t.call('hv_dns_record', { action: 'list' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    await t.close();
  });
});
