import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from '../../../tools/__tests__/tool-result.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { resolveBranchDeployTargets, buildBranchDeployWorkflow } from '../github-ops.service.js';
import { SpecStore } from '../../spec/spec.store.js';

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
  return parseToolEnvelope(result) as unknown as JsonObj;
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
      {
        environmentName: 'production',
        kind: 'production',
        branch: 'release',
        serviceNames: [],
        providerProjectId: undefined,
        providerEnvironmentId: undefined,
        providerServiceIds: [],
      },
    ]);
    expect(migration.includeStep).toBe(true);
    expect(migration.command).toBe('npm run migrate');

    const workflow = buildBranchDeployWorkflow('railway', targets[0], migration);
    expect(workflow.template).toBe('deploy-railway-production');
    expect(workflow.branch).toBe('release');
    expect(workflow.environment).toBe('production');
    expect(workflow.requiredSecrets).toEqual(['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN', 'DATABASE_URL']);
    expect(workflow.requiredVariables).toEqual(['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_IDS']);
    expect(workflow.content).toContain('branches: [release]');
    expect(workflow.content).toContain('workflow_dispatch:');
    expect(workflow.content).toContain('environment: production');
    expect(workflow.content).toContain('run: npm run migrate');
    // Migrations need dependencies installed on the runner; the deploy steps
    // build a container image and never run npm ci themselves.
    expect(workflow.content.indexOf('npm ci')).toBeGreaterThan(-1);
    expect(workflow.content.indexOf('npm ci')).toBeLessThan(workflow.content.indexOf('run: npm run migrate'));
    expect(workflow.content).toContain('actions/setup-node@v4');
    expect(workflow.content).toContain('docker/build-push-action@v6');
    expect(workflow.content).toContain('packages: write');
    expect(workflow.content).toContain('username: ${{ github.actor }}');
    expect(workflow.content).toContain('password: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow.content).toContain('Verify Railway image pull credentials');
    expect(workflow.content).toContain('username: ${{ secrets.IMAGE_REGISTRY_USERNAME }}');
    expect(workflow.content).toContain('docker buildx imagetools inspect "${{ steps.image.outputs.uri }}"');
    expect(workflow.content).toContain('serviceInstanceUpdate');
    expect(workflow.content).toContain('IMAGE_REGISTRY_USERNAME: ${{ secrets.IMAGE_REGISTRY_USERNAME }}');
    expect(workflow.content).toContain('IMAGE_REGISTRY_TOKEN: ${{ secrets.IMAGE_REGISTRY_TOKEN }}');
    expect(workflow.content).toContain('username: process.env.IMAGE_REGISTRY_USERNAME');
    expect(workflow.content).toContain('password: process.env.IMAGE_REGISTRY_TOKEN');
    expect(workflow.content).toContain('const deploymentId = await railway(deployMutation');
    expect(workflow.content).toContain('query DeploymentStatus');
    expect(workflow.content).toContain('await waitForDeployment(deploymentId, serviceId)');
    expect(workflow.content).toContain('Recent Railway logs');
    expect(workflow.content).not.toContain('secrets.GHCR_USERNAME');
    expect(workflow.content).not.toContain('secrets.GHCR_TOKEN');
    expect(workflow.content).not.toContain('railway-github-action');
    expect(workflow.content).not.toContain('vars.MIGRATION_COMMAND');
  });

  it('embeds Railway environment and service ids from stored specs when available', () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const project = projectRepo.create({
      name: 'billforge',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/billforge',
    });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-env',
        services: {
          web: { serviceId: 'rail-web' },
          worker: { serviceId: 'rail-worker' },
        },
      },
    });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {}, worker: { workloadKind: 'worker' } },
          deploy: { strategy: 'branch', branch: 'main' },
        },
      },
    });

    const { targets } = resolveBranchDeployTargets(projectRepo.findById(project.id)!);
    expect(targets[0].providerEnvironmentId).toBe('rail-env');
    expect(targets[0].providerServiceIds).toEqual(['rail-web', 'rail-worker']);

    const workflow = buildBranchDeployWorkflow('railway', targets[0], { includeStep: false });
    expect(workflow.requiredVariables).toEqual([]);
    expect(workflow.content).toContain("RAILWAY_ENVIRONMENT_ID: 'rail-env'");
    expect(workflow.content).toContain("RAILWAY_SERVICE_IDS: 'rail-web,rail-worker'");
  });

  it('builds provider API branch deploy workflows without provider CLIs', () => {
    const baseTarget = {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      serviceNames: ['web'],
      providerProjectId: undefined,
      providerEnvironmentId: undefined,
      providerServiceIds: [],
    };

    const cloudRunWorkflow = buildBranchDeployWorkflow('cloudrun', {
      ...baseTarget,
      providerServiceIds: ['cloudrun-web'],
    }, { includeStep: false });
    expect(cloudRunWorkflow.requiredSecrets).toEqual(['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_REGION']);
    expect(cloudRunWorkflow.requiredVariables).toEqual([]);
    expect(cloudRunWorkflow.content).toContain("CLOUDRUN_SERVICE_NAMES: 'cloudrun-web'");
    expect(cloudRunWorkflow.content).toContain('https://run.googleapis.com/v2/projects/');
    expect(cloudRunWorkflow.content).toContain('docker/build-push-action@v6');

    const railwayWorkflow = buildBranchDeployWorkflow('railway', {
      ...baseTarget,
      providerServiceIds: ['srv-railway'],
      providerEnvironmentId: 'env-railway',
    }, { includeStep: false });
    expect(railwayWorkflow.requiredSecrets).toEqual(['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(railwayWorkflow.content).toContain('packages: write');

    const combinedContent = [
      cloudRunWorkflow.content,
      railwayWorkflow.content,
    ].join('\n');
    expect(combinedContent).not.toMatch(/railway-github-action|vercel deploy|doctl apps|gcloud |heroku container|heroku git/);
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
    const { registerHvCiTools } = await import('../../../tools/hv-ci.tools.js');
    const { createToolContext } = await import('../../../tools/context.js');
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
    const { registerHvCiTools } = await import('../../../tools/hv-ci.tools.js');
    const { createToolContext } = await import('../../../tools/context.js');
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
