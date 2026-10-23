import { describe, expect, it } from 'vitest';
import { mergeRepoPlatformBindings } from '../repo-bindings-file.js';

const record = { id: 'dns-id', name: 'app.example.com', type: 'CNAME', target: 'web.example.net' };
const domain = { name: 'app.example.com', providerDomainId: 'domain-id', serviceName: 'web',
  serviceId: 'web-id', environmentId: 'staging-id', zoneId: 'zone-id',
  creationAcknowledged: true, recreateRevision: 'reviewed-repair', records: [record] };
const local = { provider: 'railway', projectId: 'project-id', environmentId: 'staging-id', domainDns: domain };

describe('repository domain recovery retention', () => {
  it('still reconstructs an absent local domain from the repository export', () => {
    expect(mergeRepoPlatformBindings({}, local)).toEqual(local);
  });

  it('retains acknowledged creation, consumed repair revision and owned DNS IDs from an older snapshot', () => {
    const incoming = { ...domain, creationAcknowledged: false, recreateRevision: undefined, records: [] };
    expect(mergeRepoPlatformBindings(local, { ...local, domainDns: incoming }).domainDns).toEqual(domain);
  });

  it('unions distinct DNS identities only under the same exact domain and zone owner', () => {
    const added = { id: 'txt-id', name: '_verify.app.example.com', type: 'TXT', target: 'public-proof' };
    expect(mergeRepoPlatformBindings(local, { ...local, domainDns: { ...domain, records: [added] } }).domainDns)
      .toMatchObject({ records: [record, added], creationAcknowledged: true });
  });

  it.each(['domain', 'hosting'] as const)('rejects additional DNS IDs without complete %s ownership evidence', scope => {
    const added = { id: 'old-owner-dns', name: '_old.app.example.com', type: 'TXT', target: 'old-proof' };
    const incoming = scope === 'domain'
      ? { ...local, domainDns: { name: domain.name, records: [added] } }
      : { domainDns: { ...domain, records: [added] } };
    expect(() => mergeRepoPlatformBindings(local, incoming)).toThrow(/domain.*conflict/i);
  });

  it.each(['provider', 'projectId', 'environmentId'] as const)('rejects conflicting hosting scope %s', key => {
    expect(() => mergeRepoPlatformBindings(local, { ...local, [key]: 'replacement' })).toThrow(/domain.*conflict/i);
  });

  it('rejects a repository service binding that would transplant retained domain ownership', () => {
    expect(() => mergeRepoPlatformBindings(local, { ...local, services: { web: { serviceId: 'replacement' } } }))
      .toThrow(/domain.*conflict/i);
  });

  it.each(['name', 'providerDomainId', 'serviceName', 'serviceId', 'environmentId', 'zoneId', 'recreateRevision'] as const)(
    'rejects conflicting domain recovery field %s', key => {
      expect(() => mergeRepoPlatformBindings(local, { ...local, domainDns: { ...domain, [key]: 'replacement' } }))
        .toThrow(/domain.*conflict/i);
    });

  it.each(['name', 'type', 'target'] as const)('rejects conflicting data for the same DNS record ID: %s', key => {
    expect(() => mergeRepoPlatformBindings(local, { ...local, domainDns: {
      ...domain, records: [{ ...record, [key]: 'replacement' }],
    } })).toThrow(/domain.*conflict/i);
  });

  it.each(['local', 'repository'] as const)('rejects explicit null %s domain recovery instead of treating it as absent', side => {
    expect(() => mergeRepoPlatformBindings(side === 'local' ? { ...local, domainDns: null } : local,
      side === 'repository' ? { ...local, domainDns: null } : local)).toThrow();
  });
});
