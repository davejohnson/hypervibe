import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
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
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { IProviderAdapter } from '../../domain/ports/provider.port.js';
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

  it('does not write fallback DNS when provider custom-domain attach fails', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'app.example.com');
    const project = new ProjectRepository().create({ name: 'domain-no-fallback-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-1',
        environmentId: 'rail-env-1',
        services: {
          web: {
            serviceId: 'rail-web',
            url: 'https://web-production.up.railway.app',
          },
        },
      },
    });

    const attachCustomDomain = vi.fn(async () => ({
      success: false,
      message: 'Failed to attach Railway custom domain',
      error: 'Problem processing request',
    }));
    const fakeHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: [],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return { success: true, message: 'ready' };
      },
      async ensureComponent() {
        throw new Error('not used');
      },
      async deploy() {
        throw new Error('not used');
      },
      async setEnvVars() {
        return { success: true, message: 'vars synced' };
      },
      attachCustomDomain,
    } satisfies IProviderAdapter & { attachCustomDomain: typeof attachCustomDomain };

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });
    vi.spyOn(CloudflareAdapter.prototype, 'connect').mockImplementation(() => {});
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1',
      name: 'example.com',
      status: 'active',
      paused: false,
      type: 'full',
      name_servers: [],
    });
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord');

    const t = await makeClient();
    const result = await t.call('hv_domain_setup', {
      project: 'domain-no-fallback-app',
      env: 'production',
      domain: 'app.example.com',
      service: 'web',
    });

    expect(result.ok).toBe(true);
    expect(result.data.customDomainAttached).toBe(false);
    expect(result.data.dnsConfigured).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Problem processing request'),
    ]));
    expect(attachCustomDomain).toHaveBeenCalledWith({
      projectId: 'rail-project-1',
      serviceId: 'rail-web',
      environmentId: 'rail-env-1',
      domain: 'app.example.com',
    });
    expect(upsertDnsRecord).not.toHaveBeenCalled();
    await t.close();
  });

  it('does not write fallback DNS for managed hosts without domain attach support', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'app.example.com');
    const project = new ProjectRepository().create({ name: 'domain-unsupported-host-app', defaultPlatform: 'vercel' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'vercel',
        projectId: 'vercel-project-1',
        environmentId: 'production',
        services: {
          web: {
            serviceId: 'vercel-web',
            url: 'https://web.vercel.app',
          },
        },
      },
    });

    const fakeHostingAdapter = {
      name: 'vercel',
      capabilities: {
        supportedBuilders: ['static'],
        supportedComponents: [],
        supportsAutoWiring: true,
        supportsHealthChecks: false,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return { success: true, message: 'ready' };
      },
      async ensureComponent() {
        throw new Error('not used');
      },
      async deploy() {
        throw new Error('not used');
      },
      async setEnvVars() {
        return { success: true, message: 'vars synced' };
      },
    } satisfies IProviderAdapter;

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });
    vi.spyOn(CloudflareAdapter.prototype, 'connect').mockImplementation(() => {});
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1',
      name: 'example.com',
      status: 'active',
      paused: false,
      type: 'full',
      name_servers: [],
    });
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord');

    const t = await makeClient();
    const result = await t.call('hv_domain_setup', {
      project: 'domain-unsupported-host-app',
      env: 'production',
      domain: 'app.example.com',
      service: 'web',
    });

    expect(result.ok).toBe(true);
    expect(result.data.customDomainAttached).toBe(false);
    expect(result.data.dnsConfigured).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('does not implement custom-domain attachment for vercel'),
    ]));
    expect(upsertDnsRecord).not.toHaveBeenCalled();
    await t.close();
  });
});
