import { afterEach, expect, it, vi } from 'vitest';
import { DOMAIN_VERIFY_OPERATION, executeDomainAction } from '../infrastructure-engine-domain.js';

afterEach(() => vi.unstubAllGlobals());

it('does not enable a missing Google API while verifying a domain', async () => {
  // Synthetic provider transport, independent OpenTofu-only ownership contract.
  const fetch = vi.fn(async () => new Response('SERVICE_DISABLED', { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  const result = await executeDomainAction({ gcpProjectId: 'example-project', region: 'us-central1',
    adapter: { siteVerificationAccessToken: async () => 'synthetic', engineAccessToken: async () => 'synthetic' } as never,
  }, { id: 'domain:example.com', type: 'create', resource: { provider: 'gcp', kind: 'domain', name: 'example.com' },
    verified: true, reason: 'Verify ownership', metadata: { operation: DOMAIN_VERIFY_OPERATION, domain: 'example.com' } });
  expect(result).toMatchObject({ success: false, status: 'blocked' });
  expect(fetch.mock.calls).toHaveLength(1);
});
