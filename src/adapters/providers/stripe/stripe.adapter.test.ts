import { afterEach, describe, expect, it, vi } from 'vitest';
import { StripeAdapter, StripeApiError } from './stripe.adapter.js';

function adapter(): StripeAdapter {
  const stripe = new StripeAdapter();
  stripe.connect({ secretKey: 'sk_test_example' });
  return stripe;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StripeAdapter observation semantics', () => {
  it('treats only a provider-confirmed 404 as webhook absence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'No such webhook endpoint' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    ));

    await expect(adapter().getWebhookEndpoint('sandbox', 'we_missing')).resolves.toBeNull();
  });

  it('preserves permission errors as unknown instead of planning from false absence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Permission denied' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    ));

    await expect(adapter().getWebhookEndpoint('sandbox', 'we_unknown')).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 403,
      message: 'Permission denied',
    } satisfies Partial<StripeApiError>);
  });
});
