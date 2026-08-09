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
import { setupCustomDomain, teardownCustomDomain } from '../domain.service.js';

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
    expect(result.error).toContain('No verified Cloudflare connection available for DNS zone example.com');
    expect(result.error).toContain('scope="example.com"');
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
      dnsZone: 'example.com',
    });
    expect(upsertDnsRecord).not.toHaveBeenCalled();
  });

  it('normalizes provider DNS enum record types before writing to Cloudflare', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'app.example.com');
    const project = new ProjectRepository().create({ name: 'domain-enum-record-app', defaultPlatform: 'railway' });
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

    let providerVerified = false;
    const attachCustomDomain = vi.fn(async () => ({
      success: true,
      message: 'Railway custom domain already attached',
      data: {
        domain: 'app.example.com',
        customDomainId: 'cd_123',
        providerVerified,
        dnsRecords: [
          {
            name: 'app.example.com',
            type: 'DNS_RECORD_TYPE_CNAME',
            value: 'web-production.up.railway.app.',
            purpose: 'DNS_RECORD_PURPOSE_TRAFFIC_ROUTE',
          },
          {
            name: '_railway.app.example.com',
            type: 'DNS_RECORD_TYPE_TXT',
            value: 'verify-token',
            purpose: 'verification',
          },
        ],
      },
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
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord')
      .mockResolvedValue({
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

    const pending = await setupCustomDomain({
      project,
      environment,
      domain: 'app.example.com',
      serviceName: 'web',
    });

    expect(pending).toMatchObject({
      success: false,
      pending: true,
      providerVerified: false,
      verification: { providerVerified: false },
    });
    expect(upsertDnsRecord.mock.calls.slice(0, 2)).toEqual([
      ['zone-1', 'app.example.com', 'CNAME', 'web-production.up.railway.app', { proxied: true }],
      ['zone-1', '_railway.app.example.com', 'TXT', 'verify-token', { proxied: false }],
    ]);

    const dnsOnly = await setupCustomDomain({
      project,
      environment,
      domain: 'app.example.com',
      serviceName: 'web',
      trafficProxied: false,
    });
    expect(dnsOnly).toMatchObject({ success: false, pending: true });
    expect(upsertDnsRecord.mock.calls.slice(2, 4)).toEqual([
      ['zone-1', 'app.example.com', 'CNAME', 'web-production.up.railway.app', { proxied: false }],
      ['zone-1', '_railway.app.example.com', 'TXT', 'verify-token', { proxied: false }],
    ]);

    providerVerified = true;
    const verified = await setupCustomDomain({
      project,
      environment,
      domain: 'app.example.com',
      serviceName: 'web',
    });
    expect(verified).toMatchObject({
      success: true,
      pending: false,
      providerVerified: true,
      verification: { providerVerified: true },
    });
  });

  it('preserves every exact provider record in a multi-value DNS set', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'app.example.com');
    const project = new ProjectRepository().create({ name: 'domain-multi-value-app', defaultPlatform: 'cloudrun' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project-1',
        environmentId: 'us-central1',
        services: { web: { serviceId: 'cloudrun-web' } },
      },
    });
    const attachCustomDomain = vi.fn(async () => ({
      success: true,
      message: 'Cloud Run domain mapping ready',
      data: {
        domain: 'app.example.com',
        customDomainId: 'mapping-uid-1',
        providerVerified: true,
        dnsRecords: [
          { name: 'app.example.com', type: 'A', value: '216.239.32.21', purpose: 'traffic' },
          { name: 'app.example.com', type: 'A', value: '216.239.34.21', purpose: 'traffic' },
        ],
      },
    }));
    const fakeHostingAdapter = {
      ...createBaseAdapter('cloudrun'),
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
    const ensureRecords = vi.spyOn(CloudflareAdapter.prototype, 'ensureRecords')
      .mockResolvedValue({
        created: ['216.239.34.21'],
        deleted: [],
        unchanged: ['216.239.32.21'],
        records: [
          {
            id: 'a-1',
            zone_id: 'zone-1',
            zone_name: 'example.com',
            name: 'app.example.com',
            type: 'A',
            content: '216.239.32.21',
            proxied: false,
            proxiable: true,
            ttl: 1,
            created_on: new Date().toISOString(),
            modified_on: new Date().toISOString(),
          },
          {
            id: 'a-2',
            zone_id: 'zone-1',
            zone_name: 'example.com',
            name: 'app.example.com',
            type: 'A',
            content: '216.239.34.21',
            proxied: false,
            proxiable: true,
            ttl: 1,
            created_on: new Date().toISOString(),
            modified_on: new Date().toISOString(),
          },
        ],
      });
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord');

    const result = await setupCustomDomain({
      project,
      environment,
      domain: 'app.example.com',
      serviceName: 'web',
      trafficProxied: false,
    });

    expect(result).toMatchObject({
      success: true,
      customDomainAttached: true,
      customDomainId: 'mapping-uid-1',
      dnsConfigured: true,
      dnsRecords: [
        { id: 'a-1', type: 'A', target: '216.239.32.21' },
        { id: 'a-2', type: 'A', target: '216.239.34.21' },
      ],
    });
    expect(ensureRecords).toHaveBeenCalledWith(
      'zone-1',
      'app.example.com',
      'A',
      ['216.239.32.21', '216.239.34.21'],
      { proxied: false, pruneExtras: false },
    );
    expect(upsertDnsRecord).not.toHaveBeenCalled();
  });

  it('routes an explicit domain replacement through the recreate capability', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'app.example.com');
    const project = new ProjectRepository().create({ name: 'domain-recreate-app', defaultPlatform: 'railway' });
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

    const attachCustomDomain = vi.fn();
    const recreateCustomDomain = vi.fn(async () => ({
      success: true,
      message: 'Railway custom domain deleted and recreated',
      data: {
        domain: 'app.example.com',
        customDomainId: 'cd-new',
        recreated: true,
        providerVerified: false,
        dnsRecords: [
          { name: 'app.example.com', type: 'CNAME', value: 'new-target.up.railway.app' },
          { name: '_railway-verify.app.example.com', type: 'TXT', value: 'railway-verify=new-token' },
        ],
      },
    }));
    const fakeHostingAdapter = {
      ...createBaseAdapter('railway'),
      attachCustomDomain,
      recreateCustomDomain,
    } satisfies IProviderAdapter & {
      attachCustomDomain: typeof attachCustomDomain;
      recreateCustomDomain: typeof recreateCustomDomain;
    };

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
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord')
      .mockResolvedValue({
        record: {
          id: 'rec-1',
          zone_id: 'zone-1',
          zone_name: 'example.com',
          name: 'app.example.com',
          type: 'CNAME',
          content: 'new-target.up.railway.app',
          proxied: false,
          proxiable: true,
          ttl: 1,
          created_on: new Date().toISOString(),
          modified_on: new Date().toISOString(),
        },
        action: 'updated',
      });

    const result = await setupCustomDomain({
      project,
      environment,
      domain: 'app.example.com',
      serviceName: 'web',
      trafficProxied: false,
      recreate: true,
    });

    expect(result).toMatchObject({
      success: false,
      pending: true,
      customDomainAttached: true,
      customDomainId: 'cd-new',
      recreated: true,
      providerVerified: false,
      dnsConfigured: true,
    });
    expect(attachCustomDomain).not.toHaveBeenCalled();
    expect(recreateCustomDomain).toHaveBeenCalledWith({
      projectId: 'rail-project-1',
      serviceId: 'rail-web',
      environmentId: 'rail-env-1',
      domain: 'app.example.com',
      dnsZone: 'example.com',
    });
    expect(upsertDnsRecord).toHaveBeenCalledTimes(2);
  });

  it('does not write fallback DNS for managed hosts without domain attach support', async () => {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'app.example.com');
    const project = new ProjectRepository().create({ name: 'domain-unsupported-host-app', defaultPlatform: 'cloudrun' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project-1',
        environmentId: 'production',
        services: {
          web: {
            serviceId: 'cloudrun-web',
            url: 'https://web-abc123-uc.a.run.app',
          },
        },
      },
    });

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: createBaseAdapter('cloudrun'),
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
    expect(result.customDomainError).toContain('does not implement that lifecycle for cloudrun');
    expect(result.dnsConfigured).toBe(false);
    expect(upsertDnsRecord).not.toHaveBeenCalled();
  });
});

describe('teardownCustomDomain', () => {
  function fixture() {
    seedCloudflareConnection({ apiToken: 'cf-token' }, 'example.com');
    const project = new ProjectRepository().create({ name: 'domain-teardown-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'rail-web', customDomains: ['app.example.com'] } },
        domainDns: {
          name: 'app.example.com',
          proxied: false,
          providerDomainId: 'cd-1',
          serviceName: 'web',
          serviceId: 'rail-web',
          environmentId: 'rail-env-1',
          zoneId: 'zone-1',
          records: [{
            id: 'record-1',
            name: 'app.example.com',
            type: 'CNAME',
            target: 'web-production.up.railway.app',
          }],
        },
      },
    });
    return { project, environment };
  }

  it('detaches the exact provider attachment before deleting exact managed DNS records', async () => {
    const { project, environment } = fixture();
    const detachCustomDomain = vi.fn(async () => ({
      success: true,
      message: 'detached',
      data: { customDomainId: 'cd-1' },
    }));
    const fakeHostingAdapter = {
      ...createBaseAdapter('railway'),
      detachCustomDomain,
    } satisfies IProviderAdapter & { detachCustomDomain: typeof detachCustomDomain };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });
    vi.spyOn(CloudflareAdapter.prototype, 'connect').mockImplementation(() => {});
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockResolvedValue([{
      id: 'record-1',
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
    }]);
    const deleteDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'deleteDnsRecord')
      .mockResolvedValue({ id: 'record-1' });

    const result = await teardownCustomDomain({ project, environment, domain: 'app.example.com' });

    expect(result).toEqual({
      success: true,
      hostingDetached: true,
      customDomainId: 'cd-1',
      deletedDnsRecordIds: ['record-1'],
    });
    expect(detachCustomDomain).toHaveBeenCalledWith({
      projectId: 'rail-project-1',
      serviceId: 'rail-web',
      environmentId: 'rail-env-1',
      domain: 'app.example.com',
      customDomainId: 'cd-1',
    });
    expect(deleteDnsRecord).toHaveBeenCalledWith('zone-1', 'record-1');
  });

  it('blocks before provider mutation when a durable DNS id now points elsewhere', async () => {
    const { project, environment } = fixture();
    const detachCustomDomain = vi.fn();
    const fakeHostingAdapter = {
      ...createBaseAdapter('railway'),
      detachCustomDomain,
    } satisfies IProviderAdapter & { detachCustomDomain: typeof detachCustomDomain };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });
    vi.spyOn(CloudflareAdapter.prototype, 'connect').mockImplementation(() => {});
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockResolvedValue([{
      id: 'record-1',
      zone_id: 'zone-1',
      zone_name: 'example.com',
      name: 'unrelated.example.com',
      type: 'CNAME',
      content: 'other.example.net',
      proxied: false,
      proxiable: true,
      ttl: 1,
      created_on: new Date().toISOString(),
      modified_on: new Date().toISOString(),
    }]);
    const deleteDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'deleteDnsRecord');

    const result = await teardownCustomDomain({ project, environment, domain: 'app.example.com' });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('no provider or DNS mutation') });
    expect(detachCustomDomain).not.toHaveBeenCalled();
    expect(deleteDnsRecord).not.toHaveBeenCalled();
  });
});
