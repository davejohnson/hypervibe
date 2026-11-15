import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { runCli } from '../../interfaces/cli/run.js';
import { registerCommandRegistry } from '../../interfaces/mcp/adapter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const environmentId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const token = 'hvc_44444444-4444-4444-8444-444444444444_' + 'A'.repeat(43);
const baseUrl = 'https://hypervibe.dev';
const fields = [
  { key: 'CLIENT_ID', label: 'CLIENT ID', inputType: 'password' },
  { key: 'CLIENT_SECRET', label: 'CLIENT SECRET', inputType: 'password' },
];
let root: string;
let revision: string;
let digest: string;
let expiresAt: string;
let context: ReturnType<typeof createCommandContext>;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
const sessionScope = `${baseUrl}|studio/app|staging`;
function storeGrant(overrides = {}) {
  const stored = context.repos.connections.upsert({ provider: 'hypervibe-cloud-requests', scope: sessionScope, credentialsEncrypted: context.secretStore.encryptObject({
    version: 1, status: 'verified', baseUrl, repository: 'studio/app', env: 'staging',
    project: { id: projectId, name: 'App' }, environment: { id: environmentId, key: 'staging', name: 'Staging' }, token,
    expiresAt: new Date(Date.now() + 86400000).toISOString(), ...overrides,
  }) });
  context.repos.connections.updateStatus(stored.id, 'verified');
}
function savedReview() {
  const stored = context.repos.connections.findByProviderAndScope('hypervibe-cloud-requests', sessionScope)!;
  return context.secretStore.decryptObject<{ review?: { pendingWrite: boolean; proposal?: unknown } }>(stored.credentialsEncrypted).review;
}
function storePlan(keys = ['CLIENT_ID', 'CLIENT_SECRET'], suppliedKeys: string[] = ['CLIENT_SECRET']) {
  const spec = projectSpecSchema.parse(JSON.parse(readFileSync(path.join(root, '.hypervibe/spec.json'), 'utf8')));
  const project = context.repos.projects.create({ name: spec.project, gitRemoteUrl: spec.gitRemoteUrl });
  const environment = context.repos.environments.create({ projectId: project.id, name: 'staging' });
  new ProjectSpecRepository().insert(project.id, 1, spec);
  const run = context.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
    kind: 'hv_plan', scope: 'full', environmentName: 'staging', specRevision: 1, sourceCommitSha: revision,
    observedFingerprint: null, actions: [], inputRequired: keys.map(key => ({ key, principal: 'email:owner@example.test', reason: 'Explicit input required; live state unverified.' })),
    overrides: { delegatedSecretKeys: suppliedKeys },
  } });
  context.repos.runs.updateStatus(run.id, 'succeeded');
  return run.id;
}
function request(overrides = {}) {
  return {
    id: requestId, projectId, environmentId, recipient: 'owner@example.test', authentication: 'email', title: 'App credentials', fields,
    delivery: [], sourceBranch: 'review/credentials', sourceRevision: revision,
    environment: { id: environmentId, key: 'staging', name: 'Staging' }, status: 'pending', keys: ['CLIENT_ID', 'CLIENT_SECRET'], suppliedKeys: [], submissions: [],
    expiresAt, submittedAt: null, consumedAt: null,
    verification: 'presence_only', deployment: 'not_authorized', ...overrides,
  };
}
function setup(options: { requests?: unknown[]; source?: unknown; mutation?: unknown } = {}) {
  const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/credential-request-fields')) return Response.json({ availableFields: fields, sourceError: null, source: options.source ?? { revision, digest }, selectedEnvironmentId: environmentId, sourceBranch: 'review/credentials', environments: [{ id: environmentId, name: 'Staging', preferred: true }] });
    if (init?.method === 'GET' && target.pathname.endsWith('/credential-requests')) return Response.json({ requests: options.requests ?? [], pagination: { page: Number(target.searchParams.get('page') ?? 1), pageSize: 20, total: options.requests?.length ?? 0, pageCount: options.requests?.length ? 1 : 0, hasNext: false, hasPrevious: false } });
    if (init?.method === 'GET') return Response.json({ request: request() });
    if (init?.method === 'DELETE') return Response.json({ applied: 1, skipped: 0, request: request({ status: 'revoked' }) });
    return Response.json(options.mutation ?? { applied: 1, skipped: 0, request: request(), delivery: 'queued' }, { status: 201 });
  });
  vi.stubGlobal('fetch', transport);
  const registry = createCommandRegistry(context);
  const run = (input: Record<string, unknown> = {}) => runWithWorkspaceDirectories([root], () => registry.execute('hv_cloud_requests', input));
  return { transport, registry, run, writes: () => transport.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'DELETE') };
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hv-declarative-requests-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(root, 'state.db')).migrate();
  context = createCommandContext();
  git('init', '-b', 'review/credentials');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  git('remote', 'add', 'origin', 'https://github.com/studio/app.git');
  mkdirSync(path.join(root, '.hypervibe'));
  const slot = { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] };
  writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify({ version: 1, project: 'App', gitRemoteUrl: 'https://github.com/studio/app.git', environments: { staging: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } } }, production: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } } } }, secrets: { CLIENT_ID: slot, CLIENT_SECRET: slot, PROD_ONLY: { ...slot, environments: ['production'] } } }));
  git('add', '.hypervibe/spec.json'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  expiresAt = new Date(Date.now() + 86400000).toISOString();
  revision = git('rev-parse', 'HEAD');
  digest = createHash('sha256').update(readFileSync(path.join(root, '.hypervibe/spec.json'))).digest('hex');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true }); });

describe('declarative credential collection', () => {
  // Synthetic server responses preserve the existing public pairing contract.
  // The owner-approved onboarding contract adds a request-only branch hint,
  // independently of invitation approval or committed-source authorization.
  function pairingTransport() {
    const f = setup();
    f.transport.mockImplementation(async url => String(url).endsWith('/pairing-exchanges')
      ? Response.json({ status: 'pending', applied: 0, skipped: 1, retryAfterSeconds: 2 })
      : Response.json({ purpose: 'credential-requests', environment: 'staging', deviceCode: 'B'.repeat(43),
        userCode: '2345-6789', repository: 'studio/app', expiresAt: new Date(Date.now() + 600000).toISOString(),
        intervalSeconds: 2, verificationUrl: `${baseUrl}/pair?code=2345-6789` }));
    return f;
  }
  it.each(['authorize', 'create', 'resume'])('prefills the checked-out branch through the serialized %s pairing request', async action => {
    const { run, transport } = pairingTransport();
    expect(await run({ action })).toMatchObject({ ok: true, data: { status: 'approval_required', sourceBranch: 'review/credentials' } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({
      repositoryFullName: 'studio/app', purpose: 'credential-requests', environment: 'staging', sourceBranch: 'review/credentials',
    });
  });
  it('authorizes an explicit setup branch without requiring it to match the local checkout', async () => {
    const { run, transport } = pairingTransport();
    expect(await run({ action: 'authorize', sourceBranch: 'integration/security' })).toMatchObject({ ok: true, data: { sourceBranch: 'integration/security' } });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).sourceBranch).toBe('integration/security');
  });
  it('routes the setup override through CLI and MCP without changing the public pairing response', async () => {
    const { registry, transport } = pairingTransport();
    let output = '';
    expect(await runWithWorkspaceDirectories([root], () => runCli(
      ['cloud', 'requests', '--action', 'authorize', '--source-branch', 'integration/security', '--json'],
      { registry, initialize: false, io: { writeOut: t => { output += t; }, writeErr: () => {}, readStdin: async () => '', confirm: async () => false, stdinIsTTY: false } }
    ))).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, data: { sourceBranch: 'integration/security' } });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).sourceBranch).toBe('integration/security');
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerCommandRegistry({ registerTool: (id: string, _schema: unknown, fn: (input: Record<string, unknown>) => Promise<unknown>) => handlers.set(id, fn), server: { getClientCapabilities: () => ({}) } } as unknown as McpServer, registry);
    expect(await runWithWorkspaceDirectories([root], () => handlers.get('hv_cloud_requests')!({ action: 'authorize', sourceBranch: 'integration/security' })))
      .toMatchObject({ structuredContent: { ok: true, data: { sourceBranch: 'integration/security' } } });
    expect(transport.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/v1/pairings', '/api/v1/pairing-exchanges']);
  });
  it('omits a detached setup hint instead of guessing a branch, while invitations still require one', async () => {
    git('checkout', '--detach');
    const { run, transport } = pairingTransport();
    expect(await run({ action: 'authorize' })).toMatchObject({ ok: true, data: { status: 'approval_required' } });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).not.toHaveProperty('sourceBranch');
    expect(await run({ action: 'create' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('preserves a pending setup hint across checkout changes and rejects an explicit replacement before exchange', async () => {
    const { run, transport } = pairingTransport();
    await run({ action: 'authorize', sourceBranch: 'integration/security' });
    git('checkout', '-b', 'another/branch');
    expect(await run({ action: 'authorize' })).toMatchObject({ ok: true, data: { sourceBranch: 'integration/security' } });
    const stored = context.repos.connections.findByProviderAndScope('hypervibe-cloud-requests', sessionScope)!;
    const before = stored.credentialsEncrypted;
    transport.mockClear();
    expect(await run({ action: 'authorize', sourceBranch: 'another/branch' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(transport).not.toHaveBeenCalled();
    expect(context.repos.connections.findById(stored.id)?.credentialsEncrypted).toBe(before);
  });
  it('does not silently retrofit a legacy pending code with a new explicit setup hint', async () => {
    storeGrant({ status: 'pending', deviceCode: 'B'.repeat(43), userCode: '2345-6789', verificationUrl: `${baseUrl}/pair?code=2345-6789` });
    const { run, transport } = pairingTransport();
    expect(await run({ action: 'authorize', sourceBranch: 'integration/security' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(transport).not.toHaveBeenCalled();
    expect(await run({ action: 'authorize' })).toMatchObject({ ok: true, data: { status: 'approval_required' } });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('preserves an expired pending hint when a branchless retry needs a fresh code', async () => {
    storeGrant({ status: 'pending', sourceBranch: 'integration/security', expiresAt: new Date(0).toISOString(),
      deviceCode: 'B'.repeat(43), userCode: '2345-6789', verificationUrl: `${baseUrl}/pair?code=2345-6789` });
    const { run, transport } = pairingTransport();
    expect(await run({ action: 'authorize' })).toMatchObject({ ok: true, data: { sourceBranch: 'integration/security' } });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).sourceBranch).toBe('integration/security');
  });
  it('derives owner, keys, staging and source from the committed checkout without UUID input', async () => {
    storeGrant(); const { run, writes } = setup();
    const result = await run();
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' }, confirmation: { retryInput: { confirm: true } } });
    expect(JSON.stringify(result)).toContain('owner@example.test');
    expect(JSON.stringify(result)).toContain('staging');
    expect(JSON.stringify(result)).toContain('review/credentials');
    expect(JSON.stringify(result)).toContain('CLIENT_SECRET');
    expect(JSON.stringify(result)).not.toContain('PROD_ONLY');
    expect(writes()).toHaveLength(0);
  });
  it('sends the reviewed multi-field intent and pins the source on the wire', async () => {
    storeGrant(); const { run, writes } = setup();
    await run();
    const result = await run({ confirm: true });
    expect(result).toMatchObject({ ok: true, data: { applied: 1, delivery: 'queued' } });
    const [url, init] = writes()[0];
    expect(String(url)).toBe(`${baseUrl}/api/v1/projects/${projectId}/credential-requests`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}` } });
    expect(JSON.parse(String(init?.body))).toEqual({ environmentId, recipientEmail: 'owner@example.test', title: 'App credentials', fields, sourceBranch: 'review/credentials', expectedSourceRevision: revision, expectedSourceDigest: digest });
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('will not let confirm=true invent an unreviewed invitation', async () => {
    storeGrant(); const { run, writes } = setup();
    expect(await run({ confirm: true })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(writes()).toHaveLength(0);
  });
  it('requests only unsupplied required keys from the exact persisted plan', async () => {
    const planId = storePlan();
    storeGrant(); const { run, writes } = setup({ mutation: { applied: 1, skipped: 0, request: request({ fields: [fields[0]], keys: ['CLIENT_ID'] }), delivery: 'queued' } });
    expect(await run({ planId })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(await run({ planId, confirm: true })).toMatchObject({ ok: true });
    expect(JSON.parse(String(writes()[0][1]?.body)).fields).toEqual([fields[0]]);
  });
  it('cannot expand a plan-backed request into supplied or unneeded fields', async () => {
    const planId = storePlan();
    storeGrant(); const { run, transport } = setup();
    expect(await run({ planId, fields: [{ key: 'CLIENT_SECRET' }] })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not pair or send when the plan has no eligible required credentials', async () => {
    const planId = storePlan([], []);
    const { run, transport } = setup();
    expect(await run({ planId })).toMatchObject({ ok: true, data: { status: 'not_required' } });
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not let an obsolete plan prevent read-only resume of an existing request', async () => {
    const planId = storePlan();
    context.repos.runs.updateStatus(planId, 'failed');
    storeGrant(); const { run, writes } = setup({ requests: [request({ status: 'ready' })] });
    expect(await run({ action: 'resume', planId })).toMatchObject({ ok: true, data: { status: 'ready_for_import', replanRequired: true } });
    expect(writes()).toHaveLength(0);
  });
  it('starts separate browser access and never asks for cookies, CSRF or tokens', async () => {
    const { run, transport } = setup();
    transport.mockImplementation(async () => Response.json({ purpose: 'credential-requests', environment: 'staging', deviceCode: 'B'.repeat(43), userCode: '2345-6789', repository: 'studio/app', expiresAt: new Date(Date.now() + 600000).toISOString(), intervalSeconds: 2, verificationUrl: `${baseUrl}/pair?code=2345-6789` }));
    const result = await run();
    expect(result).toMatchObject({ ok: true, data: { status: 'approval_required', verificationUrl: `${baseUrl}/pair?code=2345-6789` } });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ repositoryFullName: 'studio/app', purpose: 'credential-requests', environment: 'staging', sourceBranch: 'review/credentials' });
    expect(JSON.stringify(result)).not.toContain('B'.repeat(43));
    expect(JSON.stringify(result)).not.toContain('credentialsRef');
  });
  it('does not accept an old server silently ignoring the requested access purpose', async () => {
    const { run, transport } = setup();
    transport.mockImplementation(async () => Response.json({ deviceCode: 'B'.repeat(43), userCode: '2345-6789', repository: 'studio/app', expiresAt: new Date(Date.now() + 600000).toISOString(), intervalSeconds: 2, verificationUrl: `${baseUrl}/pair?code=2345-6789` }));
    expect(await run()).toMatchObject({ ok: false, error: { code: 'PROVIDER_ERROR' } });
  });
  it.each([400, 401, 403, 409])('can reauthorize after definite HTTP %s pairing rejection without erasing invitation recovery', async status => {
    storeGrant({ status: 'pending', deviceCode: 'B'.repeat(43), userCode: '2345-6789', verificationUrl: `${baseUrl}/pair?code=2345-6789`,
      review: { fingerprint: 'retained', message: 'Previously reviewed invitation', pendingWrite: true, action: 'create' },
    });
    const { run, transport } = setup();
    transport.mockImplementation(async url => String(url).endsWith('/pairing-exchanges')
      ? new Response(`private ${token}`, { status })
      : Response.json({ purpose: 'credential-requests', environment: 'staging', deviceCode: 'C'.repeat(43), userCode: '3456-789A', repository: 'studio/app', expiresAt: new Date(Date.now() + 600000).toISOString(), intervalSeconds: 2, verificationUrl: `${baseUrl}/pair?code=3456-789A` }));
    const rejected = await run({ action: 'resume' });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'MISSING_CONNECTION' } });
    expect(JSON.stringify(rejected)).not.toContain(token);
    expect(savedReview()).toMatchObject({ pendingWrite: true });
    expect(await run({ action: 'resume' })).toMatchObject({ ok: true, data: { status: 'approval_required' } });
    expect(savedReview()).toMatchObject({ pendingWrite: true });
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/pairing-exchanges'))).toHaveLength(1);
  });
  it.each([429, 500])('does not restart an uncertain HTTP %s pairing exchange', async status => {
    storeGrant({ status: 'pending', deviceCode: 'B'.repeat(43), userCode: '2345-6789', verificationUrl: `${baseUrl}/pair?code=2345-6789` });
    const { run, transport } = setup(); transport.mockResolvedValue(new Response('unavailable', { status }));
    expect(await run({ action: 'resume' })).toMatchObject({ ok: false });
    expect(await run({ action: 'resume' })).toMatchObject({ ok: false, error: { code: 'PROVIDER_ERROR' } });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['pending', 'ready', 'consumed'])('reuses an existing exact %s request instead of emailing again', async status => {
    storeGrant(); const { run, writes } = setup({ requests: [request({ status })] });
    expect(await run({ confirm: true })).toMatchObject({ ok: true, data: { applied: 0, skipped: 1, request: { id: requestId } } });
    expect(writes()).toHaveLength(0);
  });
  it('blocks a changed branch/source before sending', async () => {
    storeGrant(); const { run, writes } = setup({ source: { revision: 'b'.repeat(40), digest } });
    expect(await run({ confirm: true })).toMatchObject({ ok: false });
    expect(writes()).toHaveLength(0);
  });
  it('blocks conflicting active ownership without automatically revoking it', async () => {
    storeGrant(); const { run, writes } = setup({ requests: [request({ recipient: 'other@example.test' })] });
    expect(await run()).toMatchObject({ ok: false });
    expect(writes()).toHaveLength(0);
  });
  it('does not replace a declared email owner through a transient flag', async () => {
    storeGrant(); const { run, writes } = setup();
    expect(await run({ ownerEmail: 'someone-else@example.test', fields: [{ key: 'CLIENT_SECRET' }] })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(writes()).toHaveLength(0);
  });
  it('never forwards raw values or schema extras from a list', async () => {
    storeGrant(); const { run } = setup({ requests: [request({ values: { CLIENT_SECRET: 'never-in-chat' }, fields: fields.map(f => ({ ...f, value: 'never-in-chat' })), submissions: [{ values: 'never-in-chat' }] })] });
    const result = await run({ action: 'list' });
    expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain('never-in-chat');
  });
  it('requires review of the exact observed request before revoking', async () => {
    storeGrant(); const { run, writes } = setup();
    expect(await run({ action: 'revoke', requestId })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(writes()).toHaveLength(0);
    expect(await run({ action: 'revoke', requestId, confirm: true })).toMatchObject({ ok: true, data: { applied: 1, request: { status: 'revoked' } } });
    expect(writes()).toHaveLength(1);
  });
  it('records an uncertain write and refuses a repeated POST when no receipt is visible', async () => {
    storeGrant(); const { run, transport, writes } = setup();
    await run();
    const existing = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => { if (init?.method === 'POST') throw new Error(`lost ${token}`); return existing(url, init); });
    expect(await run({ confirm: true })).toMatchObject({ ok: false });
    expect(await run({ confirm: true })).toMatchObject({ ok: false });
    expect(writes()).toHaveLength(1);
  });
  it('completes browser access without exposing the grant and still requires invitation review', async () => {
    const { run, transport } = setup();
    const api = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/v1/pairings') return Response.json({ purpose: 'credential-requests', environment: 'staging', deviceCode: 'B'.repeat(43), userCode: '2345-6789', repository: 'studio/app', expiresAt: new Date(Date.now() + 600000).toISOString(), intervalSeconds: 2, verificationUrl: `${baseUrl}/pair?code=2345-6789` });
      if (pathname === '/api/v1/pairing-exchanges') return Response.json({ status: 'completed', purpose: 'credential-requests', environment: 'staging', applied: 1, skipped: 0, project: { id: projectId, name: 'App' }, credentials: [{ environment: { id: environmentId, key: 'staging', name: 'Staging' }, token, expiresAt }] });
      return api(url, init);
    });
    expect(await run()).toMatchObject({ ok: true, data: { status: 'approval_required' } });
    const result = await run({ confirm: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(JSON.stringify(result)).not.toContain(token);
    const stored = context.repos.connections.findByProviderAndScope('hypervibe-cloud-requests', sessionScope)!;
    expect(stored.credentialsEncrypted).not.toContain(token);
    expect(transport.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).endsWith('/credential-requests'))).toHaveLength(0);
  });
  it('honors selected field formats while defaulting missing labels and hidden inputs', async () => {
    storeGrant();
    const chosen = [{ key: 'CLIENT_ID', inputType: 'text' }, { key: 'CLIENT_SECRET', label: 'Private key', inputType: 'textarea' }];
    const expected = [{ key: 'CLIENT_ID', label: 'CLIENT ID', inputType: 'text' }, { key: 'CLIENT_SECRET', label: 'Private key', inputType: 'textarea' }];
    const { run, writes } = setup({ mutation: { applied: 1, skipped: 0, request: request({ fields: expected }), delivery: 'queued' } });
    await run({ fields: chosen });
    expect(await run({ fields: chosen, confirm: true })).toMatchObject({ ok: true });
    expect(JSON.parse(String(writes()[0][1]?.body)).fields).toEqual(expected);
  });
  it('shortens only the default label for a valid 128-character declared key', async () => {
    const key = 'A'.repeat(128);
    const file = path.join(root, '.hypervibe/spec.json');
    const spec = JSON.parse(readFileSync(file, 'utf8'));
    spec.secrets = { [key]: spec.secrets.CLIENT_SECRET };
    writeFileSync(file, JSON.stringify(spec)); git('add', '.hypervibe/spec.json'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'long declared key');
    revision = git('rev-parse', 'HEAD'); digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    storeGrant(); const { run, transport, writes } = setup();
    const api = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => {
      if (String(url).includes('/credential-request-fields')) return Response.json({ availableFields: [{ key, label: key, inputType: 'password' }], sourceError: null, source: { revision, digest }, selectedEnvironmentId: environmentId, sourceBranch: 'review/credentials', environments: [{ id: environmentId, name: 'Staging', preferred: true }] });
      if (init?.method === 'POST') return Response.json({ applied: 1, skipped: 0, request: request({ fields: [{ key, label: key.slice(0, 120), inputType: 'password' }], keys: [key] }), delivery: 'queued' }, { status: 201 });
      return api(url, init);
    });
    expect(await run()).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(await run({ confirm: true })).toMatchObject({ ok: true });
    expect(JSON.parse(String(writes()[0][1]?.body)).fields[0].label).toHaveLength(120);
    expect(await run({ fields: [{ key, label: key }] })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
  it('requires a fresh review if the selected field set changes', async () => {
    storeGrant(); const { run, writes } = setup(); await run();
    expect(await run({ fields: [{ key: 'CLIENT_SECRET' }], confirm: true })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(writes()).toHaveLength(0);
  });
  it('checks later pages before deciding to send another invitation', async () => {
    storeGrant(); const { run, transport, writes } = setup();
    const api = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/credential-requests') && init?.method === 'GET') {
        const second = target.searchParams.get('page') === '2';
        return Response.json({ requests: second ? [request()] : [], pagination: { page: second ? 2 : 1, pageSize: 20, total: 21, pageCount: 2, hasNext: !second, hasPrevious: second } });
      }
      return api(url, init);
    });
    expect(await run({ confirm: true })).toMatchObject({ ok: true, data: { applied: 0 } });
    expect(writes()).toHaveLength(0);
  });
  it('reconciles a lost create receipt from an exact observed request without another write', async () => {
    storeGrant(); const { run, transport, writes } = setup(); await run();
    const api = transport.getMockImplementation()!;
    let attempted = false;
    transport.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') { attempted = true; throw new Error('lost response'); }
      if (attempted && String(url).includes('/credential-requests?')) return Response.json({ requests: [request()], pagination: { page: 1, pageSize: 20, total: 1, pageCount: 1, hasNext: false, hasPrevious: false } });
      return api(url, init);
    });
    expect(await run({ confirm: true })).toMatchObject({ ok: false });
    expect(await run({ confirm: true })).toMatchObject({ ok: true, data: { applied: 0, request: { id: requestId } } });
    expect(writes()).toHaveLength(1);
  });
  // Independent lifecycle: the pinned server projects expired requests and
  // permits a fresh request after terminal states. A lost response must not
  // trap the client, nor turn an older matching request into the new receipt.
  it.each(['expired', 'revoked', 'source_advanced'])('reconciles the original lost invitation after %s without sending again', async outcome => {
    storeGrant(); const requests: unknown[] = [];
    const original = request();
    const { run, transport, writes } = setup({ requests });
    await run();
    const api = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => { if (init?.method === 'POST') throw new Error('lost response'); return api(url, init); });
    expect(await run({ confirm: true })).toMatchObject({ ok: false });
    requests.push({ ...original, status: outcome === 'source_advanced' ? 'pending' : outcome });
    if (outcome === 'source_advanced') {
      git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'next source');
      revision = git('rev-parse', 'HEAD');
    }
    expect(await run({ confirm: true })).toMatchObject({ ok: true, data: {
      request: { id: requestId, sourceRevision: original.sourceRevision }, recovery: { status: 'reconciled' },
    } });
    expect(savedReview()).toBeUndefined();
    expect(writes()).toHaveLength(1);
  });
  it.each(['absent', 'mismatched', 'older_terminal', 'unknown_read'])('keeps the lost-write marker for %s recovery evidence', async evidence => {
    storeGrant(); const requests: unknown[] = evidence === 'older_terminal' ? [request({ status: 'expired' })] : [];
    const { run, transport, writes } = setup({ requests });
    await run();
    const api = transport.getMockImplementation()!;
    let attempted = false;
    transport.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') { attempted = true; throw new Error('lost response'); }
      if (attempted && evidence === 'unknown_read' && String(url).includes('/credential-requests?')) return new Response('unavailable', { status: 503 });
      return api(url, init);
    });
    await run({ confirm: true });
    if (evidence === 'mismatched') requests.push(request({ title: 'A different invitation' }));
    const result = await run({ action: 'resume' });
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_ERROR' } });
    expect(savedReview()).toMatchObject({ pendingWrite: true, proposal: { expectedSourceRevision: revision } });
    expect(writes()).toHaveLength(1);
  });
  it.each(['consumed', 'expired', 'revoked'])('requires explicit reviewed replacement of a %s request', async status => {
    storeGrant();
    const previous = request({ status });
    const replacementId = '66666666-6666-4666-8666-666666666666';
    const { run, transport, writes } = setup({ requests: [previous], mutation: {
      applied: 1, skipped: 0, request: request({ id: replacementId }), delivery: 'queued',
    } });
    const api = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => {
      if (init?.method === 'GET' && new URL(String(url)).pathname.endsWith(`/${requestId}`)) return Response.json({ request: previous });
      return api(url, init);
    });
    if (status === 'consumed') {
      expect(await run({ confirm: true })).toMatchObject({ ok: true, data: { applied: 0, request: { status: 'consumed' } } });
    }
    expect(await run({ action: 'replace', requestId, confirm: true })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(writes()).toHaveLength(0);
    expect(await run({ action: 'replace', requestId, confirm: true })).toMatchObject({ ok: true, data: {
      applied: 1, request: { id: replacementId }, replacesRequestId: requestId,
    } });
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1]?.method).toBe('POST');
    expect(transport.mock.calls.some(([url]) => String(url).includes('/credential-retrievals'))).toBe(false);
  });
  it.each(['pending', 'ready'])('does not replace a still-active %s request', async status => {
    storeGrant(); const { run, transport, writes } = setup({ requests: [request({ status })] });
    const api = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => init?.method === 'GET' && new URL(String(url)).pathname.endsWith(`/${requestId}`)
      ? Response.json({ request: request({ status }) }) : api(url, init));
    expect(await run({ action: 'replace', requestId, confirm: true })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(writes()).toHaveLength(0);
  });
  it.each(['pending', 'ready', 'consumed', 'expired', 'revoked', 'stale_source'])('resumes %s status without caller request IDs or automatic import', async readiness => {
    storeGrant(); const record = request({ status: readiness === 'stale_source' ? 'ready' : readiness,
      ...(readiness === 'stale_source' ? { sourceRevision: 'b'.repeat(40) } : {}),
    });
    const { run, transport, writes } = setup({ requests: [record] });
    const result = await run({ action: 'resume' });
    expect(result).toMatchObject({ ok: true, data: { replanRequired: true, requests: [{ readiness, request: { id: requestId } }] } });
    if (readiness === 'ready') expect(result).toMatchObject({ data: { status: 'ready_for_import', requests: [{
      import: { command: 'hv_cloud_secrets', input: { requestId, env: 'staging', baseUrl } },
    }] } });
    else expect(JSON.stringify(result)).not.toContain('"command":"hv_cloud_secrets"');
    expect(writes()).toHaveLength(0);
    expect(transport.mock.calls.some(([url]) => String(url).includes('/credential-retrievals'))).toBe(false);
  });
  it('resumes an empty complete inventory honestly without claiming deployment readiness', async () => {
    storeGrant(); const { run, writes } = setup();
    expect(await run({ action: 'resume' })).toMatchObject({ ok: true, data: { status: 'no_active_requests', requests: [], replanRequired: true } });
    expect(writes()).toHaveLength(0);
  });
  it.each([false, true])('observes the real default branch for web-created requests (default moved=%s)', async moved => {
    storeGrant(); const { run, transport, writes } = setup({ requests: [request({ status: 'ready', sourceBranch: null })] });
    const api = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/credential-request-fields') && target.searchParams.get('sourceBranch') === '')
        return Response.json({ availableFields: fields, sourceError: null, source: { revision: moved ? 'b'.repeat(40) : revision, digest }, selectedEnvironmentId: environmentId, sourceBranch: '', environments: [{ id: environmentId, name: 'Staging', preferred: true }] });
      return api(url, init);
    });
    const result = await run({ action: 'resume' });
    expect(result).toMatchObject({ ok: true, data: { requests: [{ readiness: moved ? 'stale_source' : 'ready' }] } });
    expect(transport.mock.calls.some(([url]) => new URL(String(url)).searchParams.get('sourceBranch') === '')).toBe(true);
    if (!moved) expect(result).toMatchObject({ data: { requests: [{ import: { command: 'hv_cloud_secrets' } }] } });
    else expect(JSON.stringify(result)).not.toContain('"command":"hv_cloud_secrets"');
    expect(writes()).toHaveLength(0);
  });
  it.each([401, 403, 409, 429, 500])('keeps HTTP %s failures private and never sends after an unknown read', async status => {
    storeGrant(); const { run, transport, writes } = setup();
    transport.mockImplementation(async () => new Response(`private ${token}`, { status }));
    const result = await run({ confirm: true });
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(token); expect(writes()).toHaveLength(0);
  });
  it('fails closed on other-environment responses and dirty or unrelated checkouts', async () => {
    storeGrant(); const { run, writes } = setup({ requests: [request({ environmentId: '77777777-7777-4777-8777-777777777777' })] });
    expect(await run({ action: 'list' })).toMatchObject({ ok: false });
    writeFileSync(path.join(root, '.hypervibe/spec.json'), readFileSync(path.join(root, '.hypervibe/spec.json'), 'utf8') + '\n');
    expect(await run({ confirm: true })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    git('remote', 'set-url', 'origin', 'https://github.com/elsewhere/app.git');
    expect(await run({ action: 'list' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(writes()).toHaveLength(0);
  });
  it('retains the server ready-email delivery contract and provides a private import call', async () => {
    storeGrant(); const delivery = [{ id: '55555555-5555-4555-8555-555555555555', kind: 'ready', status: 'sent', failureCode: null }];
    const { run } = setup({ requests: [request({ status: 'ready', delivery })] });
    expect(await run()).toMatchObject({ ok: true, data: { request: { delivery }, import: { command: 'hv_cloud_secrets', input: { requestId, env: 'staging', baseUrl } } } });
  });
  it('does not require browser access when the spec needs no delegated credentials', async () => {
    const file = path.join(root, '.hypervibe/spec.json');
    const spec = JSON.parse(readFileSync(file, 'utf8')); delete spec.secrets;
    writeFileSync(file, JSON.stringify(spec)); git('add', '.hypervibe/spec.json'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'no credentials');
    const { run, transport } = setup();
    expect(await run()).toMatchObject({ ok: true, data: { status: 'not_required' } });
    expect(transport).not.toHaveBeenCalled();
  });
  it('pins the independently inspected PR #85 source without fetching schemas', () => {
    const root = new URL('../../../test/provider-contracts/hypercloud/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('source.json', root), 'utf8'));
    for (const source of manifest.sources) expect(createHash('sha256').update(readFileSync(new URL(source.snapshot, root))).digest('hex')).toBe(source.sha256);
  });
  it('rejects non-JSON and oversized status responses without echoing them', async () => {
    storeGrant(); const { run, transport } = setup();
    for (const body of ['<html>private session page</html>', 'x'.repeat(256 * 1024 + 1)]) {
      transport.mockResolvedValueOnce(new Response(body));
      const result = await run({ action: 'list' });
      expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).not.toContain('private session page');
    }
  });
  it('compensates the exact newly issued grant if encrypted persistence fails', async () => {
    const { run, transport } = setup();
    transport.mockImplementation(async url => {
      if (String(url).endsWith('/pairings')) return Response.json({ purpose: 'credential-requests', environment: 'staging', deviceCode: 'B'.repeat(43), userCode: '2345-6789', repository: 'studio/app', expiresAt: new Date(Date.now() + 600000).toISOString(), intervalSeconds: 2, verificationUrl: `${baseUrl}/pair?code=2345-6789` });
      if (String(url).endsWith('/pairing-exchanges')) return Response.json({ status: 'completed', purpose: 'credential-requests', environment: 'staging', applied: 1, skipped: 0, project: { id: projectId, name: 'App' }, credentials: [{ environment: { id: environmentId, key: 'staging', name: 'Staging' }, token, expiresAt }] });
      return Response.json({ applied: 1, skipped: 0 });
    });
    await run();
    const update = context.repos.connections.updateCredentials.bind(context.repos.connections);
    vi.spyOn(context.repos.connections, 'updateCredentials').mockImplementation((id, encrypted) => {
      if (context.secretStore.decryptObject<{ status: string }>(encrypted).status === 'verified') throw new Error('synthetic save failure');
      return update(id, encrypted);
    });
    const result = await run();
    expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).not.toContain(token);
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toEqual([[new URL('/api/v1/credential-request-access', baseUrl), expect.objectContaining({ headers: { authorization: `Bearer ${token}` } })]]);
  });
  it('allows a fresh review after a definitive server rejection without automatic retries', async () => {
    storeGrant(); const { run, transport, writes } = setup(); await run();
    const api = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => init?.method === 'POST' ? new Response('source changed', { status: 409 }) : api(url, init));
    expect(await run({ confirm: true })).toMatchObject({ ok: false });
    expect(writes()).toHaveLength(1);
    expect(await run()).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } });
    expect(writes()).toHaveLength(1);
  });
  it('does not erase an uncertain write when a later read is rejected', async () => {
    storeGrant(); const { run, transport, writes } = setup(); await run();
    const api = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => { if (init?.method === 'POST') throw new Error('lost'); return api(url, init); });
    await run({ confirm: true });
    transport.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    await run();
    expect(await run({ confirm: true })).toMatchObject({ ok: false, error: { code: 'PROVIDER_ERROR' } });
    expect(writes()).toHaveLength(1);
  });
  it('routes the same safe command through CLI and MCP', async () => {
    storeGrant(); const { registry, run } = setup(); const expected = await run({ action: 'list' });
    let output = '';
    await runWithWorkspaceDirectories([root], () => runCli(['cloud', 'requests', '--action', 'list', '--json'], { registry, initialize: false, io: { writeOut: t => { output += t; }, writeErr: () => {}, readStdin: async () => '', confirm: async () => false, stdinIsTTY: false } }));
    expect(JSON.parse(output)).toEqual(expected);
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerCommandRegistry({ registerTool: (id: string, _schema: unknown, fn: (input: Record<string, unknown>) => Promise<unknown>) => handlers.set(id, fn), server: { getClientCapabilities: () => ({}) } } as unknown as McpServer, registry);
    expect(await runWithWorkspaceDirectories([root], () => handlers.get('hv_cloud_requests')!({ action: 'list' }))).toMatchObject({ structuredContent: expected });
  });
});
