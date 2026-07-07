import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { IHostingAdapter } from '../../ports/hosting.port.js';
import { attachBootstrapDomain } from '../bootstrap-domain.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-bootstrap-domain-'));
  initializeDatabase(path.join(tempDir, 'hypervibe.db'));
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedCloudflareConnection(scope?: string) {
  const repo = new ConnectionRepository();
  const conn = repo.create({
    provider: 'cloudflare',
    scope,
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cf-token' }),
  });
  repo.updateStatus(conn.id, 'verified');
}

function createHostingAdapter(name: string): IHostingAdapter {
  return {
    name,
    capabilities: {
      supportedBuilders: ['nixpacks'],
      supportsAutoWiring: true,
      supportsHealthChecks: true,
      supportsCronSchedule: false,
      supportsReleaseCommand: true,
      supportsMultiEnvironment: true,
      managedTls: true,
      supportsAutoScaling: false,
      supportsObserve: false,
    },
    async connect() {},
    async verify() {
      return { success: true };
    },
    async ensureProject() {
      return { success: true, message: 'bound' };
    },
    async deploy() {
      throw new Error('not used');
    },
    async setEnvVars() {
      return { success: true, message: 'vars synced' };
    },
  };
}

function seedProjectEnvironmentService(args: {
  projectName: string;
  provider: string;
  bindings?: Record<string, unknown>;
}) {
  const project = new ProjectRepository().create({ name: args.projectName, defaultPlatform: args.provider });
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: args.bindings ?? {
      provider: args.provider,
      projectId: 'ext-project-1',
      environmentId: 'ext-env-1',
      services: {
        web: { serviceId: 'ext-web' },
      },
    },
  });
  const service = new ServiceRepository().create({
    projectId: project.id,
    name: 'web',
    buildConfig: { builder: 'nixpacks' },
    envVarSpec: {},
  });
  return { project, environment, service };
}

function stubCloudflareZone(zoneName: string) {
  vi.spyOn(CloudflareAdapter.prototype, 'connect').mockImplementation(() => {});
  vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
    id: 'zone-1',
    name: zoneName,
    status: 'active',
    paused: false,
    type: 'full',
    name_servers: [],
  });
}

describe('attachBootstrapDomain', () => {
  it('attaches a Railway custom domain and writes the required DNS records to Cloudflare', async () => {
    seedCloudflareConnection('app.example.com');
    const { environment, service } = seedProjectEnvironmentService({
      projectName: 'bootstrap-domain-railway-app',
      provider: 'railway',
    });

    const attachCustomDomain = vi.fn(async () => ({
      success: true,
      message: 'attached',
      data: {
        domain: 'app.example.com',
        customDomainId: 'cd_123',
        created: true,
        dnsRecords: [
          { name: 'app.example.com', type: 'DNS_RECORD_TYPE_CNAME', value: 'web-production.up.railway.app.' },
          { name: '_railway.app.example.com', type: 'DNS_RECORD_TYPE_TXT', value: 'verify-token' },
        ],
      },
    }));
    const hostingAdapter = {
      ...createHostingAdapter('railway'),
      attachCustomDomain,
    };

    stubCloudflareZone('example.com');
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord').mockResolvedValue({
      record: {
        id: 'rec-1',
        zone_id: 'zone-1',
        zone_name: 'example.com',
        name: 'app.example.com',
        type: 'CNAME',
        content: 'web-production.up.railway.app',
        proxied: false,
        proxiable: true,
        ttl: 1,
        created_on: new Date().toISOString(),
        modified_on: new Date().toISOString(),
      },
      action: 'created',
    });

    const summary: Record<string, unknown> = {};
    await attachBootstrapDomain({
      domain: 'app.example.com',
      environment,
      hostingAdapter,
      serviceWorkloads: [service],
      scopeHints: [],
      targetPlatform: 'railway',
      deployUrls: ['https://web-production.up.railway.app'],
      summary,
    });

    expect(attachCustomDomain).toHaveBeenCalledWith({
      projectId: 'ext-project-1',
      serviceId: 'ext-web',
      environmentId: 'ext-env-1',
      domain: 'app.example.com',
    });
    expect(summary.customDomainAttached).toBe(true);
    expect(summary.customDomain).toEqual({
      domain: 'app.example.com',
      service: 'web',
      created: true,
    });
    expect(summary.domainDnsConfigured).toBe(true);
    expect(summary.domainDnsRecords).toEqual([
      { name: 'app.example.com', type: 'CNAME', target: 'web-production.up.railway.app', action: 'created' },
      { name: '_railway.app.example.com', type: 'TXT', target: 'verify-token', action: 'created' },
    ]);
    expect(upsertDnsRecord.mock.calls).toEqual([
      ['zone-1', 'app.example.com', 'CNAME', 'web-production.up.railway.app', { proxied: false }],
      ['zone-1', '_railway.app.example.com', 'TXT', 'verify-token', { proxied: false }],
    ]);
  });

  it('does not write a fallback CNAME for managed hosts without attachCustomDomain support', async () => {
    seedCloudflareConnection('example.com');
    const { environment, service } = seedProjectEnvironmentService({
      projectName: 'bootstrap-domain-unsupported-app',
      provider: 'cloudrun',
    });

    stubCloudflareZone('example.com');
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord');

    const summary: Record<string, unknown> = {};
    await attachBootstrapDomain({
      domain: 'app.example.com',
      environment,
      hostingAdapter: createHostingAdapter('cloudrun'),
      serviceWorkloads: [service],
      scopeHints: [],
      targetPlatform: 'cloudrun',
      deployUrls: ['https://web-abc123-uc.a.run.app'],
      summary,
    });

    expect(summary.customDomainAttached).toBe(false);
    expect(summary.customDomainError).toContain('does not implement custom-domain attachment for cloudrun');
    expect(summary.domainDnsConfigured).toBeUndefined();
    expect(upsertDnsRecord).not.toHaveBeenCalled();
  });

  it('reports a missing service binding on a managed host without calling the provider', async () => {
    seedCloudflareConnection('example.com');
    const { environment, service } = seedProjectEnvironmentService({
      projectName: 'bootstrap-domain-binding-missing-app',
      provider: 'railway',
      bindings: {
        provider: 'railway',
        projectId: 'ext-project-1',
        environmentId: 'ext-env-1',
        services: {},
      },
    });

    const attachCustomDomain = vi.fn();
    const hostingAdapter = {
      ...createHostingAdapter('railway'),
      attachCustomDomain,
    };
    stubCloudflareZone('example.com');
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord');

    const summary: Record<string, unknown> = {};
    await attachBootstrapDomain({
      domain: 'app.example.com',
      environment,
      hostingAdapter,
      serviceWorkloads: [service],
      scopeHints: [],
      targetPlatform: 'railway',
      deployUrls: ['https://web-production.up.railway.app'],
      summary,
    });

    expect(summary.customDomainAttached).toBe(false);
    expect(summary.customDomainError).toContain('could not find the provider service/environment binding');
    expect(attachCustomDomain).not.toHaveBeenCalled();
    expect(upsertDnsRecord).not.toHaveBeenCalled();
  });

  it('marks DNS unconfigured with connection guidance when no Cloudflare connection exists', async () => {
    const { environment, service } = seedProjectEnvironmentService({
      projectName: 'bootstrap-domain-no-cf-app',
      provider: 'railway',
    });

    const attachCustomDomain = vi.fn(async () => ({
      success: true,
      message: 'attached',
      data: {
        domain: 'app.example.com',
        created: true,
        dnsRecords: [
          { name: 'app.example.com', type: 'DNS_RECORD_TYPE_CNAME', value: 'web-production.up.railway.app.' },
        ],
      },
    }));
    const hostingAdapter = {
      ...createHostingAdapter('railway'),
      attachCustomDomain,
    };
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord');

    const summary: Record<string, unknown> = {};
    await attachBootstrapDomain({
      domain: 'app.example.com',
      environment,
      hostingAdapter,
      serviceWorkloads: [service],
      scopeHints: [],
      targetPlatform: 'railway',
      deployUrls: ['https://web-production.up.railway.app'],
      summary,
    });

    expect(summary.customDomainAttached).toBe(true);
    expect(summary.domainDnsConfigured).toBe(false);
    expect(summary.domainDnsError).toContain('No verified Cloudflare connection available for DNS zone example.com');
    expect(summary.domainDnsError).toContain('needed by app.example.com');
    expect(summary.domainDnsError).toContain('hv_connect provider="cloudflare"');
    expect(upsertDnsRecord).not.toHaveBeenCalled();
  });
});
