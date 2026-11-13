import { afterEach, describe, expect, it, vi } from 'vitest';
import * as connections from '../../adapters/dns-observation/connections.js';
import { verifyDnsTrafficAbsent } from '../dns-absence.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const zone = { provider: 'gcp' as const, zoneId: 'dns-zone', zoneName: 'example.com', scope: { projectId: 'dns-project' } };
  const observe = vi.fn(async () => ({ status: 'absent' as const }));
  vi.spyOn(connections, 'resolveDnsConnection').mockResolvedValue({ connectionId: 'saved-dns', connectionProvider: 'gcp-dns',
    auth: { env: {}, redact: [] }, observer: { observeZone: async () => ({ status: 'present', value: { identity: zone, providerNativeId: '1234', visibility: 'public', dnssec: 'disabled', nameservers: ['ns.example.net'] } }), observeRecordSets: observe } });
  const fetch = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    return Response.json({ Status: 0, TC: false, AD: false, CD: false, Question: [{ name: url.searchParams.get('name'), type: Number(url.searchParams.get('type')) }] });
  });
  vi.stubGlobal('fetch', fetch);
  const input = { ctx: {} as never, project: { gitRemoteUrl: 'https://github.com/fixture/fixture' } as never, zone, domain: 'app.example.com' };
  return { input, fetch, observe };
}
describe('domain cancellation DNS absence', () => {
  it('requires complete native and public absence without any provider writes', async () => {
    const f = fixture(); const result = await verifyDnsTrafficAbsent(f.input);
    expect(result).toMatchObject({ ready: true, connectionId: 'saved-dns', zoneFingerprint: expect.any(String) });
    expect(f.observe).toHaveBeenCalledTimes(3); expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('type'))).toEqual(['1', '28', '5']);
  });
  it.each(['present', 'unknown'] as const)('retains the claim when native DNS is %s', async status => {
    const f = fixture(); f.observe.mockResolvedValue({ status, value: [], reason: 'unavailable' } as never);
    expect(await verifyDnsTrafficAbsent(f.input)).toMatchObject({ ready: false }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['cached', 'incomplete', 'servfail'] as const)('retains the claim when public DNS is %s', async status => {
    const f = fixture(); f.fetch.mockImplementation(async input => {
      const url = new URL(String(input));
      return Response.json(status === 'incomplete' ? {} : { Status: status === 'servfail' ? 2 : 0, TC: false, AD: false, CD: false,
        Question: [{ name: url.searchParams.get('name'), type: Number(url.searchParams.get('type')) }],
        ...(status === 'cached' ? { Answer: [{ name: 'app.example.com.', type: 1, data: '192.0.2.1' }] } : {}) });
    });
    expect(await verifyDnsTrafficAbsent(f.input)).toMatchObject({ ready: false });
  });
  it('rejects changed reviewed zone or connection evidence before querying records', async () => {
    const f = fixture();
    expect(await verifyDnsTrafficAbsent({ ...f.input, expected: { zoneFingerprint: 'old-zone', connectionId: 'saved-dns' } })).toMatchObject({ ready: false });
    expect(f.observe).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
});
