import { describe, expect, it } from 'vitest';
import type { DnsEngineInput, DnsRecordIntent } from '../../../../domain/ports/dns.port.js';
import { buildDnsConfiguration, dnsRecordAddress, dnsRecordNativeId } from '../dns-engine.backend.js';

import { DNS_ZONES, record } from './dns-fixtures.js';

const body = (input: DnsEngineInput) => (buildDnsConfiguration(input).files['dns.tf.json'] as { resource: Record<string, Record<string, Record<string, unknown>>> }).resource;

describe('DNS generated configuration ownership boundary', () => {
  it.each(['gcp', 'aws', 'azure'] as const)('groups %s RRsets and preserves explicitly retained values during adoption', provider => {
    const zone = DNS_ZONES[provider];
    const nativeId = dnsRecordNativeId(zone, 'www.example.com', 'A');
    const authority = { kind: 'adopt' as const, nativeId, existingValues: ['192.0.2.9'], preserveValues: ['192.0.2.9'] };
    const input = { zone, records: [record({ authority }), record({ key: 'other', values: ['192.0.2.2'], authority })] };
    const configuration = buildDnsConfiguration(input);
    expect(Object.keys(configuration.resources)).toHaveLength(1);
    expect(Object.values(configuration.imports!)).toEqual([nativeId]);
    const resources = Object.values(body(input))[0]!;
    const item = Object.values(resources)[0]!;
    expect(item.rrdatas ?? item.records).toEqual(['192.0.2.1', '192.0.2.2', '192.0.2.9']);
  });
  it('uses individual Cloudflare resources and keeps their address stable when values change', () => {
    const zone = DNS_ZONES.cloudflare;
    const one = record();
    const two = record({ key: 'second', values: ['192.0.2.2'] });
    expect(Object.keys(buildDnsConfiguration({ zone, records: [one, two] }).resources)).toHaveLength(2);
    expect(dnsRecordAddress(zone, one)).toBe(dnsRecordAddress(zone, record({ values: ['192.0.2.3'] })));
  });
  it('rejects implicit authoritative creates, wrong-scope imports, and losing existing adopted values', () => {
    const zone = DNS_ZONES.gcp;
    expect(() => buildDnsConfiguration({ zone, records: [record({ authority: undefined as never })] })).toThrow(/authority/i);
    expect(() => buildDnsConfiguration({ zone, records: [record({ authority: { kind: 'adopt', nativeId: 'projects/other/managedZones/example-zone/rrsets/www.example.com./A', existingValues: [], preserveValues: [] } })] })).toThrow(/identity|scope/i);
    expect(() => buildDnsConfiguration({ zone, records: [record({ authority: { kind: 'adopt', nativeId: dnsRecordNativeId(zone, 'www.example.com', 'A'), existingValues: ['192.0.2.9'], preserveValues: [] } })] })).toThrow(/preserv/i);
  });
  it('rejects mixed authority, TTL conflicts, CNAME siblings and outside-zone names', () => {
    const zone = DNS_ZONES.aws;
    const configured = (records: DnsRecordIntent[]) => () => buildDnsConfiguration({ zone, records });
    expect(configured([record(), record({ key: 'two', ttl: 600 })])).toThrow(/TTL/);
    expect(configured([record(), record({ key: 'two', authority: { kind: 'managed', nativeId: dnsRecordNativeId(zone, 'www.example.com', 'A'), preserveValues: [] } })])).toThrow(/authority/);
    expect(configured([record(), record({ key: 'cname', type: 'CNAME', values: ['target.example.net'] })])).toThrow(/CNAME/);
    expect(configured([record({ name: 'www.example.org' })])).toThrow(/zone/);
  });
  it('prevents provider initialization from registering Azure resources or adopting Route53 records', () => {
    const azure = buildDnsConfiguration({ zone: DNS_ZONES.azure, records: [record()] });
    expect(JSON.stringify(azure.files)).toContain('"resource_provider_registrations":"none"');
    const aws = Object.values(Object.values(body({ zone: DNS_ZONES.aws, records: [record()] }))[0]!)[0]!;
    expect(aws.allow_overwrite).toBe(false);
  });
  it('escapes OpenTofu template syntax and quotes TXT RDATA correctly', () => {
    const resources = body({ zone: DNS_ZONES.gcp, records: [record({ type: 'TXT', values: ['${sensitive.value} %{if true} "quoted" \\ slash'] })] });
    expect(Object.values(resources.google_dns_record_set!)[0]!.rrdatas).toEqual(['"$${sensitive.value} %%{if true} \\"quoted\\" \\\\ slash"']);
  });
  it('maps exact retired addresses and retains adopted sibling values during teardown', () => {
    const zone = DNS_ZONES.gcp;
    const nativeId = dnsRecordNativeId(zone, 'www.example.com', 'A');
    const retired = record({ authority: { kind: 'managed', nativeId, preserveValues: [] } });
    const removed = buildDnsConfiguration({ zone, records: [], retiredRecords: [retired] });
    expect(Object.keys(removed.resources)).toEqual([dnsRecordAddress(zone, retired)]);
    expect(body({ zone, records: [], retiredRecords: [retired] })).toEqual({});
    const shared = record({ authority: { kind: 'managed', nativeId, preserveValues: ['192.0.2.9'] } });
    const retained = body({ zone, records: [], retiredRecords: [shared] });
    expect(Object.values(retained.google_dns_record_set!)[0]!.rrdatas).toEqual(['192.0.2.9']);
    expect(() => buildDnsConfiguration({ zone, records: [], retiredRecords: [record()] })).toThrow(/managed authority/);
  });
  it('encodes MX preferences without confusing the exchange with record content', () => {
    const mx = record({ type: 'MX', values: ['10 mail.example.net.'] });
    const cf = Object.values(body({ zone: DNS_ZONES.cloudflare, records: [mx] }).cloudflare_dns_record!)[0]!;
    expect(cf).toMatchObject({ priority: 10, content: 'mail.example.net.' });
    const azure = Object.values(body({ zone: DNS_ZONES.azure, records: [mx] }).azurerm_dns_mx_record!)[0]!;
    expect(azure.record).toEqual([{ preference: 10, exchange: 'mail.example.net.' }]);
    expect(() => buildDnsConfiguration({ zone: DNS_ZONES.aws, records: [record({ type: 'MX', values: ['65536 mail.example.net'] })] })).toThrow(/preference/);
  });
});
