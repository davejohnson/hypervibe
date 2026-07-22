import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import '../../adapters/providers/railway/railway.adapter.js';
import '../../adapters/providers/gcp/cloudrun.adapter.js';
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

describe('hv_ci_setup desired-state migration', () => {
  it('keeps provider-specific workflow diagnostics outside the generic CI tool', () => {
    const source = readFileSync(new URL('../hv-ci.tools.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('RAILWAY_SERVICE_INSTANCE_MISSING');
    expect(source).not.toContain('RAILWAY_DEPLOY_POLLING_GRAPHQL_400');
    expect(source).not.toContain('Service Instance not found');
    expect(source).not.toContain('serviceInstanceDeployV2');
    expect(source).not.toContain('Railway API 400');
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

  it('diagnoses old Railway deploy workflow GraphQL polling failures', async () => {
    seedProject();
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunJobs').mockResolvedValue({
      total_count: 1,
      jobs: [{
        id: 99,
        run_id: 123,
        name: 'deploy',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-07-04T18:16:30Z',
        completed_at: '2026-07-04T18:17:00Z',
        html_url: 'https://github.com/davejohnson/billforge/actions/runs/123/job/99',
        steps: [],
      }],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getWorkflowJobLogs').mockResolvedValue([
      'Node 20 is being deprecated. This workflow is running with Node 24 by default.',
      'Run actions/github-script@v7',
      'Error: Railway API 400: {"errors":[{"message":"Problem processing request","traceId":"7784396596033792361"}]}',
      'at async waitForDeployment (eval at callAsyncFunction, <anonymous>:83:18)',
    ].join('\n'));
    const t = await makeClient();

    const res = await t.call('hv_ci_status', { project: 'billforge', include: ['logs'], runId: 123 });

    expect(res.ok).toBe(true);
    expect(res.data.diagnostics).toContainEqual(expect.objectContaining({
      code: 'GITHUB_SCRIPT_NODE20_DEPRECATED',
      jobId: 99,
      jobName: 'deploy',
    }));
    expect(res.data.diagnostics).toContainEqual(expect.objectContaining({
      code: 'RAILWAY_DEPLOY_POLLING_GRAPHQL_400',
      jobId: 99,
      jobName: 'deploy',
    }));
    const railwayDiagnostic = res.data.diagnostics.find((entry: { code: string }) => entry.code === 'RAILWAY_DEPLOY_POLLING_GRAPHQL_400');
    expect(railwayDiagnostic.summary).toContain('serviceInstanceDeployV2');
    expect(railwayDiagnostic.next).toContainEqual(expect.stringContaining('hv_plan + hv_apply'));
    await t.close();
  });

  it('diagnoses Railway missing service instances from deploy workflow logs', async () => {
    seedProject();
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunJobs').mockResolvedValue({
      total_count: 1,
      jobs: [{
        id: 101,
        run_id: 456,
        name: 'deploy',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-07-04T18:16:30Z',
        completed_at: '2026-07-04T18:17:00Z',
        html_url: 'https://github.com/davejohnson/billforge/actions/runs/456/job/101',
        steps: [],
      }],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getWorkflowJobLogs').mockResolvedValue([
      'Railway GraphQL error during DeployServiceImage variables={"serviceId":"svc-web","environmentId":"env-staging"}: Service Instance not found',
      'Railway service svc-web has no service instance in environment env-staging. Re-run Hypervibe hv_plan/hv_apply.',
    ].join('\n'));
    const t = await makeClient();

    const res = await t.call('hv_ci_status', { project: 'billforge', include: ['logs'], runId: 456 });

    expect(res.ok).toBe(true);
    expect(res.data.diagnostics).toContainEqual(expect.objectContaining({
      code: 'RAILWAY_SERVICE_INSTANCE_MISSING',
      jobId: 101,
      jobName: 'deploy',
    }));
    const diagnostic = res.data.diagnostics.find((entry: { code: string }) => entry.code === 'RAILWAY_SERVICE_INSTANCE_MISSING');
    expect(diagnostic.summary).toContain('no service instance');
    expect(diagnostic.next).toContainEqual(expect.stringContaining('hv_plan'));
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
