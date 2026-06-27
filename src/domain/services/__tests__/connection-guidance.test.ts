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

    expect(guidance).toContain('Cloudflare Account API Token');
    expect(guidance).toContain('Cloudflare User API Token');
    expect(guidance).toContain('DNS, custom domains, and email routing');
    expect(guidance).toContain('Registrar/domain purchase');
    expect(guidance).toContain('Cloudflare Dashboard -> Manage Account -> Account API Tokens');
    expect(guidance).toContain('https://dash.cloudflare.com/?to=/:account/api-tokens');
    expect(guidance).toContain('Cloudflare Dashboard -> My Profile -> API Tokens');
    expect(guidance).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(guidance).toContain('cfat_');
    expect(guidance).toContain('cfut_');
    expect(guidance).toContain('Zone -> Zone -> Read');
    expect(guidance).toContain('Zone -> Zone Settings -> Read or Edit');
    expect(guidance).toContain('Zone -> DNS -> Edit/Write');
    expect(guidance).toContain('scope="invoiceperfect.com"');
    expect(guidance).toContain('accountId');
    expect(guidance).toContain('Do not use the legacy Global API Key');
  });

  it('includes GitHub package permissions for CI image deploys', () => {
    const guidance = formatConnectionGuidance('github', {
      intro: 'Confirm the GitHub token type and package permissions.',
    });

    expect(guidance).toContain('classic personal access token');
    expect(guidance).toContain('https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages');
    expect(guidance).toContain('repo');
    expect(guidance).toContain('workflow');
    expect(guidance).toContain('read:packages');
    expect(guidance).toContain('read:packages-only token is not enough');
    expect(guidance).toContain('apiToken');
    expect(guidance).toContain('packageReadToken');
    expect(guidance).toContain('fine-grained PAT');
  });
});
