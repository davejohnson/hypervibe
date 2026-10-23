import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../adapter.factory.js';
import { setupCustomDomain, teardownCustomDomain } from '../domain.service.js';

// Reconstructed Cloudflare HTTP fixtures, not live recordings or schema certification.
// Official response contract: DNS record `name` includes its zone name.
// https://developers.cloudflare.com/api/resources/dns/subresources/records/
// The recovery counterexample retained a relative Railway TXT host in the local
// binding while Cloudflare returns the exact record's complete DNS name.
const hostname = 'staging.example.com';
const relativeName = '_railway-verify.staging';
const fullName = '_railway-verify.staging.example.com';
const token = 'railway-verify=synthetic-verification-token';
let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-domain-dns-identity-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function fixture(bound = true) {
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'cloudflare', scope: 'example.com',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-cf-token' }) });
  connections.updateStatus(connection.id, 'verified');
  const project = new ProjectRepository().create({ name: 'dns-identity', defaultPlatform: 'railway' });
  new SpecStore().replace(project, { version: 1, project: project.name, environments: { staging: {
    hosting: { provider: 'railway' }, services: { web: { public: true } }, domain: hostname,
  } } });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging',
    platformBindings: { provider: 'railway', projectId: 'rail-project', environmentId: 'rail-staging',
      services: { web: { serviceId: 'rail-web', customDomains: bound ? [hostname] : [] } },
      ...(bound ? { domainDns: { name: hostname, providerDomainId: 'rail-domain', serviceName: 'web',
        serviceId: 'rail-web', environmentId: 'rail-staging', zoneId: 'zone-id', records: [
          { id: 'txt-id', name: relativeName, type: 'TXT', target: token },
        ] } } : {}),
    } });
  const detach = vi.fn(async () => ({ success: true, message: 'Exact provider attachment absent' }));
  const attach = vi.fn(async () => ({ success: true, message: 'Attached', data: {
    customDomainId: 'rail-domain', providerVerified: false,
    dnsRecords: [{ name: relativeName, type: 'TXT', value: token, purpose: 'VERIFICATION' }],
  } }));
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true,
    adapter: { name: 'railway', attachCustomDomain: attach, detachCustomDomain: detach } as never });
  return { project, environment, detach, attach };
}

function cloudflareTransport(options: { present?: boolean; name?: string; content?: string; zoneId?: string } = {}) {
  let present = options.present ?? true;
  const writes: Array<{ method: string; path: string; body?: unknown }> = [];
  const observedRecord = { id: 'txt-id', name: options.name ?? fullName, type: 'TXT',
    content: options.content ?? token, ttl: 1, proxied: false, proxiable: false,
    created_on: '2026-10-22T00:00:00Z', modified_on: '2026-10-22T00:00:00Z' };
  // Deliberately omit legacy zone_name; current response names are already complete.
  const response = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.cloudflare.com');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/client/v4/zones') {
      return response(url.searchParams.get('name') === 'example.com'
        ? [{ id: options.zoneId ?? 'zone-id', name: 'example.com', status: 'active' }] : []);
    }
    if (method === 'GET' && url.pathname === '/client/v4/zones/zone-id') {
      return response({ id: options.zoneId ?? 'zone-id', name: 'example.com', status: 'active' });
    }
    if (method === 'GET' && url.pathname === '/client/v4/zones/zone-id/dns_records') {
      return response(present ? [observedRecord] : []);
    }
    if (method === 'POST' && url.pathname === '/client/v4/zones/zone-id/dns_records') {
      writes.push({ method, path: url.pathname, body: JSON.parse(String(init?.body)) });
      present = true;
      return response(observedRecord);
    }
    if (method === 'DELETE' && url.pathname === '/client/v4/zones/zone-id/dns_records/txt-id') {
      writes.push({ method, path: url.pathname });
      present = false;
      return response({ id: 'txt-id' });
    }
    throw new Error(`Unexpected synthetic Cloudflare request ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { writes, fetch };
}

describe('custom domain DNS identity through Cloudflare HTTP', () => {
  it('retains the full name from the provider receipt for newly created verification records', async () => {
    const { project, environment } = fixture(false);
    const { writes } = cloudflareTransport({ present: false });
    const result = await setupCustomDomain({ project, environment, domain: hostname, serviceName: 'web' });
    expect(result).toMatchObject({ pending: true, customDomainAttached: true, dnsConfigured: true,
      dnsRecords: [{ id: 'txt-id', name: fullName, type: 'TXT', target: token }] });
    expect(writes).toEqual([{ method: 'POST', path: '/client/v4/zones/zone-id/dns_records',
      body: { name: relativeName, type: 'TXT', content: token, ttl: 1, proxied: false } }]);
  });

  it('detaches a legacy relative verification name only within the exact observed bound zone', async () => {
    const { project, environment, detach } = fixture();
    const { writes } = cloudflareTransport();
    const result = await teardownCustomDomain({ project, environment, domain: hostname });
    expect(result).toMatchObject({ success: true, hostingDetached: true, deletedDnsRecordIds: ['txt-id'] });
    expect(detach).toHaveBeenCalledExactlyOnceWith({ projectId: 'rail-project', serviceId: 'rail-web',
      environmentId: 'rail-staging', domain: hostname, customDomainId: 'rail-domain' });
    expect(writes).toEqual([{ method: 'DELETE', path: '/client/v4/zones/zone-id/dns_records/txt-id' }]);
  });

  it.each([
    ['another record name', { name: '_railway-verify.other.example.com' }],
    ['changed content', { content: 'railway-verify=unreviewed-token' }],
    ['replaced zone identity', { zoneId: 'zone-replacement' }],
  ] as const)('blocks %s before provider or DNS mutation', async (_label, options) => {
    const { project, environment, detach } = fixture();
    const { writes } = cloudflareTransport(options);
    expect(await teardownCustomDomain({ project, environment, domain: hostname }))
      .toMatchObject({ success: false });
    expect(detach).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
