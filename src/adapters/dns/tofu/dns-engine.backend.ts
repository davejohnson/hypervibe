import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { DnsEngineInput, DnsProvider, DnsRecordIntent, DnsRecordType, DnsZoneIdentity } from '../../../domain/ports/dns.port.js';
import type { EngineConfiguration, EngineResourceMapping, InfrastructureEngineBackend } from '../../../domain/ports/infrastructure-engine.port.js';
import { DNS_PROVIDER_REQUIREMENTS } from './provider-pins.js';

const PROVIDER_NAMES = { cloudflare: 'cloudflare', gcp: 'google', aws: 'aws', azure: 'azurerm' } as const;
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'CAA', 'MX'];
const literal = (value: string): string => value.replace(/\$\{/g, () => '$${').replace(/%\{/g, '%%{');
const unique = (values: string[]): string[] => [...new Set(values)].sort();
const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** Canonical DNS owner form; underscores are permitted for verification labels. */
export function dnsFqdn(name: string): string {
  const result = name.toLowerCase().replace(/\.$/, '');
  if (result.length > 253 || !result.split('.').every((label, i) => (i === 0 && label === '*') || /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) {
    throw new Error('DNS owner name is invalid.');
  }
  return `${result}.`;
}

function relativeName(zone: DnsZoneIdentity, name: string): string {
  const owner = dnsFqdn(name);
  const suffix = dnsFqdn(zone.zoneName);
  if (owner === suffix) return '@';
  if (!owner.endsWith(`.${suffix}`)) throw new Error('DNS record does not belong to the exact selected zone.');
  return owner.slice(0, -(suffix.length + 1));
}

function validateZone(zone: DnsZoneIdentity): void {
  dnsFqdn(zone.zoneName);
  if (zone.zoneName.startsWith('*')) throw new Error('A DNS zone cannot be a wildcard.');
  const scope = zone.scope;
  switch (zone.provider) {
    case 'cloudflare':
      if (!/^[a-f0-9]{32}$/.test(zone.zoneId) || !/^[a-f0-9]{32}$/.test(scope.accountId ?? '')) throw new Error('Cloudflare DNS needs exact zone and account identities.');
      break;
    case 'gcp':
      if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(zone.zoneId) || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(scope.projectId ?? '')) throw new Error('Cloud DNS needs an exact managed-zone name and project identity.');
      break;
    case 'aws':
      if (!/^Z[A-Z0-9]+$/.test(zone.zoneId) || !/^\d{12}$/.test(scope.accountId ?? '')) throw new Error('Route 53 needs exact zone and account identities.');
      break;
    case 'azure': {
      if (!/^[a-f0-9-]{36}$/i.test(scope.subscriptionId ?? '') || !/^[\w().-]{1,90}$/.test(scope.resourceGroup ?? '')) throw new Error('Azure DNS needs exact subscription and resource-group identities.');
      const expected = `/subscriptions/${scope.subscriptionId}/resourceGroups/${scope.resourceGroup}/providers/Microsoft.Network/dnsZones/${dnsFqdn(zone.zoneName).slice(0, -1)}`;
      if (zone.zoneId.toLowerCase() !== expected.toLowerCase()) throw new Error('Azure DNS zone identity does not match its exact scope.');
      break;
    }
    default: throw new Error('DNS provider is not implemented.');
  }
}

/** Provider import identity, never a name-only ownership claim. */
export function dnsRecordNativeId(zone: DnsZoneIdentity, name: string, type: DnsRecordType, cloudflareRecordId?: string): string {
  validateZone(zone);
  const relative = relativeName(zone, name);
  const owner = dnsFqdn(name);
  switch (zone.provider) {
    case 'cloudflare':
      if (!/^[a-f0-9]{32}$/.test(cloudflareRecordId ?? '')) throw new Error('Cloudflare DNS requires the exact native record identity.');
      return `${zone.zoneId}/${cloudflareRecordId}`;
    case 'gcp': return `projects/${zone.scope.projectId}/managedZones/${zone.zoneId}/rrsets/${owner}/${type}`;
    case 'aws': return `${zone.zoneId}_${owner.slice(0, -1)}_${type}`;
    case 'azure': return `${zone.zoneId}/${type}/${relative}`;
  }
}

function resourceType(zone: DnsZoneIdentity, type: DnsRecordType): string {
  switch (zone.provider) {
    case 'cloudflare': return 'cloudflare_dns_record';
    case 'gcp': return 'google_dns_record_set';
    case 'aws': return 'aws_route53_record';
    case 'azure': return `azurerm_dns_${type.toLowerCase()}_record`;
  }
}

/** RRset addresses group siblings; Cloudflare addresses follow stable logical keys. */
export function dnsRecordAddress(zone: DnsZoneIdentity, record: DnsRecordIntent): string {
  const identity = JSON.stringify([zone.provider, zone.zoneId, zone.scope.accountId, zone.scope.projectId, zone.scope.subscriptionId, zone.scope.resourceGroup, dnsFqdn(record.name), record.type, zone.provider === 'cloudflare' ? record.key : null]);
  return `${resourceType(zone, record.type)}.record_${hash(identity)}`;
}

function caa(value: string): { flags: number; tag: string; value: string } {
  const parsed = /^(\d{1,3})\s+([a-zA-Z0-9]+)\s+"([^"\r\n]*)"$/.exec(value);
  if (!parsed || Number(parsed[1]) > 255) throw new Error('CAA value must be canonical flags, tag and quoted value.');
  return { flags: Number(parsed[1]), tag: parsed[2]!, value: parsed[3]! };
}

function mx(value: string): { preference: number; exchange: string } {
  const parsed = /^(\d{1,5})\s+(\S+)$/.exec(value);
  if (!parsed || Number(parsed[1]) > 65535) throw new Error('MX value must contain a preference from 0 to 65535 and an exchange hostname.');
  return { preference: Number(parsed[1]), exchange: parsed[2] === '.' ? '.' : dnsFqdn(parsed[2]!) };
}

function validateRecord(zone: DnsZoneIdentity, record: DnsRecordIntent): void {
  relativeName(zone, record.name);
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(record.key)) throw new Error('DNS record key is invalid.');
  if (!RECORD_TYPES.includes(record.type)) throw new Error('DNS record type is not implemented.');
  if (!Number.isInteger(record.ttl) || record.ttl < 1 || record.ttl > 2_147_483_647) throw new Error('DNS record TTL is invalid.');
  if (zone.provider === 'cloudflare' && record.ttl !== 1 && (record.ttl < 60 || record.ttl > 86400)) throw new Error('Cloudflare DNS TTL must be automatic (1) or between 60 and 86400 seconds.');
  if (record.proxied && (zone.provider !== 'cloudflare' || !['A', 'AAAA', 'CNAME'].includes(record.type))) throw new Error('Proxying is unavailable for this DNS provider or record type.');
  if (record.proxied && record.ttl !== 1) throw new Error('Proxied Cloudflare records require automatic TTL (1).');
  if (!record.authority || !['absent', 'managed', 'adopt'].includes(record.authority.kind)) throw new Error('DNS record requires explicit observed ownership authority.');
  if (!record.values.length || (zone.provider === 'cloudflare' && record.values.length !== 1)) throw new Error('Cloudflare records need one value per stable key; RRsets need at least one value.');
  const values = [...record.values, ...(record.authority.kind === 'absent' ? [] : record.authority.preserveValues)];
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('DNS record value is invalid.');
    if ((record.type === 'A' && isIP(value) !== 4) || (record.type === 'AAAA' && isIP(value) !== 6)) throw new Error('DNS address value is invalid.');
    if (record.type === 'CNAME') dnsFqdn(value);
    if (record.type === 'CAA') caa(value);
    if (record.type === 'MX') mx(value);
  }
  if (record.authority.kind !== 'absent') {
    const authority = record.authority;
    const expected = dnsRecordNativeId(zone, record.name, record.type, zone.provider === 'cloudflare' ? authority.nativeId.split('/')[1] : undefined);
    if (authority.nativeId !== expected) throw new Error('DNS record native identity does not match the selected scope.');
    if (zone.provider === 'cloudflare' && authority.preserveValues.length) throw new Error('Cloudflare record authority cannot adopt sibling records.');
    if (authority.kind === 'adopt' && authority.existingValues.some(value => !values.includes(value))) throw new Error('DNS adoption must preserve every existing value. Plan later removal separately.');
  }
  if (record.type === 'CNAME' && unique(values).length !== 1) throw new Error('CNAME RRsets must contain exactly one target.');
}

function providerConfiguration(zone: DnsZoneIdentity): Record<string, unknown> {
  switch (zone.provider) {
    case 'cloudflare': return { cloudflare: [{}] };
    case 'gcp': return { google: [{ project: zone.scope.projectId }] };
    case 'aws': return { aws: [{ region: 'us-east-1', allowed_account_ids: [zone.scope.accountId] }] };
    // Auto-registration would be an unplanned infrastructure write during init/plan.
    case 'azure': return { azurerm: [{ features: [{}], subscription_id: zone.scope.subscriptionId, resource_provider_registrations: 'none' }] };
  }
}

/** Quote and split TXT RDATA into DNS character strings of at most 255 UTF-8 bytes. */
export function dnsTxtRdata(value: string): string {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 255) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  chunks.push(chunk);
  return chunks.map(part => `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ');
}

function recordConfiguration(zone: DnsZoneIdentity, record: DnsRecordIntent, values: string[]): Record<string, unknown> {
  const name = dnsFqdn(record.name);
  const rdata = values.map(value => record.type === 'TXT' ? dnsTxtRdata(value) : record.type === 'CNAME' ? dnsFqdn(value)
    : record.type === 'MX' ? `${mx(value).preference} ${mx(value).exchange}` : value).map(literal);
  switch (zone.provider) {
    case 'cloudflare': return {
      zone_id: zone.zoneId, name: name.slice(0, -1), type: record.type, ttl: record.ttl,
      ...(record.type === 'CAA' ? { data: { ...caa(values[0]!), value: literal(caa(values[0]!).value) } }
        : record.type === 'MX' ? { priority: mx(values[0]!).preference, content: mx(values[0]!).exchange }
          : { content: literal(values[0]!) }),
      ...(['A', 'AAAA', 'CNAME'].includes(record.type) ? { proxied: record.proxied ?? false } : {}),
    };
    case 'gcp': return { project: zone.scope.projectId, managed_zone: zone.zoneId, name, type: record.type, ttl: record.ttl, rrdatas: rdata };
    case 'aws': return { zone_id: zone.zoneId, name: name.slice(0, -1), type: record.type, ttl: record.ttl, records: rdata, allow_overwrite: false };
    case 'azure': return {
      name: relativeName(zone, record.name), zone_name: dnsFqdn(zone.zoneName).slice(0, -1), resource_group_name: zone.scope.resourceGroup, ttl: record.ttl,
      ...(record.type === 'TXT' ? { record: values.map(value => ({ value: literal(value) })) }
        : record.type === 'CAA' ? { record: values.map(value => ({ ...caa(value), value: literal(caa(value).value) })) }
          : record.type === 'MX' ? { record: values.map(mx) }
          : record.type === 'CNAME' ? { record: dnsFqdn(values[0]!).slice(0, -1) }
            : { records: values }),
    };
  }
}

/** Pure configuration for existing scoped zones. It never creates zones or changes DNSSEC. */
export function buildDnsConfiguration(input: DnsEngineInput): EngineConfiguration {
  validateZone(input.zone);
  const resources: Record<string, EngineResourceMapping> = {};
  const imports: Record<string, string> = {};
  const resource: Record<string, Record<string, unknown>> = {};
  const groups = new Map<string, DnsRecordIntent[]>();
  const keys = new Set<string>();
  for (const record of input.records) {
    validateRecord(input.zone, record);
    if (keys.has(record.key)) throw new Error('Duplicate DNS record logical key.');
    keys.add(record.key);
    const address = dnsRecordAddress(input.zone, record);
    groups.set(address, [...groups.get(address) ?? [], record]);
  }
  for (const record of input.records.filter(item => item.type === 'CNAME')) {
    if (input.records.some(item => item !== record && dnsFqdn(item.name) === dnsFqdn(record.name) && (item.type !== 'CNAME' || item.values[0] !== record.values[0]))) throw new Error('CNAME cannot coexist with sibling record types or targets.');
  }
  for (const [address, records] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = records[0]!;
    if (records.some(item => item.ttl !== first.ttl)) throw new Error('Grouped DNS RRset records must share a TTL.');
    if (records.some(item => JSON.stringify(item.authority) !== JSON.stringify(first.authority))) throw new Error('Grouped DNS RRset records must share exact ownership authority.');
    const preserved = first.authority.kind === 'absent' ? [] : first.authority.preserveValues;
    const values = unique([...records.flatMap(item => item.values), ...preserved]);
    const [type, key] = address.split('.') as [string, string];
    (resource[type] ??= {})[key] = recordConfiguration(input.zone, first, values);
    resources[address] = { actionId: `dns:${address}`, kind: 'domain', name: `${dnsFqdn(first.name)} ${first.type}`, dataBearing: true };
    if (first.authority.kind === 'adopt') imports[address] = first.authority.nativeId;
  }
  for (const retired of input.retiredRecords ?? []) {
    validateRecord(input.zone, retired);
    if (retired.authority.kind !== 'managed') throw new Error('Retiring DNS records requires exact managed authority.');
    const address = dnsRecordAddress(input.zone, retired);
    const preserved = unique(retired.authority.preserveValues);
    const remaining = groups.get(address);
    if (remaining) {
      const declared = remaining.flatMap(record => [...record.values, ...(record.authority.kind === 'absent' ? [] : record.authority.preserveValues)]);
      if (preserved.some(value => !declared.includes(value))) throw new Error('DNS retirement must preserve adopted sibling values.');
      continue;
    }
    resources[address] = { actionId: `dns:${address}`, kind: 'domain', name: `${dnsFqdn(retired.name)} ${retired.type}${preserved.length ? ' (retain shared record set)' : ''}`, dataBearing: true };
    if (preserved.length) {
      const [type, key] = address.split('.') as [string, string];
      (resource[type] ??= {})[key] = recordConfiguration(input.zone, retired, preserved);
    }
  }
  return {
    files: {
      'dns.tf.json': { provider: providerConfiguration(input.zone), resource },
      ...(Object.keys(imports).length ? { 'imports.tf.json': { import: Object.entries(imports).map(([to, id]) => ({ to, id: literal(id) })) } } : {}),
    },
    resources,
    ...(Object.keys(imports).length ? { imports } : {}),
  };
}

/** Scoped read-only probe; applications also compare the observed native zone identity. */
export function buildDnsAuthenticationProbe(zone: DnsZoneIdentity): EngineConfiguration {
  validateZone(zone);
  const type = { cloudflare: 'cloudflare_zone', gcp: 'google_dns_managed_zone', aws: 'aws_route53_zone', azure: 'azurerm_dns_zone' }[zone.provider];
  const args = zone.provider === 'gcp' ? { project: zone.scope.projectId, name: zone.zoneId }
    : zone.provider === 'azure' ? { name: dnsFqdn(zone.zoneName).slice(0, -1), resource_group_name: zone.scope.resourceGroup }
      : { zone_id: zone.zoneId };
  return { files: { 'dns-probe.tf.json': { provider: providerConfiguration(zone), data: { [type]: { zone: args } }, output: { zone_id: { value: `\${data.${type}.zone.id}` } } } }, resources: {} };
}

export function dnsEngineBackend(providerOrZone: DnsProvider | DnsZoneIdentity): InfrastructureEngineBackend<DnsEngineInput> {
  const provider = typeof providerOrZone === 'string' ? providerOrZone : providerOrZone.provider;
  const name = PROVIDER_NAMES[provider];
  if (!name) throw new Error('DNS provider is not implemented.');
  return {
    provider: `dns-${provider}`, engine: 'opentofu', capabilities: ['dns'],
    providerRequirements: { [name]: DNS_PROVIDER_REQUIREMENTS[name]! },
    buildConfiguration: input => {
      if (input.zone.provider !== provider) throw new Error('DNS backend does not match the selected provider.');
      return buildDnsConfiguration(input);
    },
    buildAuthenticationProbe: () => {
      if (typeof providerOrZone === 'string') throw new Error('DNS authentication needs an exact zone identity; use dnsEngineBackend(zone).');
      return buildDnsAuthenticationProbe(providerOrZone);
    },
  };
}
