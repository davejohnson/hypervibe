import { describe, expect, it } from 'vitest';
import '../../../server.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { secretManagerRegistry } from '../../registry/secretmanager.registry.js';
import {
  formatConnectionGuidance,
  getConnectionGuidance,
} from '../connection-guidance.js';

describe('connection guidance', () => {
  const noSetupUrlExpected = new Set(['database', 'local', 'xcode']);

  it('covers every registered provider and secret manager', () => {
    const providers = [...providerRegistry.names(), ...secretManagerRegistry.names()].sort();
    const missing = providers.filter((provider) => !getConnectionGuidance(provider));

    expect(missing).toEqual([]);
    for (const provider of providers) {
      const guidance = formatConnectionGuidance(provider);
      expect(guidance).toContain('Token/credential type:');
      expect(guidance).toContain('Required permissions:');
      expect(guidance).toContain('Connect with:');
      if (!noSetupUrlExpected.has(provider)) {
        expect(guidance, provider).toContain('Create or review it here:');
        expect(guidance, provider).toMatch(/https?:\/\//);
      }
    }
  });

  it('keeps token guidance specific enough for agents to act on', () => {
    const providers = [...providerRegistry.names(), ...secretManagerRegistry.names()].sort();

    for (const provider of providers) {
      const guidance = getConnectionGuidance(provider)!;
      expect(guidance.displayName.trim().length, provider).toBeGreaterThan(0);
      expect(guidance.tokenType.trim().length, provider).toBeGreaterThan(0);
      expect(guidance.permissions.length, provider).toBeGreaterThan(0);
      expect(guidance.credentialExample, provider).toContain('hv_connect provider=');
      expect(
        guidance.credentialExample.includes('credentialsRef=')
        || guidance.credentialExample.includes('credentials='),
        provider
      ).toBe(true);

      if (!noSetupUrlExpected.has(provider)) {
        expect(guidance.setupUrl, provider).toMatch(/^https?:\/\//);
        expect(formatConnectionGuidance(provider), provider).toContain('Create or review it here:');
      }

      for (const permission of guidance.permissions) {
        expect(permission.trim().length, `${provider}: ${permission}`).toBeGreaterThan(20);
        expect(permission, provider).not.toMatch(/^(read|write|admin|full access|valid token)\.?$/i);
      }
    }
  });

  it('tells users the Cloudflare token type, URL, permissions, and scoped connect command', () => {
    const guidance = formatConnectionGuidance('cloudflare', { scope: 'invoiceperfect.com' });

    expect(guidance).toContain('Cloudflare Account API Token');
    expect(guidance).toContain('Cloudflare User API Token');
    expect(guidance).toContain('single User API Token');
    expect(guidance).toContain('no second token is needed');
    expect(guidance).toContain('registrarApiToken');
    expect(guidance).toContain('CLOUDFLARE_REGISTRAR_API_TOKEN');
    expect(guidance).toContain('DNS, custom domains, and email routing');
    expect(guidance).toContain('Registrar/domain purchase');
    expect(guidance).toContain('Account API Tokens for DNS/custom domains/email routing');
    expect(guidance).toContain('https://dash.cloudflare.com/?to=/:account/api-tokens');
    expect(guidance).toContain('User API Tokens for Registrar/domain purchase');
    expect(guidance).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(guidance).toContain('cfat_');
    expect(guidance).toContain('cfut_');
    expect(guidance).toContain('Zone -> Zone -> Read');
    expect(guidance).toContain('Zone -> Zone Settings -> Read or Edit');
    expect(guidance).toContain('Zone -> DNS -> Edit.');
    expect(guidance).toContain('Zone Resources must be Include -> Specific zone -> the target domain');
    expect(guidance).toContain('Email Routing Rules');
    expect(guidance).toContain('Email Routing Addresses');
    expect(guidance).toContain('Registrar write permissions');
    expect(guidance).toContain('Account API Tokens cannot be used for Registrar');
    expect(guidance).toContain('scope="invoiceperfect.com"');
    expect(guidance).not.toContain('scope="example.com"');
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
    // Every token role carries its own pre-filled creation URL.
    expect(guidance).toContain('https://github.com/settings/tokens/new?scopes=repo,workflow&description=Hypervibe%20GitHub%20API');
    expect(guidance).toContain('https://github.com/settings/tokens/new?scopes=read:packages&description=Hypervibe%20GHCR%20pull');
    expect(guidance).toContain('apiToken');
    expect(guidance).toContain('packageReadToken');
    expect(guidance).toContain('fine-grained PAT');
  });

  it('keeps provider-specific token guidance actionable', () => {
    const expectations: Record<string, string[]> = {
      railway: [
        'https://railway.com/account/tokens',
        'No workspace',
        'create projects, services, environments, variables, databases, domains, and deployments',
      ],
      sendgrid: [
        'https://app.sendgrid.com/settings/api_keys',
        'mail.send',
        'whitelabel.read',
        'Full Access',
      ],
      cloudrun: [
        'https://console.cloud.google.com/iam-admin/serviceaccounts',
        'roles/run.admin',
        'roles/iam.serviceAccountUser',
        'roles/artifactregistry.admin',
      ],
      cloudsql: [
        'https://console.cloud.google.com/iam-admin/serviceaccounts',
        'roles/cloudsql.admin',
        'roles/cloudsql.client',
      ],
      supabase: [
        'https://supabase.com/dashboard/account/tokens',
        'personal access token',
        'Owner or Administrator',
      ],
      stripe: [
        'https://dashboard.stripe.com/apikeys',
        'sk_test_',
        'sk_live_',
        'Webhook Endpoints',
      ],
      appstoreconnect: [
        'https://appstoreconnect.apple.com/access/integrations/api',
        'Team Key',
        'App Manager',
        'Admin role',
      ],
      doppler: [
        'https://docs.doppler.com/docs/service-tokens',
        'service token',
        'read/write',
      ],
      bitwarden: [
        'https://bitwarden.com/help/access-tokens/',
        'machine account',
        'organizationId',
      ],
      vault: [
        'https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2',
        'Vault token',
        'AppRole',
      ],
      '1password': [
        'https://www.1password.dev/service-accounts/',
        'service account token',
        'vaults',
      ],
      'aws-secrets': [
        'https://docs.aws.amazon.com/secretsmanager/',
        'secretsmanager:GetSecretValue',
        'secretsmanager:ListSecrets',
      ],
    };

    for (const [provider, expectedSnippets] of Object.entries(expectations)) {
      const guidance = formatConnectionGuidance(provider);
      for (const snippet of expectedSnippets) {
        expect(guidance, `${provider}: ${snippet}`).toContain(snippet);
      }
    }
  });
});
