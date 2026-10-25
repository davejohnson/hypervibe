import { afterEach, expect, it, vi } from 'vitest';
import { validateCredential } from '../../../domain/registry/credential-validation.registry.js';
import '../../../application/providers.js';

// Synthetic observations reconstructed from the official GET contracts linked
// in docs/credential-lifecycle.md. No claim of live authentication compatibility.
afterEach(() => vi.unstubAllGlobals());
const key = 'synthetic-private-input';
const base = { role: 'runtime', label: 'Runtime', purpose: 'Application access' };
it('rejects the wrong Stripe account even with the same test key prefix', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'acct_wrong', object: 'account' })));
  const result = await validateCredential({ ...base, kind: 'stripe', identity: { accountId: 'acct_expected', mode: 'test' } }, 'sk_test_synthetic');
  expect(result.result).toBe('failed');
  expect(result.tested).toMatch(/account/);
});
it('models authentication does not attest application operations', async () => {
  const fetcher = vi.fn(async (_url: unknown) => Response.json({ data: [{ id: 'model-id', type: 'model', display_name: 'Model', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'model-id', last_id: 'model-id' }));
  vi.stubGlobal('fetch', fetcher);
  const result = await validateCredential({ ...base, kind: 'anthropic' }, key);
  expect(result).toMatchObject({ result: 'passed', tested: expect.stringMatching(/authentication/), applicationOperation: 'unknown' });
  expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(key);
  expect(JSON.stringify(result)).not.toContain(key);
});
it('SendGrid scopes verify authentication and reported permissions, never delivery', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ scopes: ['mail.send'] })));
  expect(await validateCredential({ ...base, kind: 'sendgrid' }, key)).toMatchObject({ result: 'passed', applicationOperation: 'unknown' });
});
it('does not expose provider bodies on a rejected credential', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(key, { status: 401 })));
  const result = await validateCredential({ ...base, kind: 'anthropic' }, key);
  expect(result.result).toBe('failed');
  expect(JSON.stringify(result)).not.toContain(key);
});
it('unknown validation remains distinct from successful authentication', async () => {
  expect(await validateCredential({ ...base, kind: 'opaque' }, key)).toMatchObject({ result: 'unknown', at: null, applicationOperation: 'unknown' });
});
