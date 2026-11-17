import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendGridAdapter } from '../sendgrid.adapter.js';

// #373: SendGrid pages these lists (domains: limit/offset; verified senders: limit/lastSeenID).
// One response is not the whole account. #293: every request has a deadline.
afterEach(() => vi.restoreAllMocks());
const connected = () => { const adapter = new SendGridAdapter(); adapter.connect({ apiKey: 'test-private-key' }); return adapter; };

describe('SendGrid account lists', () => {
  it('reads every page of domain authentications', async () => {
    const all = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, domain: `d${i + 1}.example`, valid: true }));
    const signals: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      signals.push(init?.signal);
      const url = new URL(String(input)); const offset = Number(url.searchParams.get('offset') ?? '0'); const limit = Number(url.searchParams.get('limit') ?? '50');
      return Response.json(all.slice(offset, offset + limit));
    });
    const listed = await connected().listDomainAuthentications();
    expect(listed).toHaveLength(130);
    expect(listed.at(-1)).toMatchObject({ domain: 'd130.example' });
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it('reads every page of verified senders', async () => {
    const all = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, from_email: `s${i + 1}@example.com`, verified: true }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input)); const after = Number(url.searchParams.get('lastSeenID') ?? '0'); const limit = Number(url.searchParams.get('limit') ?? '50');
      return Response.json({ results: all.filter((sender) => sender.id > after).slice(0, limit) });
    });
    const listed = await connected().listVerifiedSenders();
    expect(listed).toHaveLength(130);
    expect(listed.at(-1)).toMatchObject({ from_email: 's130@example.com' });
  });

  it('refuses a list that repeats itself instead of looping or returning part of it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, domain: `d${i}.example`, valid: true }))));
    await expect(connected().listDomainAuthentications()).rejects.toThrow(/incomplete|repeated/i);
  });
});
