import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { createToolContext } from '../context.js';
import { registerHvCiTools } from '../hv-ci.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-ci-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();

  const github = new ConnectionRepository().create({
    provider: 'github',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gh-token' }),
  });
  new ConnectionRepository().updateStatus(github.id, 'verified');
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedProject(policies?: Record<string, unknown>) {
  return new ProjectRepository().create({
    name: 'billforge',
    defaultPlatform: 'railway',
    gitRemoteUrl: 'https://github.com/davejohnson/billforge',
    ...(policies ? { policies } : {}),
  });
}

async function makeClient() {
  const server = new McpServer({ name: 'hv-ci-test', version: '1.0.0' });
  registerHvCiTools(server, createToolContext());
  const client = new Client({ name: 'hv-ci-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('hv_ci_setup', () => {
  it('creates a workflow from a template (kind="workflow")', async () => {
    seedProject();
    const createFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false } as any);
    const t = await makeClient();

    const res = await t.call('hv_ci_setup', { project: 'billforge', kind: 'workflow', config: { template: 'node-test' } });
    expect(res.ok).toBe(true);
    expect(res.data.repository).toBe('davejohnson/billforge');
    expect(res.data.path).toBe('.github/workflows/test.yml');
    expect(res.data.created).toBe(true);
    expect(createFile).toHaveBeenCalledWith(
      'davejohnson',
      'billforge',
      '.github/workflows/test.yml',
      expect.stringContaining('npm test'),
      expect.any(String)
    );

    const unknown = await t.call('hv_ci_setup', { project: 'billforge', kind: 'workflow', config: { template: 'nope' } });
    expect(unknown.ok).toBe(false);
    expect(unknown.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('writes branch-deploy workflows using the project environments and desired branches (kind="deploy-branch")', async () => {
    const project = seedProject({
      desiredState: {
        deploy: { strategy: 'branch', branches: { production: 'release' } },
      },
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();
    const githubConnection = connectionRepo.findByProvider('github')!;
    connectionRepo.updateCredentials(githubConnection.id, secretStore.encryptObject({
      apiToken: 'gh-token',
      login: 'davejohnson',
      packageReadToken: 'gh-package-token',
    }));
    connectionRepo.updateStatus(githubConnection.id, 'verified');
    const railwayConnection = connectionRepo.create({
      provider: 'railway',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'railway-token' }),
    });
    connectionRepo.updateStatus(railwayConnection.id, 'verified');

    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'davejohnson' });
    const createFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false } as any);
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();
    const protect = vi.spyOn(GitHubAdapter.prototype, 'updateBranchProtection').mockResolvedValue();
    const t = await makeClient();

    const res = await t.call('hv_ci_setup', { project: 'billforge', kind: 'deploy-branch', config: { provider: 'railway' } });
    expect(res.ok).toBe(true);
    expect(res.data.branchMapping).toEqual({ production: 'release' });
    expect(res.data.workflows).toEqual([
      expect.objectContaining({ template: 'deploy-railway-production', branch: 'release', path: '.github/workflows/deploy-railway-production.yml', created: true }),
    ]);
    expect(res.data.requiredSecrets).toEqual(['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(res.data.requiredSecrets).not.toContain('RAILWAY_TOKEN');
    expect(res.data.requiredSecrets).not.toContain('GHCR_USERNAME');
    expect(res.data.requiredSecrets).not.toContain('GHCR_TOKEN');
    expect(res.data.syncedSecrets).toEqual(['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(res.data.manualSecrets).toEqual([]);
    expect(createFile.mock.calls[0][3]).toContain('serviceInstanceUpdate');
    expect(createFile.mock.calls[0][3]).toContain('docker/build-push-action@v6');
    expect(createFile.mock.calls[0][3]).toContain('secrets.GITHUB_TOKEN');
    expect(createFile.mock.calls[0][3]).toContain('secrets.IMAGE_REGISTRY_TOKEN');
    expect(createFile.mock.calls[0][3]).not.toContain('railway-github-action');
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'billforge', 'RAILWAY_API_TOKEN', 'railway-token');
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'billforge', 'IMAGE_REGISTRY_USERNAME', 'davejohnson');
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'billforge', 'IMAGE_REGISTRY_TOKEN', 'gh-package-token');
    expect(createFile).toHaveBeenCalledTimes(1);
    expect(protect).not.toHaveBeenCalled();
    await t.close();
  });

  it('rejects a read:packages-only GitHub apiToken for branch deploy setup', async () => {
    const project = seedProject({
      desiredState: {
        deploy: { strategy: 'branch', branches: { production: 'main' } },
      },
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['read:packages'],
    });
    const createFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false } as any);
    const t = await makeClient();

    const res = await t.call('hv_ci_setup', { project: 'billforge', kind: 'deploy-branch', config: { provider: 'railway' } });

    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('MISSING_CONNECTION');
    expect(res.data).toBeUndefined();
    expect(res.error.message).toContain('GitHub connection is missing CI deploy permissions');
    expect(res.error.details.missingScopes).toEqual(['repo', 'workflow']);
    expect(res.hint).toContain('read:packages-only token is only enough for GHCR image pulls');
    expect(res.hint).toContain('repo');
    expect(res.hint).toContain('workflow');
    expect(res.hint).toContain('packageReadToken');
    expect(res.next).toEqual(['hv_connect', 'hv_ci_setup']);
    expect(createFile).not.toHaveBeenCalled();
    await t.close();
  });

  it('uses repo-scoped GitHub package credentials for Railway branch deploys', async () => {
    const project = seedProject({
      desiredState: {
        deploy: { strategy: 'branch', branches: { production: 'main' } },
      },
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();
    const scopedGithubConnection = connectionRepo.create({
      provider: 'github',
      scope: 'davejohnson/billforge',
      credentialsEncrypted: secretStore.encryptObject({
        apiToken: 'gh-token',
        login: 'davejohnson',
        packageReadToken: 'scoped-package-token',
      }),
    });
    connectionRepo.updateStatus(scopedGithubConnection.id, 'verified');
    const railwayConnection = connectionRepo.create({
      provider: 'railway',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'railway-token' }),
    });
    connectionRepo.updateStatus(railwayConnection.id, 'verified');
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false } as any);
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();
    const t = await makeClient();

    const res = await t.call('hv_ci_setup', { project: 'billforge', kind: 'deploy-branch', config: { provider: 'railway' } });

    expect(res.ok).toBe(true);
    expect(res.data.syncedSecrets).toEqual(['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'billforge', 'IMAGE_REGISTRY_TOKEN', 'scoped-package-token');
    await t.close();
  });

  it('accepts statusChecks=false for branch-deploy setup', async () => {
    const project = seedProject({
      desiredState: {
        deploy: { strategy: 'branch', branches: { production: 'release' } },
      },
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });

    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'davejohnson' });
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false } as any);
    const protect = vi.spyOn(GitHubAdapter.prototype, 'updateBranchProtection').mockResolvedValue();
    const t = await makeClient();

    const res = await t.call('hv_ci_setup', {
      project: 'billforge',
      kind: 'deploy-branch',
      config: { provider: 'railway', protectBranches: true, statusChecks: false },
    });
    expect(res.ok).toBe(true);
    expect(protect).toHaveBeenCalledWith('davejohnson', 'billforge', 'release', expect.objectContaining({
      requireStatusChecks: false,
      statusChecks: [],
    }));
    await t.close();
  });

  it('reports missing package pull credentials for Railway branch deploys', async () => {
    const project = seedProject({
      desiredState: {
        deploy: { strategy: 'branch', branches: { production: 'release' } },
      },
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();
    const githubConnection = connectionRepo.findByProvider('github')!;
    connectionRepo.updateCredentials(githubConnection.id, secretStore.encryptObject({
      apiToken: 'gh-token',
      login: 'davejohnson',
    }));
    connectionRepo.updateStatus(githubConnection.id, 'verified');
    const railwayConnection = connectionRepo.create({
      provider: 'railway',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'railway-token' }),
    });
    connectionRepo.updateStatus(railwayConnection.id, 'verified');

    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'davejohnson' });
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false } as any);
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();
    const t = await makeClient();

    const res = await t.call('hv_ci_setup', { project: 'billforge', kind: 'deploy-branch', config: { provider: 'railway' } });
    expect(res.ok).toBe(true);
    expect(res.data.syncedSecrets).toEqual(['RAILWAY_API_TOKEN']);
    expect(res.data.manualSecrets).toEqual(['IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(res.data.missingProviderSecrets).toEqual(['IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(res.warnings).toContainEqual(expect.stringContaining('packageReadToken'));
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'billforge', 'RAILWAY_API_TOKEN', 'railway-token');
    expect(setSecret).not.toHaveBeenCalledWith('davejohnson', 'billforge', 'IMAGE_REGISTRY_TOKEN', expect.any(String));
    await t.close();
  });

  it('writes cloud provider API workflows and syncs verified provider secrets', async () => {
    const project = new ProjectRepository().create({
      name: 'cloudapp',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'https://github.com/davejohnson/cloudapp',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
    });
    const connectionRepo = new ConnectionRepository();
    const cloudRunConnection = connectionRepo.create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({
        credentials: '{"client_email":"deploy@gcp-project.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n"}',
        projectId: 'gcp-project',
        region: 'us-central1',
      }),
    });
    connectionRepo.updateStatus(cloudRunConnection.id, 'verified');

    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'davejohnson' });
    const createFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false } as any);
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();
    const t = await makeClient();

    const res = await t.call('hv_ci_setup', { project: 'cloudapp', kind: 'deploy-branch', config: { provider: 'cloudrun' } });
    expect(res.ok).toBe(true);
    expect(res.data.requiredSecrets).toEqual(['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_REGION']);
    expect(res.data.requiredVariables).toEqual([]);
    expect(res.data.syncedSecrets).toEqual(['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_REGION']);
    expect(res.data.manualSecrets).toEqual([]);
    expect(setSecret).toHaveBeenCalledTimes(3);
    expect(createFile.mock.calls[0][3]).toContain("CLOUDRUN_SERVICE_NAMES: 'gcp-project-web'");
    expect(createFile.mock.calls[0][3]).toContain('https://run.googleapis.com/v2/projects/');
    expect(createFile.mock.calls[0][3]).not.toContain('gcloud ');
    await t.close();
  });

  it('rejects invalid kind-specific config (kind="ai-review" without apiKey)', async () => {
    seedProject();
    const t = await makeClient();
    const res = await t.call('hv_ci_setup', { project: 'billforge', kind: 'ai-review', config: {} });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION');
    expect(JSON.stringify(res.error.details)).toContain('apiKey');
    await t.close();
  });

  it('applies branch protection rules (kind="branch-protection")', async () => {
    seedProject();
    const protect = vi.spyOn(GitHubAdapter.prototype, 'updateBranchProtection').mockResolvedValue();
    const t = await makeClient();

    const res = await t.call('hv_ci_setup', {
      project: 'billforge',
      kind: 'branch-protection',
      config: { branch: 'main', requireReviews: true, requiredReviewers: 2 },
    });
    expect(res.ok).toBe(true);
    expect(res.data.branch).toBe('main');
    expect(protect).toHaveBeenCalledWith('davejohnson', 'billforge', 'main', expect.objectContaining({ requireReviews: true, requiredReviewers: 2 }));
    await t.close();
  });
});

describe('hv_ci_status', () => {
  it('returns the requested sections', async () => {
    seedProject();
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflows').mockResolvedValue({
      total_count: 1,
      workflows: [{ id: 7, name: 'Tests', path: '.github/workflows/test.yml', state: 'active', created_at: '2026-01-01' } as any],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getBranchProtection').mockResolvedValue(null);
    const t = await makeClient();

    const res = await t.call('hv_ci_status', { project: 'billforge', include: ['workflows', 'branch-protection'] });
    expect(res.ok).toBe(true);
    expect(res.data.workflows).toEqual([{ id: 7, name: 'Tests', path: '.github/workflows/test.yml', state: 'active' }]);
    expect(res.data.branchProtection).toEqual({ branch: 'main', protected: false });
    await t.close();
  });

  it('uses a verified fallback GitHub connection when an exact scoped connection is unverified', async () => {
    seedProject();
    const connectionRepo = new ConnectionRepository();
    connectionRepo.create({
      provider: 'github',
      scope: 'davejohnson/billforge',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'bad-scoped-token' }),
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflows').mockResolvedValue({
      total_count: 1,
      workflows: [{ id: 7, name: 'Tests', path: '.github/workflows/test.yml', state: 'active', created_at: '2026-01-01' } as any],
    });
    const t = await makeClient();

    const res = await t.call('hv_ci_status', { project: 'billforge', include: ['workflows'] });

    expect(res.ok).toBe(true);
    expect(res.data.workflows).toEqual([{ id: 7, name: 'Tests', path: '.github/workflows/test.yml', state: 'active' }]);
    await t.close();
  });

  it('requires workflow when runs are requested', async () => {
    seedProject();
    const t = await makeClient();
    const res = await t.call('hv_ci_status', { project: 'billforge', include: ['runs'] });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('returns GitHub Actions jobs and steps for a workflow run', async () => {
    seedProject();
    const listJobs = vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunJobs').mockResolvedValue({
      total_count: 1,
      jobs: [{
        id: 99,
        run_id: 123,
        name: 'deploy',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-06-26T20:16:10Z',
        completed_at: '2026-06-26T20:17:10Z',
        html_url: 'https://github.com/davejohnson/billforge/actions/runs/123/job/99',
        steps: [{
          number: 4,
          name: 'Deploy image',
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-06-26T20:16:40Z',
          completed_at: '2026-06-26T20:17:00Z',
        }],
      }],
    });
    const t = await makeClient();

    const res = await t.call('hv_ci_status', { project: 'billforge', include: ['jobs'], runId: '123' });

    expect(res.ok).toBe(true);
    expect(listJobs).toHaveBeenCalledWith('davejohnson', 'billforge', 123, { per_page: 100 });
    expect(res.data.jobs).toEqual([{
      id: 99,
      name: 'deploy',
      status: 'completed',
      conclusion: 'failure',
      startedAt: '2026-06-26T20:16:10Z',
      completedAt: '2026-06-26T20:17:10Z',
      url: 'https://github.com/davejohnson/billforge/actions/runs/123/job/99',
      steps: [{
        number: 4,
        name: 'Deploy image',
        status: 'completed',
        conclusion: 'failure',
        startedAt: '2026-06-26T20:16:40Z',
        completedAt: '2026-06-26T20:17:00Z',
      }],
    }]);
    await t.close();
  });

  it('returns bounded log tails for failed GitHub Actions jobs', async () => {
    seedProject();
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunJobs').mockResolvedValue({
      total_count: 2,
      jobs: [
        {
          id: 98,
          run_id: 123,
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-06-26T20:16:00Z',
          completed_at: '2026-06-26T20:16:30Z',
          html_url: 'https://github.com/davejohnson/billforge/actions/runs/123/job/98',
          steps: [],
        },
        {
          id: 99,
          run_id: 123,
          name: 'deploy',
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-06-26T20:16:30Z',
          completed_at: '2026-06-26T20:17:00Z',
          html_url: 'https://github.com/davejohnson/billforge/actions/runs/123/job/99',
          steps: [],
        },
      ],
    });
    const logs = vi.spyOn(GitHubAdapter.prototype, 'getWorkflowJobLogs').mockResolvedValue('line one\nline two\nline three');
    const t = await makeClient();

    const res = await t.call('hv_ci_status', { project: 'billforge', include: ['logs'], runId: 123, logLines: 2 });

    expect(res.ok).toBe(true);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs).toHaveBeenCalledWith('davejohnson', 'billforge', 99);
    expect(res.data.logs).toEqual([{
      jobId: 99,
      name: 'deploy',
      status: 'completed',
      conclusion: 'failure',
      text: 'line two\nline three',
      lineCount: 3,
      returnedLines: 2,
      truncated: true,
    }]);
    await t.close();
  });

  it('diagnoses GHCR image pull permission failures from GitHub Actions logs', async () => {
    seedProject();
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunJobs').mockResolvedValue({
      total_count: 1,
      jobs: [{
        id: 99,
        run_id: 123,
        name: 'deploy',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-06-26T20:16:30Z',
        completed_at: '2026-06-26T20:17:00Z',
        html_url: 'https://github.com/davejohnson/billforge/actions/runs/123/job/99',
        steps: [],
      }],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getWorkflowJobLogs').mockResolvedValue([
      'Run docker buildx imagetools inspect "ghcr.io/***/apreskeys.com:dde84d02" >/dev/null',
      'ERROR: unexpected status from HEAD request to https://ghcr.io/v2/***/apreskeys.com/manifests/dde84d02: 403 Forbidden',
      'Error: Process completed with exit code 1.',
    ].join('\n'));
    const t = await makeClient();

    const res = await t.call('hv_ci_status', { project: 'billforge', include: ['logs'], runId: 123 });

    expect(res.ok).toBe(true);
    expect(res.data.diagnostics).toContainEqual(expect.objectContaining({
      code: 'GHCR_IMAGE_PULL_FORBIDDEN',
      jobId: 99,
      jobName: 'deploy',
    }));
    expect(res.data.diagnostics[0].summary).toContain('Railway will show no new deploy attempt');
    expect(res.data.diagnostics[0].next).toContainEqual(expect.stringContaining('hv_secrets_set target="github"'));
    await t.close();
  });
});

describe('hv_ci_trigger', () => {
  it('dispatches a workflow run', async () => {
    seedProject();
    const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();
    const t = await makeClient();

    const res = await t.call('hv_ci_trigger', { project: 'billforge', workflow: 'deploy.yml', inputs: { version: '1.2.3' } });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ repository: 'davejohnson/billforge', workflow: 'deploy.yml', ref: 'main' });
    expect(res.next).toContain('hv_ci_status');
    expect(trigger).toHaveBeenCalledWith('davejohnson', 'billforge', 'deploy.yml', 'main', { version: '1.2.3' });
    await t.close();
  });

  it('fails with VALIDATION when no GitHub repo can be derived', async () => {
    new ProjectRepository().create({ name: 'no-remote-app' });
    const t = await makeClient();
    const res = await t.call('hv_ci_trigger', { project: 'no-remote-app', workflow: 'deploy.yml' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION');
    await t.close();
  });
});
