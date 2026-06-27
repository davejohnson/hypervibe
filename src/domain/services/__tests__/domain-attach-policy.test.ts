import { describe, expect, it } from 'vitest';
import {
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

  it('explains that DNS is not changed when provider attach is unsupported', () => {
    const message = customDomainAttachUnsupportedMessage('vercel', 'example.com');
    expect(message).toContain('provider-side custom-domain attachment');
    expect(message).toContain('DNS was not changed');
    expect(message).toContain('vercel');
  });
});
