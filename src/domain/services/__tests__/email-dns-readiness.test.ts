import { Resolver } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { planEmail } from '../email-plan.service.js';
import { inspectEmailDnsReadiness } from '../email-dns-readiness.service.js';

// Reconstructed from official SendGrid automated-security DNS examples:
// https://www.twilio.com/docs/sendgrid/api-reference/domain-authentication/authenticate-a-domain
const dns = {
  mail_cname: { type: 'cname', host: 'em.example.com', data: 'u1446226.wl.sendgrid.net', valid: true },
  dkim1: { type: 'cname', host: 's1._domainkey.example.com', data: 's1.domainkey.u1446226.wl.sendgrid.net', valid: true },
  dkim2: { type: 'cname', host: 's2._domainkey.example.com', data: 's2.domainkey.u1446226.wl.sendgrid.net', valid: true },
};
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const absent = () => Object.assign(new Error('synthetic DNS absence'), { code: 'ENODATA' });
const project = { id: 'dns-app', name: 'dns-app', defaultPlatform: 'railway', policies: {}, createdAt: new Date(), updatedAt: new Date() };

afterEach(() => vi.restoreAllMocks());

function provider() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('whitelabel')
    ? response([{ id: 302183, domain: 'example.com', valid: true, automatic_security: true, dns }])
    : response({ results: [] }));
}
async function plan() {
  return planEmail({ project, environmentName: 'production', environment: null, observed: null,
    environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: {} },
      envVars: { SENDGRID_API_KEY: 'SG.synthetic-private', EMAIL_FROM: 'orders@example.com' } }),
  });
}

describe('email DNS readiness through plan and the real SendGrid transport', () => {
  it('does not equate a verified identity with currently published SPF/DKIM and DMARC', async () => {
    const fetch = provider();
    vi.spyOn(Resolver.prototype, 'resolveCname').mockRejectedValue(absent());
    vi.spyOn(Resolver.prototype, 'resolveTxt').mockRejectedValue(absent());
    const result = await plan();
    expect(result.senderReadiness).toMatchObject({ status: 'verified', dns: { status: 'needs_attention', senders: [{ key: 'EMAIL_FROM', spf: 'missing', dkim: 'missing', dmarc: { status: 'missing' } }] } });
    expect(result.actions).toEqual([]);
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SG.synthetic-private');
    expect(JSON.stringify(result)).not.toContain('orders@example.com');
  });

  it('checks current CNAME publication even when the provider previously marked it valid', async () => {
    provider();
    vi.spyOn(Resolver.prototype, 'resolveCname').mockImplementation(async host => {
      const record = Object.values(dns).find(record => record.host === host)!;
      return [host.startsWith('s2.') ? 'wrong.example.net' : record.data.toUpperCase() + '.'];
    });
    vi.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValue([['v=DMARC1; ', 'p=reject']]);
    expect((await plan()).senderReadiness?.dns).toMatchObject({ status: 'needs_attention', senders: [{ spf: 'published', dkim: 'mismatch', dmarc: { status: 'configured', policy: 'reject' } }] });
  });

  it.each(['ENODATA', 'ENOTFOUND', 'ETIMEOUT', 'ESERVFAIL', 'EREFUSED'])('distinguishes DNS error %s from absence', async code => {
    provider();
    vi.spyOn(Resolver.prototype, 'resolveCname').mockRejectedValue(Object.assign(new Error('private provider error'), { code }));
    vi.spyOn(Resolver.prototype, 'resolveTxt').mockRejectedValue(Object.assign(new Error('private provider error'), { code }));
    const result = (await plan()).senderReadiness?.dns;
    const status = ['ENODATA', 'ENOTFOUND'].includes(code) ? 'missing' : 'unknown';
    expect(result?.senders[0]).toMatchObject({ spf: status, dkim: status, dmarc: { status } });
    expect(JSON.stringify(result)).not.toContain('private provider error');
  });

  // RFC 7489 sections 6.3 and 6.6.3: TXT chunks, exact-domain lookup,
  // organizational fallback, sp, pct and duplicate-policy handling.
  it.each([
    { txt: [['v=DMARC1; p=reject']], status: 'configured' },
    { txt: [['v=DMARC1;', ' p=none']], status: 'monitoring' },
    { txt: [['v=DMARC1; p=quarantine; pct=50']], status: 'partial' },
    { txt: [['v=DMARC1; p=reject; pct=101']], status: 'invalid' },
    { txt: [['v=DMARC1; p=reject; p=none']], status: 'invalid' },
    { txt: [['v=DMARC1; p=reject'], ['v=DMARC1; p=none']], status: 'invalid' },
    { txt: [['other TXT record']], status: 'missing' },
  ])('reports DMARC $status without changing policy', async ({ txt, status }) => {
    provider();
    vi.spyOn(Resolver.prototype, 'resolveCname').mockImplementation(async host => [Object.values(dns).find(record => record.host === host)!.data]);
    vi.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValue(txt);
    const result = (await plan()).senderReadiness?.dns;
    expect(result?.senders[0].dmarc.status).toBe(status);
    expect(result?.status).toBe(status === 'configured' ? 'configured' : 'needs_attention');
  });

  it('inherits the organizational subdomain policy only after a successful empty exact-domain lookup', async () => {
    const read = vi.spyOn(Resolver.prototype, 'resolveTxt').mockImplementation(async name => name === '_dmarc.mail.example.co.uk' ? [] : [['v=DMARC1; p=reject; sp=none']]);
    const result = await inspectEmailDnsReadiness([{ key: 'EMAIL_FROM', address: 'orders@mail.example.co.uk', evidence: { status: 'verified-sender' } }]);
    expect(result.senders[0].dmarc).toEqual({ status: 'monitoring', policy: 'none', inherited: true });
    expect(read.mock.calls.map(([name]) => name)).toEqual(['_dmarc.mail.example.co.uk', '_dmarc.example.co.uk']);
  });

  it('does not fall back to parent policy after an unknown exact-domain read', async () => {
    const read = vi.spyOn(Resolver.prototype, 'resolveTxt').mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
    const result = await inspectEmailDnsReadiness([{ key: 'EMAIL_FROM', address: 'orders@mail.example.com', evidence: { status: 'verified-sender' } }]);
    expect(result.senders[0].dmarc.status).toBe('unknown');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('requires actual domain DNS requirements instead of inferring them from single-sender verification', async () => {
    const cname = vi.spyOn(Resolver.prototype, 'resolveCname');
    vi.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValue([['v=DMARC1; p=reject']]);
    const result = await inspectEmailDnsReadiness([{ key: 'EMAIL_FROM', address: 'orders@example.com', evidence: { status: 'verified-sender' } }]);
    expect(result).toMatchObject({ status: 'unknown', senders: [{ spf: 'unknown', dkim: 'unknown' }] });
    expect(cname).not.toHaveBeenCalled();
  });

  it('caches duplicate From domains but never reuses DNS evidence between observations', async () => {
    const cname = vi.spyOn(Resolver.prototype, 'resolveCname').mockImplementation(async host => [Object.values(dns).find(record => record.host === host)!.data]);
    const txt = vi.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValue([['v=DMARC1; p=reject']]);
    const senders = ['EMAIL_FROM', 'MAIL_FROM'].map(key => ({ key, address: 'orders@example.com', evidence: { status: 'verified-domain' as const, automaticSecurity: true, dns } }));
    expect((await inspectEmailDnsReadiness(senders)).status).toBe('configured');
    expect(cname).toHaveBeenCalledTimes(3);
    expect(txt).toHaveBeenCalledTimes(1);
    cname.mockRejectedValue(absent());
    expect((await inspectEmailDnsReadiness(senders)).status).toBe('needs_attention');
  });

  it('keeps oversized observations explicitly incomplete', async () => {
    vi.spyOn(Resolver.prototype, 'resolveCname').mockImplementation(async host => [Object.values(dns).find(record => record.host === host)!.data]);
    vi.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValue([['v=DMARC1; p=reject']]);
    const senders = Array.from({ length: 9 }, (_, index) => ({ key: `EMAIL_FROM_${index}`, address: 'orders@example.com', evidence: { status: 'verified-domain' as const, automaticSecurity: true, dns } }));
    const result = await inspectEmailDnsReadiness(senders);
    expect(result).toMatchObject({ status: 'unknown', uncheckedSenders: 1 });
    expect(result.senders).toHaveLength(8);
  });

  it('does not query provider-supplied record hosts outside the sending domain', async () => {
    const cname = vi.spyOn(Resolver.prototype, 'resolveCname');
    vi.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValue([['v=DMARC1; p=reject']]);
    const unrelated = Object.fromEntries(Object.entries(dns).map(([key, record]) => [key, { ...record, host: 'private.other.example' }]));
    const result = await inspectEmailDnsReadiness([{ key: 'EMAIL_FROM', address: 'orders@example.com', evidence: { status: 'verified-domain', automaticSecurity: true, dns: unrelated } }]);
    expect(result.status).toBe('unknown');
    expect(cname).not.toHaveBeenCalled();
  });
});
