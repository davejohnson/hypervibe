import { describe, expect, it } from 'vitest';
import {
  callCustomDomainAttach,
  customDomainAttachUnsupportedMessage,
  providerRequiresCustomDomainAttach,
  supportsCustomDomainAttach,
} from '../domain-attach-policy.js';

describe('domain attach policy', () => {
  it('requires provider-side domain attachment for managed hosting providers', () => {
    for (const provider of ['apprunner', 'cloudrun', 'digitalocean', 'heroku', 'railway', 'render', 'vercel']) {
      expect(providerRequiresCustomDomainAttach(provider), provider).toBe(true);
    }
  });

  it('detects adapters that implement custom-domain attachment', () => {
    expect(supportsCustomDomainAttach({ attachCustomDomain: async () => ({ success: true, message: 'ok' }) })).toBe(true);
    expect(supportsCustomDomainAttach({})).toBe(false);
    expect(supportsCustomDomainAttach(null)).toBe(false);
  });

  it('calls attachCustomDomain with the adapter as this', async () => {
    const adapter = {
      client: 'railway-client',
      async attachCustomDomain(this: { client?: string }, params: { domain: string }) {
        return {
          success: this.client === 'railway-client',
          message: 'attached',
          data: { domain: params.domain, client: this.client },
        };
      },
    };

    await expect(callCustomDomainAttach(adapter, {
      serviceId: 'svc-1',
      environmentId: 'env-1',
      domain: 'example.com',
    })).resolves.toMatchObject({
      success: true,
      data: { client: 'railway-client' },
    });
  });

  it('explains that DNS is not changed when provider attach is unsupported', () => {
    const message = customDomainAttachUnsupportedMessage('vercel', 'example.com');
    expect(message).toContain('provider-side custom-domain attachment');
    expect(message).toContain('DNS was not changed');
    expect(message).toContain('vercel');
  });
});
