import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../../../server.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { secretManagerRegistry } from '../../registry/secretmanager.registry.js';
import {
  credentialFieldsFromSchema,
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

    expect(guidance).toContain('classic GitHub personal access token');
    expect(guidance).toContain('fine-grained repository token');
    expect(guidance).toContain('https://github.com/settings/personal-access-tokens/new');
    expect(guidance).toContain('Contents read/write');
    expect(guidance).toContain('Workflows read/write');
    expect(guidance).toContain('read:packages');
    expect(guidance).toContain('read:packages-only token cannot manage repository infrastructure');
    // Every token role carries its own pre-filled creation URL.
    expect(guidance).toContain('https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys');
    expect(guidance).toContain('https://github.com/settings/tokens/new?scopes=repo,workflow&description=Hypervibe%20GitHub%20API');
    expect(guidance).toContain('https://github.com/settings/tokens/new?scopes=read:packages&description=Hypervibe%20GHCR%20pull');
    expect(guidance).toContain('apiToken');
    expect(guidance).toContain('packageReadToken');
    expect(guidance).toContain('NODE_AUTH_TOKEN');
    expect(guidance).toContain('HYPERVIBE_GITHUB_TOKEN');
    expect(guidance).toContain('HYPERVIBE_GITHUB_PACKAGES_TOKEN');
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
        'roles/cloudsql.viewer',
        'roles/cloudsql.admin',
        'roles/cloudsql.client',
      ],
      rds: [
        'https://console.aws.amazon.com/iam/home#/security_credentials',
        'AWS IAM access key',
        'rds:DescribeDBInstances',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupIngress',
        'credentialsRef="file:/absolute/path/rds.json"',
      ],
      ecs: [
        'https://console.aws.amazon.com/iam/home#/security_credentials',
        'AWS IAM user access key',
        'ecs:ListAccountSettings',
        'ecs:CreateService',
        'ecs:DeleteTaskDefinitions',
        'ecr:GetAuthorizationToken',
        'ecr:PutImage',
        'ec2:DescribeSubnets',
        'elasticloadbalancing:DescribeRules',
        'iam:PassRole',
        'ecs-tasks.amazonaws.com',
        'private-ECR pull permissions',
        'serviceLongArnFormat',
        'target type ip',
        'publicUrl',
        'HTTPS-only',
        'credentialsRef="file:/absolute/path/aws-ecs.json"',
      ],
      supabase: [
        'https://supabase.com/dashboard/account/tokens',
        'personal access token',
        'Owner or Administrator',
      ],
      neon: [
        'https://console.neon.tech/app/settings/api-keys',
        'personal API key or organization API key',
        'create, read, and delete projects',
        'project-scoped organization API key',
        'organizationId',
        'credentialsMap={"apiKey":"NEON_API_KEY"',
      ],
      digitalocean: [
        'https://cloud.digitalocean.com/account/api/tokens',
        'personal access token',
        'database:read',
        'database:view_credentials',
        'database:create',
        'regions:read',
        'app:create',
        'registry:read',
        'registry:update',
        'containerRegistry',
        'Full Access is a broader fallback',
        'credentialsRef="file:/absolute/path/digitalocean.json"',
      ],
      vercel: [
        'https://vercel.com/account/settings/tokens',
        'personal access token',
        'vcp_',
        'Create Project',
        'Full Production Deployment',
        'Environment Variable Manager',
        'teamId',
        'source-less Vercel Projects',
        'framework/static auto-detection',
        'long-lived start commands',
        'credentialsRef="file:/absolute/path/vercel.json"',
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
      'azure-container-apps': [
        'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
        'Microsoft Entra application service principal',
        'Container Apps Contributor',
        '358470bc-b998-42bd-ab17-a7e34c199c0f',
        'Container Apps ManagedEnvironments Contributor',
        '57cc5028-e6a7-4284-868d-0611c5923f8d',
        'AcrPush',
        '8311e382-0749-4cb8-b61a-304f252e45ec',
        'Container Registry Repository Writer',
        'registryId',
        'credentialsRef="file:/absolute/path/azure-container-apps.json"',
      ],
      'azure-postgres': [
        'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
        'Microsoft Entra application service principal',
        'Microsoft.DBforPostgreSQL/flexibleServers/read',
        'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/read',
        'start/end are 0.0.0.0',
        'credentialsRef="file:/absolute/path/azure-postgres.json"',
      ],
      'azure-managed-redis': [
        'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
        'Microsoft Entra application service principal',
        'Azure Managed Redis Contributor',
        '3015e5ed-6856-4ab3-b2f0-b8492aa30ca6',
        'listKeys',
        'credentialsRef="file:/absolute/path/azure-managed-redis.json"',
      ],
    };

    for (const [provider, expectedSnippets] of Object.entries(expectations)) {
      const guidance = formatConnectionGuidance(provider);
      for (const snippet of expectedSnippets) {
        expect(guidance, `${provider}: ${snippet}`).toContain(snippet);
      }
    }
  });

  it('keeps deliberately excluded hosting providers out of connection guidance', () => {
    expect(getConnectionGuidance('heroku')).toBeUndefined();
    expect(getConnectionGuidance('render')).toBeUndefined();
    expect(getConnectionGuidance('fly')).toBeUndefined();
  });
});

describe('credentialFieldsFromSchema', () => {
  it('describes required, optional, secret, multiline, and choice fields', () => {
    const schema = z.object({
      apiToken: z.string().min(1),
      workspaceId: z.string().optional(),
      credentials: z.string().describe('Service account JSON'),
      authMode: z.enum(['account', 'user']).default('account'),
    });

    expect(credentialFieldsFromSchema(schema)).toEqual([
      { name: 'apiToken', label: 'API Token', required: true, sensitive: true, inputKind: 'secret' },
      { name: 'workspaceId', label: 'Workspace ID', required: false, sensitive: false, inputKind: 'text' },
      {
        name: 'credentials',
        label: 'Credentials',
        required: true,
        sensitive: true,
        inputKind: 'multilineSecret',
        description: 'Service account JSON',
      },
      {
        name: 'authMode',
        label: 'Auth Mode',
        required: false,
        sensitive: false,
        inputKind: 'choice',
        options: ['account', 'user'],
      },
    ]);
  });

  it('unwraps a refined object schema', () => {
    const schema = z.object({ token: z.string() }).refine((value) => value.token.length > 0);
    expect(credentialFieldsFromSchema(schema)?.[0]).toMatchObject({
      name: 'token',
      required: true,
      sensitive: true,
    });
  });

  it('returns an empty descriptor list for providers that need no credentials', () => {
    expect(credentialFieldsFromSchema(z.object({}))).toEqual([]);
  });

  it('omits form metadata for schemas that cannot be represented safely', () => {
    expect(credentialFieldsFromSchema(z.union([z.string(), z.object({ token: z.string() })]))).toBeUndefined();
  });
});
