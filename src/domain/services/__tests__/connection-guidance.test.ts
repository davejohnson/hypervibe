import { describe, expect, it } from 'vitest';
import '../../../server.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { secretManagerRegistry } from '../../registry/secretmanager.registry.js';
import {
  formatConnectionGuidance,
  getConnectionGuidance,
} from '../connection-guidance.js';

describe('connection guidance', () => {
  it('covers every registered provider and secret manager', () => {
    const providers = [...providerRegistry.names(), ...secretManagerRegistry.names()].sort();
    const missing = providers.filter((provider) => !getConnectionGuidance(provider));

    expect(missing).toEqual([]);
    for (const provider of providers) {
      const guidance = formatConnectionGuidance(provider);
      expect(guidance).toContain('Token/credential type:');
      expect(guidance).toContain('Required permissions:');
      expect(guidance).toContain('Connect with:');
    }
  });

  it('tells users the Cloudflare token type, URL, permissions, and scoped connect command', () => {
    const guidance = formatConnectionGuidance('cloudflare', { scope: 'invoiceperfect.com' });

    expect(guidance).toContain('Cloudflare User API Token');
    expect(guidance).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(guidance).toContain('Zone -> Zone -> Read');
    expect(guidance).toContain('Zone -> DNS -> Edit/Write');
    expect(guidance).toContain('scope="invoiceperfect.com"');
    expect(guidance).toContain('Do not use the legacy Global API Key');
  });

  it('includes GitHub package permissions for CI image deploys', () => {
    const guidance = formatConnectionGuidance('github', {
      intro: 'Confirm the GitHub token type and package permissions.',
    });

    expect(guidance).toContain('classic personal access token');
    expect(guidance).toContain('https://github.com/settings/tokens');
    expect(guidance).toContain('repo');
    expect(guidance).toContain('workflow');
    expect(guidance).toContain('read:packages');
  });
});
