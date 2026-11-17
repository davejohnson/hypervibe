import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareAdapter } from '../cloudflare/cloudflare.adapter.js';
import { AppStoreConnectAdapter } from '../appstoreconnect/appstoreconnect.adapter.js';

// #293: a stalled provider connection must not hang a command forever.
afterEach(() => vi.restoreAllMocks());

describe('integration request deadlines', () => {
  it('Cloudflare requests carry a deadline', async () => {
    const signals: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { signals.push(init?.signal); return Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1 } }); });
    const adapter = new CloudflareAdapter(); adapter.connect({ apiToken: 'cfut_dns' });
    await adapter.listZones().catch(() => undefined);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it('App Store Connect requests carry a deadline', async () => {
    const signals: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { signals.push(init?.signal); return Response.json({ data: [] }); });
    const adapter = new AppStoreConnectAdapter();
    // Skip JWT signing: the deadline belongs to the request itself.
    (adapter as unknown as { generateJwt: () => string; credentials: unknown }).generateJwt = () => 'token';
    (adapter as unknown as { credentials: unknown }).credentials = { keyId: 'k', issuerId: 'i', privateKey: 'p' };
    await (adapter as unknown as { apiRequest: (method: string, path: string) => Promise<unknown> }).apiRequest('GET', '/apps').catch(() => undefined);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});
