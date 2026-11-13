import type { DnsProvider, DnsRecordIntent, DnsZoneIdentity } from '../../../../domain/ports/dns.port.js';

export const DNS_ZONES: Record<DnsProvider, DnsZoneIdentity> = {
  cloudflare: { provider: 'cloudflare', zoneId: 'a'.repeat(32), zoneName: 'example.com', scope: { accountId: 'b'.repeat(32) } },
  gcp: { provider: 'gcp', zoneId: 'example-zone', zoneName: 'example.com', scope: { projectId: 'example-project' } },
  aws: { provider: 'aws', zoneId: 'Z123456EXAMPLE', zoneName: 'example.com', scope: { accountId: '123456789012' } },
  azure: { provider: 'azure', zoneId: '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/dns-group/providers/Microsoft.Network/dnsZones/example.com', zoneName: 'example.com', scope: { subscriptionId: '00000000-0000-0000-0000-000000000001', resourceGroup: 'dns-group' } },
};
export const record = (overrides: Partial<DnsRecordIntent> = {}): DnsRecordIntent => ({ key: 'web', name: 'www.example.com', type: 'A', values: ['192.0.2.1'], ttl: 300, authority: { kind: 'absent' }, ...overrides });
