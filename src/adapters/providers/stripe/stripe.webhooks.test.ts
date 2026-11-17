import { afterEach, describe, expect, it, vi } from 'vitest';
import { StripeAdapter } from './stripe.adapter.js';
import { stripeWebhookCreationKey } from '../../../domain/services/stripe-env.service.js';

// #331: Stripe lists are paged (has_more + starting_after). One page is not the account.
// #372: Stripe replays the original response for a repeated Idempotency-Key, which is how a
// create whose response was lost is recovered without making a second endpoint.
afterEach(() => vi.unstubAllGlobals());
const connected = () => { const stripe = new StripeAdapter(); stripe.connect({ secretKey: 'sk_test_example' }); return stripe; };
const endpoint = (n: number) => ({ id: `we_${n}`, url: `https://app.example/hook/${n}`, enabled_events: ['invoice.paid'], status: 'enabled' });

describe('Stripe webhook endpoints', () => {
  it('reads every page', async () => {
    const all = Array.from({ length: 130 }, (_, i) => endpoint(i + 1));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input)); const after = url.searchParams.get('starting_after');
      const start = after ? all.findIndex((item) => item.id === after) + 1 : 0;
      const data = all.slice(start, start + 100);
      return Response.json({ object: 'list', data, has_more: start + 100 < all.length });
    }));
    const listed = await connected().listWebhookEndpoints('sandbox');
    expect(listed).toHaveLength(130);
    expect(listed.at(-1)!.id).toBe('we_130');
  });

  it('refuses a list that keeps reporting more without advancing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ object: 'list', data: [endpoint(1)], has_more: true })));
    await expect(connected().listWebhookEndpoints('sandbox')).rejects.toThrow(/incomplete|repeated/i);
  });

  it('sends the creation key so a repeated create returns the first endpoint', async () => {
    const headers: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init: RequestInit) => { headers.push(init.headers as Record<string, string>); return Response.json({ ...endpoint(1), secret: 'whsec_example' }); }));
    await connected().createWebhookEndpoint('sandbox', 'https://app.example/hook/1', ['invoice.paid'], { idempotencyKey: 'hv-webhook-abc' });
    expect(headers[0]!['Idempotency-Key']).toBe('hv-webhook-abc');
  });
});

describe('webhook creation key', () => {
  const intent = { environmentId: 'env-1', name: 'billing', url: 'https://app.example/hook', events: ['invoice.paid', 'charge.failed'], replaces: undefined as string | undefined };
  it('is the same for a retry of the same creation, whatever the event order', () => {
    expect(stripeWebhookCreationKey(intent)).toBe(stripeWebhookCreationKey({ ...intent, events: ['charge.failed', 'invoice.paid'] }));
    expect(stripeWebhookCreationKey(intent)).toMatch(/^hv-webhook-[0-9a-f]{32}$/);
  });
  it('differs for a different endpoint, environment or replacement', () => {
    const keys = new Set([intent, { ...intent, url: 'https://app.example/other' }, { ...intent, environmentId: 'env-2' }, { ...intent, replaces: 'we_old' }, { ...intent, events: ['invoice.paid'] }].map(stripeWebhookCreationKey));
    expect(keys.size).toBe(5);
  });
});
