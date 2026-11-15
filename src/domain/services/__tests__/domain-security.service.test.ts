import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectDomainSecurity } from '../domain-security.service.js';

// Synthetic DNS observations reconstructed from Google's published JSON shape
// (https://developers.google.com/speed/public-dns/docs/doh/json, 2024-09-03)
// and CAA policy examples in RFC 8659. Only HTTP transport is replaced.
const record = (name: string, data: string, type = 257) => ({ name: `${name}.`, type, TTL: 300, data });
function transport(policies: Record<string, ReturnType<typeof record>[]> = {}, overrides: Record<string, unknown> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input));
    const name = url.searchParams.get('name')!;
    const type = Number(url.searchParams.get('type'));
    return new Response(JSON.stringify({ Status: 0, TC: false, AD: true, CD: false,
      Question: [{ name: `${name}.`, type }], Answer: type === 257 ? policies[name] ?? [] : [], ...overrides,
    }));
  });
}
afterEach(() => vi.restoreAllMocks());

describe('domain security via the public DNS transport', () => {
  it('requires validated DNS evidence and completes CAA ancestry before reporting no restriction', async () => {
    const fetch = transport();
    expect(await inspectDomainSecurity('web.example.com')).toMatchObject({ status: 'observed', dnssec: 'validated', caa: { status: 'unrestricted' } });
    expect(fetch.mock.calls.some(([url]) => new URL(String(url)).searchParams.get('name') === 'com')).toBe(true);
    for (const [input, init] of fetch.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://dns.google');
      expect(url.searchParams.get('cd')).toBe('false');
      expect(url.searchParams.get('edns_client_subnet')).toBe('0.0.0.0/0');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  });

  it.each([
    { policy: ['0 issue ";"'], status: 'issuance_denied' },
    { policy: ['0 issue ";"', '0 issue "ca1.example.net"'], status: 'restricted' },
    { policy: ['0 issuewild ";"'], status: 'unrestricted' },
    { policy: ['0 iodef "mailto:security@example.com"'], status: 'unrestricted' },
    { policy: ['128 tbs "Unknown"'], status: 'unknown' },
    { policy: ['0 issue "ca1.example.net; account=230123"'], status: 'restricted' },
    { policy: ['999 issue "ca1.example.net"'], status: 'unknown' },
  ])('interprets $policy as $status without guessing the hosting issuer', async ({ policy, status }) => {
    transport({ 'example.com': policy.map(value => record('example.com', value)) });
    const result = await inspectDomainSecurity('web.example.com');
    expect(result?.caa.status).toBe(status);
    if (status === 'restricted') expect(result?.caa.issuerCompatibility).toBe('not_verified');
    expect(JSON.stringify(result)).not.toContain('230123');
    expect(JSON.stringify(result)).not.toContain('security@example.com');
  });

  it('stops at the first CAA set instead of merging a parent restriction', async () => {
    const fetch = transport({ 'web.example.com': [record('web.example.com', '0 iodef "mailto:owner@example.com"')],
      'example.com': [record('example.com', '0 issue ";"')],
    });
    expect((await inspectDomainSecurity('web.example.com'))?.caa.status).toBe('unrestricted');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('follows CNAMEs and detects loops without assuming empty policy', async () => {
    const fetch = transport({ 'web.example.com': [record('web.example.com', 'target.example.net.', 5)],
      'target.example.net': [record('target.example.net', '0 issue ";"')],
    });
    expect((await inspectDomainSecurity('web.example.com'))?.caa.status).toBe('issuance_denied');
    fetch.mockRestore();
    transport({ 'web.example.com': [record('web.example.com', 'web.example.com.', 5)] });
    expect((await inspectDomainSecurity('web.example.com'))?.caa.status).toBe('unknown');
  });

  it.each([{ Status: 2 }, { TC: true }, { CD: true }, { AD: undefined }, { Question: [] }, { Answer: null }])('preserves unknown for incomplete/failing observations %j', async override => {
    transport({}, override);
    const result = await inspectDomainSecurity('example.com');
    expect(result).toMatchObject({ dnssec: 'unknown', caa: { status: 'unknown' } });
  });

  it('uses the original parent after an alias has no CAA, not the alias parent', async () => {
    transport({ 'web.example.com': [record('web.example.com', 'target.example.net.', 5)],
      'example.com': [record('example.com', '0 issue ";"')],
      'example.net': [record('example.net', '0 issue "ca1.example.net"')],
    });
    expect((await inspectDomainSecurity('web.example.com'))?.caa).toMatchObject({ status: 'issuance_denied', inherited: true });
  });

  it('keeps exhausted alias discovery unknown', async () => {
    const policies: Record<string, ReturnType<typeof record>[]> = {};
    for (let i = 0; i < 25; i++) policies[`alias${i}.example.com`] = [record(`alias${i}.example.com`, `alias${i + 1}.example.com.`, 5)];
    const fetch = transport(policies);
    expect((await inspectDomainSecurity('alias0.example.com'))?.caa.status).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(21); // One SOA and at most twenty CAA queries.
  });

  it('keeps network failures unknown without returning exception inputs', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-network-input'));
    const result = await inspectDomainSecurity('example.com');
    expect(result).toMatchObject({ dnssec: 'unknown', caa: { status: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain('private-network-input');
  });

  it('does not diagnose broken delegation solely from AD=false', async () => {
    transport({}, { AD: false });
    expect((await inspectDomainSecurity('example.com'))?.dnssec).toBe('not_validated');
  });

  it('keeps HTTP errors unknown and does not return resolver error bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private-input-echo', { status: 403 }));
    const result = await inspectDomainSecurity('example.com');
    expect(result?.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('private-input-echo');
  });

  it('does not query missing, wildcard, IP, or private local names', async () => {
    const fetch = transport();
    expect(await inspectDomainSecurity()).toBeUndefined();
    for (const name of ['localhost', '127.0.0.1', '*.example.com', 'db.internal']) expect((await inspectDomainSecurity(name))?.status).toBe('unknown');
    expect(fetch).not.toHaveBeenCalled();
  });
});
