import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { createServer } from '../../server.js';
import { connectionSetupDetails, connectionSetupUrl, GITHUB_TOKEN_URLS, GITLAB_TOKEN_URLS, CLOUDFLARE_TOKEN_URLS } from '../../domain/services/connection-guidance.js';
import { parseToolEnvelope } from './tool-result.js';
import { buildRailwayGitHubRepoAccessHelp, buildRailwaySetupHelpInstructions } from '../../domain/services/railway-help.js';
import { missingProviderSecretsMessage } from '../../domain/services/ci-deploy.service.js';
import { splitActionScopedConnectionBlocks } from '../../application/apply-plan.js';
import { cloudflareRegistrarCredentialRequirement } from '../../domain/services/domain-registration.service.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';

let directory: string;
beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-form-links-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => {
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

async function withClient(run: (client: Client) => Promise<void>) {
  const server = createServer();
  const client = new Client({ name: 'form-link-contract', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { await run(client); }
  finally { await client.close(); await server.close(); }
}

function urls(setup: { setupUrls: string[] }): URL[] {
  return setup.setupUrls.map(link => new URL(link.slice(link.indexOf('https://'))));
}

// Expected browser parameters come from the official provider sources reviewed
// in docs/connection-form-links.md, not request-derived API response fixtures.
// No credential creation or authenticated provider browser is exercised here.
describe('contextual credential forms through MCP', () => {
  it.each(['tool description', 'discovery hint'])('%s requires contextual setup before showing a human form', async surface => {
    await withClient(async client => {
      const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'hv_connections')!;
      const result = await client.callTool({ name: 'hv_connections', arguments: {} });
      const hint = parseToolEnvelope(result).hint!;
      const guidance = surface === 'tool description' ? tool.description! : hint;
      expect(guidance).toContain('call hv_connections with action="describe", provider and the known non-secret scope');
      expect(guidance).toContain('before presenting a credential form');
      expect(guidance).toContain('Do not supply credentials, credentialsRef or confirmation to describe');
      expect(guidance).toContain('Copy the returned recommendedSetupUrl verbatim');
      expect(guidance).toContain('Do not initialize a project solely to obtain setup guidance');
      expect(hint).toContain('not completed scoped setup');
      expect(hint).toContain('Provider-owned bootstrap takes precedence');
      expect((await client.callTool({ name: 'hv_connections', arguments: {
        provider: 'github', scope: 'acme/storefront',
      } })).structuredContent).toHaveProperty('error.details.connectionSetup.recommendedSetupUrl');
    });
  });

  it.each(['add', 'verify'])('fills GitHub owner and meaningful labels for %s, preserving permissions', async action => {
    await withClient(async client => {
      const response = await client.callTool({
        name: 'hv_connections', arguments: { provider: 'github', action, scope: 'acme/storefront' },
      });
      const body = parseToolEnvelope(response);
      const setup = (body.error?.details as { connectionSetup: { setupUrls: string[]; recommendedSetupUrl: string; notes: string[] } }).connectionSetup;
      const fine = urls(setup).find(url => url.pathname === '/settings/personal-access-tokens/new')!;
      expect(fine.searchParams.get('target_name')).toBe('acme');
      expect(fine.searchParams.get('description')).toBe('Hypervibe repository management for acme/storefront');
      expect(fine.searchParams.get('name')).toBe('Hypervibe repository: acme/storefront');
      expect(fine.searchParams.get('expires_in')).toBe('90');
      expect(fine.searchParams.get('contents')).toBe('write');
      expect(fine.searchParams.get('workflows')).toBe('write');
      expect(fine.searchParams.has('repository')).toBe(false);
      const api = new URL(setup.recommendedSetupUrl);
      expect(api.searchParams.get('description')).toBe('Hypervibe GitHub API for acme/storefront');
      expect(api.searchParams.get('scopes')).toBe('repo,workflow');
      expect(api.searchParams.has('target_name')).toBe(false);
      expect(body.hint).toContain(fine.href);
      expect(JSON.stringify(response.content)).toContain(fine.href);
      expect(setup.notes.join(' ')).toContain('select the repositories manually');
    });
  });

  it('uses a declared GitLab instance and only its documented form fields', async () => {
    await withClient(async client => {
      const response = await client.callTool({ name: 'hv_connections', arguments: {
        provider: 'gitlab', action: 'verify', scope: 'https://gitlab.example.test/acme/storefront',
      } });
      const setup = (parseToolEnvelope(response).error?.details as { connectionSetup: { setupUrls: string[]; recommendedSetupUrl: string; notes: string[] } }).connectionSetup;
      const form = new URL(setup.recommendedSetupUrl);
      expect(form.origin).toBe('https://gitlab.example.test');
      expect(form.pathname).toBe('/-/user_settings/personal_access_tokens');
      expect(form.searchParams.get('description')).toBe('Hypervibe GitLab repository and CI for gitlab.example.test/acme/storefront');
      expect(form.searchParams.get('name')).toContain('acme/storefront');
      expect([...form.searchParams.keys()].sort()).toEqual(['description', 'name', 'scopes']);
      expect(form.searchParams.get('scopes')).toBe('api');
      expect(setup.notes.join(' ')).toContain('expiration manually');
      expect(JSON.stringify(response.content)).toContain(form.href);
    });
  });

  it('names Cloudflare forms for the domain without pretending a domain is an account or zone id', async () => {
    await withClient(async client => {
      const response = await client.callTool({ name: 'hv_connections', arguments: {
        provider: 'cloudflare', action: 'verify', scope: 'storefront.example',
      } });
      const setup = (parseToolEnvelope(response).error?.details as { connectionSetup: { setupUrls: string[] } }).connectionSetup;
      const forms = urls(setup).filter(url => url.hostname === 'dash.cloudflare.com');
      expect(forms).toHaveLength(2);
      for (const form of forms) {
        expect(form.searchParams.get('name')).toBe('Hypervibe DNS and domains: storefront.example');
        expect(form.searchParams.has('description')).toBe(false);
        expect(form.searchParams.has('expires_in')).toBe(false);
      }
      const user = forms.find(url => url.pathname === '/profile/api-tokens')!;
      expect(user.searchParams.get('accountId')).toBe('*');
      expect(user.searchParams.get('zoneId')).toBe('all');
      const account = forms.find(url => url.pathname === '/')!;
      expect(account.searchParams.has('accountId')).toBe(false);
      expect(account.searchParams.has('zoneId')).toBe(false);
    });
  });

  it('uses selected-project context in provider discovery without changing credential scope', async () => {
    const project = new ProjectRepository().create({
      name: 'storefront', defaultPlatform: 'railway', gitRemoteUrl: 'git@github.com:acme/storefront.git',
    });
    await withClient(async client => {
      const response = await client.callTool({ name: 'hv_connections', arguments: { project: project.name } });
      const data = parseToolEnvelope(response).data as { availableProviders: Record<string, Array<{ name: string; setupHelpUrls: Array<{ url: string }> }>> };
      const github = Object.values(data.availableProviders).flat().find(provider => provider.name === 'github')!;
      const fine = new URL(github.setupHelpUrls.find(link => link.url.includes('/personal-access-tokens/new'))!.url);
      expect(fine.searchParams.get('target_name')).toBe('acme');
      expect(fine.searchParams.get('description')).toContain('acme/storefront');
    });
  });

  it('uses repository context consistently for setup and hints without inventing a stored scope', async () => {
    const project = new ProjectRepository().create({
      name: 'storefront', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/acme/storefront.git',
    });
    await withClient(async client => {
      const response = await client.callTool({ name: 'hv_connections', arguments: {
        project: project.name, provider: 'github', action: 'verify',
      } });
      const body = parseToolEnvelope(response);
      const setup = (body.error?.details as { connectionSetup: { scope?: string; setupUrls: string[] } }).connectionSetup;
      const fine = urls(setup).find(url => url.pathname === '/settings/personal-access-tokens/new')!;
      expect(fine.searchParams.get('target_name')).toBe('acme');
      expect(body.hint).toContain(fine.href);
      expect(setup.scope).toBeUndefined();
    });
  });

  it('uses the selected GitLab scope only once in the connect command', () => {
    const setup = connectionSetupDetails('gitlab', { scope: 'https://gitlab.example.test/acme/storefront' });
    expect(setup.credentialExample.match(/scope=/g)).toHaveLength(1);
    expect(setup.credentialExample).toContain('scope="https://gitlab.example.test/acme/storefront"');
  });

  it('bounds names and encodes labels without adding parameters or guessing ownership', () => {
    const project = 'shop & café / staging?admin=true';
    const fine = new URL(connectionSetupUrl(GITHUB_TOKEN_URLS.fineGrained, { project }));
    expect(fine.searchParams.get('description')).toBe(`Hypervibe repository management for ${project}`);
    expect(fine.searchParams.has('admin')).toBe(false);
    expect(fine.searchParams.has('target_name')).toBe(false);
    expect(Array.from(fine.searchParams.get('name')!)).toHaveLength(40);
    const longestScope = `acme/${'x'.repeat(100)}`;
    const long = new URL(connectionSetupUrl(GITHUB_TOKEN_URLS.fineGrained, { scope: longestScope }));
    expect(long.searchParams.get('target_name')).toBe('acme');
    expect(long.searchParams.get('description')).toContain(longestScope);
    expect(long.searchParams.get('name')!.length).toBe(40);
    const gitlab = new URL(connectionSetupUrl(GITLAB_TOKEN_URLS.api, { project: 'x'.repeat(1500) }));
    expect(gitlab.searchParams.get('description')!.length).toBe(255);
    const cloudflare = new URL(connectionSetupUrl(CLOUDFLARE_TOKEN_URLS.user, { project: 'x'.repeat(1500) }));
    expect(cloudflare.searchParams.get('name')!.length).toBe(120);
  });

  it('keeps unknown scopes, credential-shaped labels, and unreviewed URLs out of prefill', () => {
    for (const scope of ['*', 'acme/storefront?admin=true', 'github_pat_secretshouldnotbeemitted', 'https://github.com/acme/storefront']) {
      expect(connectionSetupUrl(GITHUB_TOKEN_URLS.fineGrained, { scope })).toBe(GITHUB_TOKEN_URLS.fineGrained);
    }
    expect(connectionSetupUrl(GITLAB_TOKEN_URLS.api, { scope: 'https://user:password@gitlab.example.test/acme/storefront' })).toBe(GITLAB_TOKEN_URLS.api);
    expect(connectionSetupUrl(GITHUB_TOKEN_URLS.api, { project: 'github_pat_secretshouldnotbeemitted' })).toBe(GITHUB_TOKEN_URLS.api);
    expect(connectionSetupUrl('https://example.test/form?existing=true', { project: 'storefront' })).toBe('https://example.test/form?existing=true');
    const wildcard = new URL(connectionSetupUrl(GITHUB_TOKEN_URLS.fineGrained, { scope: 'acme/*' }));
    expect(wildcard.searchParams.get('target_name')).toBe('acme');
    expect(wildcard.searchParams.get('description')).toContain('acme/*');
  });

  it('keeps the optional Railway app-scope role contextual in both help surfaces', () => {
    const messages = [
      buildRailwayGitHubRepoAccessHelp('acme/storefront').nextSteps.join(' '),
      buildRailwaySetupHelpInstructions('acme/storefront'),
    ];
    for (const message of messages) {
      const link = message.match(/https:\/\/github\.com\/settings\/tokens\/new\?[^\s)]+/)![0];
      const form = new URL(link);
      expect(form.searchParams.get('description')).toBe('Hypervibe Railway app scope for acme/storefront');
      expect(form.searchParams.get('scopes')).toBe('repo');
    }
  });

  it('keeps package-read links contextual in CI setup and apply blockers', () => {
    const context = { project: 'storefront', scope: 'acme/storefront' };
    const messages = [
      missingProviderSecretsMessage('railway', ['IMAGE_REGISTRY_TOKEN'], context),
      ...splitActionScopedConnectionBlocks([], [{
        id: 'ci:deploy', type: 'update', verified: true,
        resource: { kind: 'ci', name: 'deploy', provider: 'github' }, reason: 'Missing package-read role',
        metadata: { operation: 'githubActionsDeployBranch', missingProviderSecrets: ['IMAGE_REGISTRY_TOKEN'] },
      }], context).actionScopedBlocked.map(block => block.reason ?? ''),
    ];
    for (const message of messages) {
      const link = message.match(/https:\/\/github\.com\/settings\/tokens\/new\?[^\s)]+/)![0];
      const form = new URL(link);
      expect(form.searchParams.get('description')).toBe('Hypervibe GHCR pull for acme/storefront');
      expect(form.searchParams.get('scopes')).toBe('read:packages');
    }
  });

  it('preserves the known Cloudflare account in the registrar credential form', () => {
    const accountId = 'a'.repeat(32);
    const repository = new ConnectionRepository();
    const connection = repository.create({
      provider: 'cloudflare', scope: 'storefront.example',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cfat_fake_test_credential', accountId }),
    });
    repository.updateStatus(connection.id, 'verified');
    const requirement = cloudflareRegistrarCredentialRequirement('storefront.example')!;
    const form = new URL(requirement.reason.match(/https:\/\/dash\.cloudflare\.com\/[^\s,]+/)![0]);
    expect(form.searchParams.get('name')).toBe('Hypervibe DNS and domains: storefront.example');
    expect(form.searchParams.get('accountId')).toBe(accountId);
    expect(form.searchParams.get('zoneId')).toBe('all');
    expect(requirement.reason).not.toContain('cfat_fake_test_credential');
    const accountForm = new URL(connectionSetupUrl(CLOUDFLARE_TOKEN_URLS.account, { accountId }));
    expect(accountForm.searchParams.has('accountId')).toBe(false);
    expect(accountForm.searchParams.has('zoneId')).toBe(false);
    const userForm = new URL(connectionSetupUrl(CLOUDFLARE_TOKEN_URLS.user, { accountId }));
    expect(userForm.searchParams.get('accountId')).toBe(accountId);
    expect(connectionSetupUrl(CLOUDFLARE_TOKEN_URLS.user, { accountId: 'not-a-native-id' })).toBe(CLOUDFLARE_TOKEN_URLS.user);
  });
});
