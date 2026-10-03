import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import '../devops-providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { PublicDnsClient } from '../../adapters/dns/public-dns.client.js';
import { gitLabCiLifecycle } from '../../adapters/providers/gitlab/gitlab-ci.lifecycle.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { orderActions, planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import * as backupPolicy from '../../domain/services/backup-policy.service.js';
import * as bootstrap from '../../domain/services/bootstrap.service.js';
import * as githubCi from '../../domain/services/ci-deploy.service.js';

// Synthetic GitLab lifecycle-port output; real registry selection, provider
// preflight, PlanService, persisted schema and apply scheduling. GitLab HTTP
// semantics remain covered in gitlab-ci.lifecycle.test.ts, not established here.
const variable = (name: string): PlanAction => ({
  id: `ci:gitlab-ci:production:variable:${name}`, type: 'create', verified: true,
  resource: { kind: 'secret', provider: 'gitlab-ci', name: `production:${name}` },
  reason: 'Synchronize a reviewed accepted-program credential',
  metadata: { operation: 'ciVariableSync', ciProvider: 'gitlab-ci', repositoryId: '42',
    instanceScope: 'https://gitlab.com', repositoryScope: 'https://gitlab.com/acme/ci-prerequisite',
    environmentName: 'production', environmentScope: 'production', variableKey: name,
    valueHash: 'a'.repeat(64), valueSource: 'connection:railway.apiToken', programHash: 'b'.repeat(64),
    protected: true, masked: true, hidden: true, raw: true },
});
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-gitlab-ci-prerequisite-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.spyOn(PublicDnsClient.prototype, 'query').mockResolvedValue({ status: 'unknown' });
});
afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(actions: PlanAction[] = [variable('RAILWAY_API_TOKEN')]) {
  const ctx = createCommandContext();
  const remote = 'https://gitlab.com/acme/ci-prerequisite';
  const project = ctx.repos.projects.create({ name: 'ci-prerequisite', defaultPlatform: 'railway', gitRemoteUrl: `${remote}.git` });
  const stored = new SpecStore().replace(project, { version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
    devops: { code: { provider: 'gitlab', scope: remote }, ci: { provider: 'gitlab-ci' }, canonicalEnvironment: 'production' },
    environments: { production: { hosting: { provider: 'railway' }, services: { web: { startCommand: 'npm start' } },
      database: { provider: 'railway', engine: 'postgres' }, email: { enabled: false },
      envVars: { PENDING_APPLICATION_CHANGE: 'new-value' },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: false } } } });
  for (const provider of ['railway', 'gitlab']) {
    const connection = ctx.repos.connections.create({ provider,
      ...(provider === 'gitlab' ? { scope: remote } : {}),
      credentialsEncrypted: ctx.secretStore.encryptObject({ apiToken: 'synthetic-token' }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');
  }
  const scope = { projectId: 'p', environmentId: 'e' };
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', ...scope, appliedSpecHash: 'unchanged-application-contract', services: { web: { serviceId: 'web' } },
    storage: { 'hypervibe-backups': { provider: 'railway', externalId: 'archive', purpose: 'backup',
      instanceScope: scope, services: [], envKeys: [] } },
  } });
  const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'db',
    bindings: { provider: 'railway', providerScope: scope, resourceKind: 'service' } });
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true, ...scope, partial: false, warnings: [],
    services: [{ name: 'web', externalId: 'web', workloadKind: 'web', sourceState: 'disconnected', status: 'running',
      config: { startCommand: 'npm start' }, envVarKeys: [], envVarHashes: {}, customDomains: [] }],
    databases: [{ provider: 'railway', engine: 'postgres', externalId: 'db', providerScope: scope, status: 'running' }],
    storage: [{ name: 'hypervibe-backups', provider: 'railway', kind: 'object', status: 'running', externalId: 'archive', instanceScope: scope }],
  } });
  const resource = { kind: 'database' as const, provider: 'railway', name: 'postgres', bindingState: 'bound' as const,
    retained: false, componentId: component.id };
  vi.spyOn(backupPolicy, 'observeBackupPolicy').mockResolvedValue({ policy: { mode: 'daily', source: 'default', resources: [resource] },
    resources: [{ resource, state: 'unknown', reason: 'Synthetic missing recovery evidence.' }] });
  vi.spyOn(gitLabCiLifecycle, 'planDeploy').mockResolvedValue({ actions, warnings: [] });
  vi.spyOn(gitLabCiLifecycle, 'planAppliedSpecHash').mockResolvedValue({ actions: [], warnings: [] });
  const sync = vi.spyOn(gitLabCiLifecycle, 'applyDeploy').mockResolvedValue({ success: true,
    message: 'Synthetic CI variable sync accepted', data: { applied: 1, skipped: 0 } });
  const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockImplementation(() => { throw new Error('CI prerequisites cannot deploy'); });
  return { ctx, project, stored, environment, sync, deploy, actions };
}

describe('GitLab credentials through the shared prerequisite stage', () => {
  it('plans against the registered GitLab connection without requesting gitlab-ci credentials', async () => {
    const f = fixture();
    const result = await new PlanService().plan(f.project, 'production', { includeEnvFile: false });
    expect(result).toMatchObject({ scope: 'managed-ci-credentials', blocked: [], actions: f.actions });
    if ('error' in result) throw new Error(result.error);
    expect(planRunDocumentSchema.safeParse(f.ctx.repos.runs.findById(result.planRunId)?.plan).success).toBe(true);
  });

  it('applies the exact credential action with only the registered GitLab connection and does not deploy', async () => {
    const f = fixture();
    const plan = f.ctx.repos.runs.create({ projectId: f.project.id, environmentId: f.environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'managed-ci-credentials', environmentName: 'production',
        specRevision: f.stored.revision, observedFingerprint: null, actions: f.actions } });
    const before = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.stored.spec, specRevision: f.stored.revision,
      planId: plan.id, confirmActions: [], alwaysRunBootstrap: true });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.sync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: f.actions[0], environmentName: 'production' }));
    expect(f.deploy).not.toHaveBeenCalled();
    expect(f.ctx.repos.environments.findById(f.environment.id)?.platformBindings).toEqual(before);
  });

  it('rejects an unselected CI consumer even when a retained project remote matches its forged action', async () => {
    const f = fixture();
    const project = f.ctx.repos.projects.update(f.project.id, { gitRemoteUrl: 'https://github.com/acme/retained-repository' })!;
    const stored = new SpecStore().replace(project, { ...f.stored.spec, gitRemoteUrl: undefined });
    const connection = f.ctx.repos.connections.create({ provider: 'github',
      credentialsEncrypted: f.ctx.secretStore.encryptObject({ apiToken: 'synthetic-old-github-token' }) });
    f.ctx.repos.connections.updateStatus(connection.id, 'verified');
    const action: PlanAction = { id: 'ci:github-actions:production:deploy-branch', type: 'update', verified: true,
      resource: { kind: 'ci', provider: 'github', name: 'deploy-branch:production' }, reason: 'Forged stale-provider action',
      metadata: { operation: 'githubActionsDeployBranch', repository: 'acme/retained-repository', provider: 'railway' } };
    const plan = f.ctx.repos.runs.create({ projectId: project.id, environmentId: f.environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'managed-ci-credentials', environmentName: 'production',
        specRevision: stored.revision, observedFingerprint: null, actions: [action] } });
    // A trap at the consumer boundary proves shared routing, not a provider write.
    const wrongConsumer = vi.spyOn(githubCi, 'applyGitHubActionsDeploy').mockImplementation(async () => {
      throw new Error('The unselected CI consumer must not be reached');
    });
    const before = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    const result = await executePlanApply(f.ctx, { project, spec: stored.spec, specRevision: stored.revision,
      planId: plan.id, confirmActions: [], alwaysRunBootstrap: true });
    expect(wrongConsumer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'executed', result: { success: false,
      receipts: [expect.objectContaining({ status: 'blocked' })] } });
    expect(f.sync).not.toHaveBeenCalled(); expect(f.deploy).not.toHaveBeenCalled();
    expect(f.ctx.repos.environments.findById(f.environment.id)?.platformBindings).toEqual(before);
  });

  it('retains the CI lifecycle dependency graph while selecting the isolated stage', async () => {
    const first = variable('FIRST'), second = { ...variable('SECOND'), dependsOn: [first.id] };
    const f = fixture([second, first]);
    const result = await new PlanService().plan(f.project, 'production', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('managed-ci-credentials');
    expect(result.actions.find(action => action.id === second.id)?.dependsOn).toEqual([first.id]);
    expect(orderActions(result.actions).map(action => action.id)).toEqual([first.id, second.id]);
  });

  it.each(['service:web', 'service:missing'])('does not discard prerequisite %s to admit CI credential work', async dependency => {
    const action = { ...variable('RAILWAY_API_TOKEN'), dependsOn: [dependency] };
    const f = fixture([action]);
    const result = await new PlanService().plan(f.project, 'production', { includeEnvFile: false });
    expect(result).toMatchObject({ scope: 'backup-readiness', actions: [] });
    expect(f.sync).not.toHaveBeenCalled();
    expect(f.deploy).not.toHaveBeenCalled();
  });

  it('preserves internal credential dependencies and rejects external rollout dependencies', () => {
    const first = variable('FIRST'), second = { ...variable('SECOND'), dependsOn: [first.id] };
    const document = { kind: 'hv_plan', scope: 'managed-ci-credentials', environmentName: 'production',
      specRevision: 1, observedFingerprint: null, actions: [second, first] };
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    expect(orderActions(document.actions).map(action => action.id)).toEqual([first.id, second.id]);
    expect(planRunDocumentSchema.safeParse({ ...document,
      actions: [{ ...second, dependsOn: ['service:web'] }, first] }).success).toBe(false);
  });
});
