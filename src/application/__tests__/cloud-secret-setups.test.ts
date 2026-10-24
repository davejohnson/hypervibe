import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { secretContainerScopeDigest } from '../../domain/ports/secret-destination-lifecycle.port.js';

let root: string;
const token = `hvc_12345678-1234-4234-8234-123456789abc_${'A'.repeat(43)}`;
const destination = { provider: 'gcp-secret-manager', projectId: 'synthetic-project', projectNumber: '123456789012', secretId: 'staging-api-key' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
  root = mkdtempSync(path.join(tmpdir(), 'hv-secret-setup-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(root, 'state.db')).migrate();
  git('init', '-b', 'review/secrets'); git('remote', 'add', 'origin', 'https://github.com/studio/app.git');
  mkdirSync(path.join(root, '.hypervibe'));
  writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify({ version: 1, project: 'app',
    secrets: { API_KEY: { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] } },
    environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} }, secretDestinations: { API_KEY: { destination } } } } }));
  git('add', '.hypervibe/spec.json'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'reviewed destinations');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const source = { branch: 'review/secrets', revision: git('rev-parse', 'HEAD'),
    digest: createHash('sha256').update(readFileSync(path.join(root, '.hypervibe/spec.json'))).digest('hex') };
  const remote = { schemaVersion: 1, project: { id: 'app-id', name: 'App', repository: 'studio/app' },
    environment: { id: 'env-id', key: 'staging', name: 'Staging' }, source,
    host: { status: 'ready', provider: 'gcp', serviceAccountEmail: 'hoster@synthetic-host.iam.gserviceaccount.com' },
    destinations: [{ key: 'API_KEY', destination, status: 'needs_setup' }] };
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET'; requests.push({ url: String(url), method, body });
    const payload = String(url).endsWith('/pairings') ? {
      deviceCode: 'B'.repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: 2,
      repository: 'studio/app', userCode: '2345-6789', purpose: 'secret-destinations', environment: 'staging',
      verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789',
    } : String(url).endsWith('/pairing-exchanges') ? {
      status: 'completed', purpose: 'secret-destinations', environment: 'staging', applied: 1, skipped: 0,
      project: { id: 'app-id', name: 'App' }, credentials: [{ token, expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        environment: { id: 'env-id', key: 'staging', name: 'Staging' } }],
    } : method === 'DELETE' ? { applied: 1, skipped: 0 } : method === 'POST' && String(url).endsWith('/secret-destination-setups') ? {
      schemaVersion: 1, projectId: 'app-id', environmentId: 'env-id', sourceRevision: source.revision, sourceDigest: source.digest,
      applied: body.connections.length, skipped: 0, results: body.connections.map(({ key }: { key: string }) => ({ key, status: 'connected', connectionId: `connection-${key}` })),
    } : remote;
    return new Response(JSON.stringify(payload));
  });
  vi.stubGlobal('fetch', fetchImpl);
  const context = createCommandContext();
  context.repos.projects.create({ name: 'app', gitRemoteUrl: 'https://github.com/studio/app.git', defaultPlatform: 'cloudrun' });
  const commands = createCommandRegistry(context);
  const run = (input: Record<string, unknown>) => runWithWorkspaceDirectories([root], () => commands.execute('hv_cloud_connections', {
    purpose: 'secret-destinations', env: 'staging', ...input,
  }));
  const pair = async () => { expect((await run({ action: 'start' })).ok).toBe(true); expect((await run({ action: 'status' })).ok).toBe(true); };
  const prepareFixture = async () => {
    await pair(); const preview = await run({ action: 'preview' }); expect(preview.ok).toBe(true);
    const row = context.repos.connections.findByProviderAndScope('hypervibe-secret-destinations', 'https://hypervibe.dev|studio/app|staging')!;
    const state = context.secretStore.decryptObject(row.credentialsEncrypted) as { preview: Record<string, unknown> };
    state.preview.writerIdentity = { serviceAccountEmail: 'writer@synthetic-project.iam.gserviceaccount.com', uniqueId: '123456789' };
    context.repos.connections.upsert({ provider: row.provider, scope: row.scope, credentialsEncrypted: context.secretStore.encryptObject(state) });
    const bindings = Object.fromEntries(remote.destinations.map(({ key, destination: target }) => [key, {
      destination: target, owner: { repository: 'github.com/studio/app', environment: 'staging', key },
      attemptId: '12345678-1234-4234-8234-123456789abc', state: 'ready',
      resource: `projects/${target.projectNumber}/secrets/${target.secretId}`, createTime: '2026-10-24T12:00:00Z',
    }]));
    context.repos.environments.create({ projectId: context.repos.projects.findByName('app')!.id, name: 'staging',
      platformBindings: { provider: 'cloudrun', secretDestinationContainers: bindings } });
    vi.spyOn(context.adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { secretDestinationSetup: {
      providers: ['gcp-secret-manager'], observe: async (_env: unknown, target: typeof destination) => {
        const binding = Object.values(bindings).find(item => item.destination.secretId === target.secretId)!;
        return { ...binding, state: 'present', scopeDigest: secretContainerScopeDigest(binding as never), hasVersions: false };
      },
    } } as never });
    return state.preview.id as string;
  };
  return { context, remote, requests, fetchImpl, run, pair, prepareFixture };
}

describe('owner-approved cloud secret setup through the real command boundary', () => {
  // Independent policy: the owner requires agent-led setup without uploading
  // deploy keys or retaining application values. Monitoring is not writer consent.
  it('starts a separate environment-scoped approval and returns no credential material', async () => {
    const f = fixture(); const result = await f.run({ action: 'start' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { status: 'pending', env: 'staging', verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789' } });
    expect(f.requests[0].body).toEqual({ repositoryFullName: 'studio/app', purpose: 'secret-destinations', environment: 'staging', sourceBranch: 'review/secrets' });
    expect(JSON.stringify(result)).not.toContain('B'.repeat(43));
  });
  it('previews the exact committed targets without reading a deployment credential', async () => {
    const f = fixture(); await f.pair(); const result = await f.run({ action: 'preview' });
    expect(result).toMatchObject({ ok: true, data: { status: 'setup_required', source: f.remote.source,
      destinationTargets: [{ key: 'API_KEY', destination }], nextSteps: expect.any(Array) } });
    expect(f.requests.at(-1)?.method).toBe('GET'); expect(JSON.stringify(result)).not.toContain(token);
  });
  it.each(['repository', 'environment', 'revision', 'digest', 'branch', 'destination'])('rejects substituted %s before cloud setup', async changed => {
    const f = fixture(); await f.pair();
    if (changed === 'repository') f.remote.project.repository = 'another/app';
    if (changed === 'environment') f.remote.environment.key = 'production';
    if (changed === 'revision') f.remote.source.revision = 'f'.repeat(40);
    if (changed === 'digest') f.remote.source.digest = 'f'.repeat(64);
    if (changed === 'branch') f.remote.source.branch = 'production';
    if (changed === 'destination') f.remote.destinations[0].destination = { ...destination, secretId: 'another-secret' };
    expect(await f.run({ action: 'preview' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(f.requests.filter(r => r.method === 'POST' && r.url.includes('secret-destination-setups'))).toHaveLength(0);
  });
  it('rejects local credential uploads and unreviewed prepare/connect requests', async () => {
    const f = fixture(); await f.pair();
    expect(await f.run({ action: 'connect', credentialsRef: 'env:DEPLOY_KEY', confirm: true })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await f.run({ action: 'prepare', adminAuth: 'default', confirm: true })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(await f.run({ action: 'connect', confirm: true })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
  });
  it('reconciles an already connected destination without another IAM setup or registration', async () => {
    const f = fixture(); await f.pair(); f.remote.destinations[0].status = 'connected';
    const preview = await f.run({ action: 'preview' });
    expect(preview).toMatchObject({ ok: true, data: { status: 'connected', nextSteps: [] } });
    const previewId = (preview as { data: { previewId: string } }).data.previewId;
    const result = await f.run({ action: 'connect', previewId, confirm: true });
    expect(result).toMatchObject({ ok: true, data: { status: 'connected', applied: 0, skipped: 1 } });
    expect(f.requests.filter(r => r.method === 'POST' && r.url.includes('secret-destination-setups'))).toHaveLength(0);
  });
  it('blocks an unavailable hosted identity and dirty local source without cloud writes', async () => {
    const f = fixture(); await f.pair(); f.remote.host.status = 'unavailable';
    expect(await f.run({ action: 'preview' })).toMatchObject({ ok: true, data: { status: 'blocked', nextSteps: [] } });
    const count = f.requests.length;
    writeFileSync(path.join(root, '.hypervibe/spec.json'), readFileSync(path.join(root, '.hypervibe/spec.json'), 'utf8') + '\n');
    expect(await f.run({ action: 'preview' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(f.requests).toHaveLength(count);
  });
  it('does not reuse reporting or monitoring access as writer consent', async () => {
    const f = fixture();
    const existing = f.context.repos.connections.upsertVerifiedBatch([{ provider: 'hypervibe-provider-connections',
      scope: 'https://hypervibe.dev|studio/app', credentialsEncrypted: f.context.secretStore.encryptObject({ token }) }])[0];
    expect(await f.run({ action: 'preview' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(f.requests).toHaveLength(0);
    expect(f.context.repos.connections.findById(existing.id)).not.toBeNull();
  });
  it('discovers a value-free destination proposal from the connected cloud without asking for names or project numbers', async () => {
    const file = path.join(root, '.hypervibe/spec.json'); const spec = JSON.parse(readFileSync(file, 'utf8'));
    delete spec.environments.staging.secretDestinations; writeFileSync(file, JSON.stringify(spec));
    git('add', '.hypervibe/spec.json'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'needs destination discovery');
    const before = readFileSync(file, 'utf8'); const f = fixture();
    const discover = vi.fn(async () => ({ state: 'known', destinations: { API_KEY: destination } }));
    vi.spyOn(f.context.adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true,
      adapter: { secretDestinationSetup: { providers: ['gcp-secret-manager'], discover } } as never });
    const result = await f.run({ action: 'discover' });
    expect(result).toMatchObject({ ok: true, data: { status: 'review_required',
      destinationTargets: [{ key: 'API_KEY', destination, status: 'proposed' }], nextStep: { command: 'hv_spec' } } });
    expect(discover).toHaveBeenCalledWith(expect.any(Object), { repository: 'github.com/studio/app', environment: 'staging', keys: ['API_KEY'] });
    expect(f.requests).toHaveLength(0); expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('registers larger environments sequentially with one reviewed destination per request', async () => {
    const file = path.join(root, '.hypervibe/spec.json'); const spec = JSON.parse(readFileSync(file, 'utf8'));
    for (let i = 0; i < 20; i++) {
      spec.secrets[`KEY_${i}`] = spec.secrets.API_KEY;
      spec.environments.staging.secretDestinations[`KEY_${i}`] = { destination: { ...destination, secretId: `staging-key-${i}` } };
    }
    writeFileSync(file, JSON.stringify(spec)); git('add', '.hypervibe/spec.json');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'larger reviewed environment');
    const f = fixture();
    f.remote.destinations = Object.entries(spec.environments.staging.secretDestinations).map(([key, slot]) => ({ key, destination: (slot as { destination: typeof destination }).destination, status: 'needs_setup' }));
    const previewId = await f.prepareFixture();
    const result = await f.run({ action: 'connect', previewId, confirm: true });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { status: 'connected', applied: 21, skipped: 0 } });
    const writes = f.requests.filter(request => request.method === 'POST' && request.url.endsWith('/secret-destination-setups'));
    expect(writes).toHaveLength(21);
    expect(writes.every(request => (request.body!.connections as unknown[]).length === 1)).toBe(true);
  }, 30_000);
  it('does not recreate revoked local setup access after an in-flight hosted inspection', async () => {
    const f = fixture(); await f.pair();
    const original = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (init?.method === 'GET') {
        const row = f.context.repos.connections.findByProviderAndScope('hypervibe-secret-destinations', 'https://hypervibe.dev|studio/app|staging')!;
        f.context.repos.connections.delete(row.id);
      }
      return response;
    });
    expect(await f.run({ action: 'preview' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(f.context.repos.connections.findByProviderAndScope('hypervibe-secret-destinations', 'https://hypervibe.dev|studio/app|staging')).toBeNull();
  });
  it.each(['dirty-spec', 'missing-spec', 'removed-destinations', 'changed-branch'])('revokes exact stored access independently of deployment source: %s', async changed => {
    const f = fixture(); await f.pair();
    const file = path.join(root, '.hypervibe/spec.json');
    if (changed === 'dirty-spec') writeFileSync(file, readFileSync(file, 'utf8') + '\n');
    if (changed === 'missing-spec') rmSync(file);
    if (changed === 'removed-destinations') {
      const spec = JSON.parse(readFileSync(file, 'utf8')); delete spec.environments.staging.secretDestinations;
      writeFileSync(file, JSON.stringify(spec)); git('add', '.hypervibe/spec.json');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'remove destination declarations');
    }
    if (changed === 'changed-branch') git('checkout', '-b', 'another/source');
    const result = await f.run({ action: 'revoke', confirm: true, baseUrl: 'https://hypervibe.dev' });
    expect(result).toMatchObject({ ok: true, data: { status: 'revoked', env: 'staging', applied: 1 } });
    expect(f.requests.filter(request => request.method === 'DELETE')).toEqual([{ url: 'https://hypervibe.dev/api/v1/secret-destination-access', method: 'DELETE', body: undefined }]);
    expect(f.context.repos.connections.findByProviderAndScope('hypervibe-secret-destinations', 'https://hypervibe.dev|studio/app|staging')).toBeNull();
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it.each(['repository', 'origin', 'environment', 'confirmation'])('does not broaden revocation authority across %s', async changed => {
    const f = fixture(); await f.pair();
    const count = f.requests.length;
    if (changed === 'repository') git('remote', 'set-url', 'origin', 'https://github.com/another/app.git');
    const result = await f.run({ action: 'revoke', confirm: changed !== 'confirmation',
      ...(changed === 'origin' ? { baseUrl: 'https://another.example.test' } : {}),
      ...(changed === 'environment' ? { env: 'production' } : {}) });
    expect(result).toMatchObject({ ok: false }); expect(f.requests).toHaveLength(count);
    expect(f.context.repos.connections.findByProviderAndScope('hypervibe-secret-destinations', 'https://hypervibe.dev|studio/app|staging')).not.toBeNull();
  });
  it.each(['source', 'local-grant', 'hosted-grant'])('retains confirmed registration receipts when later %s admission stops', async changed => {
    const file = path.join(root, '.hypervibe/spec.json'), spec = JSON.parse(readFileSync(file, 'utf8'));
    spec.secrets.SECOND_KEY = spec.secrets.API_KEY;
    spec.environments.staging.secretDestinations.SECOND_KEY = { destination: { ...destination, secretId: 'staging-second-key' } };
    writeFileSync(file, JSON.stringify(spec)); git('add', '.hypervibe/spec.json');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'two reviewed destinations');
    const f = fixture(); f.remote.destinations.push({ key: 'SECOND_KEY', destination: spec.environments.staging.secretDestinations.SECOND_KEY.destination, status: 'needs_setup' });
    const previewId = await f.prepareFixture(), original = f.fetchImpl.getMockImplementation()!;
    let registered = false;
    f.fetchImpl.mockImplementation(async (url, init) => {
      if (registered && init?.method === 'GET' && changed === 'hosted-grant') return new Response('denied', { status: 403 });
      const response = await original(url, init);
      if (init?.method === 'POST' && String(url).endsWith('/secret-destination-setups')) {
        registered = true;
        if (changed === 'source') f.remote.source.digest = 'f'.repeat(64);
        if (changed === 'local-grant') {
          // Let the first response pass its own local-state fence. Revoke before
          // the next native metadata read, so the earlier receipt is confirmed.
          const lookup = f.context.adapterFactory.getProviderAdapter;
          vi.mocked(lookup).mockImplementationOnce(async () => {
            const row = f.context.repos.connections.findByProviderAndScope('hypervibe-secret-destinations', 'https://hypervibe.dev|studio/app|staging')!;
            f.context.repos.connections.delete(row.id);
            return { success: false, error: 'synthetic revoked setup' };
          });
        }
      }
      return response;
    });
    const result = await f.run({ action: 'connect', previewId, confirm: true });
    expect(result).toMatchObject({ ok: true, data: { status: 'partial', outcome: 'confirmed', applied: 1, skipped: 0,
      results: [{ key: 'API_KEY', status: 'connected' }], pendingKeys: ['SECOND_KEY'], reason: 'admission_blocked' } });
    expect(f.requests.filter(request => request.method === 'POST' && request.url.endsWith('/secret-destination-setups'))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('requires owned ready containers before writer preparation, even with a valid hosted preview', async () => {
    const f = fixture(); await f.pair(); const preview = await f.run({ action: 'preview' });
    const previewId = (preview as { data: { previewId: string } }).data.previewId;
    expect(await f.run({ action: 'prepare', previewId, adminAuth: 'default' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
  it('returns an unknown registration outcome after a lost acknowledgment and reconciles without another write', async () => {
    const f = fixture(); const previewId = await f.prepareFixture(); const original = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (init?.method === 'POST' && String(url).endsWith('/secret-destination-setups')) {
        f.remote.destinations[0].status = 'connected'; throw new Error('synthetic lost acknowledgment');
      }
      return response;
    });
    expect(await f.run({ action: 'connect', previewId, confirm: true })).toMatchObject({ ok: true, data: {
      status: 'partial', outcome: 'unknown', pendingKeys: ['API_KEY'], nextStep: { input: { action: 'status' } },
    } });
    expect(await f.run({ action: 'connect', previewId, confirm: true })).toMatchObject({ ok: true, data: { status: 'connected', applied: 0, skipped: 1 } });
    expect(f.requests.filter(request => request.method === 'POST' && request.url.endsWith('/secret-destination-setups'))).toHaveLength(1);
  });
  it('returns the exact permission plan only after verified container readiness', async () => {
    const f = fixture(); const previewId = await f.prepareFixture();
    const result = await f.run({ action: 'prepare', previewId, adminAuth: 'default' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { status: 'confirmation_required', preparation: { success: true,
      mode: 'preview', plan: { projectId: destination.projectId, secretIds: [destination.secretId],
        hostServiceAccountEmail: f.remote.host.serviceAccountEmail } }, nextStep: { input: { action: 'prepare', confirm: true, adminAuth: 'default' } } } });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(f.requests.every(request => !request.url.includes('googleapis.com'))).toBe(true);
  });
});
