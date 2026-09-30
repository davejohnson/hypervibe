import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/devops-providers.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { Project } from '../../entities/project.entity.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { ConvergeExecutor } from '../../plan/converge.executor.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { compileManagedGitHubFiles, GITHUB_INFRASTRUCTURE_ACTION_ID, planGitHubInfrastructure } from '../github-infrastructure.service.js';

const REPOSITORY = 'owner/example';
const REQUIRED_SECRETS = ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'];

function desiredSpec(provider = 'railway') {
  return projectSpecSchema.parse({
    version: 1, project: 'example', runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
    github: {
      repository: REPOSITORY, canonicalEnvironment: 'production',
      collaboration: { issues: { enabled: false, templates: false }, pullRequests: { requirePr: false } },
      actions: { 'tester-setup': { kind: 'environment-task', environment: 'staging', service: 'web', command: ['node', 'scripts/tester-setup.js'] } },
    },
    environments: {
      production: { hosting: { provider: 'railway' }, services: { web: {} } },
      staging: {
        hosting: { provider }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        services: { web: {}, cron: { workloadKind: 'cron', cronSchedule: '*/5 * * * *', startCommand: 'npm run cron' } },
      },
    },
  });
}

function boundEnvironment(project: Project, name: string, overrides: Record<string, unknown> = {}) {
  return new EnvironmentRepository().create({
    projectId: project.id, name,
    platformBindings: {
      provider: 'railway', projectId: 'railway-project', environmentId: `${name}-environment`,
      services: { web: { serviceId: `${name}-web`, workloadKind: 'web' }, cron: { serviceId: `${name}-cron`, workloadKind: 'cron' } },
      ci: { deployBranch: { [`.github/workflows/deploy-railway-${name}.yml`]: { contentHash: 'a'.repeat(64), inputHash: 'b'.repeat(64) } } },
      ...overrides,
    },
  });
}

describe('reviewed environment-task infrastructure plan/apply', () => {
  let directory: string;
  let project: Project;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-task-plan-'));
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'hypervibe.db'));
    project = new ProjectRepository().create({ name: 'example', defaultPlatform: 'railway', gitRemoteUrl: `https://github.com/${REPOSITORY}.git` });
    const connection = new ConnectionRepository().create({ provider: 'github', scope: REPOSITORY, credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'test-token' }) });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    boundEnvironment(project, 'production');
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets').mockResolvedValue(REQUIRED_SECRETS);
  });

  afterEach(() => {
    vi.restoreAllMocks(); SqliteAdapter.resetInstance(); fs.rmSync(directory, { recursive: true, force: true });
  });

  async function plan(spec = desiredSpec()) {
    return planGitHubInfrastructure({ project, spec, environmentName: 'production' });
  }

  function persist(action: PlanAction) {
    const production = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    return new RunRepository().create({ projectId: project.id, environmentId: production.id, type: 'plan', plan: {
      kind: 'hv_plan', environmentName: 'production', specRevision: 1, observedFingerprint: null, actions: [action],
    } }).id;
  }

  it('gates staging task publication as billable even when production owns repository planning', async () => {
    boundEnvironment(project, 'staging');
    const result = await plan();
    expect(result.actions[0]).toMatchObject({ id: GITHUB_INFRASTRUCTURE_ACTION_ID, type: 'update', billable: true, requiresConfirm: true });
    expect(result.actions[0].metadata?.blockedReason).toBeUndefined();
    expect(GitHubAdapter.prototype.listEnvironmentSecrets).toHaveBeenCalledWith('owner', 'example', 'staging');
    expect(GitHubAdapter.prototype.listEnvironmentSecrets).not.toHaveBeenCalledWith('owner', 'example', 'production');
    const workflow = (result.actions[0].metadata?.desiredFiles as Array<{ path: string; review?: { mergeEffect?: string } }>)
      .find((file) => file.path.endsWith('hypervibe-tester-setup.yml'))!;
    expect(workflow.review?.mergeEffect).toMatch(/dispatch.*temporary.*cost/i);
  });

  it('blocks a missing staging binding without borrowing production identities', async () => {
    const result = await plan();
    expect(result.actions[0].metadata?.blockedReason).toBe('github_environment_task_binding_missing');
    expect(result.warnings.join('\n')).toContain('staging');
  });

  it.each([
    { environmentId: undefined },
    { services: { web: { serviceId: 'web', workloadKind: 'web' } } },
    { services: { web: { serviceId: 'same', workloadKind: 'web' }, cron: { serviceId: 'same', workloadKind: 'cron' } } },
    { ci: {} },
    { ci: { deployBranch: { '.github/workflows/deploy-railway-staging.yml': {} } } },
  ])('blocks incomplete source release bindings (%j)', async (overrides) => {
    boundEnvironment(project, 'staging', overrides);
    expect((await plan()).actions[0].metadata?.blockedReason).toBe('github_environment_task_binding_missing');
  });

  it('blocks a provider without the declared temporary-task capability', async () => {
    boundEnvironment(project, 'staging');
    expect((await plan(desiredSpec('cloudrun'))).actions[0].metadata?.blockedReason)
      .toBe('github_environment_task_unsupported');
  });

  it('requires observed machine credentials in the exact staging GitHub environment', async () => {
    boundEnvironment(project, 'staging');
    vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets').mockResolvedValue(REQUIRED_SECRETS);
    vi.mocked(GitHubAdapter.prototype.listEnvironmentSecrets).mockResolvedValue([]);
    const missing = await plan();
    expect(missing.actions[0].metadata?.blockedReason).toBe('github_environment_task_secret_missing');
    expect(GitHubAdapter.prototype.listRepositorySecrets).not.toHaveBeenCalled();
    vi.mocked(GitHubAdapter.prototype.listEnvironmentSecrets).mockRejectedValue(new Error('Access denied'));
    expect((await plan()).actions[0].metadata?.blockedReason).toBe('github_observation_unknown');
  });

  it('requires the exact persisted billable action id before any apply handler can run', async () => {
    boundEnvironment(project, 'staging');
    const action = (await plan()).actions[0];
    const handler = vi.fn(async () => ({ success: true, message: 'Synthetic publication boundary reached' }));
    const rejected = await new ConvergeExecutor().execute({ planRunId: persist(action), currentSpecRevision: 1, confirmActions: ['wrong-action'], handler });
    expect(rejected).toMatchObject({ success: false, receipts: [{ actionId: GITHUB_INFRASTRUCTURE_ACTION_ID, status: 'skipped_requires_confirm' }] });
    expect(handler).not.toHaveBeenCalled();
    const accepted = await new ConvergeExecutor().execute({ planRunId: persist(action), currentSpecRevision: 1, confirmActions: [GITHUB_INFRASTRUCTURE_ACTION_ID], handler });
    expect(accepted.success).toBe(true); expect(handler).toHaveBeenCalledOnce();
  });

  it('keeps an unchanged task noop and performs no apply mutations', async () => {
    boundEnvironment(project, 'staging');
    const desired = desiredSpec();
    const files = new Map(compileManagedGitHubFiles(desired.github!, desired.runtime).map((file) => [file.path, file.content]));
    vi.mocked(GitHubAdapter.prototype.getFileContent).mockImplementation(async (_owner, _repo, file) => files.get(file) ?? null);
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main', private: true });
    vi.spyOn(GitHubAdapter.prototype, 'listLabels').mockResolvedValue([]);
    const action = (await plan(desired)).actions[0];
    expect(action).toMatchObject({ type: 'noop' }); expect(action.billable).toBeUndefined();
    const handler = vi.fn(async () => ({ success: true, message: 'Should not run for noop' }));
    expect((await new ConvergeExecutor().execute({ planRunId: persist(action), currentSpecRevision: 1, handler })).success).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});
