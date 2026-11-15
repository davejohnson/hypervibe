import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { createToolContext } from '../../../application/context.js';
import { PlanService } from '../../plan/plan.service.js';
import { hashEnvValue } from '../../ports/observe.port.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import { GITHUB_INFRASTRUCTURE_ACTION_ID, GITHUB_INFRASTRUCTURE_BRANCH } from '../github-infrastructure.service.js';

const SECRET_VALUE = 'synthetic-workflow-key';

// The documented repository lifecycle requires reviewed files on the default
// branch before dependent secret changes. Exercise the persisted full plan:
// task publication requires confirmation and is consequently reordered there.
describe('GitHub Actions secret publication prerequisites', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-actions-secret-staging-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(directory, 'state.db'));
    process.env.STAGING_TEST_KEY = SECRET_VALUE;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network access'); }));
  });

  afterEach(() => {
    delete process.env.STAGING_TEST_KEY;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function fixture(key: string, options: { accepted?: boolean; retire?: boolean; environment?: boolean } = {}) {
    const project = new ProjectRepository().create({
      name: 'example', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/owner/example.git',
    });
    for (const provider of ['github', 'railway']) {
      const connection = new ConnectionRepository().create({
        provider,
        ...(provider === 'github' ? { scope: 'owner/example' } : {}),
        credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-token' }),
      });
      new ConnectionRepository().updateStatus(connection.id, 'verified');
    }
    const spec = projectSpecSchema.parse({
      version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
      github: {
        repository: 'owner/example', canonicalEnvironment: 'production',
        collaboration: { issues: { enabled: false, templates: false }, pullRequests: { requirePr: false } },
        actions: {
          ...(key === 'OPENAI_API_KEY' ? {
            audit: { kind: 'code-audit', instructions: 'Review only', schedule: { cron: '17 5 * * *', timezone: 'UTC' } },
          } : {}),
          'tester-setup': {
            kind: 'environment-task', environment: 'staging', service: 'web', command: ['node', 'scripts/setup.js'],
          },
        },
      },
      secrets: options.retire ? {} : {
        [key]: { principal: 'github:owner', githubActions: options.environment ? { environments: ['staging'] } : { repository: true } },
      },
      environments: {
        production: { hosting: { provider: 'railway' }, services: {} },
        staging: {
          hosting: { provider: 'railway' }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' }, services: { web: {} },
        },
      },
    });
    const stored = new SpecStore().replace(project, spec);
    const target = options.environment ? 'environment:staging' : 'repository';
    const actionId = `secret:github:${target}:${key}`;
    const environments = new EnvironmentRepository();
    environments.create({
      projectId: project.id, name: 'production',
      platformBindings: {
        provider: 'railway', projectId: 'rp', environmentId: 'production-env',
        ...(options.accepted || options.retire ? { github: { delegatedActionsBindings: [{
          name: key, target, principal: 'github:owner', valueHash: hashEnvValue(SECRET_VALUE), actionId,
          syncedAt: '2026-11-03T00:00:00Z',
        }] } } : {}),
      },
    });
    environments.create({
      projectId: project.id, name: 'staging',
      platformBindings: {
        provider: 'railway', projectId: 'rp', environmentId: 'staging-env',
        services: { web: { serviceId: 'staging-web', workloadKind: 'web' } },
        ci: { deployBranch: { '.github/workflows/deploy-railway-staging.yml': { contentHash: 'a'.repeat(64), inputHash: 'b'.repeat(64) } } },
      },
    });
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({
      observed: {
        provider: 'railway', projectExists: true, observedAt: '2026-11-03T00:00:00Z', partial: false, warnings: [],
        projectId: 'rp', environmentId: 'production-env', services: [], databases: [],
        completeness: { project: 'complete', environment: 'complete', services: 'complete' },
      }, warnings: [],
    });
    const files = new Map<string, string>();
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent')
      .mockImplementation(async (_owner, _repo, file) => files.get(file) ?? null);
    const secrets = new Set(options.accepted || options.retire ? [key] : []);
    vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets').mockImplementation(async () => [...secrets]);
    vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets')
      .mockImplementation(async () => ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN', ...secrets]);
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret')
      .mockImplementation(async (_owner, _repo, name) => { secrets.add(name); });
    const setEnvironmentSecret = vi.spyOn(GitHubAdapter.prototype, 'setEnvironmentSecret')
      .mockImplementation(async (_owner, _repo, _environment, name) => { secrets.add(name); });
    const deleteSecret = vi.spyOn(GitHubAdapter.prototype, 'deleteSecret').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main', private: false });
    vi.spyOn(GitHubAdapter.prototype, 'listLabels').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    vi.spyOn(GitHubAdapter.prototype, 'createRef').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
    const writeFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false });
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
      number: 42, html_url: 'https://github.com/owner/example/pull/42',
    });
    return {
      actionId: options.retire ? `${actionId}:destroy` : actionId,
      setSecret, setEnvironmentSecret, deleteSecret, writeFile, files,
      async plan() {
        const plan = await new PlanService().plan(project, 'production', {
          ...(!options.retire && !options.accepted ? { secretRefs: { [key]: 'env:STAGING_TEST_KEY' } } : {}),
        });
        if ('error' in plan) throw new Error(plan.error);
        expect(plan.blocked).toEqual([]);
        return plan;
      },
      apply(planId: string) {
        return executePlanApply(createToolContext(), {
          project, spec: stored.spec, specRevision: stored.revision, planId,
          confirmActions: [GITHUB_INFRASTRUCTURE_ACTION_ID, `${actionId}:destroy`],
        });
      },
    };
  }

  it.each([
    { key: 'OPENAI_API_KEY', environment: false },
    { key: 'CI_TOKEN', environment: false },
    { key: 'CI_TOKEN', environment: true },
  ])('defers $key (environment=$environment) until the workflow pull request merges', async ({ key, environment }) => {
    const context = fixture(key, { environment });
    const plan = await context.plan();
    expect(plan.actions.find(action => action.id === GITHUB_INFRASTRUCTURE_ACTION_ID))
      .toMatchObject({ type: 'update', requiresConfirm: true });
    const outcome = await context.apply(plan.planRunId);
    expect(outcome).toMatchObject({ kind: 'executed', result: { receipts: expect.arrayContaining([
      expect.objectContaining({ actionId: GITHUB_INFRASTRUCTURE_ACTION_ID, status: 'pending' }),
      expect.objectContaining({ actionId: context.actionId, status: 'aborted' }),
    ]) } });
    expect(context.setSecret).not.toHaveBeenCalled();
    expect(context.setEnvironmentSecret).not.toHaveBeenCalled();
  });

  it('does not change a secret if workflow publication fails', async () => {
    const context = fixture('CI_TOKEN');
    context.writeFile.mockRejectedValue(new Error('Synthetic publication failure'));
    const plan = await context.plan();
    const outcome = await context.apply(plan.planRunId);
    expect(outcome).toMatchObject({ kind: 'executed', result: { receipts: expect.arrayContaining([
      expect.objectContaining({ actionId: GITHUB_INFRASTRUCTURE_ACTION_ID, status: 'failed' }),
      expect.objectContaining({ actionId: context.actionId, status: 'aborted' }),
    ]) } });
    expect(context.setSecret).not.toHaveBeenCalled();
  });

  it('installs a missing key after a fresh plan observes the merged files', async () => {
    const context = fixture('OPENAI_API_KEY');
    const beforeMerge = await context.plan();
    const publication = beforeMerge.actions.find(action => action.id === GITHUB_INFRASTRUCTURE_ACTION_ID)!;
    for (const file of publication.metadata!.desiredFiles as Array<{ path: string; content: string }>) {
      context.files.set(file.path, file.content);
    }
    const afterMerge = await context.plan();
    expect(afterMerge.actions.find(action => action.id === GITHUB_INFRASTRUCTURE_ACTION_ID)?.type).toBe('noop');
    expect(afterMerge.actions.find(action => action.id === context.actionId)?.dependsOn).toBeUndefined();
    expect(await context.apply(afterMerge.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(context.setSecret).toHaveBeenCalledWith('owner', 'example', 'OPENAI_API_KEY', SECRET_VALUE);
  });

  it('preserves accepted keys as independent noops during publication', async () => {
    const context = fixture('CI_TOKEN', { accepted: true });
    const plan = await context.plan();
    const secret = plan.actions.find(action => action.id === context.actionId)!;
    expect(secret.type).toBe('noop');
    expect(secret.dependsOn).toBeUndefined();
    await context.apply(plan.planRunId);
    expect(context.setSecret).not.toHaveBeenCalled();
    expect(context.deleteSecret).not.toHaveBeenCalled();
  });

  it('preserves a retired key until its replacement workflows are reviewed', async () => {
    const context = fixture('OLD_CI_TOKEN', { retire: true });
    const plan = await context.plan();
    expect(plan.actions.find(action => action.id === context.actionId))
      .toMatchObject({ type: 'destroy', dependsOn: [GITHUB_INFRASTRUCTURE_ACTION_ID] });
    expect(await context.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { receipts: expect.arrayContaining([
      expect.objectContaining({ actionId: GITHUB_INFRASTRUCTURE_ACTION_ID, status: 'pending' }),
      expect.objectContaining({ actionId: context.actionId, status: 'aborted' }),
    ]) } });
    expect(context.deleteSecret).not.toHaveBeenCalled();
  });

  it('rejects a persisted plan without its publication dependency before any writes', async () => {
    const context = fixture('CI_TOKEN');
    const plan = await context.plan();
    const repository = new RunRepository();
    const run = repository.findById(plan.planRunId)!;
    const document = run.plan as { actions: Array<{ id: string; dependsOn?: string[] }> };
    delete document.actions.find(action => action.id === context.actionId)!.dependsOn;
    SqliteAdapter.getInstance().getDb().prepare('UPDATE runs SET plan = ? WHERE id = ?')
      .run(JSON.stringify(document), run.id);
    expect(await context.apply(plan.planRunId)).toMatchObject({ kind: 'blocked' });
    expect(context.setSecret).not.toHaveBeenCalled();
    expect(context.writeFile).not.toHaveBeenCalled();
  });
});
