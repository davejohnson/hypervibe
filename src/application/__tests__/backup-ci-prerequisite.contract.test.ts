import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import '../devops-providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { PublicDnsClient } from '../../adapters/dns/public-dns.client.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { AdapterFactory } from '../../domain/services/adapter.factory.js';
import { buildBranchDeployWorkflow, resolveBranchDeployTargets } from '../../domain/services/github-ops.service.js';
import { workflowFiles } from '../../domain/services/ci-deploy.service.js';
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
      github: { enabled: true, repository: 'acme/backup-ci', canonicalEnvironment: 'repository',
        collaboration: { issues: { enabled: false, templates: false }, pullRequests: { requirePr: false } },
        dependencies: { alerts: false, securityUpdates: false }, actions: {},
        security: { codeScanning: false, secretScanning: false, pushProtection: false } },
      environments: { production: {
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
    vi.spyOn(AdapterFactory.prototype, 'getStorageAdapter').mockResolvedValue({ success: true,
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
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input)), method = options?.method ?? 'GET', route = url.pathname;
      if (url.origin !== 'https://api.github.com') { unexpected.push(`${method} ${url.origin}${route}`); throw new Error('Unexpected provider HTTP'); }
      if (method === 'GET' && route === '/user') return json({ login: 'acme', id: 1 });
      if (method === 'GET' && route === '/repos/acme/backup-ci') return json({ default_branch: 'main', private: true });
      if (method === 'GET' && route.startsWith('/repos/acme/backup-ci/contents/')) {
        const file = decodeURIComponent(route.slice('/repos/acme/backup-ci/contents/'.length)), content = files.get(file);
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
    const plan = (env = 'production') => new PlanService().plan(project, env, { includeEnvFile: false });
    return { project, stored, environment, files, secretNames, writes, unexpected, plan, refreshWorkflow,
      setUnknown: (value: boolean) => { secretsUnknown = value; } };
  }

  it('sets only environment CI credentials before publishing the exact production backup contract', async () => {
    const f = await fixture();
    const blockedPublication = await f.plan('repository');
    if ('error' in blockedPublication) throw new Error(blockedPublication.error);
    expect(blockedPublication.actions[0].metadata?.blockedReason).toBe('managed_backup_credentials_missing');
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
    expect(retry).toMatchObject({ scope: 'backup-readiness', actions: [] });
    const publication = await f.plan('repository');
    if ('error' in publication) throw new Error(publication.error);
    const action = publication.actions.find(action => action.metadata?.backupWorkflowPublicationRequired === true)!;
    expect(action).toMatchObject({ requiresConfirm: true, billable: true });
    expect(action.metadata?.blockedReason).toBeUndefined();
    expect((action.metadata?.desiredFiles as Array<{ path: string }>).map(file => file.path))
      .toEqual(expect.arrayContaining(['.github/workflows/hypervibe-backup-production.yml', '.github/hypervibe/backups-production.json']));
    expect(f.writes).toHaveLength(3); expect(f.unexpected).toEqual([]);
  });

  it('does not authorize credential synchronization when environment secret observation is unknown', async () => {
    const f = await fixture();
    f.setUnknown(true);
    const plan = await f.plan();
    expect(plan).toMatchObject({ scope: 'backup-readiness', actions: [] });
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
