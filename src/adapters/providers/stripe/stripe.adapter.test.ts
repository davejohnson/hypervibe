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

  it('accepts restricted keys and derives their Stripe mode', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'acct_development' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const stripe = new StripeAdapter();
    stripe.connect({ secretKey: 'rk_test_development' });

    await expect(stripe.verify()).resolves.toEqual({
      success: true,
      accountId: 'acct_development',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/account',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer rk_test_development' }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(stripe.getRuntimeCredentials('sandbox')).toMatchObject({
      secretKey: 'rk_test_development',
      mode: 'sandbox',
    });
  });

  it('enumerates timeout failures at the Stripe boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }));

    await expect(adapter().listProducts('sandbox')).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 0,
      kind: 'timeout',
      message: expect.stringContaining('timed out'),
    } satisfies Partial<StripeApiError>);
  });

  it('enumerates malformed provider payloads instead of casting them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html>not json</html>', { status: 502 })
    ));

    await expect(adapter().listProducts('sandbox')).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 502,
      kind: 'malformed_response',
    } satisfies Partial<StripeApiError>);
  });

  it('sends tax_code when creating a product', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        id: 'prod_starter',
        name: 'Starter',
        description: null,
        tax_code: 'txcd_10103001',
        active: true,
        metadata: {},
        created: 1,
        updated: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    await adapter().createProduct('sandbox', {
      name: 'Starter',
      tax_code: 'txcd_10103001',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/products',
      expect.objectContaining({
        body: expect.stringContaining('tax_code=txcd_10103001'),
      })
    );
  });

  it('sends tax_code when updating a product', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        id: 'prod_starter',
        name: 'Starter',
        description: null,
        tax_code: 'txcd_10103001',
        active: true,
        metadata: {},
        created: 1,
        updated: 2,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    await adapter().updateProduct('sandbox', 'prod_starter', {
      tax_code: 'txcd_10103001',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/products/prod_starter',
      expect.objectContaining({
        body: expect.stringContaining('tax_code=txcd_10103001'),
      })
    );
  });
});
