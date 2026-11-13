import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { CloudflareAdapter } from '../../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { IProviderLifecycleAdapter } from '../../ports/provider.port.js';
import { adapterFactory } from '../adapter.factory.js';
import { setupCustomDomain, teardownCustomDomain } from '../domain.service.js';

let directory: string;
beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-domain-engine-stage-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function target(extra: Record<string, unknown> = {}) {
  const project = new ProjectRepository().create({ name: 'domain-stage', defaultPlatform: 'railway' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 'rs-1' } }, ...extra,
  } });
  return { project, environment, domain: 'app.example.com' };
}
function base(): IProviderLifecycleAdapter {
  return { name: 'railway', capabilities: { supportedBuilders: [], supportedComponents: [], supportsAutoWiring: false,
    supportsHealthChecks: true, supportsCronSchedule: false, supportsReleaseCommand: false, supportsMultiEnvironment: true,
    managedTls: true, supportsObserve: false }, async connect() {}, async verify() { return { success: true }; },
    async ensureProject() { throw Error('unused'); }, async ensureComponent() { throw Error('unused'); },
    async deploy() { throw Error('unused'); }, async setEnvVars() { return { success: true, message: 'unused' }; } };
}
function attachAdapter(data: Record<string, unknown> = {}) {
  const attachCustomDomain = vi.fn(async () => ({ success: true, message: 'attached', data: {
    customDomainId: 'domain-1', providerVerified: false,
    dnsRecords: [{ name: 'app.example.com', type: 'DNS_RECORD_TYPE_CNAME', value: 'app.up.railway.app.', purpose: 'DNS_RECORD_PURPOSE_TRAFFIC_ROUTE' },
      { name: '_railway.app.example.com', type: 'DNS_RECORD_TYPE_TXT', value: 'verification', purpose: 'verification' }], ...data,
  } }));
  const adapter = { ...base(), attachCustomDomain };
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
  return adapter;
}

describe('custom-domain hosting stages', () => {
  it('stages a hosting attachment without direct DNS writes or a Cloudflare connection', async () => {
    const params = target();
    const adapter = attachAdapter();
    const upsert = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord');
    const create = vi.spyOn(CloudflareAdapter.prototype, 'createDnsRecord');
    const lookup = vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName');
    const result = await setupCustomDomain(params);
    expect(result).toMatchObject({ customDomainAttached: true, pending: true, dnsConfigured: false, customDomainId: 'domain-1',
      requiredDnsRecords: [{ name: 'app.example.com', type: 'CNAME', value: 'app.up.railway.app' },
        { name: '_railway.app.example.com', type: 'TXT', value: 'verification' }] });
    expect(adapter.attachCustomDomain).toHaveBeenCalledWith({ projectId: 'rp-1', environmentId: 're-1', serviceId: 'rs-1',
      domain: 'app.example.com', dnsZone: 'example.com' });
    expect(upsert).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps every provider value as a requirement for the later engine plan', async () => {
    const params = target();
    attachAdapter({ dnsRecords: ['192.0.2.1', '192.0.2.2'].map(value => ({ name: 'app.example.com', type: 'A', value })) });
    const result = await setupCustomDomain(params);
    expect(result.requiredDnsRecords?.map(record => record.value)).toEqual(['192.0.2.1', '192.0.2.2']);
    expect(result.dnsRecords).toEqual([]);
    expect(result.success).toBe(false);
  });

  it('does not turn provider verification into DNS configuration evidence', async () => {
    const params = target();
    attachAdapter({ providerVerified: true });
    expect(await setupCustomDomain(params)).toMatchObject({ providerVerified: true, pending: true, dnsConfigured: false, success: false });
  });

  it('retains a pending attachment even before its DNS requirements become available', async () => {
    const params = target();
    attachAdapter({ dnsRecords: [] });
    expect(await setupCustomDomain(params)).toMatchObject({ customDomainAttached: true, pending: true, requiredDnsRecords: [] });
  });

  it('rejects an attachment response without its exact native identity', async () => {
    const params = target();
    attachAdapter({ customDomainId: undefined });
    expect(await setupCustomDomain(params)).toMatchObject({ customDomainAttached: false, success: false });
  });

  it('does not choose the first service when the target is ambiguous', async () => {
    const params = target({ services: { web: { serviceId: 'rs-1' }, other: { serviceId: 'rs-2' } } });
    const adapter = attachAdapter();
    expect((await setupCustomDomain(params)).customDomainAttached).toBe(false);
    expect(adapter.attachCustomDomain).not.toHaveBeenCalled();
  });

  it('uses the explicit provider recreate capability without writing DNS', async () => {
    const params = target();
    const recreateCustomDomain = vi.fn(async () => ({ success: true, message: 'recreated', data: { customDomainId: 'domain-2', recreated: true } }));
    const adapter = { ...base(), attachCustomDomain: vi.fn(), recreateCustomDomain };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
    const result = await setupCustomDomain({ ...params, recreate: true });
    expect(result).toMatchObject({ customDomainId: 'domain-2', recreated: true, pending: true, dnsConfigured: false });
    expect(recreateCustomDomain).toHaveBeenCalledOnce();
    expect(adapter.attachCustomDomain).not.toHaveBeenCalled();
  });

  it('reports unavailable hosting support without DNS fallback', async () => {
    const params = target();
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: base() });
    const upsert = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord');
    expect((await setupCustomDomain(params)).customDomainAttached).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('preserves the hosting claim and legacy DNS identities until engine cleanup is confirmed', async () => {
    const params = target({ domainDns: { name: 'app.example.com', providerDomainId: 'domain-1', serviceName: 'web',
      serviceId: 'rs-1', environmentId: 're-1', zoneId: 'zone-1', records: [{ id: 'record-1', name: 'app.example.com', type: 'CNAME', target: 'app.up.railway.app' }] } });
    const adapterLookup = vi.spyOn(adapterFactory, 'getProviderAdapter');
    const remove = vi.spyOn(CloudflareAdapter.prototype, 'deleteDnsRecord');
    expect(await teardownCustomDomain(params)).toMatchObject({ success: false });
    expect(adapterLookup).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('detaches only the exact hosting attachment after confirmed engine DNS removal', async () => {
    const params = target({ domainDns: { name: 'app.example.com', providerDomainId: 'domain-1', serviceName: 'web',
      serviceId: 'rs-1', environmentId: 're-1', zoneId: 'zone-1', records: [], dnsEngineRemoved: true } });
    const detachCustomDomain = vi.fn(async () => ({ success: true, message: 'absence confirmed' }));
    const adapter = { ...base(), detachCustomDomain };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
    const remove = vi.spyOn(CloudflareAdapter.prototype, 'deleteDnsRecord');
    expect(await teardownCustomDomain(params)).toMatchObject({ success: true, hostingDetached: true });
    expect(detachCustomDomain).toHaveBeenCalledWith({ projectId: 'rp-1', serviceId: 'rs-1', environmentId: 're-1', domain: 'app.example.com', customDomainId: 'domain-1' });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves incomplete historical and unverified pending claims (pending=%s)', async pending => {
    const params = target({ domainDns: { name: 'app.example.com', providerDomainId: 'domain-1', serviceName: 'web',
      serviceId: 'rs-1', environmentId: 're-1', records: [], ...(pending ? {
        dnsStagePending: true, dnsSelection: { provider: 'cloudflare', zone: { id: 'zone-1', name: 'example.com', accountId: 'account-1' } },
      } : {}) } });
    const adapterLookup = vi.spyOn(adapterFactory, 'getProviderAdapter');
    expect(await teardownCustomDomain(params)).toMatchObject({ success: false });
    expect(adapterLookup).not.toHaveBeenCalled();
  });
});
