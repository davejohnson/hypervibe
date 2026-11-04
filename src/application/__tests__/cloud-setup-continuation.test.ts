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
import { runCli } from '../../interfaces/cli/run.js';
import { registerCommandRegistry } from '../../interfaces/mcp/adapter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Independently agreed HC wire contract, 2026-11-04. Synthetic serialized HTTP,
// actual command/CLI/MCP, Git and SQLite; not live provider compatibility.
let root: string;
const token = `hvc_12345678-1234-4234-8234-123456789abc_${'A'.repeat(43)}`;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
  root = mkdtempSync(path.join(tmpdir(), 'hv-setup-continue-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(root, 'state.db')).migrate();
  git('init', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/studio/app.git'); mkdirSync(path.join(root, '.hypervibe'));
  writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify({ version: 1, project: 'app',
    secrets: { API_KEY: { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] } },
    environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } } } }));
  git('add', '.hypervibe/spec.json'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'reviewed app');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true }); });
function fixture(purpose: 'connect-cloud' | 'deployment-access', baseUrl = 'https://hypervibe.dev') {
  const deployment = purpose === 'deployment-access';
  const source = { branch: 'main', revision: git('rev-parse', 'HEAD'), digest: createHash('sha256').update(readFileSync(path.join(root, '.hypervibe/spec.json'))).digest('hex') };
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let connection: any;
  let transform = (value: any) => value;
  let during: () => void | Promise<void> = () => {};
  let transportError = false;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const address = String(url), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: address, method, body });
    if (address.endsWith('/pairings')) return Response.json({ deviceCode: 'B'.repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: 2,
      repository: 'studio/app', userCode: '2345-6789', purpose: deployment ? 'deployment-access' : 'secret-destinations', environment: 'staging', verificationUrl: `${baseUrl}/pair?code=2345-6789` });
    if (address.endsWith('/pairing-exchanges')) return Response.json({ status: 'completed', purpose: deployment ? 'deployment-access' : 'secret-destinations', environment: 'staging', applied: 1, skipped: 0,
      project: { id: 'app-id', name: 'App' }, credentials: [{ token, expiresAt: new Date(Date.now() + 86400_000).toISOString(), environment: { id: 'env-id', key: 'staging', name: 'Staging' } }] });
    if (address.endsWith('/setup-continuations')) {
      await during(); if (transportError) throw new Error(token);
      return Response.json(transform({ connection: { ...connection, provider: 'gcp', status: 'pending' }, continuation: { schemaVersion: 1, status: 'waiting', reason: 'provider_pending', nextAction: 'continue', observedCompletedActions: 0, startedAttempts: 0 } }));
    }
    if (method === 'POST') {
      connection = { id: body.connectionId, ...(deployment ? { purpose: 'deployment' } : {}), mode: 'connect', status: 'choose-provider', provider: null, keys: deployment ? [] : ['API_KEY'], environment: 'staging', source,
        expiresAt: new Date(Date.now() + 86400_000).toISOString(), connectUrl: `${baseUrl}/apps/app-id/cloud-connections/${body.connectionId}`, deployment: 'not-authorized' };
      return Response.json({ applied: 1, skipped: 0, connection });
    }
    return Response.json({ connection });
  });
  vi.stubGlobal('fetch', fetchImpl);
  const context = createCommandContext(); context.repos.projects.create({ name: 'app', gitRemoteUrl: 'https://github.com/studio/app.git', defaultPlatform: 'cloudrun' });
  const commands = createCommandRegistry(context);
  const run = (input: Record<string, unknown>) => runWithWorkspaceDirectories([root], () => commands.execute('hv_cloud_connections', { purpose, env: 'staging', baseUrl, ...input }));
  const connect = async () => { for (const action of ['start', 'status', 'connect']) { const result = await run({ action }); expect(result, JSON.stringify(result)).toMatchObject({ ok: true }); } };
  return { run, connect, commands, context, calls, source, pending: (status = 'pending') => { connection.status = status; }, transform: (fn: typeof transform) => { transform = fn; }, during: (fn: typeof during) => { during = fn; }, lose: () => { transportError = true; } };
}

describe.each(['connect-cloud', 'deployment-access'] as const)('%s agent continuation', purpose => {
  it('posts only an empty body to the existing exact connection and keeps waiting agent-owned', async () => {
    const f = fixture(purpose); await f.connect(); const before = f.calls.length;
    const result = await f.run({ action: 'continue' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { status: 'pending', continuation: { status: 'waiting', nextAction: 'continue' }, nextStep: { action: 'continue' } }, agentInstruction: { action: 'continue' } });
    expect(f.calls.slice(before)).toEqual([{ url: expect.stringMatching(new RegExp(`/api/v1/projects/app-id/${purpose === 'connect-cloud' ? 'cloud-connections' : 'cloud-deployments'}/[a-f0-9-]+/setup-continuations$`)), method: 'POST', body: {} }]);
    expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toMatch(/Check installation/);
    const n = f.calls.length; await f.run({ action: 'status' }); expect(f.calls.slice(n).every(call => call.method === 'GET')).toBe(true);
  });
  it('preserves all agreed handoff states without inventing approval or retries', async () => {
    const f = fixture(purpose); await f.connect();
    const cases = [
      ['progressed', 'progress_recorded', 'continue'], ['waiting', 'provider_pending', 'continue'],
      ['needs-sign-in', 'authorization_required', 'sign-in'], ['needs-review', 'review_required', 'review'], ['needs-review', 'source_changed', 'review'],
      ['blocked', 'authority_changed', 'inspect'], ['blocked', 'retry_review_required', 'inspect'], ['blocked', 'provider_blocked', 'inspect'], ['blocked', 'setup_unavailable', 'inspect'],
    ];
    for (const [status, reason, nextAction] of cases) {
      f.transform(value => { Object.assign(value.continuation, { status, reason, nextAction, startedAttempts: status === 'progressed' ? 1 : 0 }); return value; });
      expect(await f.run({ action: 'continue' })).toMatchObject({ ok: true, data: { continuation: { status, reason, nextAction }, nextStep: { action: nextAction === 'inspect' ? 'status' : nextAction } }, agentInstruction: { action: status.startsWith('needs-') ? 'ask_user' : 'continue' } });
    }
  });
  it('exposes only actual closed setup diagnostics for agent diagnosis', async () => {
    const f = fixture(purpose); await f.connect();
    for (const reason of ['host_identity_access_unverified', 'writer_impersonation_unverified', 'writer_permissions_unverified']) {
      const diagnostic = { stage: purpose === 'connect-cloud' ? 'collection' : 'deployment', reason };
      f.transform(value => { value.continuation.diagnostic = diagnostic; return value; });
      expect(await f.run({ action: 'continue' })).toMatchObject({ ok: true, data: { continuation: { diagnostic }, nextStep: { diagnostic } }, agentInstruction: { action: 'continue' } });
    }
    for (const diagnostic of [{ stage: 'unknown', reason: 'timeout' }, { stage: 'collection', reason: 'not-an-engine-reason' }, { stage: 'collection', reason: 'timeout', native: 'forbidden' }, { stage: 'collection', reason: token }]) {
      f.transform(value => { value.continuation.diagnostic = diagnostic; return value; });
      const result = await f.run({ action: 'continue' }); expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).not.toContain(token);
    }
  });
  it('keeps pending saved-setup status with the agent while device pairing still needs the person', async () => {
    const f = fixture(purpose);
    expect(await f.run({ action: 'start' })).toMatchObject({ ok: true, data: { status: 'pending' }, agentInstruction: { action: 'ask_user' } });
    await f.run({ action: 'status' }); await f.run({ action: 'connect' });
    for (const status of ['choose-provider', 'authorization-required', 'review-required', 'pending', 'blocked', ...(purpose === 'connect-cloud' ? ['scope-ready'] : [])]) {
      f.pending(status); const before = f.calls.length;
      const result = await f.run({ action: 'status' });
      expect(result).toMatchObject({ ok: true, data: { status, nextStep: { command: 'hv_cloud_connections', input: { purpose, env: 'staging', action: 'continue' } } }, agentInstruction: { action: 'continue' } });
      expect(JSON.stringify(result)).not.toContain('Open this connection’s browser link to review the next setup step');
      expect(f.calls.slice(before).every(call => call.method === 'GET')).toBe(true);
    }
  });
  it.each(['status', 'waiting', 'ready', 'blocked'])('keeps the executable %s next step on the exact custom site', async state => {
    const baseUrl = 'https://connect-test.example.test'; const f = fixture(purpose, baseUrl); await f.connect(); f.pending();
    f.transform(value => {
      if (state === 'ready') { Object.assign(value.connection, { status: purpose === 'connect-cloud' ? 'source-required' : 'ready', deployment: purpose === 'connect-cloud' ? 'not-authorized' : 'provision-approved' }); Object.assign(value.continuation, { status: 'ready', reason: 'setup_complete', nextAction: 'none' }); }
      if (state === 'blocked') Object.assign(value.continuation, { status: 'blocked', reason: 'provider_blocked', nextAction: 'inspect' });
      return value;
    });
    const result = await f.run({ action: state === 'status' ? 'status' : 'continue' });
    const action = ['ready', 'blocked'].includes(state) ? 'status' : 'continue';
    expect(result).toMatchObject({ ok: true, data: { nextStep: { input: { purpose, env: 'staging', baseUrl, action } } } });
    if (!result.ok) throw new Error('Expected saved setup receipt');
    const before = f.calls.length;
    expect(await runWithWorkspaceDirectories([root], () => f.commands.execute('hv_cloud_connections', (result.data as any).nextStep.input))).toMatchObject({ ok: true });
    expect(f.calls.slice(before).every(call => call.method === (action === 'status' ? 'GET' : 'POST'))).toBe(true);
    expect(f.calls.every(call => new URL(call.url).origin === baseUrl)).toBe(true);
  });
  it('cannot create a connection or pairing through continue', async () => {
    const f = fixture(purpose); expect(await f.run({ action: 'continue' })).toMatchObject({ ok: false }); expect(f.calls).toEqual([]);
  });
  it.each(['provider', 'connectionId', 'keys', 'mode', 'confirm', 'sourceBranch'])('rejects the %s override without HTTP', async field => {
    const f = fixture(purpose); await f.connect(); const before = f.calls.length;
    const value = ({ provider: 'gcp', connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', keys: ['API_KEY'], mode: 'connect', confirm: true, sourceBranch: 'main' } as any)[field];
    expect(await f.run({ action: 'continue', [field]: value })).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(before);
  });
  it.each(['mismatch', 'extra', 'token', 'oversized', 'scope', 'bad-date', 'counts', 'ready-mismatch', 'empty-progress', 'purpose', 'missing-mode'])('rejects %s response without retry', async kind => {
    const f = fixture(purpose); await f.connect();
    f.transform(value => {
      if (kind === 'mismatch') value.continuation.nextAction = 'none';
      if (kind === 'extra') value.connection.installation = { native: 'forbidden' };
      if (kind === 'token') value.connection.environment = token;
      if (kind === 'oversized') value.unexpected = 'x'.repeat(65536);
      if (kind === 'scope') value.connection.source.revision = 'f'.repeat(40);
      if (kind === 'bad-date') value.connection.expiresAt = 'not-a-date';
      if (kind === 'empty-progress') Object.assign(value.continuation, { status: 'progressed', reason: 'progress_recorded' });
      if (kind === 'purpose') value.connection.purpose = 'collection';
      if (kind === 'missing-mode') delete value.connection.mode;
      if (kind === 'counts') value.continuation.startedAttempts = 901;
      if (kind === 'ready-mismatch') Object.assign(value.continuation, { status: 'ready', reason: 'setup_complete', nextAction: 'none' });
      return value;
    });
    const result = await f.run({ action: 'continue' }); expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).not.toContain(token);
    expect(f.calls.filter(call => call.url.endsWith('/setup-continuations'))).toHaveLength(1);
  });
  // HC active()/approvedSetup preserves exact durable approval after the initial
  // setup review window expires. That timestamp is not the device grant expiry.
  it.each(['pending', 'ready'])('accepts %s for durable approved setup after its initial review window', async status => {
    const f = fixture(purpose); await f.connect(); f.transform(value => {
      value.connection.expiresAt = new Date(0).toISOString();
      if (status === 'ready') { Object.assign(value.connection, { status: purpose === 'connect-cloud' ? 'source-required' : 'ready', deployment: purpose === 'connect-cloud' ? 'not-authorized' : 'provision-approved' }); Object.assign(value.continuation, { status: 'ready', reason: 'setup_complete', nextAction: 'none' }); }
      return value;
    });
    expect(await f.run({ action: 'continue' })).toMatchObject({ ok: true });
  });
  it('returns setup-only readiness and asks the agent to obtain the existing final status receipt', async () => {
    const f = fixture(purpose); await f.connect(); f.transform(value => { Object.assign(value.connection, { status: purpose === 'connect-cloud' ? 'source-required' : 'ready', deployment: purpose === 'connect-cloud' ? 'not-authorized' : 'provision-approved' }); Object.assign(value.continuation, { status: 'ready', reason: 'setup_complete', nextAction: 'none' }); return value; });
    expect(await f.run({ action: 'continue' })).toMatchObject({ ok: true, data: { nextStep: { action: 'status' } } });
    expect(f.context.repos.connections.findAllByProvider('hypervibe-deployment-binding').map(row => f.context.secretStore.decryptObject(row.credentialsEncrypted))).not.toContainEqual(expect.objectContaining({ status: 'ready' }));
  });
  it.each(['revocation', 'source', 'repository', 'expired', 'status'])('rejects %s changed while awaiting response', async change => {
    const f = fixture(purpose); await f.connect();
    f.during(() => {
      if (change === 'source') { writeFileSync(path.join(root, 'changed.txt'), 'changed'); git('add', 'changed.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'different source'); }
      else if (change === 'repository') git('remote', 'set-url', 'origin', 'https://github.com/other/app.git');
      else if (change === 'expired') { const future = Date.now() + 2 * 86400_000; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(future); }
      else { const provider = purpose === 'connect-cloud' ? 'hypervibe-secret-destinations' : 'hypervibe-deployment-access'; for (const row of f.context.repos.connections.findAllByProvider(provider)) { if (change === 'status') f.context.repos.connections.updateStatus(row.id, 'failed'); else f.context.repos.connections.delete(row.id); } }
    });
    expect(await f.run({ action: 'continue' })).toMatchObject({ ok: false });
  });
  it('does not retry a lost response or expose transport text', async () => {
    const f = fixture(purpose); await f.connect(); f.lose(); const result = await f.run({ action: 'continue' });
    expect(result).toMatchObject({ ok: false, agentInstruction: { action: 'continue' } }); expect(JSON.stringify(result)).not.toContain(token); expect(f.calls.filter(call => call.url.endsWith('/setup-continuations'))).toHaveLength(1);
  });
  it('bounds a non-cooperative continuation and preserves the exact saved authority on timeout', async () => {
    const f = fixture(purpose); await f.connect();
    const before = ['hypervibe-secret-destinations', 'hypervibe-deployment-access', 'hypervibe-deployment-binding'].flatMap(provider => f.context.repos.connections.findAllByProvider(provider));
    f.during(() => new Promise<void>(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = f.run({ action: 'continue' });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await pending).toMatchObject({ ok: false, agentInstruction: { action: 'continue' } });
    expect(['hypervibe-secret-destinations', 'hypervibe-deployment-access', 'hypervibe-deployment-binding'].flatMap(provider => f.context.repos.connections.findAllByProvider(provider))).toEqual(before);
    expect(f.calls.filter(call => call.url.endsWith('/setup-continuations'))).toHaveLength(1);
  });
  it('uses identical public CLI and MCP metadata/handling', async () => {
    const f = fixture(purpose); await f.connect(); let output = '';
    const code = await runWithWorkspaceDirectories([root], () => runCli(['cloud', 'connections', '--purpose', purpose, '--env', 'staging', '--action', 'continue', '--json'], { registry: f.commands, initialize: false, io: { writeOut: value => { output += value; }, writeErr: () => {}, readStdin: async () => '', confirm: async () => false, stdinIsTTY: false } }));
    expect(code).toBe(0); expect(JSON.parse(output)).toMatchObject({ ok: true, data: { continuation: { status: 'waiting' } } });
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerCommandRegistry({ registerTool: (id: string, _schema: unknown, fn: (input: Record<string, unknown>) => Promise<unknown>) => handlers.set(id, fn), server: { getClientCapabilities: () => ({}) } } as unknown as McpServer, f.commands);
    expect(await runWithWorkspaceDirectories([root], () => handlers.get('hv_cloud_connections')!({ purpose, env: 'staging', action: 'continue' }))).toMatchObject({ structuredContent: { ok: true, data: { continuation: { status: 'waiting' } } } });
  });
});
it.each(['provider-connections', 'secret-destinations'])('continue rejects legacy %s', async purpose => {
  const f = fixture('connect-cloud'); expect(await f.run({ purpose, action: 'continue' })).toMatchObject({ ok: false }); expect(f.calls).toEqual([]);
});
