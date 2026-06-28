import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { IProviderAdapter } from '../../ports/provider.port.js';
import { adapterFactory } from '../adapter.factory.js';
import { setupCustomDomain } from '../domain.service.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-domain-service-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedCloudflareConnection(credentials: Record<string, unknown> = { apiToken: 'cf-token' }, scope?: string) {
  const repo = new ConnectionRepository();
  const encrypted = getSecretStore().encryptObject(credentials);
  const conn = repo.create({ provider: 'cloudflare', credentialsEncrypted: encrypted, scope });
  repo.updateStatus(conn.id, 'verified');
}

function createBaseAdapter(name: string): IProviderAdapter {
  return {
    name,
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
  };
}

describe('setupCustomDomain', () => {
  it('reports a missing Cloudflare connection before changing DNS', async () => {
    const project = new ProjectRepository().create({ name: 'domain-conn-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: {} },
    });

    const result = await setupCustomDomain({
      project,
      environment,
      domain: 'app.example.com',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no_connection');
    expect(result.error).toContain('No Cloudflare connection available');
  });

  it('does not write fallback DNS when provider custom-domain attach fails', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'app.example.com');
    const project = new ProjectRepository().create({ name: 'domain-no-fallback-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
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
      ...createBaseAdapter('railway'),
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

    const result = await setupCustomDomain({
      project,
      environment,
      domain: 'app.example.com',
      serviceName: 'web',
    });

    expect(result.customDomainAttached).toBe(false);
    expect(result.customDomainError).toContain('Problem processing request');
    expect(result.dnsConfigured).toBe(false);
    expect(result.dnsError).toContain('Custom-domain attach failed on railway');
    expect(attachCustomDomain).toHaveBeenCalledWith({
      projectId: 'rail-project-1',
      serviceId: 'rail-web',
      environmentId: 'rail-env-1',
      domain: 'app.example.com',
    });
    expect(upsertDnsRecord).not.toHaveBeenCalled();
  });

  it('does not write fallback DNS for managed hosts without domain attach support', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'app.example.com');
    const project = new ProjectRepository().create({ name: 'domain-unsupported-host-app', defaultPlatform: 'vercel' });
    const environment = new EnvironmentRepository().create({
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

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: createBaseAdapter('vercel'),
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

    const result = await setupCustomDomain({
      project,
      environment,
      domain: 'app.example.com',
      serviceName: 'web',
    });

    expect(result.customDomainAttached).toBe(false);
    expect(result.customDomainError).toContain('does not implement custom-domain attachment for vercel');
    expect(result.dnsConfigured).toBe(false);
    expect(upsertDnsRecord).not.toHaveBeenCalled();
  });
});
