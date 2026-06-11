import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  new ConnectionRepository().create({
    provider: 'github',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gh-token' }),
  });
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
      const content = (result.content as Array<{ type: string; text: string }>)[0];
      return JSON.parse(content.text) as Record<string, any>;
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

    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'davejohnson' });
    const createFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false } as any);
    const protect = vi.spyOn(GitHubAdapter.prototype, 'updateBranchProtection').mockResolvedValue();
    const t = await makeClient();

    const res = await t.call('hv_ci_setup', { project: 'billforge', kind: 'deploy-branch', config: { provider: 'railway' } });
    expect(res.ok).toBe(true);
    expect(res.data.branchMapping).toEqual({ production: 'release' });
    expect(res.data.workflows).toEqual([
      expect.objectContaining({ template: 'deploy-railway-production', branch: 'release', path: '.github/workflows/deploy-railway-production.yml', created: true }),
    ]);
    expect(res.data.requiredSecrets).toContain('RAILWAY_TOKEN');
    expect(createFile).toHaveBeenCalledTimes(1);
    expect(protect).not.toHaveBeenCalled();
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

  it('requires workflow when runs are requested', async () => {
    seedProject();
    const t = await makeClient();
    const res = await t.call('hv_ci_status', { project: 'billforge', include: ['runs'] });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION');
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
