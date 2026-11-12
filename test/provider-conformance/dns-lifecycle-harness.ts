import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { dnsHostnameBelongsToZone, dnsHostnameSchema, dnsSpecSchema } from '../../src/domain/spec/dns.schema.js';
import type { DnsObservedRecord, DnsRecordType, DnsZoneIdentity } from '../../src/domain/ports/dns.port.js';
import type { DnsObserver } from '../../src/adapters/dns-observation/http-observer.js';
import { dnsName } from '../../src/adapters/dns-observation/http-observer.js';
import type { NativeFixtureResource } from './lifecycle-live-harness.js';
import { dnsZoneScopeForDomain } from '../../src/domain/services/domain-scope.js';

const recordType = z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'CAA', 'MX']);
export const dnsFixtureMarkerSchema = z.object({
  version: z.literal(1), purpose: z.literal('disposable-dns-conformance'),
  profile: z.enum(['dns-cloudflare', 'dns-gcp', 'dns-aws', 'dns-azure']),
  project: z.string().min(1), internalProjectId: z.string().min(1), environment: z.string().min(1), internalEnvironmentId: z.string().min(1),
  repository: z.string().min(1), hostname: dnsHostnameSchema, expectedRevision: z.string().min(1),
  dns: dnsSpecSchema,
  /** Existing records at a different name prove shared-zone preservation; no sentinel is created by the harness. */
  preserved: z.array(z.object({ name: dnsHostnameSchema, type: recordType, nativeIds: z.array(z.string().min(1)).min(1) }).strict()).min(1).max(20),
}).strict().superRefine((value, context) => {
  if (value.profile !== `dns-${value.dns.provider}` || !dnsHostnameBelongsToZone(value.hostname, value.dns.zone.name)
    || value.hostname === value.dns.zone.name) context.addIssue({ code: 'custom', message: 'Use an exact dedicated subdomain in this profile’s zone.' });
  const proofName = dnsZoneScopeForDomain(value.hostname);
  if (!dnsHostnameBelongsToZone(proofName, value.dns.zone.name)) context.addIssue({ code: 'custom', message: 'The selected zone must contain the registrable ownership domain.' });
  if (value.dns.adoptRecords?.some(record => dnsName(record.name) !== proofName || record.type !== 'TXT'))
    context.addIssue({ code: 'custom', message: 'Only exact current base-domain TXT records may be adopted; fixture traffic must start absent.' });
  if (value.dns.policy?.proxy === 'on' || value.dns.policy?.exposure === 'private') context.addIssue({ code: 'custom', message: 'The fixture requires direct public DNS and HTTPS.' });
  if (!value.dns.connectionScope || value.dns.connectionScope === 'global') context.addIssue({ code: 'custom', message: 'Select an exact verified fixture connection scope.' });
  if (value.preserved.some(record => !dnsHostnameBelongsToZone(record.name, value.dns.zone.name) || record.name === value.hostname
    || record.name.endsWith(`.${value.hostname}`) || record.name === proofName && record.type === 'TXT'))
    context.addIssue({ code: 'custom', message: 'Preserved sentinels must be outside the fixture hostname and base-domain TXT proof records.' });
});
export type DnsFixtureMarker = z.infer<typeof dnsFixtureMarkerSchema>;
export const DNS_FIXTURE_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'TXT', 'CAA', 'MX'];
export function dnsFixtureProofName(marker: DnsFixtureMarker): string { return dnsZoneScopeForDomain(marker.hostname); }
function allowedRecord(name: string, type: string, marker: DnsFixtureMarker): boolean {
  return DNS_FIXTURE_TYPES.includes(type as DnsRecordType)
    && (dnsName(name) === marker.hostname || dnsName(name) === dnsFixtureProofName(marker) && type === 'TXT');
}

export function dnsFixtureZone(marker: DnsFixtureMarker): DnsZoneIdentity {
  const { id, name, ...scope } = marker.dns.zone;
  return { provider: marker.dns.provider, zoneId: id, zoneName: name, scope };
}

export function assertDnsFixtureTarget(marker: DnsFixtureMarker, actual: {
  profile: string; project: string; internalProjectId: string; environment: string; internalEnvironmentId: string; repository: string;
}): void {
  for (const [key, value] of Object.entries(actual)) if (!value || marker[key as keyof DnsFixtureMarker] !== value) throw new Error('The DNS marker does not match the exact prepared project, environment and repository.');
}

/** Every non-noop action is checked before every apply, including continuation and cleanup. */
export function assertDnsFixtureActions(actions: Array<Record<string, any>>, marker: DnsFixtureMarker, stage: 'create' | 'update' | 'absent'): void {
  for (const action of actions) {
    if (action.type === 'noop') continue;
    if (action.resource?.kind !== 'domain' || !action.metadata) throw new Error('The DNS fixture cannot change app, project, service, secret or shared infrastructure.');
    const metadata = action.metadata;
    if (metadata.operation === 'dnsOwnershipReconcile' || metadata.operation === 'gcpDomainForget') {
      const provider = metadata.operation === 'dnsOwnershipReconcile' ? `dns-${marker.dns.provider}` : 'gcp';
      if (action.type !== 'update' || action.resource.provider !== provider || action.resource.name !== marker.hostname
        || metadata.domain !== marker.hostname || metadata.engineSegment
        || metadata.operation === 'gcpDomainForget' && stage !== 'absent') throw new Error('The DNS observation stage is outside this exact fixture.');
      continue;
    }
    if (metadata.operation === 'dnsEngine') {
      const [selectedName = '', selectedType = ''] = typeof action.resource.name === 'string' ? action.resource.name.split(' ') : [];
      const allowed = marker.dns.provider === 'cloudflare' ? /^cloudflare_dns_record\./ : marker.dns.provider === 'gcp' ? /^google_dns_record_set\./
        : marker.dns.provider === 'aws' ? /^aws_route53_record\./ : /^azurerm_dns_(?:a|aaaa|cname|txt|caa|mx)_record\./;
      if (action.resource.provider !== `dns-${marker.dns.provider}` || !metadata.engineSegment?.id
        || metadata.domain !== marker.hostname || !allowedRecord(selectedName, selectedType, marker)
        || !Array.isArray(metadata.engineSegment.addresses) || !metadata.engineSegment.addresses.length
        || metadata.engineSegment.addresses.some((address: unknown) => typeof address !== 'string' || !allowed.test(address)))
        throw new Error('The DNS engine action is outside this exact fixture target.');
      if (stage === 'update' && !['update', 'noop'].includes(action.type)) throw new Error('The TTL update cannot create, replace, adopt or delete another DNS record.');
      continue;
    }
    if (['gcpDomainVerify', 'gcpDomainReady'].includes(metadata.operation)) {
      if (marker.hostname !== metadata.domain || action.resource.provider !== 'gcp' || stage === 'absent') throw new Error('The domain operation is outside this fixture.');
      continue;
    }
    const segment = metadata.engineSegment;
    if (action.resource.provider === 'gcp' && action.id === `domain:${marker.hostname}` && action.resource.name === marker.hostname
      && Array.isArray(segment?.addresses) && segment.addresses.length === 1
      && /^google_cloud_run_domain_mapping\.[a-zA-Z0-9_]+$/.test(segment.addresses[0])) continue;
    throw new Error('The DNS fixture contains an unreviewed domain operation.');
  }
}

export interface SafeDnsOwnedRecord { nativeId: string; name: string; type: DnsRecordType; address: string; owner: string; retainedOnly?: true }
export function dnsFixtureInventory(records: SafeDnsOwnedRecord[], marker: DnsFixtureMarker): NativeFixtureResource[] {
  return records.flatMap(record => {
    if (!allowedRecord(record.name, record.type, marker) || !DNS_FIXTURE_TYPES.includes(record.type) || !record.nativeId || !record.address)
      throw new Error('Owned DNS inventory is outside the exact fixture hostname.');
    return record.retainedOnly ? [] : [{ provider: marker.dns.provider, type: record.type, id: record.nativeId, address: record.address }];
  });
}

export async function readDnsFixtureRecords(observer: DnsObserver, marker: DnsFixtureMarker): Promise<DnsObservedRecord[]> {
  const result: DnsObservedRecord[] = [];
  const targets: Array<[string, DnsRecordType]> = DNS_FIXTURE_TYPES.map(type => [marker.hostname, type]);
  if (dnsFixtureProofName(marker) !== marker.hostname) targets.push([dnsFixtureProofName(marker), 'TXT']);
  for (const [name, type] of targets) {
    const observation = await observer.observeRecordSets(name, type);
    if (observation.status === 'unknown') throw new Error('The fixture DNS inventory is unknown; preserve its recovery state.');
    if (observation.status === 'present') result.push(...observation.value);
  }
  return result;
}

/** Validate explicit adoption against a complete base-domain observation before any plan. */
export function dnsFixtureProofBaseline(observed: DnsObservedRecord[], marker: DnsFixtureMarker): DnsObservedRecord[] {
  if (observed.some(record => dnsName(record.name) === marker.hostname)) throw new Error('The exact fixture hostname already has records; traffic adoption is not authorized.');
  const proof = observed.filter(record => dnsName(record.name) === dnsFixtureProofName(marker) && record.type === 'TXT');
  const adoptions = marker.dns.adoptRecords ?? [];
  for (const selected of adoptions) {
    const exact = proof.find(record => record.nativeId === selected.id);
    if (!exact || !isDeepStrictEqual([...exact.values].sort(), [...selected.values].sort())) throw new Error('The selected base-domain TXT adoption does not match its exact current native identity and values.');
  }
  if (marker.dns.provider !== 'cloudflare' && proof.some(record => !adoptions.some(selected => selected.id === record.nativeId)))
    throw new Error('Existing authoritative base-domain TXT needs exact dns.adoptRecords before this fixture.');
  return proof;
}

/** Adopted TXT may gain the fixture contribution; every original value remains private and preserved. */
export function assertDnsProofPreserved(initial: DnsObservedRecord[], current: DnsObservedRecord[], owned: SafeDnsOwnedRecord[], marker: DnsFixtureMarker, final = false): void {
  for (const baseline of initial) {
    const present = current.find(record => record.nativeId === baseline.nativeId);
    if (!present || dnsName(present.name) !== dnsName(baseline.name) || present.type !== baseline.type) throw new Error('An original base-domain TXT identity is missing or changed.');
    const adopted = marker.dns.adoptRecords?.some(record => record.id === baseline.nativeId);
    const active = owned.some(record => record.nativeId === baseline.nativeId && !record.retainedOnly);
    if (!adopted || final || !active) {
      if (!isDeepStrictEqual([...present.values].sort(), [...baseline.values].sort())) throw new Error('Base-domain TXT cleanup or preservation is unverified.');
    } else if (baseline.values.some(value => !present.values.includes(value))) throw new Error('An original base-domain TXT value was removed.');
    if (!adopted && (present.ttl !== baseline.ttl || present.proxied !== baseline.proxied)) throw new Error('Unrelated base-domain TXT settings changed.');
  }
}

/** A retained RRset is never labelled absent: its original values must be exact. */
export function dnsFixtureCleanupState(resource: NativeFixtureResource, observed: DnsObservedRecord[], baseline: DnsObservedRecord[]): 'absent' | 'present' | 'retained' | 'unknown' {
  const original = baseline.find(record => record.nativeId === resource.id && record.type === resource.type);
  const current = observed.find(record => record.nativeId === resource.id && record.type === resource.type);
  if (original) return current && dnsName(current.name) === dnsName(original.name)
    && isDeepStrictEqual([...current.values].sort(), [...original.values].sort()) ? 'retained' : 'unknown';
  return current ? 'present' : 'absent';
}

/** Full provider-native values are kept only inside the private encrypted baseline. */
export async function readDnsPreservedRecords(observer: DnsObserver, marker: DnsFixtureMarker): Promise<DnsObservedRecord[]> {
  const result: DnsObservedRecord[] = [];
  for (const entry of marker.preserved) {
    const observation = await observer.observeRecordSets(entry.name, entry.type);
    if (observation.status !== 'present' || !isDeepStrictEqual([...entry.nativeIds].sort(), observation.value.map(record => record.nativeId).sort()))
      throw new Error('The exact preserved DNS records could not be confirmed.');
    result.push(...observation.value);
  }
  return result.sort((a, b) => a.nativeId.localeCompare(b.nativeId));
}

export function assertDnsPreservedRecords(initial: DnsObservedRecord[], current: DnsObservedRecord[]): void {
  const canonical = (rows: DnsObservedRecord[]) => rows.map(row => ({ ...row, name: dnsName(row.name), values: [...row.values].sort() })).sort((a, b) => a.nativeId.localeCompare(b.nativeId));
  if (!isDeepStrictEqual(canonical(initial), canonical(current))) throw new Error('Unrelated DNS records changed. Preserve the fixture journal and stop.');
}

export function assertDnsFixtureValues(owned: SafeDnsOwnedRecord[], observed: DnsObservedRecord[], expectedTtl: number, baselineProof: DnsObservedRecord[] = []): void {
  owned = owned.filter(record => !record.retainedOnly);
  if (!owned.length || !observed.length || new Set(owned.map(record => record.nativeId)).size !== owned.length) throw new Error('The fixture has no complete, unique owned DNS identities.');
  if (observed.some(record => !owned.some(item => item.nativeId === record.nativeId) && !baselineProof.some(item => item.nativeId === record.nativeId)) || owned.some(record => !observed.some(item => item.nativeId === record.nativeId)))
    throw new Error('Live DNS and the owned native inventory differ.');
  if (observed.some(record => !record.values.length || (['A', 'AAAA', 'CNAME'].includes(record.type) && record.ttl !== expectedTtl) || record.proxied === true)) throw new Error('The fixture DNS values, TTL or proxy state did not converge.');
  if (!observed.some(record => ['A', 'AAAA', 'CNAME'].includes(record.type))) throw new Error('The fixture has no native traffic records.');
}
