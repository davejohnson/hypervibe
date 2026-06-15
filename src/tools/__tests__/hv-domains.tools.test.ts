import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
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
      return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function seedCloudflareConnection(credentials: Record<string, unknown> = { apiToken: 'cf-token' }) {
  const repo = new ConnectionRepository();
  const encrypted = getSecretStore().encryptObject(credentials);
  const conn = repo.create({ provider: 'cloudflare', credentialsEncrypted: encrypted });
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

  it('requires a zone for record actions', async () => {
    seedCloudflareConnection();
    const t = await makeClient();
    const result = await t.call('hv_dns_record', { action: 'list' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    await t.close();
  });
});

describe('hv_domain_register', () => {
  it('checks registrar availability and returns pricing', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token', accountId: 'acct-1' });
    const check = vi.spyOn(CloudflareAdapter.prototype, 'checkRegistrarDomains').mockResolvedValue([
      {
        name: 'apreskeys.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);
    const t = await makeClient();

    const result = await t.call('hv_domain_register', { action: 'check', domain: 'apreskeys.com' });
    expect(result.ok).toBe(true);
    expect(result.data.accountId).toBe('acct-1');
    expect(result.data.domains).toEqual([
      expect.objectContaining({
        name: 'apreskeys.com',
        registrable: true,
        pricing: { currency: 'USD', registrationCost: '10.00', renewalCost: '10.00' },
      }),
    ]);
    expect(check).toHaveBeenCalledWith('acct-1', ['apreskeys.com']);
    await t.close();
  });

  it('confirm-gates billable domain purchases', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token', accountId: 'acct-1' });
    vi.spyOn(CloudflareAdapter.prototype, 'checkRegistrarDomains').mockResolvedValue([
      {
        name: 'apreskeys.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);
    const create = vi.spyOn(CloudflareAdapter.prototype, 'createRegistrarRegistration').mockResolvedValue({
      completed: false,
      created_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:00:00.000Z',
      links: { self: '/status' },
      state: 'in_progress',
    });
    const t = await makeClient();

    const result = await t.call('hv_domain_register', { action: 'purchase', domain: 'apreskeys.com' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    expect(JSON.stringify(result.error.details)).toContain('10.00');
    expect(create).not.toHaveBeenCalled();
    await t.close();
  });

  it('submits purchase after confirm and records workflow status', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token', accountId: 'acct-1' });
    const check = vi.spyOn(CloudflareAdapter.prototype, 'checkRegistrarDomains').mockResolvedValue([
      {
        name: 'apreskeys.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);
    const create = vi.spyOn(CloudflareAdapter.prototype, 'createRegistrarRegistration').mockResolvedValue({
      completed: false,
      created_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:00:00.000Z',
      links: { self: '/accounts/acct-1/registrar/registrations/apreskeys.com/registration-status' },
      state: 'in_progress',
    });
    const t = await makeClient();

    const result = await t.call('hv_domain_register', {
      action: 'purchase',
      domain: 'apreskeys.com',
      years: 1,
      autoRenew: true,
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data.workflow.state).toBe('in_progress');
    expect(check).toHaveBeenCalledWith('acct-1', ['apreskeys.com']);
    expect(create).toHaveBeenCalledWith('acct-1', {
      domainName: 'apreskeys.com',
      autoRenew: true,
      years: 1,
    });
    await t.close();
  });

  it('polls registration status', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token', accountId: 'acct-1' });
    const status = vi.spyOn(CloudflareAdapter.prototype, 'getRegistrarRegistrationStatus').mockResolvedValue({
      completed: true,
      created_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:01:00.000Z',
      links: { self: '/status', resource: '/domain' },
      state: 'succeeded',
      context: { domain_name: 'apreskeys.com' },
    });
    const t = await makeClient();

    const result = await t.call('hv_domain_register', { action: 'status', domain: 'apreskeys.com' });
    expect(result.ok).toBe(true);
    expect(result.data.workflow.state).toBe('succeeded');
    expect(status).toHaveBeenCalledWith('acct-1', 'apreskeys.com');
    await t.close();
  });
});

describe('hv_domain_setup', () => {
  it('errors for unknown environments', async () => {
    new ProjectRepository().create({ name: 'domain-app' });
    const t = await makeClient();
    const result = await t.call('hv_domain_setup', { project: 'domain-app', env: 'staging', domain: 'app.example.com' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    await t.close();
  });

  it('reports a missing Cloudflare connection as MISSING_CONNECTION', async () => {
    const project = new ProjectRepository().create({ name: 'domain-conn-app' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'railway', projectId: 'rp-1', services: {} } });
    const t = await makeClient();
    const result = await t.call('hv_domain_setup', { project: 'domain-conn-app', env: 'staging', domain: 'app.example.com' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('MISSING_CONNECTION');
    await t.close();
  });
});
