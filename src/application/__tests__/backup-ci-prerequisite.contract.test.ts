import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import '../providers.js';
import '../devops-providers.js';
import { getDb, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { PublicDnsClient } from '../../adapters/dns/public-dns.client.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { AdapterFactory, adapterFactory } from '../../domain/services/adapter.factory.js';
import { managedBackupTargetHash } from '../../domain/services/managed-backup-target.service.js';
import { observeManagedBackupProgram } from '../../domain/services/managed-backup-policy.service.js';
import { applyGitHubInfrastructure } from '../../domain/services/github-infrastructure.service.js';
import { buildBranchDeployWorkflow, resolveBranchDeployTargets } from '../../domain/services/github-ops.service.js';
import { workflowFiles } from '../../domain/services/ci-deploy.service.js';
import { compileManagedBackupFiles } from '../../domain/services/managed-backup-workflows.service.js';
import type { IDatabaseAdapter } from '../../domain/ports/database.port.js';
import type { IStorageAdapter } from '../../domain/ports/storage.port.js';
import * as bootstrap from '../../domain/services/bootstrap.service.js';

// Real planners, SQLite, workflow compiler, apply and GitHub HTTP adapter.
// HTTP replies and native backup observations are synthetic, not live proof.
describe('backup activation through CI credentials and canonical repository publication', () => {
  let directory: string;
  let ctx: CommandContext;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-backup-ci-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
    ctx = createCommandContext();
    vi.spyOn(PublicDnsClient.prototype, 'query').mockResolvedValue({ status: 'unknown' });
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
  });

  async function fixture() {
    const project = ctx.repos.projects.create({ name: 'backup-ci', defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/acme/backup-ci' });
    const stored = new SpecStore().replace(project, { version: 1, project: project.name,
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
      github: { enabled: true, repository: 'acme/backup-ci', canonicalEnvironment: 'staging',
        collaboration: { issues: { enabled: false, templates: false }, pullRequests: { requirePr: false } },
        dependencies: { alerts: false, securityUpdates: false }, actions: {},
        security: { codeScanning: false, secretScanning: false, pushProtection: false } },
      environments: { staging: { hosting: { provider: 'railway' }, services: {}, backups: { mode: 'disabled', reason: 'Disposable staging' }, email: { enabled: false } }, production: {
        hosting: { provider: 'railway' }, services: { web: { startCommand: 'npm start', public: true } },
        database: { provider: 'railway', engine: 'postgres' },
        storage: { documents: { provider: 'railway', type: 'bucket', region: 'iad', injectInto: ['web'] } },
        backups: { mode: 'daily', runnerImage: `ghcr.io/acme/backup@sha256:${'a'.repeat(64)}`,
          fileReferenceQueries: [{ storageName: 'documents', query: 'SELECT key FROM files' }] },
        email: { enabled: false }, envVars: { CHANGE_PENDING: 'new-value' },
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
      } } });
    for (const [provider, credentials] of Object.entries({ railway: { apiToken: 'synthetic-railway-token' },
      github: { apiToken: 'synthetic-github-token', login: 'acme', packageReadToken: 'synthetic-package-token' } })) {
      const connection = ctx.repos.connections.create({ provider, credentialsEncrypted: ctx.secretStore.encryptObject(credentials) });
      ctx.repos.connections.updateStatus(connection.id, 'verified');
    }
    const scope = { projectId: 'project-1', environmentId: 'production-1' };
    const bucket = (externalId: string, purpose?: 'backup') => ({ provider: 'railway', externalId,
      region: 'iad', instanceScope: scope, services: purpose ? [] : ['web'], envKeys: [], ...(purpose ? { purpose } : {}) });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
      provider: 'railway', ...scope, services: { web: { serviceId: 'web-1', workloadKind: 'web' } },
      appliedSpecHash: 'unchanged-application-contract',
      storage: { documents: bucket('documents-1'), 'hypervibe-backups': bucket('archive-1', 'backup') },
    } });
    const source = { provider: 'railway', primaryExternalId: 'db-1', providerScope: scope,
      resourceIdentity: { volumeId: 'volume-1', volumeInstanceId: 'volume-instance-1' } };
    ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'db-1',
      bindings: { provider: 'railway', resourceKind: 'service', providerScope: scope } });
    const observe = vi.fn(async () => ({ state: 'known', source, daily: true,
      policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot' }));
    vi.spyOn(AdapterFactory.prototype, 'getDatabaseAdapter').mockResolvedValue({ success: true,
      adapter: { name: 'railway', dailyBackups: { observe } } as unknown as IDatabaseAdapter });
    vi.spyOn(AdapterFactory.prototype, 'getDatabaseOperations').mockResolvedValue({ success: true,
      adapter: { name: 'railway', dailyBackups: { observe } } as unknown as IDatabaseAdapter });
    vi.spyOn(AdapterFactory.prototype, 'getStorageAdapter').mockResolvedValue({ success: true,
      adapter: { name: 'railway', capabilities: { recoveryCredentialScope: 'bucket' },
        getCredentials: vi.fn(() => { throw new Error('No storage data-plane access is authorized'); }) } as unknown as IStorageAdapter });
    vi.spyOn(AdapterFactory.prototype, 'getStorageOperations').mockResolvedValue({ success: true,
      adapter: { name: 'railway', capabilities: { recoveryCredentialScope: 'bucket' },
        getCredentials: vi.fn(() => { throw new Error('No storage data-plane access is authorized'); }) } as unknown as IStorageAdapter });
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true, ...scope,
      partial: false, warnings: [], services: [{ name: 'web', externalId: 'web-1', workloadKind: 'web',
        sourceState: 'disconnected', config: { startCommand: 'npm start', public: true }, envVarKeys: [], envVarHashes: {}, customDomains: [], status: 'running' }],
      databases: [{ provider: 'railway', engine: 'postgres', externalId: 'db-1', status: 'running', providerScope: scope }],
      storage: ['documents', 'hypervibe-backups'].map(name => ({ name, provider: 'railway', kind: 'object' as const,
        status: 'running' as const, externalId: name === 'documents' ? 'documents-1' : 'archive-1', region: 'iad', instanceScope: scope })),
    } });
    const files = new Map<string, string>();
    const refreshWorkflow = () => {
      const { targets, migration } = resolveBranchDeployTargets(project);
      const workflow = buildBranchDeployWorkflow('railway', targets[0], migration);
      for (const file of workflowFiles(workflow)) files.set(file.path, file.content);
      return workflow;
    };
    refreshWorkflow();
    const secretNames = new Set<string>();
    const writes: Array<{ method: string; pathname: string; body: unknown }> = [];
    const unexpected: string[] = [];
    let secretsUnknown = false;
    let unknownFile: string | undefined;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input)), method = options?.method ?? 'GET', route = url.pathname;
      if (url.origin !== 'https://api.github.com') { unexpected.push(`${method} ${url.origin}${route}`); throw new Error('Unexpected provider HTTP'); }
      if (method === 'GET' && route === '/user') return json({ login: 'acme', id: 1 });
      if (method === 'GET' && route === '/repos/acme/backup-ci') return json({ default_branch: 'main', private: true });
      if (method === 'GET' && route.startsWith('/repos/acme/backup-ci/contents/')) {
        const file = decodeURIComponent(route.slice('/repos/acme/backup-ci/contents/'.length)), content = files.get(file);
        if (file === unknownFile) return json({ message: 'Denied' }, 403);
        return content === undefined ? json({ message: 'Not Found' }, 404)
          : json({ type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), sha: 'b'.repeat(40) });
      }
      if (method === 'GET' && route === '/repos/acme/backup-ci/environments/production/secrets')
        return secretsUnknown ? json({ message: 'Denied' }, 403) : json({ total_count: secretNames.size, secrets: [...secretNames].map(name => ({ name })) });
      if (method === 'GET' && route === '/repos/acme/backup-ci/environments/production') return json({ name: 'production' });
      if (method === 'GET' && route.endsWith('/environments/production/secrets/public-key'))
        return json({ key_id: 'key-1', key: Buffer.alloc(32, 9).toString('base64') });
      if (method === 'PUT' && route.startsWith('/repos/acme/backup-ci/environments/production/secrets/')) {
        const body = JSON.parse(String(options?.body));
        expect(Object.keys(body).sort()).toEqual(['encrypted_value', 'key_id']);
        expect(body.key_id).toBe('key-1'); expect(body.encrypted_value).not.toContain('synthetic');
        secretNames.add(decodeURIComponent(route.split('/').at(-1)!)); writes.push({ method, pathname: route, body });
        return new Response(null, { status: 204 });
      }
      if (method === 'GET' && route.includes('/environments/production/variables/')) return json({ message: 'Not Found' }, 404);
      if (method === 'GET' && route.endsWith('/actions/workflows')) return json({ total_count: 1,
        workflows: [{ id: 1, path: '.github/workflows/hypervibe-backup-production.yml', state: 'active' }] });
      if (method === 'GET' && route.endsWith('/labels')) return json([]);
      unexpected.push(`${method} ${route}`); throw new Error(`Unexpected GitHub HTTP: ${method} ${route}`);
    }));
    const plan = (env = 'production') => new PlanService().plan(project, env, { includeEnvFile: false, ...(env === 'production' ? { scope: 'backups' as const } : {}) });
    return { project, stored, environment, files, secretNames, writes, unexpected, plan, refreshWorkflow,
      setUnknown: (value: boolean) => { secretsUnknown = value; },
      setUnknownFile: (value: string) => { unknownFile = value; } };
  }

  const backupPaths = ['.github/hypervibe/backups-production.json', '.github/workflows/hypervibe-backup-production.yml'];
  const previousProgram = new URL('../../domain/services/__tests__/fixtures/backup-program-v0.1.52/', import.meta.url);

  const lastMonitoredImage = 'ghcr.io/davejohnson/hypervibe/backup-runner@sha256:bb0358608d057fa764c6c195522f48c0a2e4b819783a06f47a5f2c3723e28734';

  function installPreviousWorkflow(f: Awaited<ReturnType<typeof fixture>>, image: string) {
    const oldTarget = JSON.parse(readFileSync(new URL(path.basename(backupPaths[0]), previousProgram), 'utf8'));
    const target = { ...oldTarget, runnerImage: image };
    const workflow = readFileSync(new URL(path.basename(backupPaths[1]), previousProgram), 'utf8')
      .replaceAll(oldTarget.runnerImage, image).replaceAll(managedBackupTargetHash(oldTarget), managedBackupTargetHash(target));
    f.files.set(backupPaths[0], JSON.stringify(target, null, 2) + '\n');
    f.files.set(backupPaths[1], workflow);
    getDb().prepare('UPDATE components SET id = ? WHERE environment_id = ? AND external_id = ?')
      .run(target.database.componentId, f.environment.id, target.database.source.primaryExternalId);
    return new SpecStore().merge(f.project, { environments: { production: { backups: { mode: 'daily', runnerImage: image } } } });
  }

  it('does not report a previous template as ready for a release with a different alert format', async () => {
    const f = await fixture();
    const image = 'ghcr.io/davejohnson/hypervibe/backup-runner@sha256:f1afe914ebefbc1927be64dfc58d3f946cb5ac7f3662977154402518994ae9f6';
    const { spec } = installPreviousWorkflow(f, image);
    expect(await observeManagedBackupProgram({ project: f.project, spec: spec.environments.production,
      environment: f.environment, components: ctx.repos.components.findByEnvironmentId(f.environment.id), adapterFactory }))
      .toMatchObject({ state: 'blocked' });
  });

  it('repairs an old workflow generated for a newer official helper without changing its digest', async () => {
    const f = await fixture();
    for (const name of ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']) f.secretNames.add(name);
    const image = 'ghcr.io/davejohnson/hypervibe/backup-runner@sha256:' + 'd'.repeat(64);
    const { spec } = installPreviousWorkflow(f, image);
    const observed = await observeManagedBackupProgram({ project: f.project, spec: spec.environments.production,
      environment: f.environment, components: ctx.repos.components.findByEnvironmentId(f.environment.id), adapterFactory });
    expect(observed.state).toBe('blocked');
    const planned = await f.plan();
    if ('error' in planned) throw new Error(planned.error);
    expect(planned).toMatchObject({ scope: 'backup-program-publication', blocked: [] });
    const files = planned.actions[0].metadata?.desiredFiles as Array<{ path: string; content: string }>;
    expect(files[0].content).toBe(f.files.get(backupPaths[0]));
    expect(files[1].content).toContain(image);
    expect(files[1].content).not.toContain('issues: write');
    expect(f.writes).toEqual([]);
  });

  it('requires a compatible helper when activating an older release pin without any published workflow', async () => {
    const f = await fixture();
    new SpecStore().merge(f.project, { environments: { production: { backups: { mode: 'daily',
      runnerImage: lastMonitoredImage } } } });
    const result = await f.plan();
    expect(result).toMatchObject({ actions: [], blocked: [expect.objectContaining({ reason: expect.stringContaining('backups.runnerImage') })] });
    expect(f.files.has(backupPaths[1])).toBe(false);
    const spec = new SpecStore().get(f.project)!.spec;
    const incompatible = await compileManagedBackupFiles({ project: f.project, spec, environmentName: 'production' });
    expect(incompatible.issues).toEqual([]);
    for (const file of incompatible.files) f.files.set(file.path, file.content);
    expect(await observeManagedBackupProgram({ project: f.project, spec: spec.environments.production, environment: f.environment,
      components: ctx.repos.components.findByEnvironmentId(f.environment.id), adapterFactory })).toMatchObject({ state: 'blocked' });
    expect(f.writes).toEqual([]);
  });

  it('requires a new plan before applying a saved publication of the retired workflow', async () => {
    const f = await fixture();
    for (const name of ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']) f.secretNames.add(name);
    const contract = readFileSync(new URL('backups-production.json', previousProgram), 'utf8');
    const target = JSON.parse(contract);
    getDb().prepare('UPDATE components SET id = ? WHERE environment_id = ? AND external_id = ?')
      .run(target.database.componentId, f.environment.id, target.database.source.primaryExternalId);
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    const document = ctx.repos.runs.findById(plan.planRunId)!.plan!;
    const action = plan.actions[0];
    const previous = readFileSync(new URL('hypervibe-backup-production.yml', previousProgram), 'utf8');
    const desired = action.metadata!.desiredFiles as Array<{ path: string; content: string; hash: string }>;
    expect(desired.find(file => file.path === backupPaths[0])?.content).toBe(contract);
    const metadata = { ...action.metadata, desiredFiles: desired.map(file => file.path === backupPaths[1]
      ? { ...file, content: previous, hash: createHash('sha256').update(previous).digest('hex') } : file) };
    const saved = ctx.repos.runs.create({ projectId: f.project.id, environmentId: f.environment.id, type: 'plan',
      plan: { ...document, actions: [{ ...action, metadata }] } });
    const applied = await executePlanApply(ctx, { project: f.project, spec: f.stored.spec, specRevision: f.stored.revision,
      planId: saved.id, confirmActions: [action.id] });
    expect(applied).toMatchObject({ kind: 'executed', result: { success: false, receipts: [
      expect.objectContaining({ status: 'blocked', message: expect.stringContaining('Re-run hv_plan') }),
    ] } });
    expect(f.writes).toEqual([]);
  });

  it('preserves the installed backup program until its reviewed helper and workflow are upgraded together', async () => {
    const f = await fixture();
    for (const name of ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']) f.secretNames.add(name);
    // Previous production TypeScript build, with a synthetic app and stable imported database identity.
    const { spec } = installPreviousWorkflow(f, lastMonitoredImage);
    const previous = JSON.parse(f.files.get(backupPaths[0])!);
    f.files.set('.github/hypervibe/manifest.json', JSON.stringify({ version: 1, managedBy: 'hypervibe', files: backupPaths }));
    const context = { project: f.project, spec: spec.environments.production, environment: f.environment,
      components: ctx.repos.components.findByEnvironmentId(f.environment.id), adapterFactory };
    const before = new Map(f.files);
    const desired = await compileManagedBackupFiles({ project: f.project, spec, environmentName: 'production' });
    expect(desired.files[0].content).toBe(before.get(backupPaths[0]));
    expect(await observeManagedBackupProgram(context)).toMatchObject({ state: 'ready', target: previous });
    // Historical ownership alone does not certify changed job behavior.
    for (const change of [['contents: read', 'contents: write'], ['receipt-invalid', 'receipt-missing']]) {
      f.files.set(backupPaths[1], before.get(backupPaths[1])!.replace(change[0], change[1]));
      expect(await observeManagedBackupProgram(context)).toMatchObject({ state: 'blocked' });
    }
    f.files.set(backupPaths[1], before.get(backupPaths[1])!);
    const blocked = await f.plan();
    expect(blocked).toMatchObject({ scope: 'backup-readiness', actions: [], blocked: [
      expect.objectContaining({ reason: expect.stringMatching(/runnerImage.*hv_plan.*backups/) }),
    ] });
    expect(f.files).toEqual(before);
    expect(f.writes).toEqual([]);
    const image = `ghcr.io/acme/backup@sha256:${'b'.repeat(64)}`;
    const updated = new SpecStore().merge(f.project, { environments: { production: { backups: { mode: 'daily', runnerImage: image } } } });
    const upgrade = await f.plan();
    if ('error' in upgrade) throw new Error(upgrade.error);
    expect(upgrade).toMatchObject({ scope: 'backup-program-publication', blocked: [], actions: [
      expect.objectContaining({ requiresConfirm: true, billable: true, metadata: expect.objectContaining({ backupEnvironment: 'production' }) }),
    ] });
    const files = upgrade.actions[0].metadata?.desiredFiles as Array<{ path: string; content: string }>;
    expect(files.map(file => file.path)).toEqual(backupPaths);
    expect(JSON.parse(files[0].content)).toEqual({ ...previous, runnerImage: image });
    expect(files[1].content).not.toMatch(/47 \* \* \* \*|issues: write/);
    expect(f.files).toEqual(before);
    expect(f.writes).toEqual([]);
    for (const file of files) f.files.set(file.path, file.content);
    expect(await observeManagedBackupProgram({ ...context, spec: updated.spec.environments.production })).toMatchObject({ state: 'ready' });
  });

  it('stops a saved initial publication if a monitored program with that pin appeared after review', async () => {
    const f = await fixture();
    for (const name of ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']) f.secretNames.add(name);
    const planned = await f.plan();
    if ('error' in planned) throw new Error(planned.error);
    expect(planned.scope).toBe('backup-program-publication');
    for (const file of backupPaths) f.files.set(file, readFileSync(new URL(path.basename(file), previousProgram), 'utf8'));
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true });
    vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({ ref: 'refs/heads/main', object: { sha: 'b'.repeat(40) } });
    const result = await applyGitHubInfrastructure({ action: planned.actions[0] });
    expect(result).toMatchObject({ success: false, status: 'blocked', message: expect.stringContaining('files changed since review') });
    expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
  });

  it('uses the published legacy contract when its workflow image was edited', async () => {
    const f = await fixture();
    for (const name of ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']) f.secretNames.add(name);
    const contract = readFileSync(new URL(path.basename(backupPaths[0]), previousProgram), 'utf8');
    const previous = readFileSync(new URL(path.basename(backupPaths[1]), previousProgram), 'utf8');
    const changed = previous.replace(JSON.parse(contract).runnerImage, 'ghcr.io/acme/backup@sha256:' + 'c'.repeat(64));
    expect(changed).not.toBe(previous);
    f.files.set(backupPaths[0], contract); f.files.set(backupPaths[1], changed);
    expect(await f.plan()).toMatchObject({ scope: 'backup-readiness', actions: [], blocked: [
      expect.objectContaining({ reason: expect.stringContaining('runnerImage') }),
    ] });
    expect(f.writes).toEqual([]);
  });

  it.each(['unparseable', 'stray alert job'])('can repair a %s current-format workflow with its existing helper', async damage => {
    const f = await fixture();
    for (const name of ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']) f.secretNames.add(name);
    const compiled = await compileManagedBackupFiles({ project: f.project, spec: f.stored.spec, environmentName: 'production' });
    const [contract, workflow] = compiled.files;
    f.files.set(contract.path, contract.content);
    f.files.set(workflow.path, workflow.content + (damage === 'unparseable' ? '  unexpected: [\n' : '  alert: {}\n'));
    expect(await f.plan()).toMatchObject({ scope: 'backup-program-publication', blocked: [],
      actions: [expect.objectContaining({ requiresConfirm: true })] });
    expect(f.writes).toEqual([]);
  });

  async function disabledProgramFixture(manifestPaths: string[] | null) {
    const f = await fixture();
    // A prior accepted program exists independently of whether its index survived.
    // Compile while daily intent still supplies its real contract and scoped identities.
    const compiled = await compileManagedBackupFiles({ project: f.project, spec: f.stored.spec, environmentName: 'production' });
    expect(compiled.issues).toEqual([]);
    expect(compiled.files.map(file => file.path)).toEqual(backupPaths);
    for (const file of compiled.files) f.files.set(file.path, file.content);
    if (manifestPaths !== null) f.files.set('.github/hypervibe/manifest.json',
      JSON.stringify({ version: 1, managedBy: 'hypervibe', files: manifestPaths }));
    f.files.set('.github/workflows/deploy-railway-production.yml', 'unrelated application workflow drift');
    f.files.set('.github/hypervibe/backups-staging.json', 'preserved staging contract');
    f.files.set('.github/workflows/hypervibe-backup-staging.yml', 'preserved staging workflow');
    const disabled = structuredClone(f.stored.spec);
    disabled.environments.production.backups = { mode: 'disabled', reason: 'Explicitly retire the managed backup program' };
    new SpecStore().replace(f.project, disabled);
    return { ...f, disabled };
  }

  it('sets only environment CI credentials before publishing the exact production backup contract', async () => {
    const f = await fixture();
    const blockedPublication = await f.plan('staging');
    if ('error' in blockedPublication) throw new Error(blockedPublication.error);
    expect(blockedPublication.actions.every(action => !action.metadata?.blockedReason)).toBe(true);
    const planned = await f.plan();
    if ('error' in planned) throw new Error(planned.error);
    expect(planned.scope).toBe('managed-ci-credentials');
    expect(planned.actions).toEqual([expect.objectContaining({ id: 'ci:github-actions:production:deploy-branch' })]);
    const document = ctx.repos.runs.findById(planned.planRunId)!.plan;
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    for (const key of ['overrides', 'integrationFingerprints', 'inputRequired', 'lockEnvironmentIds']) expect(document).not.toHaveProperty(key);
    expect(await f.plan()).toMatchObject({ scope: 'managed-ci-credentials' });
    const preflight = vi.spyOn(PlanService.prototype, 'preflight');
    const observed = vi.mocked(PlanService.prototype.observeEnvironment);
    observed.mockClear();
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockImplementation(() => { throw new Error('Credential setup cannot deploy'); });
    const result = await executePlanApply(ctx, { project: f.project, spec: f.stored.spec, specRevision: f.stored.revision,
      planId: planned.planRunId, confirmActions: [], alwaysRunBootstrap: true });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(preflight).not.toHaveBeenCalled(); expect(observed).not.toHaveBeenCalled(); expect(deploy).not.toHaveBeenCalled();
    preflight.mockRestore();
    expect(f.writes.map(write => write.pathname.split('/').at(-1)).sort())
      .toEqual(['IMAGE_REGISTRY_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'RAILWAY_API_TOKEN']);
    expect(ctx.repos.environments.findById(f.environment.id)!.platformBindings.appliedSpecHash).toBe('unchanged-application-contract');
    const retry = await f.plan();
    expect(retry).toMatchObject({ scope: 'backup-program-publication' });
    const publication = await f.plan();
    if ('error' in publication) throw new Error(publication.error);
    const action = publication.actions.find(action => action.metadata?.backupWorkflowPublicationRequired === true)!;
    expect(action).toMatchObject({ requiresConfirm: true, billable: true });
    expect(action.metadata?.blockedReason).toBeUndefined();
    expect((action.metadata?.desiredFiles as Array<{ path: string }>).map(file => file.path))
      .toEqual(['.github/hypervibe/backups-production.json', '.github/workflows/hypervibe-backup-production.yml']);
    expect(publication.scope).toBe('backup-program-publication');
    expect(publication.actions).toHaveLength(1);
    expect(action.metadata?.backupEnvironment).toBe('production');
    expect(f.writes).toHaveLength(3); expect(f.unexpected).toEqual([]);
  });

  it('does not authorize credential synchronization when environment secret observation is unknown', async () => {
    const f = await fixture();
    f.setUnknown(true);
    const plan = await f.plan();
    expect(plan).toMatchObject({ scope: 'backup-readiness', actions: [] });
    expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
  });

  it('publishes a ready production backup independently of unrelated application API and workflow drift', async () => {
    const f = await fixture();
    for (const name of ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']) f.secretNames.add(name);
    new SpecStore().merge(f.project, { environments: { production: { api: { service: 'web', compatibility: { command: 'npm run test:api' },
      versions: { v1: { path: '/v1', contract: 'api/v1.json', status: 'supported' } } } } } });
    f.files.set('.github/workflows/deploy-railway-production.yml', 'unrelated previous application workflow');
    const result = await f.plan();
    if ('error' in result) throw new Error(result.error);
    expect(result).toMatchObject({ scope: 'backup-program-publication', actions: [expect.objectContaining({
      metadata: expect.objectContaining({ backupEnvironment: 'production', desiredFiles: [
        expect.objectContaining({ path: '.github/hypervibe/backups-production.json' }),
        expect.objectContaining({ path: '.github/workflows/hypervibe-backup-production.yml' }),
      ] }),
    })] });
    expect(f.writes).toEqual([]);
  });

  it('keeps uncertain data identity recovery ahead of backup publication', async () => {
    const f = await fixture();
    for (const name of ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']) f.secretNames.add(name);
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { storageCreateRecovery: null });
    const result = await f.plan();
    expect(result).toHaveProperty('error', expect.stringContaining('uncertain data-resource identities'));
    expect(f.writes).toEqual([]);
  });

  it('reviews only the selected disabled program removal and then reports a nondeploying noop', async () => {
    const f = await disabledProgramFixture(backupPaths);
    const result = await f.plan();
    if ('error' in result) throw new Error(result.error);
    expect(result).toMatchObject({ scope: 'backup-program-publication', actions: [expect.objectContaining({
      requiresConfirm: true, metadata: expect.objectContaining({ backupEnvironment: 'production', desiredFiles: [] }),
    })] });
    expect(result.actions[0].billable).not.toBe(true);
    // A pending repository change is not a completed backup/restore assessment.
    expect(result).not.toHaveProperty('backupReadiness');
    expect(ctx.repos.runs.findById(result.planRunId)!.plan).not.toHaveProperty('backupReadiness');
    expect(planRunDocumentSchema.safeParse(ctx.repos.runs.findById(result.planRunId)!.plan).success).toBe(true);
    expect(PlanService.prototype.observeEnvironment).not.toHaveBeenCalled();
    f.files.set('.github/hypervibe/manifest.json', JSON.stringify({ version: 1, managedBy: 'hypervibe', files: [] }));
    for (const filePath of backupPaths) f.files.delete(filePath);
    expect(await f.plan()).toMatchObject({ scope: 'backup-readiness', actions: [], blocked: [], backupReadiness: { ready: true } });
    expect(f.writes).toEqual([]);
    expect(ctx.repos.environments.findById(f.environment.id)!.platformBindings.storage).toEqual(f.environment.platformBindings.storage);
  });

  it.each([
    ['absent', null],
    ['empty', []],
    ['contract-only', [backupPaths[0]]],
    ['workflow-only', [backupPaths[1]]],
  ] as const)('reviews an observed owned program retirement with a %s manifest', async (_name, manifestPaths) => {
    const f = await disabledProgramFixture(manifestPaths === null ? null : [...manifestPaths]);
    const priorFiles = new Map(f.files);
    const priorBindings = structuredClone(ctx.repos.environments.findById(f.environment.id)!.platformBindings);
    const result = await f.plan();
    if ('error' in result) throw new Error(result.error);
    expect(result).toMatchObject({ scope: 'backup-program-publication', blocked: [], actions: [expect.objectContaining({
      type: 'update', verified: true, requiresConfirm: true,
      metadata: expect.objectContaining({ backupEnvironment: 'production', desiredFiles: [] }),
    })] });
    expect(result.actions[0].billable).not.toBe(true);
    expect(planRunDocumentSchema.safeParse(ctx.repos.runs.findById(result.planRunId)!.plan).success).toBe(true);
    expect(PlanService.prototype.observeEnvironment).not.toHaveBeenCalled();
    expect(f.files).toEqual(priorFiles);
    expect(ctx.repos.environments.findById(f.environment.id)!.platformBindings).toEqual(priorBindings);
    expect(new SpecStore().get(f.project)?.spec.environments.production.envVars).toEqual(f.disabled.environments.production.envVars);
    expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
  });

  it.each(backupPaths)('blocks disabled-program retirement when observing %s is unknown', async filePath => {
    const f = await disabledProgramFixture([]);
    f.setUnknownFile(filePath);
    const priorFiles = new Map(f.files);
    const priorBindings = structuredClone(ctx.repos.environments.findById(f.environment.id)!.platformBindings);
    const result = await f.plan();
    if ('error' in result) throw new Error(result.error);
    expect(result.blocked.length).toBeGreaterThan(0);
    expect(result.backupReadiness?.ready).toBe(false);
    expect(result.actions.every(action => !action.requiresConfirm)).toBe(true);
    expect(f.files).toEqual(priorFiles);
    expect(ctx.repos.environments.findById(f.environment.id)!.platformBindings).toEqual(priorBindings);
    expect(new SpecStore().get(f.project)?.spec.environments.production.envVars).toEqual(f.disabled.environments.production.envVars);
    expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
  });

  it.each(['unknown-inventory', 'changed-inventory', 'workflow-drift'] as const)('rejects %s before writes from a saved credential plan', async change => {
    const f = await fixture();
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.scope).toBe('managed-ci-credentials');
    if (change === 'unknown-inventory') f.setUnknown(true);
    if (change === 'changed-inventory') f.secretNames.add('RAILWAY_API_TOKEN');
    if (change === 'workflow-drift') f.files.set('.github/workflows/deploy-railway-production.yml', 'unreviewed workflow');
    const result = await executePlanApply(ctx, { project: f.project, spec: f.stored.spec, specRevision: f.stored.revision,
      planId: plan.planRunId, confirmActions: [], alwaysRunBootstrap: true });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false, receipts: [expect.objectContaining({ status: 'blocked' })] } });
    expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
    expect(ctx.repos.environments.findById(f.environment.id)!.platformBindings.appliedSpecHash).toBe('unchanged-application-contract');
  });

  it('provisions a missing database before CI can synchronize its required DATABASE_URL', async () => {
    const f = await fixture();
    const component = ctx.repos.components.findByEnvironmentId(f.environment.id)[0];
    ctx.repos.components.delete(component.id);
    new SpecStore().merge(f.project, { environments: { production: { migrations: { mode: 'tool', command: 'npm run migrate' } } } });
    const observation = vi.mocked(PlanService.prototype.observeEnvironment).getMockImplementation()!;
    vi.mocked(PlanService.prototype.observeEnvironment).mockImplementation(async (...args) => {
      const result = await observation(...args);
      if (result.observed) result.observed.databases = [];
      return result;
    });
    expect(f.refreshWorkflow().requiredSecrets).toContain('DATABASE_URL');
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.scope).toBe('backup-provisioning');
    expect(plan.actions).toEqual([expect.objectContaining({ id: 'database:railway', type: 'create', requiresConfirm: true })]);
    expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
  });

  it.each(['workload', 'applied-spec', 'publication', 'unknown-action', 'external-dependency', 'override', 'wrong-environment'] as const)(
    'rejects a forged credential stage containing %s', async mutation => {
      const f = await fixture();
      const plan = await f.plan();
      if ('error' in plan) throw new Error(plan.error);
      expect(plan.scope).toBe('managed-ci-credentials');
      const saved = structuredClone(ctx.repos.runs.findById(plan.planRunId)!.plan) as Record<string, any>;
      if (mutation === 'workload') saved.actions.push({ id: 'service:web', type: 'update',
        resource: { kind: 'service', provider: 'railway', name: 'web' }, verified: true, reason: 'Forged rollout' });
      if (mutation === 'applied-spec') saved.actions.push({ id: 'ci:github-actions:production:applied-spec-hash', type: 'update',
        resource: { kind: 'ci', provider: 'github', name: 'applied-spec-hash:production' }, verified: true, reason: 'Forged acceptance',
        metadata: { operation: 'githubActionsAppliedSpecHash', desiredHash: 'f'.repeat(64), repository: 'acme/backup-ci', environmentName: 'production' } });
      if (mutation === 'publication') saved.actions[0].metadata.workflowPublicationRequired = true;
      if (mutation === 'unknown-action') saved.actions[0].metadata.operation = 'unknown';
      if (mutation === 'external-dependency') saved.actions[0].dependsOn = ['service:web'];
      if (mutation === 'override') saved.overrides = { envVarKeys: ['ROLLOUT'] };
      const environmentId = mutation === 'wrong-environment'
        ? ctx.repos.environments.create({ projectId: f.project.id, name: 'other' }).id : f.environment.id;
      const forged = ctx.repos.runs.create({ projectId: f.project.id, environmentId, type: 'plan', plan: saved });
      const result = await executePlanApply(ctx, { project: f.project, spec: f.stored.spec, specRevision: f.stored.revision,
        planId: forged.id, confirmActions: [], alwaysRunBootstrap: true });
      expect(result.kind).toBe(mutation === 'wrong-environment' ? 'blocked' : 'plan_not_found');
      expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
      expect(ctx.repos.environments.findById(f.environment.id)!.platformBindings.appliedSpecHash).toBe('unchanged-application-contract');
    });
});
