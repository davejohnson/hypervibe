import { describe, expect, it, vi } from 'vitest';
import type { DnsObservedRecord } from '../../src/domain/ports/dns.port.js';
import { assertDnsFixtureActions, assertDnsFixtureTarget, assertDnsFixtureValues, assertDnsPreservedRecords, dnsFixtureInventory,
  assertDnsProofPreserved, dnsFixtureCleanupState, dnsFixtureProofBaseline,
  dnsFixtureMarkerSchema, readDnsFixtureRecords, readDnsPreservedRecords, type DnsFixtureMarker, type SafeDnsOwnedRecord } from './dns-lifecycle-harness.js';
import { runDisposableFixture, type FixtureJournal } from './lifecycle-live-harness.js';
import type { DnsObserver } from '../../src/adapters/dns-observation/http-observer.js';

const marker: DnsFixtureMarker = { version: 1, purpose: 'disposable-dns-conformance', profile: 'dns-cloudflare', project: 'fixture', internalProjectId: 'p1',
  environment: 'test', internalEnvironmentId: 'e1', repository: 'owner/fixture', hostname: 'fixture.example.com', expectedRevision: 'fixed-v1',
  dns: { provider: 'cloudflare', zone: { id: 'zone1', name: 'example.com', accountId: 'account1' }, connectionScope: 'owner/fixture', policy: { proxy: 'off' } },
  preserved: [{ name: 'sentinel.example.com', type: 'TXT', nativeIds: ['zone1/sentinel'] }] };
const row: DnsObservedRecord = { nativeId: 'zone1/r1', name: 'fixture.example.com.', type: 'A', values: ['192.0.2.1'], ttl: 300, proxied: false };
const owned: SafeDnsOwnedRecord = { nativeId: row.nativeId, name: row.name, type: row.type, address: 'cloudflare_dns_record.fixture', owner: 'domain:fixture.example.com' };
const observer = (callback: DnsObserver['observeRecordSets']): DnsObserver => ({ observeRecordSets: callback, observeZone: async () => ({ status: 'unknown', reason: 'unused' }) });
const action = { id: 'dns1', type: 'create', resource: { kind: 'domain', provider: 'dns-cloudflare', name: 'fixture.example.com A' },
  metadata: { operation: 'dnsEngine', domain: 'fixture.example.com', engineSegment: { id: 'dns1', addresses: ['cloudflare_dns_record.fixture'] } } };

describe('disposable DNS fixture authorization and evidence', () => {
  it('requires an exact prepared project, environment, DNS zone and scoped connection', () => {
    expect(dnsFixtureMarkerSchema.safeParse(marker).success).toBe(true);
    for (const invalid of [{ ...marker, hostname: 'example.com' }, { ...marker, profile: 'dns-gcp' },
      { ...marker, dns: { ...marker.dns, connectionScope: 'global' } }, { ...marker, preserved: [] }]) expect(dnsFixtureMarkerSchema.safeParse(invalid).success).toBe(false);
    expect(() => assertDnsFixtureTarget(marker, { profile: marker.profile, project: marker.project, internalProjectId: 'another', environment: marker.environment, internalEnvironmentId: marker.internalEnvironmentId, repository: marker.repository })).toThrow('exact prepared');
  });
  it('requires the selected zone to contain Google’s registrable ownership domain', () => {
    expect(dnsFixtureMarkerSchema.safeParse({ ...marker, hostname: 'app.fixture.example.com',
      dns: { ...marker.dns, zone: { ...marker.dns.zone, name: 'fixture.example.com' } },
      preserved: [{ ...marker.preserved[0], name: 'sentinel.fixture.example.com' }] }).success).toBe(false);
  });
  it('allows explicit current base-domain TXT adoption but never fixture traffic adoption', () => {
    const adopted = { id: 'zone1/base-txt', name: 'example.com', type: 'TXT', values: ['preexisting-owner'] };
    expect(dnsFixtureMarkerSchema.safeParse({ ...marker, dns: { ...marker.dns, adoptRecords: [adopted] } }).success).toBe(true);
    expect(dnsFixtureMarkerSchema.safeParse({ ...marker, dns: { ...marker.dns, adoptRecords: [{ ...adopted, name: marker.hostname }] } }).success).toBe(false);
  });
  it('permits ownership TXT at the registrable base without authorizing base traffic records', () => {
    const proof = { ...action, resource: { ...action.resource, name: 'example.com. TXT' } };
    expect(() => assertDnsFixtureActions([proof], marker, 'create')).not.toThrow();
    expect(() => assertDnsFixtureActions([{ ...proof, resource: { ...proof.resource, name: 'example.com. A' } }], marker, 'create')).toThrow();
  });
  it('checks every mutating continuation, rejecting service changes and cross-domain work', () => {
    expect(() => assertDnsFixtureActions([action], marker, 'create')).not.toThrow();
    for (const invalid of [{ ...action, resource: { ...action.resource, kind: 'service' } },
      { ...action, metadata: { ...action.metadata, domain: 'customer.example.com' } },
      { ...action, metadata: { ...action.metadata, operation: 'gcpDomainDns' } }]) expect(() => assertDnsFixtureActions([invalid], marker, 'create')).toThrow();
    expect(() => assertDnsFixtureActions([action], marker, 'update')).toThrow('TTL update');
    expect(() => assertDnsFixtureActions([{ ...action, type: 'update' }], marker, 'update')).not.toThrow();
  });
  it('rejects extra domain-engine addresses that could mutate the retained app', () => {
    const mapping = { id: 'domain:fixture.example.com', type: 'create', resource: { kind: 'domain', name: 'fixture.example.com', provider: 'gcp' }, metadata: { engineSegment: { addresses: ['google_cloud_run_domain_mapping.fixture'] } } };
    expect(() => assertDnsFixtureActions([mapping], marker, 'create')).not.toThrow();
    expect(() => assertDnsFixtureActions([{ ...mapping, metadata: { engineSegment: { addresses: [...mapping.metadata.engineSegment.addresses, 'google_cloud_run_v2_service.web'] } } }], marker, 'create')).toThrow();
  });
  it('does not infer absent records from an unknown provider read or from missing bindings', async () => {
    await expect(readDnsFixtureRecords(observer(async () => ({ status: 'unknown', reason: '403' })), marker)).rejects.toThrow('unknown');
    expect(() => assertDnsFixtureValues([], [row], 300)).toThrow();
    expect(() => assertDnsFixtureValues([owned], [{ ...row, nativeId: 'zone1/foreign' }], 300)).toThrow('differ');
    expect(() => dnsFixtureInventory([{ ...owned, name: 'customer.example.com' }], marker)).toThrow('outside');
  });
  it('requires native TTL/proxy convergence and exact identity correspondence', () => {
    expect(() => assertDnsFixtureValues([owned], [row], 300)).not.toThrow();
    expect(() => assertDnsFixtureValues([owned], [row], 600)).toThrow('TTL');
    expect(() => assertDnsFixtureValues([owned], [{ ...row, proxied: true }], 300)).toThrow('proxy');
  });
  it('preserves complete unrelated RRsets and refuses incomplete sentinel identity evidence', async () => {
    const sentinel = { ...row, nativeId: 'zone1/sentinel', name: 'sentinel.example.com', type: 'TXT' as const, values: ['first', 'second'] };
    const observed = await readDnsPreservedRecords(observer(async () => ({ status: 'present', value: [sentinel] })), marker);
    expect(() => assertDnsPreservedRecords(observed, [{ ...sentinel, values: ['second', 'first'] }])).not.toThrow();
    expect(() => assertDnsPreservedRecords(observed, [{ ...sentinel, values: ['first'] }])).toThrow('Unrelated');
    await expect(readDnsPreservedRecords(observer(async () => ({ status: 'absent' })), marker)).rejects.toThrow('preserved');
  });
  it('retains exact DNS identities and recovery state after an unknown cleanup read', async () => {
    const journal: FixtureJournal = { version: 1, profile: marker.profile, project: marker.project, environment: marker.environment,
      phase: 'cleanup-required', resources: dnsFixtureInventory([owned], marker), checks: { created: false, noop: false, updated: false, absent: false } };
    const converge = vi.fn(async () => {});
    await expect(runDisposableFixture({ journal, cleanupOnly: true, save: () => {}, driver: {
      inventory: async () => [], converge, assertNoop: async () => {}, verifyRunning: async () => {}, observe: async () => 'unknown',
    } })).rejects.toThrow('cleanup is unverified');
    expect(journal.phase).toBe('cleanup-required'); expect(journal.resources[0].id).toBe('zone1/r1'); expect(journal.checks.absent).toBe(false);
  });
  it('does not count a preserved-only base TXT RRset as an active fixture contribution', () => {
    expect(dnsFixtureInventory([{ ...owned, name: 'example.com', type: 'TXT', retainedOnly: true }], marker)).toEqual([]);
  });
  it('distinguishes explicitly retained RRsets from verified native absence during cleanup', async () => {
    const resource = { provider: 'cloudflare', type: 'TXT', id: 'zone1/base-txt', address: 'cloudflare_dns_record.proof' };
    const journal: FixtureJournal = { version: 1, profile: marker.profile, project: marker.project, environment: marker.environment,
      phase: 'cleanup-required', resources: [resource], checks: { created: true, noop: true, updated: true, absent: false } };
    await runDisposableFixture({ journal, cleanupOnly: true, retainedResources: [resource], save: () => {}, driver: {
      inventory: async () => [], converge: async () => {}, assertNoop: async () => {}, verifyRunning: async () => {}, observe: async () => 'retained',
    } });
    expect(journal).toMatchObject({ phase: 'cleaned', retainedResources: [resource], checks: { absent: true, retained: true } });
  });
  it('observes proof only at the registrable base and keeps traffic at the dedicated hostname', async () => {
    const read = vi.fn<DnsObserver['observeRecordSets']>(async () => ({ status: 'absent' }));
    await readDnsFixtureRecords(observer(read), marker);
    expect(read).toHaveBeenCalledWith('example.com', 'TXT');
    expect(read).toHaveBeenCalledWith('fixture.example.com', 'A');
    expect(read).not.toHaveBeenCalledWith('example.com', 'A');
  });
  it('requires an exact current adoption for an existing authoritative base TXT RRset', () => {
    const proof: DnsObservedRecord = { nativeId: 'projects/dns-project/managedZones/zone/rrsets/example.com./TXT', name: 'example.com.', type: 'TXT', values: ['original-owner'], ttl: 300 };
    const target: DnsFixtureMarker = { ...marker, profile: 'dns-gcp', dns: { provider: 'gcp', zone: { id: 'zone', name: 'example.com', projectId: 'dns-project' }, connectionScope: marker.repository } };
    expect(() => dnsFixtureProofBaseline([proof], target)).toThrow('dns.adoptRecords');
    target.dns.adoptRecords = [{ id: proof.nativeId, name: 'example.com', type: 'TXT', values: [...proof.values] }];
    expect(dnsFixtureProofBaseline([proof], target)).toEqual([proof]);
    expect(() => dnsFixtureProofBaseline([{ ...proof, values: ['changed-owner'] }], target)).toThrow('exact current');
    expect(() => dnsFixtureProofBaseline([proof, row], target)).toThrow('traffic adoption');
  });
  it('permits the adopted proof contribution while preserving original values and verifies its removal separately', () => {
    const proof: DnsObservedRecord = { ...row, nativeId: 'zone1/base-txt', name: 'example.com.', type: 'TXT', values: ['original-owner'], ttl: 300 };
    const target: DnsFixtureMarker = { ...marker, dns: { ...marker.dns, adoptRecords: [{ id: proof.nativeId, name: 'example.com', type: 'TXT', values: [...proof.values] }] } };
    const proofOwner: SafeDnsOwnedRecord = { ...owned, nativeId: proof.nativeId, name: proof.name, type: 'TXT' };
    const during = { ...proof, values: ['original-owner', 'fixture-proof'], ttl: 600 };
    expect(() => assertDnsProofPreserved([proof], [during], [proofOwner], target)).not.toThrow();
    expect(() => assertDnsProofPreserved([proof], [{ ...during, values: ['fixture-proof'] }], [proofOwner], target)).toThrow('original');
    expect(() => assertDnsProofPreserved([proof], [during], [proofOwner], target, true)).toThrow('cleanup');
    expect(() => assertDnsProofPreserved([proof], [{ ...proof, ttl: 600 }], [{ ...proofOwner, retainedOnly: true }], target, true)).not.toThrow();
    const resource = { provider: 'cloudflare', type: 'TXT', id: proof.nativeId, address: proofOwner.address };
    expect(dnsFixtureCleanupState(resource, [during], [proof])).toBe('unknown');
    expect(dnsFixtureCleanupState(resource, [], [proof])).toBe('unknown');
    expect(dnsFixtureCleanupState(resource, [{ ...proof, ttl: 600 }], [proof])).toBe('retained');
  });
  it('does not accept a retained cleanup result without exact pre-existing retention authority', async () => {
    const resource = { provider: 'cloudflare', type: 'TXT', id: 'zone1/unreviewed', address: 'cloudflare_dns_record.proof' };
    const journal: FixtureJournal = { version: 1, profile: marker.profile, project: marker.project, environment: marker.environment,
      phase: 'cleanup-required', resources: [resource], checks: { created: false, noop: false, updated: false, absent: false } };
    await expect(runDisposableFixture({ journal, cleanupOnly: true, save: () => {}, driver: {
      inventory: async () => [], converge: async () => {}, assertNoop: async () => {}, verifyRunning: async () => {}, observe: async () => 'retained',
    } })).rejects.toThrow('cleanup is unverified');
    expect(journal.phase).toBe('cleanup-required'); expect(journal.checks.absent).toBe(false);
  });
});
