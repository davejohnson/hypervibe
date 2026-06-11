import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { resolveBranchDeployTargets, buildBranchDeployWorkflow } from '../github.tools.js';

type JsonObj = Record<string, unknown>;

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<JsonObj> {
  const result = await client.request(
    {
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    },
    CallToolResultSchema
  );
  const text = result.content.find((content) => content.type === 'text')?.text;
  if (!text) throw new Error(`Tool ${name} returned no text payload`);
  return JSON.parse(text) as JsonObj;
}

describe('github tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-github-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds only the production branch-deploy workflow using desired deploy state', () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();

    const project = projectRepo.create({
      name: 'billforge',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/billforge',
      policies: {
        desiredState: {
          environmentName: 'production',
          deploy: {
            strategy: 'branch',
            branches: {
              production: 'release',
            },
          },
          migrations: {
            mode: 'tool',
            runInDeploy: true,
            command: 'npm run migrate',
          },
        },
      },
    });

    envRepo.create({
      projectId: project.id,
      name: 'production',
    });

    const { targets, migration } = resolveBranchDeployTargets(projectRepo.findById(project.id)!);
    expect(targets).toEqual([
      { environmentName: 'production', kind: 'production', branch: 'release' },
    ]);
    expect(migration.includeStep).toBe(true);
    expect(migration.command).toBe('npm run migrate');

    const workflow = buildBranchDeployWorkflow('railway', targets[0], migration);
    expect(workflow.template).toBe('deploy-railway-production');
    expect(workflow.branch).toBe('release');
    expect(workflow.environment).toBe('production');
    expect(workflow.requiredSecrets).toEqual(['RAILWAY_TOKEN', 'DATABASE_URL']);
    expect(workflow.requiredVariables).toEqual([]);
    expect(workflow.content).toContain('branches: [release]');
    expect(workflow.content).toContain('environment: production');
    expect(workflow.content).toContain('run: npm run migrate');
    expect(workflow.content).not.toContain('vars.MIGRATION_COMMAND');
  });

  it('hv_ci_setup deploy-branch fails fast when the GitHub connection is invalid', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();

    const project = projectRepo.create({
      name: 'billforge',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/billforge',
    });
    envRepo.create({ projectId: project.id, name: 'production' });
    const connection = connectionRepo.create({
      provider: 'github',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'token' }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');

    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: false,
      error: 'GitHub API error: Bad credentials',
    });

    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerHvCiTools } = await import('../hv-ci.tools.js');
    const { createToolContext } = await import('../context.js');
    const server = new McpServer({ name: 'hv-ci-invalid-test', version: '1.0.0' });
    registerHvCiTools(server, createToolContext());
    const client = new Client({ name: 'hv-ci-invalid-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'hv_ci_setup', {
      project: 'billforge',
      kind: 'deploy-branch',
      config: { provider: 'railway' },
    });

    expect(payload.ok).toBe(false);
    expect((payload.error as JsonObj).message).toBe('GitHub API error: Bad credentials');

    await Promise.all([client.close(), server.close()]);
  });

  it('does not apply branch protection when workflow creation fails', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();

    const project = projectRepo.create({
      name: 'billforge',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/billforge',
    });

    envRepo.create({
      projectId: project.id,
      name: 'production',
    });

    const connection = connectionRepo.create({
      provider: 'github',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'token' }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');

    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'davejohnson' });
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockRejectedValue(
      new Error('GitHub API error: Could not create file: Changes must be made through a pull request.')
    );
    const updateBranchProtection = vi.spyOn(GitHubAdapter.prototype, 'updateBranchProtection').mockResolvedValue();

    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerHvCiTools } = await import('../hv-ci.tools.js');
    const { createToolContext } = await import('../context.js');
    const server = new McpServer({ name: 'hv-ci-protection-test', version: '1.0.0' });
    registerHvCiTools(server, createToolContext());
    const client = new Client({ name: 'github-client-protection-failure', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'hv_ci_setup', {
      project: 'billforge',
      kind: 'deploy-branch',
      config: { provider: 'railway', protectBranches: true },
    });

    expect(payload.ok).toBe(false);
    const details = (payload.error as JsonObj).details as JsonObj;
    expect(details.errors).toEqual([
      {
        template: 'deploy-railway-production',
        path: '.github/workflows/deploy-railway-production.yml',
        error: 'GitHub API error: Could not create file: Changes must be made through a pull request.',
      },
    ]);
    expect(updateBranchProtection).not.toHaveBeenCalled();
    expect(details.branchProtection).toEqual([]);

    await Promise.all([client.close(), server.close()]);
  });
});
