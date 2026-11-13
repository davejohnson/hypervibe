import { describe, expect, it } from 'vitest';
import { environmentSpecSchema, projectSpecSchema } from '../spec.schema.js';

const environment = { hosting: { provider: 'aws-ecs' }, domain: 'app.example.com' };
const cloudflare = { provider: 'cloudflare', zone: { id: 'cf-zone-123', name: 'example.com', accountId: 'cf-account-123' } };

describe('DNS desired state at the environment boundary', () => {
  it.each([
    cloudflare,
    { provider: 'gcp', zone: { id: '123456', name: 'example.com', projectId: 'dns-project' } },
    { provider: 'aws', zone: { id: 'Z0123456789', name: 'example.com', accountId: '123456789012' } },
    { provider: 'azure', zone: { id: '/subscriptions/sub/resourceGroups/dns/providers/Microsoft.Network/dnsZones/example.com', name: 'example.com', subscriptionId: 'sub', resourceGroup: 'dns' } },
  ])('keeps DNS provider independent from hosting: $provider', (dns) => {
    const parsed = environmentSpecSchema.parse({ ...environment, dns });
    expect(parsed).toMatchObject({ hosting: environment.hosting, dns });
  });

  it('keeps old custom-domain specs without adding DNS ownership', () => {
    const parsed = environmentSpecSchema.parse({ ...environment, domainProxy: true });
    expect(parsed).not.toHaveProperty('dns');
    expect(parsed.domainProxy).toBe(true);
  });

  it.each([
    { ...cloudflare, zone: { id: 'cf-zone-123', name: 'example.com' } },
    { ...cloudflare, zone: { ...cloudflare.zone, projectId: 'different-scope' } },
    { provider: 'gcp', zone: { id: '123456', name: 'example.com' } },
    { provider: 'aws', zone: { id: 'Z0123456789', name: 'example.com', accountId: 'not-an-account' } },
    { provider: 'azure', zone: { id: 'zone', name: 'example.com', subscriptionId: 'sub' } },
    { ...cloudflare, zone: { ...cloudflare.zone, name: 'evil-example.com' } },
  ])('rejects incomplete, mixed or unrelated zone identity', (dns) => {
    expect(environmentSpecSchema.safeParse({ ...environment, dns }).success).toBe(false);
  });

  it('allows a DNS fragment without borrowing a hosting hostname and validates the consumer at project level', () => {
    const selected = { hosting: { provider: 'cloudrun' }, dns: cloudflare };
    expect(environmentSpecSchema.safeParse(selected).success).toBe(true);
    expect(projectSpecSchema.safeParse({ version: 1, project: 'pages', environments: { repository: selected } }).success).toBe(false);
    expect(projectSpecSchema.safeParse({ version: 1, project: 'pages', github: {
      repository: 'owner/pages', canonicalEnvironment: 'repository', pages: { sourcePath: 'public', customDomain: 'example.com' },
    }, environments: { repository: selected } }).success).toBe(true);
  });

  it('rejects a Pages consumer outside the selected DNS zone or canonical environment', () => {
    const selected = { hosting: { provider: 'cloudrun' }, dns: cloudflare };
    const source = { version: 1, project: 'pages', github: { repository: 'owner/pages', canonicalEnvironment: 'repository',
      pages: { sourcePath: 'public', customDomain: 'other.example.net' } }, environments: { repository: selected } };
    expect(projectSpecSchema.safeParse(source).success).toBe(false);
    expect(projectSpecSchema.safeParse({ ...source, github: { ...source.github, canonicalEnvironment: 'different',
      pages: { ...source.github.pages, customDomain: 'example.com' } } }).success).toBe(false);
  });

  it('rejects contradictory legacy and explicit proxy intent', () => {
    expect(environmentSpecSchema.safeParse({ ...environment, domainProxy: true,
      dns: { ...cloudflare, policy: { proxy: 'off' } } }).success).toBe(false);
  });

  it('retains unsupported security intent so planning can explain the missing capability', () => {
    const dns = { ...cloudflare, connectionScope: 'production-dns', policy: {
      exposure: 'private', dnssec: 'required', tls: 'required', caa: { issuers: ['letsencrypt.org'] },
      wildcard: 'allow', proxy: 'off',
    } };
    expect(environmentSpecSchema.parse({ ...environment, dns })).toMatchObject({ dns });
  });

  it('requires an explicit wildcard policy for a wildcard hostname', () => {
    expect(environmentSpecSchema.safeParse({ ...environment, domain: '*.example.com', dns: cloudflare }).success).toBe(false);
    expect(environmentSpecSchema.safeParse({ ...environment, domain: '*.example.com',
      dns: { ...cloudflare, policy: { wildcard: 'allow' } } }).success).toBe(true);
  });

  it('retains exact reviewed adoption identity and current values', () => {
    const adoptRecords = [{ id: 'cf-record-123', name: 'app.example.com', type: 'CNAME', values: ['old.example.net'] }];
    expect(environmentSpecSchema.parse({ ...environment, dns: { ...cloudflare, adoptRecords } }))
      .toMatchObject({ dns: { adoptRecords } });
    expect(environmentSpecSchema.safeParse({ ...environment, dns: { ...cloudflare,
      adoptRecords: [{ ...adoptRecords[0], name: 'app.other.com' }] } }).success).toBe(false);
    expect(environmentSpecSchema.safeParse({ ...environment, dns: { ...cloudflare,
      adoptRecords: [{ ...adoptRecords[0], values: [] }] } }).success).toBe(false);
  });
});
