import { GetDNSSECCommand, GetHostedZoneCommand, ListResourceRecordSetsCommand, type ListResourceRecordSetsCommandOutput, type Route53Client, type RRType } from '@aws-sdk/client-route-53';
import type { DnsObservation, DnsObservedRecord, DnsRecordType, DnsZoneIdentity, DnsZoneObservation } from '../../domain/ports/dns.port.js';
import { dnsName, textValue, ttl, txtContent, unknown, validateRecordOwner, type DnsObserver } from './http-observer.js';

/** Uses the official SDK serializer and credential signer; no write operations. */
export class AwsDnsObserver implements DnsObserver {
  constructor(readonly zone: DnsZoneIdentity, private readonly client: Route53Client, private readonly callerAccountId: string) {}

  async observeZone(): Promise<DnsObservation<DnsZoneObservation>> {
    if (this.callerAccountId !== this.zone.scope.accountId) return unknown('AWS authenticated account differs from the selected DNS account.');
    try {
      const response = await this.client.send(new GetHostedZoneCommand({ Id: this.zone.zoneId }));
      const hosted = response.HostedZone;
      if (hosted?.Id?.replace(/^\/hostedzone\//, '') !== this.zone.zoneId || dnsName(hosted?.Name ?? '') !== dnsName(this.zone.zoneName)) return unknown('AWS hosted zone identity differs from the selected zone.');
      let dnssec: DnsZoneObservation['dnssec'] = 'unknown';
      try {
        const result = await this.client.send(new GetDNSSECCommand({ HostedZoneId: this.zone.zoneId }));
        dnssec = result.Status?.ServeSignature === 'SIGNING' ? 'enabled' : result.Status?.ServeSignature === 'NOT_SIGNING' ? 'disabled' : 'unknown';
      } catch { /* Private zones and restricted DNSSEC reads remain explicitly unknown. */ }
      return { status: 'present', value: { identity: this.zone, providerNativeId: this.zone.zoneId,
        visibility: hosted.Config?.PrivateZone === true ? 'private' : hosted.Config?.PrivateZone === false ? 'public' : 'unknown',
        dnssec, nameservers: response.DelegationSet?.NameServers ?? [] } };
    } catch (error) {
      return error instanceof Error && error.name === 'NoSuchHostedZone' ? { status: 'absent' } : unknown();
    }
  }

  async observeRecordSets(name: string, type: DnsRecordType): Promise<DnsObservation<DnsObservedRecord[]>> {
    if (!validateRecordOwner(this.zone, name)) return unknown('DNS record is outside the selected zone.');
    if ((await this.observeZone()).status !== 'present') return unknown('AWS hosted zone could not be confirmed before reading records.');
    const fqdn = `${dnsName(name)}.`;
    try {
      const records: DnsObservedRecord[] = []; const seen = new Set<string>();
      let nextName = fqdn; let nextType: RRType = type; let nextIdentifier: string | undefined;
      for (let page = 0; ; page++) {
        const cursor = JSON.stringify([nextName, nextType, nextIdentifier]);
        if (seen.has(cursor) || page >= 100) throw new Error('Incomplete Route53 pagination.');
        seen.add(cursor);
        const response: ListResourceRecordSetsCommandOutput = await this.client.send(new ListResourceRecordSetsCommand({ HostedZoneId: this.zone.zoneId,
          StartRecordName: nextName, StartRecordType: nextType, ...(nextIdentifier ? { StartRecordIdentifier: nextIdentifier } : {}), MaxItems: 100 }));
        if (!Array.isArray(response.ResourceRecordSets) || typeof response.IsTruncated !== 'boolean') throw new Error('Incomplete Route53 list response.');
        for (const record of response.ResourceRecordSets) {
          const owner = dnsName(textValue(record.Name));
          if (owner !== dnsName(name) || record.Type !== type) continue;
          // Routing/alias records are different resources; never collapse them into a simple RRset.
          if (record.AliasTarget || record.SetIdentifier || record.Weight !== undefined || record.Region || record.Failover
            || record.GeoLocation || record.GeoProximityLocation || record.CidrRoutingConfig || record.MultiValueAnswer === true || record.HealthCheckId) throw new Error('Unsupported Route53 routing record.');
          if (!record.ResourceRecords?.length) throw new Error('Missing Route53 values.');
          const values = record.ResourceRecords.map(value => textValue(value.Value));
          records.push({ nativeId: `${this.zone.zoneId}_${dnsName(name)}_${type}`, name: fqdn, type,
            values: type === 'TXT' ? values.map(txtContent) : values, ttl: ttl(record.TTL) });
        }
        if (!response.IsTruncated) break;
        nextName = textValue(response.NextRecordName); nextType = response.NextRecordType!;
        if (!nextType) throw new Error('Missing Route53 continuation type.');
        nextIdentifier = response.NextRecordIdentifier;
        // Name/type are a start cursor, not a filter. Do not mistake a neighbouring owner for the target.
        if (dnsName(nextName) !== dnsName(name) || nextType !== type) break;
      }
      if (records.length > 1) throw new Error('Ambiguous Route53 record set.');
      return records.length ? { status: 'present', value: records } : { status: 'absent' };
    } catch { return unknown(); }
  }
}
