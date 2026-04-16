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

  it('deploy_branch_setup previews only the production workflow for a production-only project and uses desired deploy state', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();

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

    const connection = connectionRepo.create({
      provider: 'github',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'token' }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');

    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'davejohnson' });

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'github-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'deploy_branch_setup', {
      owner: 'davejohnson',
      repo: 'billforge',
      provider: 'railway',
      requiredReviewers: 1,
    });

    expect(payload.success).toBe(true);
    expect(payload.mode).toBe('preview');
    expect(payload.project).toBe('billforge');
    expect(payload.branchMapping).toEqual({ production: 'release' });
    expect(payload.requiredSecrets).toEqual(['RAILWAY_TOKEN', 'DATABASE_URL']);
    expect(payload.requiredVariables).toEqual([]);

    const workflows = payload.workflows as Array<Record<string, unknown>>;
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.template).toBe('deploy-railway-production');
    expect(workflows[0]?.branch).toBe('release');
    expect(workflows[0]?.environment).toBe('production');
    expect(typeof workflows[0]?.content).toBe('string');
    expect((workflows[0]?.content as string)).toContain('branches: [release]');
    expect((workflows[0]?.content as string)).toContain('environment: production');
    expect((workflows[0]?.content as string)).toContain('run: npm run migrate');
    expect((workflows[0]?.content as string)).not.toContain('vars.MIGRATION_COMMAND');

    expect(payload.branchProtection).toBeNull();

    const notes = payload.notes as string[];
    expect(notes).toContain('Set secret DATABASE_URL in GitHub Environment "production" for the migration step.');
    expect(notes.join(' ')).not.toContain('MIGRATION_COMMAND');

    await Promise.all([client.close(), server.close()]);
  });

  it('deploy_branch_setup fails fast when the GitHub connection is invalid', async () => {
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

    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: false,
      error: 'GitHub API error: Bad credentials',
    });

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'github-client-invalid', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'deploy_branch_setup', {
      owner: 'davejohnson',
      repo: 'billforge',
      provider: 'railway',
    });

    expect(payload.success).toBe(false);
    expect(payload.error).toBe('GitHub API error: Bad credentials');

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

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'github-client-protection-failure', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'deploy_branch_setup', {
      owner: 'davejohnson',
      repo: 'billforge',
      provider: 'railway',
      protectBranches: true,
      confirm: true,
    });

    expect(payload.success).toBe(false);
    expect(payload.errors).toEqual([
      {
        template: 'deploy-railway-production',
        path: '.github/workflows/deploy-railway-production.yml',
        error: 'GitHub API error: Could not create file: Changes must be made through a pull request.',
      },
    ]);
    expect(updateBranchProtection).not.toHaveBeenCalled();
    expect(payload.branchProtection).toEqual({
      enabled: false,
      results: [],
      rules: {
        requireReviews: true,
        requiredReviewers: 1,
        dismissStaleReviews: true,
        requireCodeOwnerReviews: false,
        requireStatusChecks: false,
        statusChecks: [],
        strictStatusChecks: true,
        enforceAdmins: true,
        requireLinearHistory: false,
        allowForcePushes: false,
        allowDeletions: false,
      },
    });

    await Promise.all([client.close(), server.close()]);
  });
});
