import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import type { CloudDeploymentAdapterInputV1 } from '../../domain/ports/cloud-deployment.port.js';
import { resolveReviewedBranchDeployTargets } from '../../domain/services/managed-ci-targets.js';
import { readRepoSpecFile } from '../../domain/spec/repo-spec-file.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { runCli } from '../../interfaces/cli/run.js';
import { registerCommandRegistry } from '../../interfaces/mcp/adapter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Synthetic HC protocol and native adapter boundary. Real Git, SQLite, command,
// broker serialization and factory selection run; this is not live cloud evidence.
let root: string;
const deviceToken = `hvc_12345678-1234-4234-8234-123456789abc_${'A'.repeat(43)}`;
const nativeToken = 'sensitive-native-session-never-persist';
let nativeProjectExists = false;
const factory = vi.fn(async (input: CloudDeploymentAdapterInputV1) => ({ input, name: 'deployment-fixture',
  capabilities: { supportsObserve: true, supportedBuilders: [], supportedComponents: [], supportsAutoWiring: false,
    supportsHealthChecks: false, supportsCronSchedule: false, supportsReleaseCommand: false, supportsMultiEnvironment: false, managedTls: false },
  configureTarget: async () => {},
  observe: async () => ({ provider: 'deployment-fixture', observedAt: new Date().toISOString(), projectExists: nativeProjectExists,
    projectId: nativeProjectExists ? 'native-project' : undefined, environmentId: nativeProjectExists ? 'native-environment' : undefined,
    services: [], databases: [], completeness: { project: 'complete', environment: 'complete', services: 'complete', databases: 'complete' }, partial: false, warnings: [] }),
  ensureProject: async () => {
    if (input.authentication.kind !== 'gcp-impersonation') throw new Error('Wrong auth kind');
    await input.authentication.getAccessToken(new AbortController().signal); nativeProjectExists = true;
    return { success: true, message: 'Synthetic project prepared', data: { projectId: 'native-project', environmentId: 'native-environment', created: true } };
  },
}));
const legacy = vi.fn(async () => ({ legacy: true }));
if (!providerRegistry.get('deployment-fixture')) providerRegistry.register({ metadata: { name: 'deployment-fixture', displayName: 'Synthetic deployment', category: 'deployment', credentialsSchema: z.object({ password: z.string() }),
  lifecycle: { hosting: { workloadKinds: ['web'], customDomains: 'unsupported', teardownBoundary: 'project' } }, maturity: { lifecycle: { hosting: { status: 'ready-for-live' } } },
  orchestration: { ci: { transientDeployment: 'github-oidc-broker-v1', displayName: 'Synthetic deployment', requiredSecrets: [], buildGitHubActionsSteps: () => ({ displayName: 'Synthetic deployment', requiredSecrets: [], requiredVariables: [], steps: '', permissions: '' }) } } },
  inspection: { resources: ['environment'], selectors: { environment: { mode: 'environment-forensics', required: ['project', 'env'], optional: ['limit'], list: true } }, inspect: async () => ({ environments: [] }) },
  factory: legacy, transientAuthentication: { provider: 'gcp', hostingProvider: 'deployment-fixture',
    parseScope: value => z.object({ projectId: z.string(), projectNumber: z.string(), region: z.string() }).strict().parse(value), createAdapter: factory } });
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0'); factory.mockClear(); legacy.mockClear(); nativeProjectExists = false;
  root = mkdtempSync(path.join(tmpdir(), 'hv-deployment-access-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(root, 'state.db')).migrate();
  git('init', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/studio/app.git'); mkdirSync(path.join(root, '.hypervibe'));
  writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify({ version: 1, project: 'app', environments: {
    staging: { hosting: { provider: 'deployment-fixture' }, services: { web: {} } }, production: { hosting: { provider: 'deployment-fixture' }, services: { web: {} } },
  } }));
  git('add', '.hypervibe/spec.json'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'reviewed source');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const source = { branch: git('branch', '--show-current'), revision: git('rev-parse', 'HEAD'), digest: createHash('sha256').update(readFileSync(path.join(root, '.hypervibe/spec.json'))).digest('hex') };
  const nativePrincipal = (name: string, uid: string) => ({ kind: 'gcp-service-account', projectId: 'native-project', projectNumber: '123456789', serviceAccountEmail: `${name}@native-project.iam.gserviceaccount.com`, serviceAccountUniqueId: uid });
  const provision = nativePrincipal('provision', '111111111111111111111');
  let browser: any; let ready = false; let lost = false; let denied = false;
  let rewrite = (receipt: any) => receipt;
  let duringSession = () => {};
  let policy: any; let losePolicy = false;
  let sourceAuthorization: any, sourceProposal: any, receipt: any, loseSource = false, loseExchange = false, exchanges = 0;
  let rewriteAuthorization = (value: any) => value;
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined, method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body });
    if (String(url).endsWith('/pairings')) return Response.json({ deviceCode: 'B'.repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: 2,
      repository: 'studio/app', userCode: '2345-6789', purpose: 'deployment-access', environment: 'staging', verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789' });
    if (String(url).endsWith('/pairing-exchanges')) {
      exchanges++; if (loseExchange) throw new Error('Consuming exchange acknowledgment lost');
      return Response.json({ status: 'completed', purpose: 'deployment-access', environment: 'staging', applied: 1, skipped: 0,
        project: { id: 'app-id', name: 'App' }, credentials: [{ token: exchanges === 1 ? deviceToken : deviceToken.replace('A'.repeat(43), 'C'.repeat(43)), expiresAt: new Date(Date.now() + 86400_000).toISOString(), environment: { id: 'env-id', key: 'staging', name: 'Staging' } }] });
    }
    if (method === 'DELETE') return Response.json({ applied: 1, skipped: 0 });
    if (String(url).endsWith('/release-policies')) {
      policy = { id: body.policyId, status: 'review-required', digest: 'f'.repeat(64) };
      if (losePolicy) throw new Error('Lost release-policy acknowledgment');
      return Response.json({ applied: 1, skipped: 0, policy: { ...policy, receipt: { deliberately: 'not-rendered' } }, connectUrl: browser.connectUrl });
    }
    if (String(url).includes('/release-policies/')) return policy ? Response.json({ policy }) : Response.json({}, { status: 404 });
    if (String(url).endsWith('/source-authorizations')) {
      const connectionDigest = canonicalJsonSha256(receipt), from = sourceAuthorization?.source ?? receipt.source;
      const fields = { schemaVersion: 1, id: body.authorizationId, connectionDigest,
        previousDigest: sourceAuthorization?.digest ?? canonicalJsonSha256({ schemaVersion: 1, connectionDigest, source: receipt.source }), from,
        source: { repository: 'github.com/studio/app', branch: 'main', revision: body.expectedSourceRevision, specDigest: body.expectedSourceDigest } };
      sourceProposal = { id: body.authorizationId, status: 'review-required', receipt: { ...fields, digest: canonicalJsonSha256(fields) }, digest: canonicalJsonSha256(fields) };
      if (loseSource) throw new Error('Source proposal acknowledgment lost');
      return Response.json({ applied: 1, skipped: 0, authorization: rewriteAuthorization(sourceProposal), connectUrl: browser.connectUrl });
    }
    if (String(url).includes('/source-authorizations/')) return sourceProposal ? Response.json({ authorization: rewriteAuthorization(sourceProposal) }) : Response.json({}, { status: 404 });
    if (String(url).endsWith('/deployment-sessions')) { duringSession(); return denied ? Response.json({ echoed: nativeToken }, { status: 403 })
      : Response.json({ kind: 'gcp-impersonation', principal: provision, token: nativeToken, expiresAt: new Date(Date.now() + 300_000).toISOString() }); }
    if (denied && method === 'GET') return Response.json({ error: deviceToken }, { status: 403 });
    if (method === 'POST') {
      browser = { id: body.connectionId, purpose: 'deployment', mode: 'connect', status: 'choose-provider', provider: null, keys: [], environment: 'staging', source,
        expiresAt: new Date(Date.now() + 86400_000).toISOString(), connectUrl: `https://hypervibe.dev/apps/app-id/cloud-connections/${body.connectionId}`, deployment: 'not-authorized' };
      if (lost) throw new Error('lost response');
      return Response.json({ applied: 1, skipped: 0, connection: browser });
    }
    const deploymentConnection = { schemaVersion: 1, purpose: 'deployment', installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', planDigest: 'd'.repeat(64), customerId: 'customer-id', appId: 'app-id', environment: 'staging',
      source: { repository: 'github.com/studio/app', branch: source.branch, revision: source.revision, specDigest: source.digest }, provider: 'gcp', hostingProvider: 'deployment-fixture',
      nativeScope: { projectId: 'native-project', projectNumber: '123456789', region: 'us-central1' },
      deployment: { hostingProvider: 'deployment-fixture', region: 'us-central1', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] },
      hostIdentity: { kind: 'gcp-service-account', projectId: 'host-project', projectNumber: '987654321', serviceAccountEmail: 'delivery@host-project.iam.gserviceaccount.com', subject: '987654321098765432109', issuer: 'https://accounts.google.com' },
      principals: { provision, release: nativePrincipal('release', '222222222222222222222') }, runtimeIdentities: [{ workload: 'web', installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner: 'e'.repeat(64), principal: nativePrincipal('runtime', '333333333333333333333') }] };
    receipt = deploymentConnection;
    return Response.json({ connection: { ...browser, ...(ready ? { status: 'ready', provider: 'gcp', deployment: 'provision-approved' } : {}) }, ...(ready ? { deploymentConnection: rewrite(deploymentConnection), releasePolicies: policy ? [policy] : [], ...(sourceAuthorization ? { sourceAuthorization } : {}) } : {}) });
  });
  vi.stubGlobal('fetch', request);
  const context = createCommandContext(); const project = context.repos.projects.create({ name: 'app', gitRemoteUrl: 'https://github.com/studio/app.git', defaultPlatform: 'deployment-fixture' });
  const commands = createCommandRegistry(context);
  const run = (input: Record<string, unknown>) => runWithWorkspaceDirectories([root], () => commands.execute('hv_cloud_connections', { purpose: 'deployment-access', env: 'staging', ...input }));
  const command = (name: string, input: Record<string, unknown>) => runWithWorkspaceDirectories([root], () => commands.execute(name, input));
  const pair = async () => { expect(await run({ action: 'start' })).toMatchObject({ ok: true, data: { status: 'pending' } }); expect(await run({ action: 'status' })).toMatchObject({ ok: true, data: { status: 'verified' } }); };
  const adapter = (env?: string) => runWithWorkspaceDirectories([root], () => context.adapterFactory.getProviderAdapter('deployment-fixture', project, undefined, env));
  return { context, commands, project, calls, run, command, pair, adapter, source, request, setReady: () => { ready = true; }, lose: () => { lost = true; }, deny: () => { denied = true; }, rewrite: (fn: typeof rewrite) => { rewrite = fn; }, duringSession: (fn: typeof duringSession) => { duringSession = fn; }, losePolicy: () => { losePolicy = true; },
    loseSource: () => { loseSource = true; }, approveSource: () => { sourceProposal.status = 'approved'; sourceAuthorization = sourceProposal.receipt; }, loseExchange: () => { loseExchange = true; },
    rewriteAuthorization: (fn: typeof rewriteAuthorization) => { rewriteAuthorization = fn; } };
}
describe('device deployment authority through the ordinary command and adapter boundaries', () => {
  it('proposes a branch transfer using the retained device after its old branch is deleted, without replacing native evidence', async () => {
    git('switch', '-c', 'review/cloud'); const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    const before = f.context.secretStore.decryptObject(f.context.repos.connections.findAllByProvider('hypervibe-deployment-binding')[0]!.credentialsEncrypted) as any;
    git('switch', 'main'); git('branch', '-D', 'review/cloud');
    const proposed = await f.run({ action: 'propose-source' });
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, data: { sourceAuthorization: { status: 'review-required' } } });
    const after = f.context.secretStore.decryptObject(f.context.repos.connections.findAllByProvider('hypervibe-deployment-binding')[0]!.credentialsEncrypted) as any;
    expect(after.receipt).toEqual(before.receipt); expect(after.source).toEqual(before.source);
    expect(f.calls.filter(call => call.url.endsWith('/source-authorizations'))).toHaveLength(1);
    expect((await f.adapter('staging')).success).toBe(false); expect(factory).not.toHaveBeenCalled();
  });
  it('routes branch proposals and historical recovery through both CLI and MCP with the same safe envelope', async () => {
    git('switch', '-c', 'review/cloud'); const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    git('switch', 'main'); git('branch', '-D', 'review/cloud'); let output = '';
    expect(await runWithWorkspaceDirectories([root], () => runCli(['cloud', 'connections', '--purpose', 'deployment-access', '--env', 'staging', '--action', 'propose-source', '--json'],
      { registry: f.commands, initialize: false, io: { writeOut: value => { output += value; }, writeErr: () => {}, readStdin: async () => '', confirm: async () => false, stdinIsTTY: false } }))).toBe(0);
    const proposal = JSON.parse(output).data.sourceAuthorization;
    expect(proposal.status).toBe('review-required'); expect(output).not.toContain(deviceToken);
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerCommandRegistry({ registerTool: (id: string, _schema: unknown, fn: (input: Record<string, unknown>) => Promise<unknown>) => handlers.set(id, fn),
      server: { getClientCapabilities: () => ({}) } } as unknown as McpServer, f.commands);
    const result = await runWithWorkspaceDirectories([root], () => handlers.get('hv_cloud_connections')!({ purpose: 'deployment-access', env: 'staging', action: 'status' }));
    expect(result).toMatchObject({ structuredContent: { ok: true, data: { sourceAuthorization: proposal } } });
    expect(JSON.stringify(result)).not.toContain(deviceToken);
    expect(f.calls.filter(call => call.url.endsWith('/source-authorizations'))).toHaveLength(1);
  });
  it('recovers the exact transfer and keeps the old grant until separate new-branch pairing completes', async () => {
    git('switch', '-c', 'review/cloud'); const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    git('switch', 'main'); git('branch', '-D', 'review/cloud'); f.loseSource();
    expect((await f.run({ action: 'propose-source' })).ok).toBe(false);
    const proposal = f.calls.find(call => call.url.endsWith('/source-authorizations'));
    expect(proposal).toBeDefined();
    expect(await f.run({ action: 'status' })).toMatchObject({ ok: true, data: { sourceAuthorization: { id: proposal!.body.authorizationId, status: 'review-required' } } });
    f.approveSource();
    expect(await f.run({ action: 'status', sourceBranch: 'main' })).toMatchObject({ ok: true, data: { sourceAuthorization: { status: 'approved' } } });
    expect((await f.adapter('staging')).success).toBe(false);
    expect(await f.run({ action: 'start' })).toMatchObject({ ok: true, data: { status: 'pending', sourceBranch: 'main' } });
    const access = () => f.context.secretStore.decryptObject(f.context.repos.connections.findAllByProvider('hypervibe-deployment-access')[0]!.credentialsEncrypted) as any;
    expect(access().token).toBe(deviceToken); expect(access().sourceBranch).toBe('review/cloud');
    expect(await f.run({ action: 'status', sourceBranch: 'main' })).toMatchObject({ ok: true, data: { status: 'verified', sourceBranch: 'main' } });
    expect(await f.run({ action: 'status', sourceBranch: 'main' })).toMatchObject({ ok: true, data: { sourceAuthorization: { status: 'approved' } } });
    expect((await f.run({ action: 'status', sourceBranch: 'unapproved-branch' })).ok).toBe(false);
    expect(access().token).not.toBe(deviceToken);
    const selected = await f.adapter('staging'); expect(selected.success).toBe(true);
    expect((selected.adapter as any).input.connection.source.branch).toBe('review/cloud');
    expect((selected.adapter as any).input.sourceAuthorization.source.branch).toBe('main');
    const originalReceipt = (selected.adapter as any).input.connection;
    await runWithWorkspaceDirectories([root], () => (selected.adapter as any).input.authentication.getAccessToken(new AbortController().signal));
    expect(f.calls.find(call => call.url.endsWith('/deployment-sessions'))?.body.sourceAuthorityDigest).toBe((selected.adapter as any).input.sourceAuthorization.digest);
    const document = JSON.parse(readFileSync(path.join(root, '.hypervibe/spec.json'), 'utf8'));
    for (const environment of Object.values(document.environments) as any[]) environment.deploy = { strategy: 'branch', trigger: 'ci', branch: 'main' };
    writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify(document)); git('add', '.hypervibe/spec.json');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'managed CI after source approval');
    const resolved = await runWithWorkspaceDirectories([root], async () => resolveReviewedBranchDeployTargets(f.project, readRepoSpecFile(root)!.spec));
    const ciAccess = resolved.targets.find(target => target.environmentName === 'staging')?.deploymentAccess;
    expect(ciAccess?.sourceBranch).toBe('main'); expect(ciAccess?.sourceAuthorization).toEqual((selected.adapter as any).input.sourceAuthorization);
    expect(canonicalJsonSha256(ciAccess?.connection)).toBe(canonicalJsonSha256(originalReceipt));
    expect(f.calls.filter(call => call.url.endsWith('/source-authorizations'))).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/cloud-deployments'))).toHaveLength(1);
  });
  it('never repeats an uncertain replacement device exchange and retains the historical grant', async () => {
    git('switch', '-c', 'review/cloud'); const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    git('switch', 'main'); expect((await f.run({ action: 'propose-source' })).ok).toBe(true); f.approveSource(); await f.run({ action: 'status' });
    await f.run({ action: 'start' }); f.loseExchange(); expect((await f.run({ action: 'status' })).ok).toBe(false);
    const attempted = f.calls.filter(call => call.url.endsWith('/pairing-exchanges')).length;
    expect(await f.run({ action: 'status' })).toMatchObject({ ok: true, data: { status: 'exchange_uncertain' } });
    expect(f.calls.filter(call => call.url.endsWith('/pairing-exchanges'))).toHaveLength(attempted);
    const access = f.context.secretStore.decryptObject(f.context.repos.connections.findAllByProvider('hypervibe-deployment-access')[0]!.credentialsEncrypted) as any;
    expect(access.token).toBe(deviceToken); expect((await f.adapter('staging')).success).toBe(false);
  });
  it('recovers the encrypted received replacement token after the final local grant replacement fails', async () => {
    git('switch', '-c', 'review/cloud'); const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    git('switch', 'main'); await f.run({ action: 'propose-source' }); f.approveSource(); await f.run({ action: 'status' }); await f.run({ action: 'start' });
    const save = f.context.repos.connections.compareAndSwap.bind(f.context.repos.connections);
    const failing = vi.spyOn(f.context.repos.connections, 'compareAndSwap').mockImplementation((input, ...args) => {
      const next = f.context.secretStore.decryptObject(input.credentialsEncrypted) as any;
      if (input.provider === 'hypervibe-deployment-access' && next.status === 'verified' && next.sourceBranch === 'main' && !next.pendingPairing)
        throw new Error('Synthetic final persistence failure');
      return save(input, ...args);
    });
    expect((await f.run({ action: 'status' })).ok).toBe(false); failing.mockRestore();
    const access = f.context.secretStore.decryptObject(f.context.repos.connections.findAllByProvider('hypervibe-deployment-access')[0]!.credentialsEncrypted) as any;
    expect(access.token).toBe(deviceToken); expect(access.exchangeRecovery?.token).toBe(deviceToken.replace('A'.repeat(43), 'C'.repeat(43)));
    const attempts = f.calls.filter(call => call.url.endsWith('/pairing-exchanges')).length;
    const recovered = await f.run({ action: 'status' });
    expect(recovered).toMatchObject({ ok: true, data: { status: 'verified', sourceBranch: 'main' } });
    expect(JSON.stringify(recovered)).not.toContain('C'.repeat(43));
    expect(f.calls.filter(call => call.url.endsWith('/pairing-exchanges'))).toHaveLength(attempts);
  });
  it.each(['from', 'predecessor', 'connection'])('rejects a branch proposal whose signed-shape %s differs from the exact local review', async changed => {
    git('switch', '-c', 'review/cloud'); const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    git('switch', 'main');
    f.rewriteAuthorization(value => {
      const { digest: _digest, ...fields } = value.receipt;
      if (changed === 'from') fields.from = { ...fields.from, branch: 'unrelated-branch' };
      if (changed === 'predecessor') fields.previousDigest = '0'.repeat(64);
      if (changed === 'connection') fields.connectionDigest = '1'.repeat(64);
      return { ...value, receipt: { ...fields, digest: canonicalJsonSha256(fields) }, digest: canonicalJsonSha256(fields) };
    });
    expect((await f.run({ action: 'propose-source' })).ok).toBe(false);
    const retained = f.context.secretStore.decryptObject(f.context.repos.connections.findAllByProvider('hypervibe-deployment-binding')[0]!.credentialsEncrypted) as any;
    expect(retained.sourceAuthorization).toBeUndefined(); expect(retained.sourceProposal.status).toBe('pending');
    expect((await f.adapter('staging')).success).toBe(false);
  });
  it('does not retain a replacement grant or consuming token recovery after explicit device revocation', async () => {
    git('switch', '-c', 'review/cloud'); const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    git('switch', 'main'); await f.run({ action: 'propose-source' }); f.approveSource(); await f.run({ action: 'status' }); await f.run({ action: 'start' });
    const save = f.context.repos.connections.compareAndSwap.bind(f.context.repos.connections);
    const failing = vi.spyOn(f.context.repos.connections, 'compareAndSwap').mockImplementation((input, ...args) => {
      const next = f.context.secretStore.decryptObject(input.credentialsEncrypted) as any;
      if (input.provider === 'hypervibe-deployment-access' && next.status === 'verified' && next.sourceBranch === 'main' && !next.pendingPairing)
        throw new Error('Synthetic final persistence failure');
      return save(input, ...args);
    });
    expect((await f.run({ action: 'status' })).ok).toBe(false); failing.mockRestore();
    expect(await f.run({ action: 'revoke', confirm: true })).toMatchObject({ ok: true, data: { status: 'revoked' } });
    const access = f.context.secretStore.decryptObject(f.context.repos.connections.findAllByProvider('hypervibe-deployment-access')[0]!.credentialsEncrypted) as any;
    expect(access.token).toBeUndefined(); expect(access.pendingPairing).toBeUndefined(); expect(access.exchangeRecovery).toBeUndefined();
    expect((await f.run({ action: 'status' })).ok).toBe(false); expect((await f.adapter('staging')).success).toBe(false);
  });
  it('retains uncertain replacement revocation evidence and never restores either local grant', async () => {
    git('switch', '-c', 'review/cloud'); const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    git('switch', 'main'); await f.run({ action: 'propose-source' }); f.approveSource(); await f.run({ action: 'status' }); await f.run({ action: 'start' });
    const save = f.context.repos.connections.compareAndSwap.bind(f.context.repos.connections);
    const failing = vi.spyOn(f.context.repos.connections, 'compareAndSwap').mockImplementation((input, ...args) => {
      const next = f.context.secretStore.decryptObject(input.credentialsEncrypted) as any;
      if (input.provider === 'hypervibe-deployment-access' && next.status === 'verified' && next.sourceBranch === 'main' && !next.pendingPairing) throw new Error('Synthetic final persistence failure');
      return save(input, ...args);
    });
    await f.run({ action: 'status' }); failing.mockRestore();
    const transport = f.request.getMockImplementation()!; let lost = false;
    f.request.mockImplementation(async (url, init) => {
      if (init?.method === 'DELETE' && new Headers(init.headers).get('authorization')?.includes('C'.repeat(43))) {
        if (!lost) { lost = true; throw new Error('Lost replacement revoke acknowledgment'); }
        return Response.json({ error: 'Already rejected' }, { status: 401 });
      }
      return transport(url, init);
    });
    expect((await f.run({ action: 'revoke', confirm: true })).ok).toBe(false);
    const saved = () => f.context.secretStore.decryptObject(f.context.repos.connections.findAllByProvider('hypervibe-deployment-access')[0]!.credentialsEncrypted) as any;
    expect(saved().exchangeRecovery.token).toContain('C'.repeat(43)); expect(saved().status).toBe('revoked');
    expect((await f.adapter('staging')).success).toBe(false);
    const result = await f.run({ action: 'revoke', confirm: true });
    expect(result).toMatchObject({ ok: true, data: { status: 'partial', deviceAccess: 'disabled' } });
    expect(JSON.stringify(result)).not.toContain('C'.repeat(43)); expect(saved().exchangeRecovery).toBeUndefined();
    expect((await f.run({ action: 'status' })).ok).toBe(false);
  });
  it('recovers the exact lost installation receipt from a dirty checkout without adopting edits or granting deployment', async () => {
    const f = fixture(); await f.pair(); f.lose(); expect((await f.run({ action: 'connect' })).ok).toBe(false); f.setReady();
    const edits = 'unfinished invalid spec'; writeFileSync(path.join(root, '.hypervibe/spec.json'), edits);
    const before = f.calls.length;
    expect(await f.run({ action: 'status' })).toMatchObject({ ok: true, data: { status: 'ready', connection: { source: f.source } } });
    expect(f.calls.slice(before).every(call => call.method === 'GET' && call.url.includes('/cloud-deployments/'))).toBe(true);
    expect(readFileSync(path.join(root, '.hypervibe/spec.json'), 'utf8')).toBe(edits);
    expect((await f.adapter('staging')).success).toBe(false);
    expect((await f.run({ action: 'connect' })).ok).toBe(false); expect((await f.run({ action: 'propose-release' })).ok).toBe(false);
    expect((await f.run({ action: 'propose-source' })).ok).toBe(false);
    expect(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/cloud-deployments'))).toHaveLength(1);
  });
  it('recovers the saved policy on another branch and preserves its approved branch without extra POSTs', async () => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' }); f.losePolicy();
    expect((await f.run({ action: 'propose-release' })).ok).toBe(false);
    const policyId = f.calls.find(call => call.url.endsWith('/release-policies'))!.body.policyId;
    git('switch', '-c', 'unapproved-branch'); const before = f.calls.length;
    expect(await f.run({ action: 'status' })).toMatchObject({ ok: true, data: { releasePolicy: { id: policyId, status: 'review-required' }, connection: { source: { branch: 'main' } } } });
    expect(f.calls.slice(before).every(call => call.method === 'GET')).toBe(true);
    expect((await f.run({ action: 'status', sourceBranch: 'unapproved-branch' })).ok).toBe(false);
    expect((await f.adapter('staging')).success).toBe(false);
    expect((await f.run({ action: 'propose-release' })).ok).toBe(false);
    expect(f.calls.filter(call => call.url.endsWith('/release-policies'))).toHaveLength(1);
  });
  it.each(['hypervibe-deployment-access', 'hypervibe-deployment-binding'])('does not accept a delayed browser receipt after %s loses authority', async provider => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    const transport = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async (...args) => {
      const response = await transport(...args), row = f.context.repos.connections.findAllByProvider(provider)[0]!;
      f.context.repos.connections.updateStatus(row.id, 'failed'); return response;
    });
    expect((await f.run({ action: 'status' })).ok).toBe(false);
    expect(f.context.repos.connections.findAllByProvider(provider)[0]!.status).toBe('failed');
    expect((await f.run({ action: 'status' })).ok).toBe(false);
  });
  it('routes only the exact environment binding into managed CI and fails closed after local revocation', async () => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    const document = JSON.parse(readFileSync(path.join(root, '.hypervibe/spec.json'), 'utf8'));
    for (const environment of Object.values(document.environments) as any[]) environment.deploy = { strategy: 'branch', trigger: 'ci', branch: 'main' };
    writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify(document)); git('add', '.hypervibe/spec.json'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'managed CI');
    const resolve = () => runWithWorkspaceDirectories([root], async () => resolveReviewedBranchDeployTargets(f.project, readRepoSpecFile(root)!.spec));
    const result = await resolve(); expect(result.targets.find(target => target.environmentName === 'staging')?.deploymentAccess).toMatchObject({ environment: 'staging', sourceBranch: 'main', origin: 'https://hypervibe.dev', projectId: 'app-id' });
    expect(result.targets.find(target => target.environmentName === 'production')?.deploymentAccess).toBeUndefined();
    const row = f.context.repos.connections.findAllByProvider('hypervibe-deployment-access')[0]!; f.context.repos.connections.updateStatus(row.id, 'failed');
    await expect(resolve()).rejects.toThrow();
  });
  it('persists a release-policy request before posting and recovers its exact lost acknowledgment without authorizing release', async () => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' }); f.losePolicy();
    expect((await f.run({ action: 'propose-release' })).ok).toBe(false);
    const policyCalls = f.calls.filter(call => call.url.endsWith('/release-policies')); expect(policyCalls).toHaveLength(1);
    const result = await f.run({ action: 'status' }); expect(result).toMatchObject({ ok: true, data: { releasePolicy: { id: policyCalls[0].body.policyId, status: 'review-required', digest: 'f'.repeat(64) } } });
    expect(f.calls.some(call => call.method === 'GET' && call.url.endsWith(`/release-policies/${policyCalls[0].body.policyId}`))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('deliberately');
    await f.run({ action: 'propose-release' }); expect(f.calls.filter(call => call.url.endsWith('/release-policies'))).toHaveLength(1);
  });
  it.each(['hypervibe-deployment-access', 'hypervibe-deployment-binding'])('rejects a native token when %s loses verified status during issuance', async provider => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    const result = await f.adapter('staging'); expect(result.success).toBe(true);
    f.duringSession(() => { const row = f.context.repos.connections.findAllByProvider(provider)[0]!; f.context.repos.connections.updateStatus(row.id, 'failed'); });
    await expect(runWithWorkspaceDirectories([root], () => (result.adapter as any).input.authentication.getAccessToken(new AbortController().signal))).rejects.toThrow();
    expect((await f.adapter('staging')).success).toBe(false); expect(legacy).not.toHaveBeenCalled();
  });
  it('carries the environment through first project plan/apply without a local environment row, then ordinary status', async () => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    expect(f.context.repos.environments.findByProjectAndName(f.project.id, 'staging')).toBeNull();
    const plan = await f.command('hv_plan', { project: f.project.name, env: 'staging' }); expect(plan.ok, JSON.stringify(plan)).toBe(true);
    const planData = plan.data as any;
    const applied = await f.command('hv_apply', { project: f.project.name, planId: planData.planId, confirmActions: planData.actions?.map((action: any) => action.id) ?? [] });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    expect(f.calls.some(call => call.url.endsWith('/deployment-sessions'))).toBe(true);
    expect(factory.mock.calls.every(([input]) => input.connection.environment === 'staging')).toBe(true); expect(legacy).not.toHaveBeenCalled();
    expect(f.context.repos.environments.findByProjectAndName(f.project.id, 'staging')?.platformBindings.projectId).toBe('native-project');
    expect((await f.command('hv_status', { project: f.project.name, env: 'staging' })).ok).toBe(true);
  });
  it('starts a fresh browser approval after definite remote revocation while preserving the exact installation reference', async () => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' }); f.deny();
    expect(await f.run({ action: 'start' })).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/cloud-deployments'))).toHaveLength(1);
  });
  it('rejects successful metadata that echoes the supplied device credential', async () => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); f.rewrite(receipt => ({ ...receipt, customerId: deviceToken }));
    const result = await f.run({ action: 'status' }); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(deviceToken);
    expect((await f.adapter('staging')).success).toBe(false);
  });
  it('can revoke the exact device grant after the source branch and uncommitted spec change', async () => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    git('switch', '-c', 'changed'); writeFileSync(path.join(root, '.hypervibe/spec.json'), 'uncommitted broken source');
    expect(await f.run({ action: 'revoke', confirm: true })).toMatchObject({ ok: true, data: { status: 'revoked', applied: 1 } });
  });
  it('pairs separately, recovers a lost connection response by exact ID, and persists only a value-free ready binding', async () => {
    const f = fixture(); await f.pair(); f.lose(); expect((await f.run({ action: 'connect' })).ok).toBe(false);
    f.setReady(); const ready = await f.run({ action: 'status' }); expect(ready).toMatchObject({ ok: true, data: { status: 'ready' } });
    expect(f.calls.filter(call => call.url.endsWith('/cloud-deployments') && call.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(ready)).not.toMatch(new RegExp(`${deviceToken}|${nativeToken}`));
    expect(factory).not.toHaveBeenCalled();
  });
  it('resolves exact environment using transient callbacks and blocks legacy fallback after native access is revoked', async () => {
    const f = fixture(); await f.pair(); await f.run({ action: 'connect' }); f.setReady(); await f.run({ action: 'status' });
    const stored = f.context.repos.connections.upsert({ provider: 'deployment-fixture', scope: null, credentialsEncrypted: f.context.secretStore.encryptObject({ password: 'legacy-secret' }) }); f.context.repos.connections.updateStatus(stored.id, 'verified');
    const result = await f.adapter('staging'); expect(result.success).toBe(true); expect(legacy).not.toHaveBeenCalled();
    const native = (result.adapter as any).input.authentication;
    const issued = await runWithWorkspaceDirectories([root], () => native.getAccessToken(new AbortController().signal)) as { token: string }; expect(issued.token).toBe(nativeToken);
    expect((await f.adapter()).success).toBe(false);
    f.deny(); await expect(runWithWorkspaceDirectories([root], () => native.getAccessToken(new AbortController().signal))).rejects.toThrow();
    expect((await f.adapter('staging')).success).toBe(false); expect(legacy).not.toHaveBeenCalled();
    for (const record of f.context.repos.connections.findAll()) expect(JSON.stringify(f.context.secretStore.decryptObject(record.credentialsEncrypted))).not.toContain(nativeToken);
  });
});
