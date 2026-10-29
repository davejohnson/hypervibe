import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import '../devops-providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { AdapterFactory } from '../../domain/services/adapter.factory.js';
import type { IDatabaseAdapter } from '../../domain/ports/database.port.js';
import { compileManagedBackupFiles } from '../../domain/services/managed-backup-workflows.service.js';
import { compileManagedGitHubFiles, GITHUB_INFRASTRUCTURE_ACTION_ID,
  GITHUB_INFRASTRUCTURE_MANIFEST, planGitHubInfrastructure, applyGitHubInfrastructure,
  GITHUB_INFRASTRUCTURE_BRANCH, GITHUB_INFRASTRUCTURE_PR_TITLE, GITHUB_INFRASTRUCTURE_PR_BODY_MARKER } from '../../domain/services/github-infrastructure.service.js';
import { planGitHubActionsAppliedSpecHash } from '../../domain/services/ci-deploy.service.js';
import { environmentDeploymentContractHash } from '../../domain/services/deployment-contract.service.js';

// Reconstructed from the 2026-10-29 Invoice Perfect incident: staging explicitly
// excludes backups, production has daily native snapshots but no bound archive
// bucket, and the canonical repository environment is staging. A real apply
// blocked repo:github-infrastructure-pr after staging work and aborted its hash.
// The user requires independent staging reconciliation, not permission to create
// production storage or publish an incomplete production recovery program.
// Real repository/hash planners, SQLite, application apply, backup compiler and
// GitHub HTTP serialization are exercised. Native source observations and HTTP
// responses are synthetic; this does not certify live backup or provider support.
describe('selected-environment repository reconciliation with unrelated incomplete backups', () => {
  let directory: string;
  let ctx: CommandContext;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-staging-backup-isolation-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
    ctx = createCommandContext();
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    { previousProgram: false, state: 'incomplete' },
    { previousProgram: true, state: 'incomplete' },
    { previousProgram: true, state: 'omitted' },
    { previousProgram: true, state: 'removed-environment' },
    { previousProgram: true, state: 'missing-helper' },
    { previousProgram: true, state: 'unknown-credentials' },
    { previousProgram: true, state: 'unknown-backup-file' },
    { previousProgram: true, state: 'disabled' },
    { previousProgram: false, state: 'ready' },
    { previousProgram: true, state: 'absent-backup-file' },
    { previousProgram: true, state: 'exact-accepted-bytes' },
    { previousProgram: false, state: 'explicit-ready' },
    { previousProgram: true, state: 'explicit-disabled' },
    { previousProgram: true, state: 'unknown-manifest' },
    { previousProgram: true, state: 'malformed-manifest' },
    { previousProgram: false, state: 'absent-manifest' },
  ])('preserves ordinary reconciliation and accepted backups ($state; previous program: $previousProgram)', async ({ previousProgram, state }) => {
    const repository = 'acme/backup-isolation';
    const project = ctx.repos.projects.create({ name: 'backup-isolation', defaultPlatform: 'railway',
      gitRemoteUrl: `https://github.com/${repository}` });
    let stored = new SpecStore().replace(project, { version: 1, project: project.name,
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
      github: { enabled: true, repository, canonicalEnvironment: 'staging',
        collaboration: { issues: { enabled: false, templates: false }, pullRequests: { requirePr: false } },
        dependencies: { alerts: false, securityUpdates: false },
        security: { codeScanning: false, secretScanning: false, pushProtection: false },
        actions: { tests: { kind: 'check', category: 'test', runtime: { kind: 'node', version: '24' }, commands: ['npm test'] } } },
      environments: {
        staging: { hosting: { provider: 'railway' }, services: {}, email: { enabled: false },
          backups: { mode: 'disabled', reason: 'Disposable staging data does not need retained backups.' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } },
        production: { hosting: { provider: 'railway' }, services: {}, email: { enabled: false },
          database: { provider: 'railway', engine: 'postgres' },
          storage: { archive: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: [], purpose: 'backup' } },
          backups: { mode: 'daily', destination: 'archive', runnerImage: `ghcr.io/acme/helper@sha256:${'a'.repeat(64)}` } },
      } });
    for (const provider of ['github', 'railway']) {
      const connection = ctx.repos.connections.create({ provider,
        ...(provider === 'github' ? { scope: repository } : {}),
        credentialsEncrypted: ctx.secretStore.encryptObject({ apiToken: `synthetic-${provider}-token` }) });
      ctx.repos.connections.updateStatus(connection.id, 'verified');
    }
    const staging = ctx.repos.environments.create({ projectId: project.id, name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'native-project', environmentId: 'native-staging',
        appliedSpecHash: 'previous-staging-contract' } });
    const scope = { projectId: 'native-project', environmentId: 'native-production' };
    const production = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', ...scope, appliedSpecHash: 'unchanged-production-contract',
        storage: previousProgram || ['ready', 'explicit-ready'].includes(state) ? { archive: { provider: 'railway', externalId: 'prior-archive', region: 'sjc',
          instanceScope: scope, services: [], envKeys: [], purpose: 'backup' } } : {} } });
    ctx.repos.components.create({ environmentId: production.id, type: 'postgres', externalId: 'production-db',
      bindings: { provider: 'railway', resourceKind: 'service', providerScope: scope } });
    const observe = vi.fn(async () => ({ state: 'known', daily: true, mechanism: 'snapshot',
      policyFingerprint: 'b'.repeat(64), preservationFingerprint: 'c'.repeat(64),
      source: { provider: 'railway', primaryExternalId: 'production-db', providerScope: scope,
        resourceIdentity: { volumeId: 'production-volume', volumeInstanceId: 'production-volume-instance' } } }));
    const configureDaily = vi.fn(() => { throw new Error('Production backup writes are not authorized'); });
    vi.spyOn(AdapterFactory.prototype, 'getDatabaseAdapter').mockResolvedValue({ success: true,
      adapter: { name: 'railway', dailyBackups: { observe, configureDaily } } as unknown as IDatabaseAdapter });
    const previousBackups = previousProgram ? await compileManagedBackupFiles({ project, spec: stored.spec, environmentName: 'production' }) : { files: [], issues: [] };
    expect(previousBackups.issues).toEqual([]);
    const files = new Map(compileManagedGitHubFiles(stored.spec.github!, stored.spec.runtime, previousBackups.files)
      .map(file => [file.path, file.content]));
    if (state === 'removed-environment') {
      const next = structuredClone(stored.spec);
      delete next.environments.production;
      stored = new SpecStore().replace(project, next);
    }
    if (state === 'omitted') {
      const next = structuredClone(stored.spec);
      delete next.environments.production.backups;
      stored = new SpecStore().replace(project, next);
    }
    if (state === 'disabled' || state === 'explicit-disabled') {
      const next = structuredClone(stored.spec);
      next.environments.production.backups = { mode: 'disabled', reason: 'Reviewed explicit removal of the recurring program.' };
      stored = new SpecStore().replace(project, next);
    }
    if (state === 'missing-helper') {
      const next = structuredClone(stored.spec);
      if (next.environments.production.backups?.mode !== 'daily') throw new Error('Expected a daily program');
      delete next.environments.production.backups.runnerImage;
      stored = new SpecStore().replace(project, next);
    }
    if (state === 'exact-accepted-bytes') for (const file of previousBackups.files) files.set(file.path, file.content.trimEnd());
    if (state === 'absent-backup-file') files.delete('.github/hypervibe/backups-production.json');
    if (state === 'absent-manifest') files.delete(GITHUB_INFRASTRUCTURE_MANIFEST);
    if (state.startsWith('explicit-')) {
      // These accepted paths belong to other repository lifecycles. Their bytes
      // and ownership must survive selected production backup publication.
      files.set('.github/hypervibe/backups-staging.json', 'accepted staging contract');
      files.set('.github/workflows/hypervibe-backup-staging.yml', 'accepted staging workflow');
      const manifest = JSON.parse(files.get(GITHUB_INFRASTRUCTURE_MANIFEST)!);
      manifest.files.push('.github/hypervibe/backups-staging.json', '.github/workflows/hypervibe-backup-staging.yml');
      manifest.files.sort(); files.set(GITHUB_INFRASTRUCTURE_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    }
    const originalFiles = new Map(files);
    if (!['unknown-credentials', 'ready', 'explicit-ready'].includes(state)) ctx.repos.environments.updatePlatformBindings(production.id, { storage: {} });
    const originalProduction = ctx.repos.environments.findById(production.id)!.platformBindings;
    const writes: Array<{ method: string; route: string }> = [];
    const unexpected: string[] = [];
    let appliedHash = 'previous-staging-contract';
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input)), method = options?.method ?? 'GET', route = url.pathname;
      const root = `/repos/${repository}`;
      if (url.origin !== 'https://api.github.com') {
        unexpected.push(`${method} ${url.origin}${route}`); throw new Error('No other provider HTTP is authorized');
      }
      if (method === 'GET' && route === '/user') return json({ login: 'acme', id: 1 });
      if (method === 'GET' && route === root) return json({ default_branch: 'main', private: true });
      if (method === 'GET' && route === `${root}/labels`) return json([]);
      if (method === 'GET' && route === `${root}/environments/staging`) return json({ name: 'staging' });
      if (state.startsWith('explicit-') && method === 'GET' && route.startsWith(`${root}/git/ref/`)) return json({ ref: decodeURIComponent(route.slice(`${root}/git/ref/`.length)), object: { sha: 'd'.repeat(40) } });
      if (state.startsWith('explicit-') && method === 'GET' && route === `${root}/pulls`) return json([{ number: 1, html_url: 'https://github.com/acme/backup-isolation/pull/1',
        state: 'open', merged_at: null, title: GITHUB_INFRASTRUCTURE_PR_TITLE, body: GITHUB_INFRASTRUCTURE_PR_BODY_MARKER,
        head: { ref: GITHUB_INFRASTRUCTURE_BRANCH, sha: 'd'.repeat(40) }, base: { ref: 'main' } }]);
      if (state.startsWith('explicit-') && method === 'GET' && route.startsWith(`${root}/compare/`)) return json({ status: 'ahead', ahead_by: 1, behind_by: 0 });
      if (state.startsWith('explicit-') && ['PUT', 'DELETE'].includes(method) && route.startsWith(`${root}/contents/`)) {
        const file = decodeURIComponent(route.slice(`${root}/contents/`.length)), body = JSON.parse(String(options?.body));
        expect(body.branch).toBe(GITHUB_INFRASTRUCTURE_BRANCH);
        if (method === 'PUT') files.set(file, Buffer.from(body.content, 'base64').toString('utf8'));
        else files.delete(file);
        writes.push({ method, route }); return json({});
      }
      if (method === 'GET' && route === `${root}/environments/production/secrets`) return ['ready', 'explicit-ready'].includes(state) ? json({ total_count: 1, secrets: [{ name: 'RAILWAY_API_TOKEN' }] }) : json({ message: 'Denied' }, 403);
      if (method === 'GET' && route.startsWith(`${root}/contents/`)) {
        const file = decodeURIComponent(route.slice(`${root}/contents/`.length));
        if (file === '.github/hypervibe/backups-production.json' && state === 'unknown-backup-file') return json({ message: 'Denied' }, 403);
        if (file === GITHUB_INFRASTRUCTURE_MANIFEST && state === 'unknown-manifest') return json({ message: 'Denied' }, 403);
        const content = file === GITHUB_INFRASTRUCTURE_MANIFEST && state === 'malformed-manifest' ? '{incomplete' : files.get(file);
        return content === undefined ? json({ message: 'Not Found' }, 404)
          : json({ type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), sha: 'd'.repeat(40) });
      }
      if (method === 'GET' && route === `${root}/environments/staging/variables/HYPERVIBE_APPLIED_SPEC_HASH`)
        return appliedHash ? json({ name: 'HYPERVIBE_APPLIED_SPEC_HASH', value: appliedHash }) : json({ message: 'Not Found' }, 404);
      if (method === 'PATCH' && route === `${root}/environments/staging/variables/HYPERVIBE_APPLIED_SPEC_HASH`) {
        const body = JSON.parse(String(options?.body));
        expect(body.name).toBe('HYPERVIBE_APPLIED_SPEC_HASH');
        appliedHash = body.value; writes.push({ method, route }); return new Response(null, { status: 204 });
      }
      unexpected.push(`${method} ${route}`); throw new Error(`Unexpected GitHub HTTP: ${method} ${route}`);
    }));
    observe.mockClear();
    const repositoryPlan = await planGitHubInfrastructure({ project, spec: stored.spec,
      environmentName: state.startsWith('explicit-') ? 'production' : 'staging',
      ...(state.startsWith('explicit-') ? { backupEnvironment: 'production' } : {}) });
    if (state.startsWith('explicit-')) {
      const action = repositoryPlan.actions.find(action => action.id === GITHUB_INFRASTRUCTURE_ACTION_ID);
      expect(action).toMatchObject({ type: 'update', requiresConfirm: true,
        metadata: { backupEnvironment: 'production', backupWorkflowPublicationRequired: true } });
      expect((action!.metadata?.desiredFiles as Array<{ path: string }>).map(file => file.path).sort()).toEqual(state === 'explicit-disabled' ? [] : [
        '.github/hypervibe/backups-production.json', '.github/workflows/hypervibe-backup-production.yml'
      ].sort());
      expect(repositoryPlan.actions).toHaveLength(1);
      expect(await applyGitHubInfrastructure({ action: action! })).toMatchObject({ success: false, status: 'pending' });
      const selected = ['.github/hypervibe/backups-production.json', '.github/workflows/hypervibe-backup-production.yml'];
      expect(writes.map(write => write.route.slice(`/repos/${repository}/contents/`.length)).sort()).toEqual([...selected, GITHUB_INFRASTRUCTURE_MANIFEST].sort());
      for (const [path, content] of originalFiles) {
        if (!selected.includes(path) && path !== GITHUB_INFRASTRUCTURE_MANIFEST) expect(files.get(path)).toBe(content);
      }
      const manifestPaths = JSON.parse(files.get(GITHUB_INFRASTRUCTURE_MANIFEST)!).files;
      expect(manifestPaths.filter((path: string) => !selected.includes(path))).toEqual(JSON.parse(originalFiles.get(GITHUB_INFRASTRUCTURE_MANIFEST)!).files.filter((path: string) => !selected.includes(path)));
      for (const path of selected) expect(manifestPaths.includes(path)).toBe(state !== 'explicit-disabled');
      writes.length = 0;
      expect(await applyGitHubInfrastructure({ action: action! })).toMatchObject({ success: false, status: 'pending' });
      expect(writes).toEqual([]);
      expect(configureDaily).not.toHaveBeenCalled();
      expect(unexpected).toEqual([]);
      return;
    }
    expect.soft(observe).not.toHaveBeenCalled();
    if (previousProgram && state === 'omitted') {
      const desired = repositoryPlan.actions[0].metadata?.desiredFiles as Array<{ path: string; content: string }>;
      for (const previous of previousBackups.files) expect.soft(desired.find(file => file.path === previous.path)?.content).toBe(previous.content);
    }
    const hashPlan = await planGitHubActionsAppliedSpecHash({ project, spec: stored.spec, environmentName: 'staging',
      environmentSpec: stored.spec.environments.staging, environment: staging,
      dependsOn: repositoryPlan.actions.filter(action => action.type !== 'noop').map(action => action.id) });
    expect(hashPlan.action).toBeDefined();
    const plan = ctx.repos.runs.create({ projectId: project.id, environmentId: staging.id, type: 'plan', plan: {
      kind: 'hv_plan', scope: 'full', environmentName: 'staging', specRevision: stored.revision,
      observedFingerprint: null, actions: [...repositoryPlan.actions, hashPlan.action!],
    } });
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
    const outcome = state === 'absent-manifest' ? undefined : await executePlanApply(ctx, { project, spec: stored.spec, specRevision: stored.revision,
      planId: plan.id, confirmActions: [] });
    if (['unknown-manifest', 'malformed-manifest', 'unknown-backup-file'].includes(state)) {
      expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
      expect(repositoryPlan.actions.find(action => action.id === GITHUB_INFRASTRUCTURE_ACTION_ID)?.metadata?.blockedReason).toBeDefined();
      expect(writes).toEqual([]);
      expect(appliedHash).toBe('previous-staging-contract');
      expect(unexpected).toEqual([]);
      expect(configureDaily).not.toHaveBeenCalled();
      return;
    }
    if (state === 'absent-manifest') {
      // Provider-confirmed absence permits a new repository proposal, but never
      // creates a backup program whose production target remains incomplete.
      const desired = repositoryPlan.actions[0].metadata?.desiredFiles as Array<{ path: string }>;
      expect(repositoryPlan.actions[0].metadata?.blockedReason).toBeUndefined();
      expect(desired.some(file => /backup-production|backups-production/.test(file.path))).toBe(false);
      expect(configureDaily).not.toHaveBeenCalled();
      expect(unexpected).toEqual([]);
      return;
    }
    expect.soft(repositoryPlan.actions.find(action => action.id === GITHUB_INFRASTRUCTURE_ACTION_ID)?.metadata?.blockedReason)
      .toBeUndefined();
    expect.soft(outcome, JSON.stringify(outcome && 'result' in outcome ? outcome.result : outcome)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect.soft(appliedHash).toBe(environmentDeploymentContractHash(stored.spec, 'staging'));
    expect.soft(writes).toEqual([{ method: 'PATCH', route: `/repos/${repository}/environments/staging/variables/HYPERVIBE_APPLIED_SPEC_HASH` }]);
    expect(unexpected).toEqual([]);
    expect(configureDaily).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(production.id)!.platformBindings).toEqual(originalProduction);
    expect(files).toEqual(originalFiles);
    const desired = repositoryPlan.actions.find(action => action.id === GITHUB_INFRASTRUCTURE_ACTION_ID)?.metadata?.desiredFiles as Array<{ path: string; content: string }>;
    for (const previous of previousBackups.files) {
      expect(desired.find(file => file.path === previous.path)?.content).toBe(originalFiles.get(previous.path));
      expect(JSON.parse(desired.find(file => file.path === GITHUB_INFRASTRUCTURE_MANIFEST)!.content).files).toContain(previous.path);
    }
    if (!previousProgram) expect(desired.some(file => /backup-production|backups-production/.test(file.path))).toBe(false);
  });
  it.each(['updated', 'removed', 'newly-managed', 'newly-managed-retired-environment'] as const)(
    'preserves the current reviewed backup program during repository publication and retry (%s)', async state => {
    const repository = 'acme/backup-isolation';
    const connection = ctx.repos.connections.create({ provider: 'github', scope: repository,
      credentialsEncrypted: ctx.secretStore.encryptObject({ apiToken: 'synthetic-github-token' }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');
    const protectedPaths = ['.github/hypervibe/backups-production.json', '.github/workflows/hypervibe-backup-production.yml'];
    const acceptance = '.github/workflows/hypervibe-acceptance.yml';
    const manifest = (paths: string[]) => JSON.stringify({ version: 1, managedBy: 'hypervibe', files: [...paths].sort() }, null, 2) + '\n';
    const plannedFiles = [
      { path: acceptance, content: 'name: reviewed acceptance change\n', hash: 'a'.repeat(64) },
      ...protectedPaths.filter(() => !state.startsWith('newly-managed')).map(path => ({ path, content: 'old accepted backup bytes\n', hash: 'b'.repeat(64) })),
      { path: GITHUB_INFRASTRUCTURE_MANIFEST, content: manifest(state.startsWith('newly-managed') ? [acceptance] : [acceptance, ...protectedPaths]), hash: 'c'.repeat(64) },
    ];
    // A later reviewed backup operation changed only the proposal branch after
    // staging's plan: it may update, retire or introduce its own managed program.
    const currentFiles = new Map<string, string>([
      [acceptance, 'name: prior acceptance\n'],
      ...protectedPaths.filter(() => state !== 'removed').map(path => [path, 'latest independently accepted backup bytes\n'] as [string, string]),
      [GITHUB_INFRASTRUCTURE_MANIFEST, manifest(state === 'removed' ? [acceptance] : [acceptance, ...protectedPaths])],
    ]);
    const writes: Array<{ method: string; path: string }> = [];
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input)), method = options?.method ?? 'GET', root = `/repos/${repository}`, route = decodeURIComponent(url.pathname);
      if (url.origin !== 'https://api.github.com') throw new Error('No non-GitHub requests permitted');
      if (method === 'GET' && route === '/user') return json({ login: 'acme', id: 1 });
      if (method === 'GET' && route === root) return json({ default_branch: 'main', private: true });
      if (method === 'GET' && route.startsWith(`${root}/git/ref/`)) return json({ ref: route.slice(`${root}/git/ref/`.length), object: { sha: 'd'.repeat(40) } });
      if (method === 'GET' && route === `${root}/pulls`) return json([{ number: 1, html_url: 'https://github.com/acme/backup-isolation/pull/1',
        state: 'open', merged_at: null, title: GITHUB_INFRASTRUCTURE_PR_TITLE, body: GITHUB_INFRASTRUCTURE_PR_BODY_MARKER,
        head: { ref: GITHUB_INFRASTRUCTURE_BRANCH, sha: 'd'.repeat(40) }, base: { ref: 'main' } }]);
      if (method === 'GET' && route.startsWith(`${root}/compare/`)) return json({ status: 'ahead', ahead_by: 1, behind_by: 0 });
      if (route.startsWith(`${root}/contents/`)) {
        const path = route.slice(`${root}/contents/`.length);
        if (method === 'GET') {
          const content = currentFiles.get(path);
          return content === undefined ? json({ message: 'Not Found' }, 404)
            : json({ type: 'file', content: Buffer.from(content).toString('base64'), sha: 'e'.repeat(40) });
        }
        if (method === 'PUT') {
          const body = JSON.parse(String(options?.body));
          expect(body.branch).toBe(GITHUB_INFRASTRUCTURE_BRANCH);
          writes.push({ method, path }); currentFiles.set(path, Buffer.from(body.content, 'base64').toString('utf8')); return json({});
        }
        if (method === 'DELETE') { writes.push({ method, path }); currentFiles.delete(path); return json({}); }
      }
      throw new Error(`Unexpected request: ${method} ${route}`);
    }));
    const action = { id: GITHUB_INFRASTRUCTURE_ACTION_ID, type: 'update' as const,
      resource: { kind: 'repo' as const, name: repository, provider: 'github' }, reason: 'Acceptance change', verified: true,
      metadata: { repository, desiredFiles: plannedFiles, preservedManagedPaths: state === 'newly-managed-retired-environment'
        ? ['.github/hypervibe/backups-staging.json', '.github/workflows/hypervibe-backup-staging.yml'] : protectedPaths } };
    expect(await applyGitHubInfrastructure({ action })).toMatchObject({ success: false, status: 'pending' });
    expect(writes.filter(write => protectedPaths.includes(write.path))).toEqual([]);
    for (const path of protectedPaths) expect(currentFiles.get(path)).toBe(state === 'removed' ? undefined : 'latest independently accepted backup bytes\n');
    expect(JSON.parse(currentFiles.get(GITHUB_INFRASTRUCTURE_MANIFEST)!).files).toEqual((state === 'removed' ? [acceptance] : [acceptance, ...protectedPaths]).sort());
    expect(currentFiles.get(acceptance)).toBe('name: reviewed acceptance change\n');
    writes.length = 0;
    expect(await applyGitHubInfrastructure({ action })).toMatchObject({ success: false, status: 'pending' });
    expect(writes).toEqual([]);
  });

});
