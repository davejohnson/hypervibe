import { describe, expect, it, vi } from 'vitest';
import { Route53Client } from '@aws-sdk/client-route-53';
import type { DnsZoneIdentity } from '../../../domain/ports/dns.port.js';
import { HttpDnsObserver } from '../http-observer.js';
import { AwsDnsObserver } from '../aws-observer.js';

// Reconstructed official REST/XML examples, not captured live evidence. Sources:
// CF https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/
// GCP https://cloud.google.com/dns/docs/reference/v1/resourceRecordSets/list
// AWS https://docs.aws.amazon.com/Route53/latest/APIReference/API_ListResourceRecordSets.html
// Azure https://learn.microsoft.com/en-us/rest/api/dns/record-sets/list-all-by-dns-zone?view=rest-dns-2018-05-01
const cf: DnsZoneIdentity = { provider: 'cloudflare', zoneId: 'zone-1', zoneName: 'example.com', scope: { accountId: 'account-1' } };
const gcp: DnsZoneIdentity = { provider: 'gcp', zoneId: 'public-zone', zoneName: 'example.com', scope: { projectId: 'dns-project' } };
const aws: DnsZoneIdentity = { provider: 'aws', zoneId: 'Z123', zoneName: 'example.com', scope: { accountId: '123456789012' } };
const azureId = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/dns/providers/Microsoft.Network/dnsZones/example.com';
const azure: DnsZoneIdentity = { provider: 'azure', zoneId: azureId, zoneName: 'example.com',
  scope: { subscriptionId: '11111111-1111-4111-8111-111111111111', resourceGroup: 'dns' } };
const cfZone = { success: true, result: { id: 'zone-1', name: 'example.com', account: { id: 'account-1' }, name_servers: ['ns1.cloudflare.com'] } };
const gcpZone = { kind: 'dns#managedZone', name: 'public-zone', id: '987654321', dnsName: 'example.com.', visibility: 'public', nameServers: ['ns-cloud-a1.googledomains.com.'], dnssecConfig: { state: 'on' } };
const azureZone = { id: azureId, name: 'example.com', etag: 'version-one', properties: { zoneType: 'Public', nameServers: ['ns1-01.azure-dns.com.'] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function httpFixture(handler: (url: URL) => Response) {
  return vi.fn<typeof fetch>(async (input, options) => {
    expect(options?.method).toBe('GET'); expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer private-token');
    return handler(new URL(String(input)));
  });
}

describe('Cloudflare exact-zone read-only transport', () => {
  it('retains MX preference rather than treating exchange alone as the value', async () => {
    const transport = httpFixture(url => url.pathname.endsWith('/dns_records') ? json({ success: true,
      result: [{ id: 'mx1', name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10, ttl: 300 }],
      result_info: { page: 1, total_pages: 1, total_count: 1, per_page: 100 } }) : url.pathname.endsWith('/dnssec') ? json({}, 403) : json(cfZone));
    expect(await new HttpDnsObserver(cf, 'private-token', transport).observeRecordSets('example.com', 'MX'))
      .toMatchObject({ status: 'present', value: [{ nativeId: 'zone-1/mx1', values: ['10 mail.example.com'] }] });
  });
  it('reads every page and preserves native record identities, TTL and proxy state', async () => {
    const transport = httpFixture(url => {
      if (url.pathname.endsWith('/dnssec')) return json({ success: true, result: { status: 'active' } });
      if (!url.pathname.endsWith('/dns_records')) return json(cfZone);
      const page = Number(url.searchParams.get('page'));
      expect(url.searchParams.get('name')).toBe('_verify.example.com');
      return json({ success: true, result: [{ id: `record-${page}`, name: '_verify.example.com', type: 'TXT', content: `token-${page}`, ttl: 300, proxied: false }], result_info: { page, total_pages: 2, total_count: 2, per_page: 1 } });
    });
    const result = await new HttpDnsObserver(cf, 'private-token', transport).observeRecordSets('_verify.example.com', 'TXT');
    expect(result).toMatchObject({ status: 'present', value: [
      { nativeId: 'zone-1/record-1', values: ['token-1'], ttl: 300, proxied: false },
      { nativeId: 'zone-1/record-2', values: ['token-2'] },
    ] });
  });
  it.each([403, 429, 500])('classifies HTTP %i as unknown and excludes echoed credentials', async status => {
    const transport = httpFixture(() => json({ errors: ['private-token'] }, status));
    const result = await new HttpDnsObserver(cf, 'private-token', transport).observeZone();
    expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('private-token');
  });
  it('distinguishes confirmed 404 zone absence from permission failure', async () => {
    expect(await new HttpDnsObserver(cf, 'private-token', httpFixture(() => json({}, 404))).observeZone()).toEqual({ status: 'absent' });
  });
  it('accepts the documented empty collection with zero total pages, but rejects a truncated collection', async () => {
    for (const total_count of [0, 3]) {
      const transport = httpFixture(url => url.pathname.endsWith('/dns_records') ? json({ success: true, result: [], result_info: { page: 1, total_pages: total_count ? 1 : 0, per_page: 100, total_count } })
        : url.pathname.endsWith('/dnssec') ? json({}, 403) : json(cfZone));
      expect(await new HttpDnsObserver(cf, 'private-token', transport).observeRecordSets('www.example.com', 'A')).toMatchObject({ status: total_count ? 'unknown' : 'absent' });
    }
  });
  it('rejects a same-name zone in another account before reading records', async () => {
    const transport = httpFixture(() => json({ ...cfZone, result: { ...cfZone.result, account: { id: 'other-account' } } }));
    expect((await new HttpDnsObserver(cf, 'private-token', transport).observeRecordSets('example.com', 'A')).status).toBe('unknown');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects incomplete pagination and records outside an exact-name filter', async () => {
    for (const result of [
      { success: true, result: [], result_info: { page: 1 } },
      { success: true, result: [{ id: 'other', name: 'other.example.com', type: 'A', content: '192.0.2.1', ttl: 60 }], result_info: { page: 1, total_pages: 1 } },
    ]) {
      const transport = httpFixture(url => url.pathname.endsWith('/dns_records') ? json(result) : url.pathname.endsWith('/dnssec') ? json({}, 403) : json(cfZone));
      expect((await new HttpDnsObserver(cf, 'private-token', transport).observeRecordSets('www.example.com', 'A')).status).toBe('unknown');
    }
  });
});

describe('Google DNS exact managed-zone transport', () => {
  it('retains Google MX RDATA in the authoritative RRset', async () => {
    const transport = httpFixture(url => url.pathname.endsWith('/rrsets') ? json({ rrsets: [{ name: 'example.com.', type: 'MX', ttl: 300, rrdatas: ['10 mail.example.com.'] }] }) : json(gcpZone));
    expect(await new HttpDnsObserver(gcp, 'private-token', transport).observeRecordSets('example.com', 'MX'))
      .toMatchObject({ status: 'present', value: [{ values: ['10 mail.example.com.'] }] });
  });
  it('captures immutable numeric zone identity and decodes TXT chunks through complete pagination', async () => {
    const transport = httpFixture(url => {
      expect(url.pathname).toContain('/projects/dns-project/managedZones/public-zone');
      if (!url.pathname.endsWith('/rrsets')) return json(gcpZone);
      expect(url.searchParams.get('name')).toBe('_verify.example.com.');
      return url.searchParams.has('pageToken') ? json({ rrsets: [{ name: '_verify.example.com.', type: 'TXT', ttl: 300, rrdatas: ['"first" "second"'] }] })
        : json({ rrsets: [], nextPageToken: 'page-two' });
    });
    const observer = new HttpDnsObserver(gcp, 'private-token', transport);
    expect(await observer.observeZone()).toMatchObject({ status: 'present', value: { providerNativeId: '987654321', dnssec: 'enabled', visibility: 'public' } });
    expect(await observer.observeRecordSets('_verify.example.com', 'TXT')).toMatchObject({ status: 'present', value: [
      { nativeId: 'projects/dns-project/managedZones/public-zone/rrsets/_verify.example.com./TXT', values: ['firstsecond'] },
    ] });
  });
  it('rejects a same-DNS-name managed zone with another native resource name', async () => {
    const transport = httpFixture(() => json({ ...gcpZone, name: 'another-zone' }));
    expect((await new HttpDnsObserver(gcp, 'private-token', transport).observeZone()).status).toBe('unknown');
  });
  it('does not confuse a repeated continuation or a later page failure with absence', async () => {
    for (const status of [200, 403]) {
      const transport = httpFixture(url => !url.pathname.endsWith('/rrsets') ? json(gcpZone)
        : json({ rrsets: [], nextPageToken: 'repeat' }, url.searchParams.has('pageToken') ? status : 200));
      expect((await new HttpDnsObserver(gcp, 'private-token', transport).observeRecordSets('www.example.com', 'A')).status).toBe('unknown');
    }
  });
  it('keeps unknown zone visibility and DNSSEC distinct from disabled/public defaults', async () => {
    const { visibility: _visibility, dnssecConfig: _dnssec, ...minimal } = gcpZone;
    expect(await new HttpDnsObserver(gcp, 'private-token', httpFixture(() => json(minimal))).observeZone())
      .toMatchObject({ status: 'present', value: { dnssec: 'unknown', visibility: 'unknown' } });
  });
  it('accepts omitted empty Google rrsets only with the expected response kind', async () => {
    for (const data of [{}, { kind: 'dns#resourceRecordSetsListResponse' }]) {
      const transport = httpFixture(url => url.pathname.endsWith('/rrsets') ? json(data) : json(gcpZone));
      expect((await new HttpDnsObserver(gcp, 'private-token', transport).observeRecordSets('www.example.com', 'A')).status).toBe('kind' in data ? 'absent' : 'unknown');
    }
  });
});

describe('Azure DNS scoped ARM transport', () => {
  it('retains Azure MX preference and canonical scoped identity despite ARM casing', async () => {
    const transport = httpFixture(url => url.pathname.endsWith('/MX') ? json({ value: [{ id: `${azureId.toUpperCase()}/MX/@`, name: '@', type: 'Microsoft.Network/dnsZones/MX',
      properties: { TTL: 300, MXRecords: [{ preference: 10, exchange: 'mail.example.com.' }] } }] }) : json(azureZone));
    expect(await new HttpDnsObserver(azure, 'private-token', transport).observeRecordSets('example.com', 'MX'))
      .toMatchObject({ status: 'present', value: [{ nativeId: `${azureId}/MX/@`, values: ['10 mail.example.com.'] }] });
  });
  it('preserves complete RRsets and rejects a lookalike record from another resource group', async () => {
    const row = { id: `${azureId}/TXT/_verify`, name: '_verify', type: 'Microsoft.Network/dnsZones/TXT', properties: { TTL: 300, fqdn: '_verify.example.com.', TXTRecords: [{ value: ['part1', 'part2'] }, { value: ['unrelated'] }] } };
    for (const foreign of [false, true]) {
      const transport = httpFixture(url => url.pathname.endsWith('/TXT') ? json({ value: [{ ...row, id: foreign ? row.id.replace('/resourceGroups/dns/', '/resourceGroups/another/') : row.id }] }) : json(azureZone));
      const result = await new HttpDnsObserver(azure, 'private-token', transport).observeRecordSets('_verify.example.com', 'TXT');
      expect(result).toMatchObject(foreign ? { status: 'unknown' } : { status: 'present', value: [{ nativeId: row.id, values: ['part1part2', 'unrelated'] }] });
    }
  });
  it('never forwards a bearer token to a foreign or cross-zone continuation', async () => {
    for (const nextLink of ['https://attacker.example/dns', `https://management.azure.com${azureId.replace('example.com', 'other.example')}/A?api-version=2018-05-01`]) {
      const transport = httpFixture(url => url.pathname.endsWith('/A') ? json({ value: [], nextLink }) : json(azureZone));
      expect((await new HttpDnsObserver(azure, 'private-token', transport).observeRecordSets('www.example.com', 'A')).status).toBe('unknown');
      expect(transport).toHaveBeenCalledTimes(2);
    }
  });
  it('reads empty pages to terminal absence and labels etag as coherence evidence', async () => {
    const transport = httpFixture(url => !url.pathname.endsWith('/A') ? json(azureZone)
      : json(url.searchParams.has('$skipToken') ? { value: [] } : { value: [], nextLink: `https://management.azure.com${azureId}/A?api-version=2018-05-01&$skipToken=next` }));
    const observer = new HttpDnsObserver(azure, 'private-token', transport);
    expect(await observer.observeZone()).toMatchObject({ status: 'present', value: { etag: 'version-one', dnssec: 'unknown' } });
    expect(await observer.observeRecordSets('www.example.com', 'A')).toEqual({ status: 'absent' });
  });
});

function route53Transport(handler: (path: string, query: Record<string, unknown>) => { body: string; status?: number }) {
  const requests: Array<{ path: string; query: Record<string, unknown> }> = [];
  const client = new Route53Client({ region: 'us-east-1', credentials: { accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret', sessionToken: 'fixture-session' }, maxAttempts: 1,
    requestHandler: { async handle(request: { method: string; headers: Record<string, string>; path: string; query: Record<string, unknown> }) {
      expect(request.method).toBe('GET'); expect(request.headers['x-amz-security-token']).toBe('fixture-session');
      expect(request.headers.authorization).toContain('/us-east-1/route53/aws4_request');
      requests.push({ path: request.path, query: request.query }); const result = handler(request.path, request.query);
      return { response: { statusCode: result.status ?? 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(result.body) } };
    } },
  });
  return { client, requests };
}
const zoneXml = '<GetHostedZoneResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><HostedZone><Id>/hostedzone/Z123</Id><Name>example.com.</Name><CallerReference>owner</CallerReference><Config><PrivateZone>false</PrivateZone></Config></HostedZone><DelegationSet><NameServers><NameServer>ns-1.awsdns.com</NameServer></NameServers></DelegationSet></GetHostedZoneResponse>';
const dnssecXml = '<GetDNSSECResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><Status><ServeSignature>SIGNING</ServeSignature></Status></GetDNSSECResponse>';
const rrsetXml = (records: string, tail = '<IsTruncated>false</IsTruncated>') => `<ListResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ResourceRecordSets>${records}</ResourceRecordSets>${tail}<MaxItems>100</MaxItems></ListResourceRecordSetsResponse>`;
describe('Route53 SDK serialized read-only transport', () => {
  it('retains MX RDATA through the official XML deserializer', async () => {
    const { client } = route53Transport(path => ({ body: path.endsWith('/dnssec') ? dnssecXml : path.endsWith('/rrset')
      ? rrsetXml('<ResourceRecordSet><Name>example.com.</Name><Type>MX</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>10 mail.example.com.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>') : zoneXml }));
    expect(await new AwsDnsObserver(aws, client, '123456789012').observeRecordSets('example.com', 'MX'))
      .toMatchObject({ status: 'present', value: [{ nativeId: 'Z123_example.com_MX', values: ['10 mail.example.com.'] }] });
  });
  it('uses signed SDK requests and treats name/type as a cursor, not an exact filter', async () => {
    const { client, requests } = route53Transport(path => ({ body: path.endsWith('/dnssec') ? dnssecXml : path.endsWith('/rrset')
      ? rrsetXml('<ResourceRecordSet><Name>www.example.com.</Name><Type>A</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>192.0.2.1</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>') : zoneXml }));
    const observer = new AwsDnsObserver(aws, client, '123456789012');
    expect(await observer.observeRecordSets('www.example.com', 'A')).toMatchObject({ status: 'present', value: [{ nativeId: 'Z123_www.example.com_A', values: ['192.0.2.1'] }] });
    expect(await observer.observeRecordSets('missing.example.com', 'A')).toEqual({ status: 'absent' });
    expect(requests.find(request => request.path.endsWith('/rrset'))?.query).toMatchObject({ name: 'www.example.com.', type: 'A' });
  });
  it('refuses mismatched authenticated accounts without a DNS call', async () => {
    const { client, requests } = route53Transport(() => ({ body: zoneXml }));
    expect((await new AwsDnsObserver(aws, client, '000000000000').observeZone()).status).toBe('unknown'); expect(requests).toHaveLength(0);
  });
  it('rejects missing pagination evidence and never treats access denied as absent', async () => {
    for (const response of [{ body: rrsetXml('', '<IsTruncated>true</IsTruncated>') }, { status: 403, body: '<ErrorResponse><Error><Code>AccessDenied</Code><Message>fixture-secret</Message></Error></ErrorResponse>' }]) {
      const { client } = route53Transport(path => path.endsWith('/rrset') ? response : { body: path.endsWith('/dnssec') ? dnssecXml : zoneXml });
      const result = await new AwsDnsObserver(aws, client, '123456789012').observeRecordSets('www.example.com', 'A');
      expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('fixture-secret');
    }
  });
  it('does not collapse weighted or alias routing records into an owned simple RRset', async () => {
    const { client } = route53Transport(path => ({ body: path.endsWith('/dnssec') ? dnssecXml : path.endsWith('/rrset')
      ? rrsetXml('<ResourceRecordSet><Name>www.example.com.</Name><Type>A</Type><SetIdentifier>other-owner</SetIdentifier><Weight>10</Weight><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>192.0.2.1</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>') : zoneXml }));
    expect((await new AwsDnsObserver(aws, client, '123456789012').observeRecordSets('www.example.com', 'A')).status).toBe('unknown');
  });
});
