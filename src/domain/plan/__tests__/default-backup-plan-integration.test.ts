import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { PublicDnsClient } from '../../../adapters/dns/public-dns.client.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../application/devops-providers.js';
import { SpecStore } from '../../spec/spec.store.js';
import type { ProjectSpec } from '../../spec/spec.schema.js';
import { PlanService } from '../plan.service.js';
import { orderActions, planRunDocumentSchema } from '../converge.executor.js';
import type { PlanAction } from '../plan.types.js';
import * as backupPolicy from '../../services/backup-policy.service.js';
import * as resilience from '../../services/database-resilience-plan.service.js';
import * as githubInfrastructure from '../../services/github-infrastructure.service.js';
import * as managedCi from '../../services/managed-ci.service.js';
import { buildBranchDeployWorkflow, resolveBranchDeployTargets } from '../../services/github-ops.service.js';
import { githubActionsWorkflowInputHash, workflowFiles, workflowFilesContentHash } from '../../services/ci-deploy.service.js';

// Orchestration-only fixture. The real provider transport tests establish
// Railway schedule semantics; this test verifies policy reaches stored plans.
const checkpoint: PlanAction = {
  id: 'database:railway:checkpoint:pre-release', type: 'create',
  resource: { kind: 'database', provider: 'railway', name: 'checkpoint:pre-release' },
  verified: true, reason: 'Create the requested recovery checkpoint',
  requiresConfirm: true, billable: true, dataBearing: true,
  metadata: { operation: 'databaseCheckpointCreate', checkpointId: 'pre-release' },
};

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-default-backup-stage-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  vi.spyOn(PublicDnsClient.prototype, 'query').mockResolvedValue({ status: 'unknown' });
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const project = new ProjectRepository().create({ name: 'daily-before-release', defaultPlatform: 'railway',
    gitRemoteUrl: 'https://github.com/acme/daily-before-release' });
  new SpecStore().replace(project, {
    version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
    secrets: { UNRELATED_SECRET: { principal: 'github:alice', environments: ['production'] } },
    environments: { production: {
      hosting: { provider: 'railway' }, services: { web: { startCommand: 'npm start', public: true } },
      database: { provider: 'railway', engine: 'postgres' },
      storage: { documents: { provider: 'railway', type: 'bucket', region: 'iad', injectInto: ['web'] } },
      email: { enabled: false }, envVars: { UNRELATED_SETTING: 'new-value' },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    } },
  });
  const connections = new ConnectionRepository();
  for (const [provider, credentials] of Object.entries({
    railway: { apiToken: 'test-railway-token' },
    github: { apiToken: 'test-github-token', login: 'acme', packageReadToken: 'test-package-token' },
  })) {
    const connection = connections.create({ provider, credentialsEncrypted: getSecretStore().encryptObject(credentials) });
    connections.updateStatus(connection.id, 'verified');
  }
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'project-1', environmentId: 'production-1', services: { web: { serviceId: 'web-1' } },
    storage: { documents: { provider: 'railway', externalId: 'bucket-1', services: ['web'],
      instanceScope: { projectId: 'project-1', environmentId: 'production-1' } } },
  } });
  const component = new ComponentRepository().create({ environmentId: environment.id, type: 'postgres', externalId: 'db-1',
    bindings: { provider: 'railway', resourceKind: 'service', providerScope: { projectId: 'project-1', environmentId: 'production-1' } } });
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
    projectId: 'project-1', environmentId: 'production-1', partial: false, warnings: [],
    services: [{ name: 'web', externalId: 'web-1', workloadKind: 'web', sourceState: 'disconnected',
      config: { startCommand: 'npm start', public: true }, envVarKeys: [], envVarHashes: {}, customDomains: [], status: 'running' }],
    databases: [{ provider: 'railway', engine: 'postgres', externalId: 'db-1', status: 'running',
      providerScope: { projectId: 'project-1', environmentId: 'production-1' } }],
  } });
  vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
  vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets').mockResolvedValue([]);
  vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
  vi.spyOn(GitHubAdapter.prototype, 'getEnvironmentVariable').mockResolvedValue(null);
  const planResilience = vi.spyOn(resilience, 'planDatabaseResilience')
    .mockReturnValue({ actions: [], warnings: [], unmanaged: [], serviceDependencies: [] });
  const observation = vi.spyOn(backupPolicy, 'observeBackupPolicy').mockImplementation(async context => ({
    policy: backupPolicy.resolveBackupPolicies({ version: 1, project: project.name, secrets: {},
      environments: { production: context.spec } } as ProjectSpec, [environment], [component]).production,
    resources: [
      { resource: { kind: 'database', name: 'postgres', provider: 'railway', retained: false,
        bindingState: 'bound', componentId: component.id }, state: 'needs-configuration',
      target: { kind: 'database', componentId: component.id }, observation: {
        state: 'known', source: { provider: 'railway', primaryExternalId: 'db-1',
          providerScope: { projectId: 'project-1', environmentId: 'production-1' },
          resourceIdentity: { volumeId: 'volume-1', volumeInstanceId: 'volume-instance-1' } },
        daily: false, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot',
      } },
      { resource: { kind: 'storage', name: 'documents', provider: 'railway', retained: false, bindingState: 'bound' },
        state: 'unsupported', reason: 'Railway object buckets do not implement daily backup policy.' },
    ],
  }));
  return { project, environment, component, observation, planResilience, planner: new PlanService() };
}

describe('default backup policy in real PlanService orchestration', () => {
  it('defaults omitted policy to daily and persists isolated work plus the unsupported bucket gap', async () => {
    const f = await fixture();
    const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('backup-policy');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ id: 'backup-policy:database:railway:postgres',
      resource: { kind: 'database', provider: 'railway', name: 'postgres' },
      metadata: { operation: 'dailyBackupConfigure' } });
    expect(result.backupCoverage).toMatchObject({ policy: { mode: 'daily', source: 'default' },
      complete: false, backupObserved: 'unverified', restoreTested: 'unverified',
      resources: [ { state: 'needs-configuration' }, { state: 'unsupported', resource: { name: 'documents' } } ] });
    expect(f.observation.mock.calls[0][0].spec).not.toHaveProperty('backups');
    const document = new RunRepository().findById(result.planRunId)!.plan;
    expect(document).toHaveProperty('backupCoverage', result.backupCoverage);
    expect(document).toMatchObject({ scope: 'backup-policy', observedFingerprint: null, actions: result.actions });
    for (const field of ['inputRequired', 'overrides', 'integrationFingerprints', 'lockEnvironmentIds']) {
      expect(document).not.toHaveProperty(field);
    }
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
  });

  it('keeps a pending checkpoint ahead of daily policy configuration', async () => {
    const f = await fixture();
    f.planResilience.mockReturnValue({ actions: [checkpoint], warnings: [], unmanaged: [], serviceDependencies: [] });
    const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    expect(result).toMatchObject({ scope: 'database-checkpoint', actions: [checkpoint] });
    if ('error' in result) throw new Error(result.error);
    const document = new RunRepository().findById(result.planRunId)!.plan;
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
  });

  it('keeps unsupported coverage incomplete after the database daily policy is already satisfied', async () => {
    const f = await fixture();
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementation(async context => {
      const coverage = await observe(context);
      const database = coverage.resources[0];
      database.state = 'scheduled';
      if (database.observation?.state === 'known') database.observation.daily = true;
      return coverage;
    });
    const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('managed-ci-publication');
    expect(result.actions.some(action => action.metadata?.operation === 'dailyBackupConfigure')).toBe(false);
    expect(result.backupCoverage).toMatchObject({ complete: false,
      resources: [{ state: 'scheduled' }, { state: 'unsupported', resource: { name: 'documents' } }] });
    expect(result.warnings.join(' ')).toContain('documents');
  });

  it('does not let a service filter bypass pending daily backup policy', async () => {
    const f = await fixture();
    const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false, serviceFilter: ['web'] });
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('A filtered plan bypassed pending backup policy.');
    expect(result.error).toMatch(/backup/i);
  });

  it('blocks an ordinary rollout with unsupported data protection after workflow publication', async () => {
    const f = await fixture();
    new EnvironmentRepository().updatePlatformBindings(f.environment.id, { storage: {
      ...f.environment.platformBindings.storage as Record<string, unknown>,
      'hypervibe-backups': { provider: 'railway', externalId: 'backup-bucket-1', purpose: 'backup', region: 'iad', services: [],
        instanceScope: { projectId: 'project-1', environmentId: 'production-1' } },
    } });
    const originalObservation = vi.mocked(PlanService.prototype.observeEnvironment).getMockImplementation()!;
    vi.mocked(PlanService.prototype.observeEnvironment).mockImplementation(async (...args) => {
      const result = await originalObservation(...args);
      if (result.observed) result.observed.storage = [{ name: 'hypervibe-backups', provider: 'railway', kind: 'object', status: 'running', externalId: 'backup-bucket-1', region: 'iad',
        instanceScope: { projectId: 'project-1', environmentId: 'production-1' } }];
      return result;
    });
    vi.spyOn(managedCi, 'planManagedCiDeploy').mockResolvedValue({ actions: [], warnings: [] });
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementation(async context => {
      const coverage = await observe(context);
      coverage.resources[0].state = 'scheduled';
      if (coverage.resources[0].observation?.state === 'known') coverage.resources[0].observation.daily = true;
      return coverage;
    });
    const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('backup-readiness');
    expect(result.actions).toEqual([]);
    expect(result.blocked).toContainEqual(expect.objectContaining({ provider: 'hypervibe', reason: expect.stringMatching(/backup/i) }));
    expect(result.backupCoverage?.complete).toBe(false);
  });

  it('publishes only the confirmed backup program PR before the first usable recovery point exists', async () => {
    const f = await fixture();
    new EnvironmentRepository().updatePlatformBindings(f.environment.id, { storage: {
      ...f.environment.platformBindings.storage as Record<string, unknown>,
      'hypervibe-backups': { provider: 'railway', externalId: 'backup-bucket-1', purpose: 'backup', region: 'iad', services: [],
        instanceScope: { projectId: 'project-1', environmentId: 'production-1' } },
    } });
    const original = vi.mocked(PlanService.prototype.observeEnvironment).getMockImplementation()!;
    vi.mocked(PlanService.prototype.observeEnvironment).mockImplementation(async (...args) => {
      const observed = await original(...args);
      if (observed.observed) observed.observed.storage = [{ name: 'hypervibe-backups', provider: 'railway', kind: 'object', status: 'running', externalId: 'backup-bucket-1', region: 'iad',
        instanceScope: { projectId: 'project-1', environmentId: 'production-1' } }];
      return observed;
    });
    vi.spyOn(managedCi, 'planManagedCiDeploy').mockResolvedValue({ actions: [], warnings: [] });
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementation(async context => {
      const coverage = await observe(context);
      coverage.resources[0].state = 'scheduled';
      if (coverage.resources[0].observation?.state === 'known') coverage.resources[0].observation.daily = true;
      return coverage;
    });
    const publication: PlanAction = { id: 'github:infrastructure', type: 'update',
      resource: { kind: 'repo', provider: 'github', name: 'acme/daily-before-release' },
      verified: true, requiresConfirm: true, billable: true, reason: 'Publish reviewed managed backup schedule',
      metadata: { operation: 'githubInfrastructurePullRequest', repository: 'acme/daily-before-release',
        backupWorkflowPublicationRequired: true, desiredFiles: [
          { path: '.github/workflows/hypervibe-backup-production.yml', hash: 'a'.repeat(64) },
          { path: '.github/hypervibe/backups-production.json', hash: 'b'.repeat(64) },
        ] } };
    vi.spyOn(githubInfrastructure, 'planGitHubInfrastructure').mockResolvedValue({ actions: [publication], warnings: [], blocked: [], inputRequired: [] });
    const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('backup-program-publication');
    expect(result.actions).toEqual([{ ...publication, dependsOn: undefined }]);
    expect(result.backupReadiness?.ready).toBe(false);
    const document = new RunRepository().findById(result.planRunId)!.plan;
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    expect(document).toHaveProperty('observedFingerprint', null);
    for (const field of ['overrides', 'integrationFingerprints', 'inputRequired']) expect(document).not.toHaveProperty(field);
    expect(result.blocked).toEqual([]);
  });

  it('isolates creation of the derived backup destination before wiring or rollout', async () => {
    const f = await fixture();
    vi.spyOn(managedCi, 'planManagedCiDeploy').mockResolvedValue({ actions: [], warnings: [] });
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementation(async context => {
      const coverage = await observe(context);
      coverage.resources[0].state = 'scheduled';
      if (coverage.resources[0].observation?.state === 'known') coverage.resources[0].observation.daily = true;
      return coverage;
    });
    const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('backup-provisioning');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ resource: { kind: 'storage', name: 'hypervibe-backups' },
      requiresConfirm: true, billable: true, dataBearing: true, metadata: { operation: 'storageEnsure' } });
    const document = new RunRepository().findById(result.planRunId)!.plan;
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    for (const field of ['overrides', 'integrationFingerprints', 'inputRequired']) expect(document).not.toHaveProperty(field);
  });

  it.each(['contract-adoption', 'secret-sync'] as const)('preserves archive provisioning after publication with pending %s, then blocks rollout', async pending => {
    const f = await fixture();
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementation(async context => {
      const coverage = await observe(context);
      coverage.resources[0].state = 'scheduled';
      if (coverage.resources[0].observation?.state === 'known') coverage.resources[0].observation.daily = true;
      return coverage;
    });
    // This is a synthetic GitHub read boundary, but the workflow renderer,
    // acceptance, CI action and complete PlanService dependency graph are real.
    const { targets, migration } = resolveBranchDeployTargets(f.project);
    const target = targets.find(candidate => candidate.environmentName === 'production')!;
    const workflow = buildBranchDeployWorkflow('railway', target, migration);
    const files = workflowFiles(workflow);
    const publication = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    expect(publication).toMatchObject({ scope: 'managed-ci-publication', actions: [expect.objectContaining({
      metadata: expect.objectContaining({ workflowPublicationRequired: true }),
    })] });

    vi.mocked(GitHubAdapter.prototype.getFileContent).mockImplementation(async (_owner, _repo, filePath) =>
      files.find(file => file.path === filePath)?.content ?? null);
    if (pending === 'secret-sync') new EnvironmentRepository().updatePlatformBindings(f.environment.id, {
      ci: { deployBranch: { [workflow.path]: {
        inputHash: githubActionsWorkflowInputHash({ provider: 'railway', target, migration }),
        contentHash: workflowFilesContentHash(files),
      } } },
    });
    const spec = new SpecStore().get(f.project)!.spec;
    const ci = await managedCi.planManagedCiDeploy({ project: f.project, spec, environmentName: 'production',
      environmentSpec: spec.environments.production, environment: new EnvironmentRepository().findById(f.environment.id)! });
    expect(ci.actions).toEqual([expect.objectContaining({ type: 'update', resource: expect.objectContaining({ kind: 'ci' }) })]);
    expect(ci.actions[0].metadata).not.toHaveProperty('workflowPublicationRequired');
    expect(ci.actions[0].reason).toMatch(pending === 'secret-sync' ? /secrets need syncing/ : /input contract/);

    // A retry before apply keeps the same isolated authority. Neither pending
    // CI work nor ordinary service/env changes may enter storage provisioning.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
      if ('error' in result) throw new Error(result.error);
      expect(result.scope).toBe('backup-provisioning');
      expect(result.actions).toEqual([expect.objectContaining({ id: 'storage:hypervibe-backups',
        requiresConfirm: true, billable: true, dataBearing: true, metadata: expect.objectContaining({ operation: 'storageEnsure' }) })]);
      expect(result.actions[0].dependsOn ?? []).toEqual([]);
      expect(result.inputRequired).toEqual([]);
      const document = new RunRepository().findById(result.planRunId)!.plan;
      expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
      for (const field of ['overrides', 'integrationFingerprints', 'inputRequired']) expect(document).not.toHaveProperty(field);
    }

    // Stand in for successful provider creation by recording and observing the
    // new bucket. This does not supply a completed recovery point or restore.
    new EnvironmentRepository().updatePlatformBindings(f.environment.id, { storage: {
      ...f.environment.platformBindings.storage as Record<string, unknown>,
      'hypervibe-backups': { provider: 'railway', externalId: 'backup-bucket-1', purpose: 'backup', region: 'iad', services: [],
        instanceScope: { projectId: 'project-1', environmentId: 'production-1' } },
    } });
    const original = vi.mocked(PlanService.prototype.observeEnvironment).getMockImplementation()!;
    vi.mocked(PlanService.prototype.observeEnvironment).mockImplementation(async (...args) => {
      const result = await original(...args);
      if (result.observed) result.observed.storage = [{ name: 'hypervibe-backups', provider: 'railway', kind: 'object', status: 'running', externalId: 'backup-bucket-1', region: 'iad',
        instanceScope: { projectId: 'project-1', environmentId: 'production-1' } }];
      return result;
    });
    const afterBinding = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    // Accepted CI credentials are themselves needed to run the first backup.
    // Exposing that prerequisite must still leave every workload update gated.
    expect(afterBinding).toMatchObject({ scope: 'managed-ci-credentials', actions: [expect.objectContaining({
      id: 'ci:github-actions:production:deploy-branch', metadata: expect.objectContaining({ operation: 'githubActionsDeployBranch' }),
    })] });
    const hashes = ci.actions[0].metadata?.desiredEnvironmentSecretHashes as Record<string, string>;
    new EnvironmentRepository().updatePlatformBindings(f.environment.id, { ci: { deployBranch: { [workflow.path]: {
      inputHash: githubActionsWorkflowInputHash({ provider: 'railway', target, migration }),
      contentHash: workflowFilesContentHash(files), syncedEnvironmentSecretHashes: hashes,
    } } } });
    vi.mocked(GitHubAdapter.prototype.listEnvironmentSecrets).mockResolvedValue(Object.keys(hashes));
    const afterCredentials = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    expect(afterCredentials).toMatchObject({ scope: 'backup-readiness', actions: [], blocked: [expect.objectContaining({
      category: 'prerequisite', provider: 'hypervibe', reason: expect.stringMatching(/backup/i),
    })] });
  });

  it('preserves database creation before CI database-secret sync and CI before workload changes', async () => {
    const f = await fixture();
    // An explicit reviewed exclusion admits the ordinary full graph so this
    // test can inspect its genuine DATABASE_URL dependency, not a pruned stage.
    new SpecStore().merge(f.project, { environments: { production: {
      backups: { mode: 'disabled', reason: 'Disposable dependency-order test environment' },
      migrations: { mode: 'tool', command: 'npm run migrate' },
    } } });
    new ComponentRepository().delete(f.component.id);
    const original = vi.mocked(PlanService.prototype.observeEnvironment).getMockImplementation()!;
    vi.mocked(PlanService.prototype.observeEnvironment).mockImplementation(async (...args) => {
      const result = await original(...args);
      if (result.observed) result.observed.databases = [];
      return result;
    });
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementation(async context => ({ ...(await observe(context)), resources: [] }));
    const { targets, migration } = resolveBranchDeployTargets(f.project);
    const target = targets.find(candidate => candidate.environmentName === 'production')!;
    const workflow = buildBranchDeployWorkflow('railway', target, migration);
    expect(workflow.requiredSecrets).toContain('DATABASE_URL');
    vi.mocked(GitHubAdapter.prototype.getFileContent).mockImplementation(async (_owner, _repo, filePath) =>
      workflowFiles(workflow).find(file => file.path === filePath)?.content ?? null);

    const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('full');
    const database = result.actions.find(action => action.id === 'database:railway')!;
    const ci = result.actions.find(action => action.id === 'ci:github-actions:production:deploy-branch')!;
    const web = result.actions.find(action => action.id === 'service:web')!;
    expect(database).toMatchObject({ type: 'create', billable: true });
    expect(database.dependsOn ?? []).not.toContain(ci.id);
    expect(ci).toMatchObject({ type: 'update', dependsOn: ['database:railway'] });
    expect(web).toMatchObject({ type: 'update', dependsOn: expect.arrayContaining([database.id, ci.id]) });
    const order = orderActions(result.actions).map(action => action.id);
    expect(order.indexOf(database.id)).toBeLessThan(order.indexOf(ci.id));
    expect(order.indexOf(ci.id)).toBeLessThan(order.indexOf(web.id));
  });

  it('cannot bypass an unsupported backup gap with a service filter', async () => {
    const f = await fixture();
    vi.spyOn(managedCi, 'planManagedCiDeploy').mockResolvedValue({ actions: [], warnings: [] });
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementation(async context => {
      const coverage = await observe(context);
      coverage.resources[0].state = 'scheduled';
      if (coverage.resources[0].observation?.state === 'known') coverage.resources[0].observation.daily = true;
      return coverage;
    });
    const result = await f.planner.plan(f.project, 'production', { includeEnvFile: false, serviceFilter: ['web'] });
    expect(result).toHaveProperty('error', expect.stringMatching(/backup/i));
  });
});
