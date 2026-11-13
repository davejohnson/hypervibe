import type { DnsObservation, DnsObservedRecord, DnsRecordType, DnsZoneIdentity, DnsZoneObservation } from '../../domain/ports/dns.port.js';

export interface DnsObserver {
  observeZone(): Promise<DnsObservation<DnsZoneObservation>>;
  observeRecordSets(name: string, type: DnsRecordType): Promise<DnsObservation<DnsObservedRecord[]>>;
}

type Json = Record<string, unknown>;
const PAGE_CAP = 100;
export const dnsName = (name: string) => name.toLowerCase().replace(/\.$/, '');
export function unknown(reason = 'DNS provider observation failed.'): DnsObservation<never> { return { status: 'unknown', reason }; }
export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider object.');
  return value as Json;
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Invalid provider values.');
  return value as string[];
}
export function ttl(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error('Invalid DNS TTL.');
  return Number(value);
}
export function textValue(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid provider identity.');
  return value;
}
/** TXT chunks are DNS quoted character strings; concatenate, preserving escapes. */
export function txtContent(value: string): string {
  const chunks = value.match(/"(?:[^"\\]|\\.)*"/g);
  if (!chunks || chunks.join(' ') !== value.trim()) throw new Error('Unsupported TXT encoding.');
  return chunks.map(chunk => JSON.parse(chunk) as string).join('');
}
export function validateRecordOwner(zone: DnsZoneIdentity, name: string): boolean {
  const normalized = dnsName(name); const suffix = dnsName(zone.zoneName);
  return normalized === suffix || normalized.endsWith(`.${suffix}`);
}
export function azureZonePath(zone: DnsZoneIdentity): string {
  return `/subscriptions/${zone.scope.subscriptionId}/resourceGroups/${zone.scope.resourceGroup}/providers/Microsoft.Network/dnsZones/${dnsName(zone.zoneName)}`;
}
class HttpFailure extends Error { constructor(readonly status: number) { super('DNS provider request failed.'); } }

/** These clients have no write methods. Unknown/malformed/incomplete reads never mean absence. */
export class HttpDnsObserver implements DnsObserver {
  constructor(readonly zone: DnsZoneIdentity, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private base(): string {
    const zone = this.zone;
    if (zone.provider === 'cloudflare') return `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone.zoneId)}`;
    if (zone.provider === 'gcp') return `https://dns.googleapis.com/dns/v1/projects/${encodeURIComponent(zone.scope.projectId!)}/managedZones/${encodeURIComponent(zone.zoneId)}`;
    return `https://management.azure.com${azureZonePath(zone)}`;
  }
  private async get(url: string): Promise<Json> {
    const response = await this.fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } });
    if (!response.ok) throw new HttpFailure(response.status);
    // Bound potentially secret-bearing provider diagnostics; never expose a rejected body.
    const reader = response.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    if (!reader) throw new Error('Missing DNS provider body.');
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('DNS provider body exceeded limit.'); }
      chunks.push(next.value);
    }
    const parsed = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (this.zone.provider === 'cloudflare' && parsed.success !== true) throw new Error('Cloudflare did not confirm the read.');
    return parsed;
  }

  async observeZone(): Promise<DnsObservation<DnsZoneObservation>> {
    try {
      const zone = this.zone; const base = this.base();
      const data = await this.get(base + (zone.provider === 'azure' ? '?api-version=2018-05-01' : ''));
      let visibility: DnsZoneObservation['visibility'] = 'unknown';
      let dnssec: DnsZoneObservation['dnssec'] = 'unknown'; let nameservers: string[] = [];
      let providerNativeId: string;
      if (zone.provider === 'cloudflare') {
        const result = object(data.result);
        if (result.id !== zone.zoneId || dnsName(textValue(result.name)) !== dnsName(zone.zoneName)
          || object(result.account).id !== zone.scope.accountId) return unknown('DNS zone identity or account differs from the selected zone.');
        providerNativeId = textValue(result.id); visibility = 'public';
        nameservers = strings(result.name_servers ?? []);
        try {
          const status = object((await this.get(`${base}/dnssec`)).result).status;
          dnssec = status === 'active' ? 'enabled' : status === 'disabled' ? 'disabled' : 'unknown';
        } catch { /* DNSSEC may require additional read permission. */ }
      } else if (zone.provider === 'gcp') {
        if (data.name !== zone.zoneId || dnsName(textValue(data.dnsName)) !== dnsName(zone.zoneName)) return unknown('DNS zone identity differs from the selected zone.');
        providerNativeId = textValue(data.id);
        visibility = data.visibility === 'public' || data.visibility === 'private' ? data.visibility : 'unknown';
        nameservers = strings(data.nameServers ?? []);
        const state = data.dnssecConfig ? object(data.dnssecConfig).state : undefined;
        dnssec = state === 'on' ? 'enabled' : state === 'off' ? 'disabled' : 'unknown';
      } else {
        const id = textValue(data.id); const expected = azureZonePath(zone);
        if (id.toLowerCase() !== expected.toLowerCase() || zone.zoneId.toLowerCase() !== expected.toLowerCase()
          || dnsName(textValue(data.name)) !== dnsName(zone.zoneName)) return unknown('DNS zone identity or subscription differs from the selected zone.');
        providerNativeId = id;
        const properties = object(data.properties);
        visibility = properties.zoneType === 'Public' ? 'public' : properties.zoneType === 'Private' ? 'private' : 'unknown';
        nameservers = strings(properties.nameServers ?? []);
        // The 2018-05-01 public DNS zone API does not establish DNSSEC status.
      }
      return { status: 'present', value: { identity: zone, providerNativeId, visibility, dnssec, nameservers,
        ...(typeof data.etag === 'string' ? { etag: data.etag } : {}) } };
    } catch (error) { return error instanceof HttpFailure && error.status === 404 ? { status: 'absent' } : unknown(); }
  }

  async observeRecordSets(name: string, type: DnsRecordType): Promise<DnsObservation<DnsObservedRecord[]>> {
    if (!validateRecordOwner(this.zone, name)) return unknown('DNS record is outside the selected zone.');
    const zoneObservation = await this.observeZone();
    if (zoneObservation.status !== 'present') return unknown('DNS zone could not be confirmed before reading records.');
    try {
      const records: DnsObservedRecord[] = []; const seen = new Set<string>();
      const zone = this.zone; const base = this.base(); const fqdn = `${dnsName(name)}.`;
      let page = 1; let next: string | undefined; let expectedCount: number | undefined;
      let url = zone.provider === 'cloudflare' ? `${base}/dns_records?name=${encodeURIComponent(dnsName(name))}&type=${type}&per_page=100&page=1`
        : zone.provider === 'gcp' ? `${base}/rrsets?name=${encodeURIComponent(fqdn)}&type=${type}&maxResults=100`
          : `${base}/${type}?api-version=2018-05-01`;
      for (;;) {
        if (seen.has(url) || page > PAGE_CAP) throw new Error('Incomplete DNS pagination.');
        seen.add(url); const data = await this.get(url);
        if (zone.provider === 'gcp' && data.rrsets === undefined && data.kind !== 'dns#resourceRecordSetsListResponse') throw new Error('Missing Google collection identity.');
        const items = zone.provider === 'cloudflare' ? data.result : zone.provider === 'gcp' ? data.rrsets ?? [] : data.value;
        if (!Array.isArray(items)) throw new Error('Invalid DNS record list.');
        for (const item of items) {
          const row = object(item);
          if (zone.provider === 'cloudflare') {
            if (dnsName(textValue(row.name)) !== dnsName(name) || row.type !== type) throw new Error('DNS filter identity mismatch.');
            const value = type === 'MX' ? (() => {
              if (!Number.isInteger(row.priority) || Number(row.priority) < 0 || Number(row.priority) > 65535) throw new Error('Invalid MX preference.');
              return `${row.priority} ${textValue(row.content)}`;
            })() : type === 'CAA' ? (() => { const caa = object(row.data);
              if (!Number.isInteger(caa.flags) || Number(caa.flags) < 0 || Number(caa.flags) > 255) throw new Error('Invalid CAA flags.');
              return `${caa.flags} ${textValue(caa.tag)} ${JSON.stringify(textValue(caa.value))}`;
            })() : textValue(row.content);
            records.push({ nativeId: `${zone.zoneId}/${textValue(row.id)}`, name: fqdn, type, values: [value], ttl: ttl(row.ttl), ...(typeof row.proxied === 'boolean' ? { proxied: row.proxied } : {}) });
          } else if (zone.provider === 'gcp') {
            if (row.name !== fqdn || row.type !== type || row.routingPolicy !== undefined) throw new Error('Unsupported DNS record identity or routing policy.');
            const values = strings(row.rrdatas);
            records.push({ nativeId: `projects/${zone.scope.projectId}/managedZones/${zone.zoneId}/rrsets/${fqdn}/${type}`, name: fqdn, type, values: type === 'TXT' ? values.map(txtContent) : values, ttl: ttl(row.ttl) });
          } else {
            const properties = object(row.properties); const relative = textValue(row.name);
            const owner = relative === '@' ? dnsName(zone.zoneName) : `${relative}.${dnsName(zone.zoneName)}`;
            const expectedId = `${azureZonePath(zone)}/${type}/${relative}`;
            if (textValue(row.id).toLowerCase() !== expectedId.toLowerCase() || row.type !== `Microsoft.Network/dnsZones/${type}`
              || (properties.fqdn !== undefined && dnsName(textValue(properties.fqdn)) !== dnsName(owner))) throw new Error('DNS record scope mismatch.');
            if (dnsName(owner) !== dnsName(name)) continue;
            if (properties.targetResource !== undefined) throw new Error('Azure alias records require separate ownership.');
            const values = azureValues(properties, type);
            records.push({ nativeId: `${zone.zoneId}/${type}/${relative.toLowerCase()}`, name: fqdn, type, values, ttl: ttl(properties.TTL) });
          }
        }
        next = undefined;
        if (zone.provider === 'cloudflare') {
          const info = object(data.result_info);
          if (info.page !== page || !Number.isInteger(info.total_pages) || Number(info.total_pages) < 0
            || (Number(info.total_pages) < page && !(page === 1 && info.total_pages === 0 && items.length === 0))
            || !Number.isInteger(info.total_count) || Number(info.total_count) < 0
            || !Number.isInteger(info.per_page) || Number(info.per_page) < 1) throw new Error('Incomplete Cloudflare pagination.');
          if (expectedCount !== undefined && expectedCount !== info.total_count) throw new Error('Cloudflare collection changed while paging.');
          expectedCount = Number(info.total_count);
          if (Number(info.total_pages) > page) { const nextUrl = new URL(url); nextUrl.searchParams.set('page', String(page + 1)); next = nextUrl.toString(); }
        } else if (zone.provider === 'gcp' && data.nextPageToken) {
          const nextUrl = new URL(url); nextUrl.searchParams.set('pageToken', textValue(data.nextPageToken)); next = nextUrl.toString();
        } else if (zone.provider === 'azure' && data.nextLink) {
          const nextUrl = new URL(textValue(data.nextLink)); const expected = new URL(base);
          if (nextUrl.origin !== expected.origin || nextUrl.pathname.toLowerCase() !== `${expected.pathname}/${type}`.toLowerCase() || nextUrl.username || nextUrl.password || nextUrl.hash) throw new Error('Unsafe DNS continuation.');
          next = nextUrl.toString();
        }
        if (!next) break; url = next; page += 1;
      }
      if (expectedCount !== undefined && expectedCount !== records.length) throw new Error('Incomplete Cloudflare collection.');
      if (new Set(records.map(record => record.nativeId)).size !== records.length) throw new Error('Duplicate DNS identities.');
      if (zone.provider !== 'cloudflare' && records.length > 1) throw new Error('Ambiguous DNS record set.');
      return records.length ? { status: 'present', value: records } : { status: 'absent' };
    } catch { return unknown(); }
  }
}

function azureValues(properties: Json, type: DnsRecordType): string[] {
  if (type === 'CNAME') return [textValue(object(properties.CNAMERecord).cname)];
  const field = { A: 'ARecords', AAAA: 'AAAARecords', TXT: 'TXTRecords', CAA: 'caaRecords', MX: 'MXRecords' }[type];
  const values = properties[field]; if (!Array.isArray(values) || values.length === 0) throw new Error('Invalid DNS values.');
  return values.map(value => { const row = object(value);
    if (type === 'A') return textValue(row.ipv4Address);
    if (type === 'AAAA') return textValue(row.ipv6Address);
    if (type === 'TXT') return strings(row.value).join('');
    if (type === 'MX') {
      if (!Number.isInteger(row.preference) || Number(row.preference) < 0 || Number(row.preference) > 65535) throw new Error('Invalid MX preference.');
      return `${row.preference} ${textValue(row.exchange)}`;
    }
    if (!Number.isInteger(row.flags) || Number(row.flags) < 0 || Number(row.flags) > 255) throw new Error('Invalid CAA flags.');
    return `${row.flags} ${textValue(row.tag)} ${JSON.stringify(textValue(row.value))}`;
  });
}
