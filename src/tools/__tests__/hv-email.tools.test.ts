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
import { SendGridAdapter } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { createToolContext } from '../context.js';
import { registerHvEmailTools } from '../hv-email.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-email-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-email-test', version: '1.0.0' });
  registerHvEmailTools(server, createToolContext());
  const client = new Client({ name: 'hv-email-test-client', version: '1.0.0' });
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

function seedSendGridConnection() {
  const repo = new ConnectionRepository();
  const encrypted = getSecretStore().encryptObject({ apiKey: 'SG.test-key' });
  const conn = repo.create({ provider: 'sendgrid', credentialsEncrypted: encrypted });
  repo.updateStatus(conn.id, 'verified');
}

describe('hv_email_setup', () => {
  it('errors without a SendGrid connection', async () => {
    const t = await makeClient();
    const result = await t.call('hv_email_setup', { domain: 'example.com' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('MISSING_CONNECTION');
    await t.close();
  });

  it('requires domain for validate', async () => {
    seedSendGridConnection();
    const t = await makeClient();
    const result = await t.call('hv_email_setup', { action: 'validate' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('returns dns-records for an authenticated domain via mocked adapter', async () => {
    seedSendGridConnection();
    vi.spyOn(SendGridAdapter.prototype, 'listDomainAuthentications').mockResolvedValue([
      {
        id: 1,
        domain: 'example.com',
        valid: false,
        dns: {
          dkim1: { host: 's1._domainkey.example.com', type: 'CNAME', data: 's1.u123.wl.sendgrid.net', valid: false },
          dkim2: { host: 's2._domainkey.example.com', type: 'CNAME', data: 's2.u123.wl.sendgrid.net', valid: false },
          mail_cname: { host: 'em123.example.com', type: 'CNAME', data: 'u123.wl.sendgrid.net', valid: false },
        },
      } as never,
    ]);
    const t = await makeClient();
    const result = await t.call('hv_email_setup', { domain: 'example.com', action: 'dns-records' });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain('_domainkey');
    await t.close();
  });
});

describe('hv_email_forwarding', () => {
  it('errors without a Cloudflare connection', async () => {
    const t = await makeClient();
    const result = await t.call('hv_email_forwarding', { action: 'list', domain: 'example.com' });
    expect(result.ok).toBe(false);
    expect(['MISSING_CONNECTION', 'NOT_FOUND']).toContain(result.error.code);
    await t.close();
  });
});

describe('hv_email_send', () => {
  it('requires a from address', async () => {
    const t = await makeClient();
    const result = await t.call('hv_email_send', { to: 'a@example.com', subject: 'hi', body: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.hint).toContain('hv_email_setup');
    await t.close();
  });

  it('errors without a SendGrid connection', async () => {
    const t = await makeClient();
    const result = await t.call('hv_email_send', { to: 'a@example.com', from: 'noreply@example.com', subject: 'hi', body: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('MISSING_CONNECTION');
    await t.close();
  });
});
