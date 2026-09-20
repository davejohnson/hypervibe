import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { createCloudConnections } from '../cloud-connections.js';
import { createCommandRegistry } from '../commands.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { runCli } from '../../interfaces/cli/run.js';

let root: string;
const NOW = new Date('2026-09-20T12:00:00Z');
const token = `hvc_12345678-1234-4234-8234-123456789abc_${'A'.repeat(43)}`;
const secret = 'private-test-token-must-not-appear';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hv-cloud-connections-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(root, 'state.db')).migrate();
  git('init'); git('remote', 'add', 'origin', 'https://github.com/studio/app.git');
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true });
});
function provider(providerId = 'cloudflare', scope = 'project', kind = 'cloudflare-api-token') {
  return { providerId, name: providerId, status: 'disconnected',
    authorization: { scope, method: 'token', credentialKind: kind, label: 'Access', help: 'Private reference' },
    canReuseAuthorization: false,
    environments: ['staging', 'production'].map(key => ({ id: key, key, name: key, status: 'disconnected' })) };
}
function fixture() {
  const context = createCommandContext();
  const providers = [provider()];
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | undefined; authorization: string | null }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const method = init?.method ?? 'GET';
    requests.push({ url: String(url), method, body, authorization: new Headers(init?.headers).get('authorization') });
    let response;
    if (String(url).endsWith('/pairings')) response = {
      deviceCode: 'B'.repeat(43), expiresAt: '2026-09-20T12:10:00.000Z', intervalSeconds: 2,
      repository: 'studio/app', userCode: '2345-6789', purpose: 'provider-connections',
      verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789',
    };
    else if (String(url).endsWith('/pairing-exchanges')) response = {
      status: 'completed', purpose: 'provider-connections', applied: 1, skipped: 0,
      project: { id: 'app-id', name: 'App' }, credentials: [{ token, expiresAt: '2026-10-20T12:00:00.000Z',
        environment: { id: 'staging', key: 'staging', name: 'Staging' } }],
    };
    else if (method === 'GET') response = { project: { id: 'app-id', name: 'App' }, coverage: 'complete', providers };
    else if (method === 'DELETE') response = { applied: 1, skipped: 0 };
    else {
      const item = providers.find(item => item.providerId === body.providerId)!;
      const targets = item.environments.filter(env => !body.secrets || env.id in body.secrets);
      response = { projectId: 'app-id', providerId: item.providerId,
        applied: targets.filter(env => env.status !== 'connected').length,
        skipped: targets.filter(env => env.status === 'connected').length,
        results: targets.map(env => ({ environmentId: env.id, environmentName: secret,
          status: env.status === 'connected' ? 'already_connected' : 'connected', message: `echo ${secret}` })),
      };
      targets.forEach(env => { env.status = 'connected'; });
    }
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const app = createCloudConnections({ context, fetchImpl, directory: () => root, now: () => NOW });
  async function pair() { await app.run({ action: 'start' }); await app.run({ action: 'status' }); }
  function connection(name = 'cloudflare', scope: string | null = 'studio/app', value: Record<string, string> = { apiToken: secret }) {
    return context.repos.connections.upsertVerifiedBatch([{ provider: name, scope,
      credentialsEncrypted: context.secretStore.encryptObject(value) }])[0]!;
  }
  return { context, providers, requests, fetchImpl, app, pair, connection };
}

describe('hosted provider connection sharing', () => {
  it('pairs separately from reporting and stores the expiring grant encrypted without output tokens', async () => {
    const f = fixture(); f.connection('hypervibe-cloud', 'studio/app', { token: 'reporting-do-not-touch' });
    const started = await f.app.run({ action: 'start' });
    const verified = await f.app.run({ action: 'status' });
    expect(f.requests[0]!.body).toEqual({ repositoryFullName: 'studio/app', purpose: 'provider-connections' });
    expect(JSON.stringify([started, verified])).not.toContain(token);
    expect(JSON.stringify(started)).not.toContain('B'.repeat(43));
    expect(verified).toMatchObject({ status: 'verified', expiresAt: '2026-10-20T12:00:00.000Z' });
    expect(f.context.secretStore.decryptObject(f.context.repos.connections.findByProviderAndScope('hypervibe-cloud', 'studio/app')!.credentialsEncrypted)).toEqual({ token: 'reporting-do-not-touch' });
  });

  it('requires an exact reviewed preview and returns only value-free receipts through the real serialized boundary', async () => {
    const f = fixture(); f.connection(); await f.pair();
    const preview = await f.app.run({ action: 'preview' });
    expect(preview).toMatchObject({ baseUrl: 'https://hypervibe.dev', repository: 'studio/app', project: { id: 'app-id' },
      providers: [{ providerId: 'cloudflare', status: 'ready', sourceScope: 'studio/app',
        destinations: [{ id: 'staging' }, { id: 'production' }] }] });
    await expect(f.app.run({ action: 'connect' })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    const result = await f.app.run({ action: 'connect', previewId: 'previewId' in preview ? preview.previewId : '', confirm: true });
    expect(f.requests.at(-1)).toMatchObject({ method: 'POST', authorization: `Bearer ${token}`,
      body: { providerId: 'cloudflare', expectedEnvironmentIds: ['production', 'staging'], secret } });
    expect(result).toMatchObject({ status: 'completed', applied: 2, skipped: 0 });
    expect(JSON.stringify([preview, result])).not.toContain(secret);
    expect(JSON.stringify([preview, result])).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('message');
  });

  it('skips connected destinations and reuses hosted authorization before resolving local values', async () => {
    const f = fixture(); await f.pair(); f.providers[0]!.canReuseAuthorization = true;
    f.providers[0]!.environments[0]!.status = 'connected';
    const preview = await f.app.run({ action: 'preview' });
    expect(preview).toMatchObject({ providers: [{ source: 'hosted_connection', skippedEnvironments: 1 }] });
    const result = await f.app.run({ action: 'connect', previewId: 'previewId' in preview ? preview.previewId : '', confirm: true });
    expect(f.requests.at(-1)?.body).toEqual({ providerId: 'cloudflare', expectedEnvironmentIds: ['production', 'staging'] });
    expect(result).toMatchObject({ applied: 1, skipped: 1 });
    const second = await f.app.run({ action: 'preview' });
    expect(second).toMatchObject({ providers: [{ status: 'already_connected', skippedEnvironments: 2 }] });
  });

  it('never treats a deployment account token or SendGrid sending key as monitoring credentials', async () => {
    const f = fixture(); f.providers.splice(0, 1,
      provider('railway', 'environment', 'railway-project-token'), provider('sendgrid', 'environment', 'sendgrid-webhook-verification-key'));
    f.connection('railway'); f.connection('sendgrid', 'studio/app', { apiKey: secret }); await f.pair();
    expect(await f.app.run({ action: 'preview' })).toMatchObject({ providers: [
      { providerId: 'railway', status: 'needs_access' }, { providerId: 'sendgrid', status: 'needs_access' },
    ] });
  });

  it('requires explicit environment and credential kind for a private reference, never copying it across environments', async () => {
    const f = fixture(); f.providers.splice(0, 1, provider('railway', 'environment', 'railway-project-token')); await f.pair();
    vi.stubEnv('TEST_MONITORING_ACCESS', secret);
    const input = { provider: 'railway', credentialsRef: 'env:TEST_MONITORING_ACCESS', credentialKind: 'railway-project-token' };
    expect(await f.app.run(input)).toMatchObject({ providers: [{ status: 'needs_access' }] });
    const preview = await f.app.run({ ...input, env: 'staging' });
    const result = await f.app.run({ ...input, env: 'staging', action: 'connect', previewId: 'previewId' in preview ? preview.previewId : '', confirm: true });
    expect(f.requests.at(-1)?.body).toEqual({ providerId: 'railway', expectedEnvironmentIds: ['production', 'staging'], secrets: { staging: secret } });
    expect(result).toMatchObject({ applied: 1 });
    expect(f.providers[0]!.environments[1]!.status).toBe('disconnected');
  });

  it('serializes explicitly selected structured observer files without a user-invented wrapper', async () => {
    const f = fixture(); const observer = provider('cloudrun', 'environment', 'gcp-observer-service-account');
    observer.authorization.method = 'workload-identity'; f.providers.splice(0, 1, observer); await f.pair();
    const document = { type: 'service_account', private_key: secret, project_id: 'fixture' };
    const file = path.join(root, 'observer.json'); writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
    const input = { provider: 'cloudrun', env: 'staging', credentialsRef: `file:${file}`, credentialKind: 'gcp-observer-service-account' };
    const preview = await f.app.run(input);
    expect(preview).toMatchObject({ providers: [{ status: 'ready' }] });
    const result = await f.app.run({ ...input, action: 'connect', previewId: 'previewId' in preview ? preview.previewId : '', confirm: true });
    expect(f.requests.at(-1)?.body).toEqual({ providerId: 'cloudrun', expectedEnvironmentIds: ['production', 'staging'], secrets: { staging: JSON.stringify(document) } });
    expect(JSON.stringify([preview, result])).not.toContain(secret);
  });

  it('preserves real resource mutation counts and allows untouched environment results', async () => {
    const f = fixture(); f.providers.splice(0, 1, provider('railway', 'environment', 'railway-project-token')); await f.pair();
    vi.stubEnv('TEST_MONITORING_ACCESS', secret);
    const input = { provider: 'railway', env: 'staging', credentialsRef: 'env:TEST_MONITORING_ACCESS', credentialKind: 'railway-project-token' };
    const preview = await f.app.run(input);
    const actualFetch = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(actualFetch).mockImplementationOnce(async () => new Response(JSON.stringify({
      projectId: 'app-id', providerId: 'railway', applied: 4, skipped: 1,
      results: [{ environmentId: 'staging', environmentName: 'Staging', status: 'connected', message: 'Two resources created and activated' },
        { environmentId: 'production', environmentName: 'Production', status: 'skipped', message: 'No access supplied' }],
    })));
    expect(await f.app.run({ ...input, action: 'connect', previewId: 'previewId' in preview ? preview.previewId : '', confirm: true }))
      .toMatchObject({ status: 'completed', applied: 4, skipped: 1, results: [{ results: [{ environmentId: 'staging', status: 'connected' }, { environmentId: 'production', status: 'skipped' }] }] });
  });

  it('rejects unrelated saved scopes and only allows a global connection after explicit selection', async () => {
    const f = fixture(); f.connection('cloudflare', 'studio/another'); const global = f.connection('cloudflare', null); await f.pair();
    expect(await f.app.run({})).toMatchObject({ providers: [{ status: 'needs_access' }] });
    expect(await f.app.run({ provider: 'cloudflare', connectionId: global.id })).toMatchObject({ providers: [{ status: 'ready', sourceScope: 'global' }] });
  });

  it('blocks another repository or origin without sending the existing grant', async () => {
    const f = fixture(); await f.pair(); const count = f.requests.length;
    await expect(f.app.run({ baseUrl: 'https://staging.hypervibe.dev' })).rejects.toThrow('browser approval');
    git('remote', 'set-url', 'origin', 'https://github.com/studio/other.git');
    await expect(f.app.run({})).rejects.toThrow('browser approval');
    expect(f.requests).toHaveLength(count);
  });

  it('blocks empty or ambiguous MCP roots instead of choosing the first project', async () => {
    const f = fixture(); await f.pair();
    await expect(runWithWorkspaceDirectories([], () => f.app.run({}))).rejects.toThrow('repository');
    await expect(runWithWorkspaceDirectories([root, tmpdir()], () => f.app.run({}))).rejects.toThrow('repository');
  });

  it('invalidates changed previews and retries partial uploads only after fresh observation', async () => {
    const f = fixture(); f.connection(); await f.pair();
    const preview = await f.app.run({});
    f.connection('cloudflare', 'studio/app', { apiToken: 'rotated-fixture' });
    await expect(f.app.run({ action: 'connect', previewId: 'previewId' in preview ? preview.previewId : '', confirm: true })).rejects.toThrow('changed or expired');
    const fresh = await f.app.run({});
    const actualFetch = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(actualFetch).mockImplementationOnce(async () => { throw new Error(secret); });
    const partial = await f.app.run({ action: 'connect', previewId: 'previewId' in fresh ? fresh.previewId : '', confirm: true });
    expect(partial).toMatchObject({ status: 'partial', applied: 0, results: [{ status: 'unknown' }] });
    expect(JSON.stringify(partial)).not.toContain(secret);
    await expect(f.app.run({ action: 'connect', previewId: 'previewId' in fresh ? fresh.previewId : '', confirm: true })).rejects.toThrow('changed or expired');
  });

  it.each(['missing', 'skipped'])('never claims completion for a selected %s destination receipt', async kind => {
    const f = fixture(); f.connection(); await f.pair();
    const preview = await f.app.run({});
    const actualFetch = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(actualFetch).mockImplementationOnce(async () => new Response(JSON.stringify({
      projectId: 'app-id', providerId: 'cloudflare', applied: 0, skipped: 0,
      results: kind === 'missing' ? [] : f.providers[0]!.environments.map(env => ({
        environmentId: env.id, environmentName: env.name, status: 'skipped', message: 'No supported target found',
      })),
    })));
    const result = await f.app.run({ action: 'connect', previewId: 'previewId' in preview ? preview.previewId : '', confirm: true });
    expect(result).toMatchObject({ status: 'partial', results: [{ status: kind === 'missing' ? 'unknown' : 'partial' }] });
  });

  it('blocks incomplete destination coverage before preview approval or upload', async () => {
    const f = fixture(); await f.pair();
    f.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ project: { id: 'app-id', name: 'App' }, coverage: 'partial', providers: f.providers })));
    await expect(f.app.run({})).rejects.toThrow('every connection destination');
    expect(f.requests.filter(request => request.url.endsWith('provider-connections') && request.method === 'POST')).toHaveLength(0);
  });

  it('revokes the separate grant and leaves provider/reporting connections alone', async () => {
    const f = fixture(); const local = f.connection(); await f.pair();
    await expect(f.app.run({ action: 'revoke' })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(await f.app.run({ action: 'revoke', confirm: true })).toMatchObject({ status: 'revoked' });
    expect(f.requests.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://hypervibe.dev/api/v1/provider-connection-access' });
    expect(f.context.repos.connections.findById(local.id)?.status).toBe('verified');
    await expect(f.app.run({})).rejects.toThrow('browser approval');
  });

  it('requires the real revoke receipt before claiming success or removing local access', async () => {
    const f = fixture(); await f.pair();
    f.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ revoked: true })));
    await expect(f.app.run({ action: 'revoke', confirm: true })).rejects.toThrow('revocation');
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'verified' });
    expect(f.requests.filter(request => request.url.endsWith('/pairings'))).toHaveLength(1);
    expect(await f.app.run({ action: 'revoke', confirm: true })).toMatchObject({ status: 'revoked', applied: 1 });
  });

  it('does not erase a newer local grant when an older revoke finishes', async () => {
    const f = fixture(); await f.pair();
    const scope = 'https://hypervibe.dev|studio/app';
    const replacement = `hvc_12345678-1234-4234-8234-123456789abc_${'Z'.repeat(43)}`;
    f.fetchImpl.mockImplementationOnce(async () => {
      const stored = f.context.repos.connections.findByProviderAndScope('hypervibe-provider-connections', scope)!;
      const prior = f.context.secretStore.decryptObject<Record<string, unknown>>(stored.credentialsEncrypted);
      f.context.repos.connections.updateCredentials(stored.id, f.context.secretStore.encryptObject({ ...prior, token: replacement }));
      return new Response(JSON.stringify({ applied: 1, skipped: 0 }));
    });
    await f.app.run({ action: 'revoke', confirm: true });
    const current = f.context.repos.connections.findByProviderAndScope('hypervibe-provider-connections', scope);
    expect(current).not.toBeNull();
    expect(f.context.secretStore.decryptObject(current!.credentialsEncrypted)).toMatchObject({ token: replacement });
  });

  it.each([401, 403])('recovers a remotely rejected %s grant without touching reporting or provider access', async status => {
    const f = fixture(); const source = f.connection();
    const reporting = f.connection('hypervibe-cloud', 'studio/app', { token: 'reporting-unchanged' });
    await f.pair();
    f.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: secret } }), { status }));
    await expect(f.app.run({ action: 'status' })).rejects.toThrow('Start a new browser approval');
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'pending' });
    expect(f.requests.filter(request => request.url.endsWith('/pairings'))).toHaveLength(2);
    expect(f.context.repos.connections.findById(source.id)).toBeTruthy();
    expect(f.context.repos.connections.findById(reporting.id)).toBeTruthy();
  });

  it('checks an existing grant on start and replaces rejected access immediately', async () => {
    const f = fixture(); await f.pair();
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'verified' });
    expect(f.requests.at(-1)).toMatchObject({ method: 'GET', authorization: `Bearer ${token}` });
    expect(f.requests.filter(request => request.url.endsWith('/pairings'))).toHaveLength(1);
    f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'pending' });
    expect(f.requests.filter(request => request.url.endsWith('/pairings'))).toHaveLength(2);
  });

  it.each(['network', 'server'])('preserves a verified grant after a %s failure', async failure => {
    const f = fixture(); await f.pair();
    if (failure === 'network') f.fetchImpl.mockRejectedValueOnce(new Error(secret));
    else f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await expect(f.app.run({ action: 'start' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'verified' });
    expect(f.requests.filter(request => request.url.endsWith('/pairings'))).toHaveLength(1);
  });

  it('lets a rejected revoke recover through a new approval', async () => {
    const f = fixture(); await f.pair();
    f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(f.app.run({ action: 'revoke', confirm: true })).rejects.toThrow('Start a new browser approval');
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'pending' });
  });

  it('reports authorization lost during upload and permits a fresh browser approval', async () => {
    const f = fixture(); f.connection(); await f.pair();
    const preview = await f.app.run({}); const actualFetch = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(actualFetch).mockResolvedValueOnce(new Response('{}', { status: 403 }));
    const result = await f.app.run({ action: 'connect', previewId: 'previewId' in preview ? preview.previewId : '', confirm: true });
    expect(result).toMatchObject({ status: 'partial', results: [{ status: 'access_required', nextStep: expect.stringContaining('Start a new browser approval') }] });
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'pending' });
  });

  it('restarts browser approval after a definite consumed or invalid exchange response', async () => {
    const f = fixture(); await f.app.run({ action: 'start' });
    f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 400 }));
    await expect(f.app.run({ action: 'status' })).rejects.toThrow('Start a new browser approval');
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'pending' });
    expect(f.requests.filter(request => request.url.endsWith('/pairings'))).toHaveLength(2);
  });

  it('preserves a pending grant after a lost exchange response and recovers from its consumed retry', async () => {
    const f = fixture(); await f.app.run({ action: 'start' });
    f.fetchImpl.mockRejectedValueOnce(new Error(secret));
    await expect(f.app.run({ action: 'status' })).rejects.toThrow('Could not reach');
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'pending' });
    expect(f.requests.filter(request => request.url.endsWith('/pairings'))).toHaveLength(1);
    f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 400 }));
    await expect(f.app.run({ action: 'status' })).rejects.toThrow('Start a new browser approval');
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'pending' });
    expect(f.requests.filter(request => request.url.endsWith('/pairings'))).toHaveLength(2);
  });

  it.each([429, 500])('retains pending pairing after a retryable %s exchange response', async status => {
    const f = fixture(); await f.app.run({ action: 'start' });
    f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status }));
    await expect(f.app.run({ action: 'status' })).rejects.toThrow();
    expect(await f.app.run({ action: 'start' })).toMatchObject({ status: 'pending' });
    expect(f.requests.filter(request => request.url.endsWith('/pairings'))).toHaveLength(1);
    expect(await f.app.run({ action: 'status' })).toMatchObject({ status: 'verified' });
  });

  it('routes CLI through the same command and rejects raw credentials', async () => {
    const f = fixture(); const registry = createCommandRegistry(f.context);
    expect(await registry.execute('hv_cloud_connections', { credentials: { apiToken: secret } })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    let out = ''; let err = '';
    const code = await runWithWorkspaceDirectories([root], () => runCli(['cloud', 'connections', '--json'], {
      registry, initialize: false, io: { stdinIsTTY: false, readStdin: async () => '', writeOut: text => { out += text; }, writeErr: text => { err += text; }, confirm: async () => false },
    }));
    expect(code).toBe(1); expect(err).toBe('');
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: expect.stringContaining('browser approval') } });
    expect(out).not.toContain(secret);
  });
});
