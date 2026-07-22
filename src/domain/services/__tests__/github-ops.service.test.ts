import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from '../../../tools/__tests__/tool-result.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
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
        autoDeployOnPush: false,
        promoteFromEnvironment: 'staging',
        serviceNames: [],
        providerProjectId: undefined,
        providerEnvironmentId: undefined,
        providerServiceIds: [],
        providerJobNames: [],
        needsServiceNames: true,
        needsJobNames: false,
      },
    ]);
    expect(migration.includeStep).toBe(true);
    expect(migration.command).toBe('npm run migrate');

    const workflow = buildBranchDeployWorkflow('railway', targets[0], migration);
    expect(workflow.template).toBe('deploy-railway-production');
    expect(workflow.branch).toBe('release');
    expect(workflow.autoDeployOnPush).toBe(false);
    expect(workflow.environment).toBe('production');
    expect(workflow.requiredSecrets).toEqual(['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN', 'DATABASE_URL']);
    expect(workflow.requiredVariables).toEqual(['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_IDS']);
    expect(workflow.content).not.toContain('  push:\n    branches:');
    expect(workflow.content).toContain('workflow_dispatch:');
    expect(workflow.content).toContain('commit_sha:');
    expect(workflow.content).toContain('environment: production');
    expect(workflow.content).toContain('ref: ${{ steps.deploy.outputs.sha }}');
    expect(workflow.content).toContain('name: "Deployment safety gate: verify Hypervibe reconciliation"');
    expect(workflow.content).toContain('HYPERVIBE_APPLIED_SPEC_HASH: ${{ vars.HYPERVIBE_APPLIED_SPEC_HASH }}');
    expect(workflow.content).toContain('HYPERVIBE_DEPLOY_SHA: ${{ steps.deploy.outputs.sha }}');
    expect(workflow.content).toContain("readFileSync('.hypervibe/spec.json', 'utf8')");
    expect(workflow.content).toContain('Deployment blocked — Hypervibe reconciliation required');
    expect(workflow.content).toContain('This is not an application build or test failure. No image was built and nothing was deployed.');
    expect(workflow.content).toContain('group: hypervibe-deploy-production');
    expect(workflow.content).toContain('cancel-in-progress: false');
    expect(workflow.content).toContain('run: npm run migrate');
    // Migrations need dependencies installed on the runner; the deploy steps
    // build a container image and never run npm ci themselves.
    expect(workflow.content.indexOf('npm ci')).toBeGreaterThan(-1);
    expect(workflow.content.indexOf('npm ci')).toBeLessThan(workflow.content.indexOf('run: npm run migrate'));
    expect(workflow.content.indexOf('Deployment safety gate: verify Hypervibe reconciliation'))
      .toBeLessThan(workflow.content.indexOf('npm ci'));
    expect(workflow.content).toContain('actions/setup-node@v4');
    expect(workflow.content).toContain('docker/build-push-action@v6');
    expect(workflow.content).toContain('if [ -f .npmrc ]; then');
    expect(workflow.content).toContain('COPY package*.json .npmrc ./');
    expect(workflow.content).toContain('RUN --mount=type=secret,id=npm_token');
    expect(workflow.content).toContain('npm_token=${{ secrets.NODE_AUTH_TOKEN }}');
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
    expect(workflow.content).toContain('DEPLOY_SHA: ${{ steps.deploy.outputs.sha }}');
    expect(workflow.content).toContain('uses: actions/github-script@v8');
    expect(workflow.content).toContain('Railway API \' + response.status + \' during \' + operation');
    expect(workflow.content).toContain('traceId=');
    expect(workflow.content).toContain('const deploymentData = await railway(deployMutation');
    expect(workflow.content).toContain('const deploymentId = requireString(deploymentData.serviceInstanceDeployV2');
    expect(workflow.content).toContain('query DeploymentStatus');
    expect(workflow.content).toContain('await waitForDeployment(deploymentId, serviceId)');
    expect(workflow.content).toContain('Recent Railway logs');
    expect(workflow.content).not.toContain('secrets.GHCR_USERNAME');
    expect(workflow.content).not.toContain('secrets.GHCR_TOKEN');
    expect(workflow.content).not.toContain('railway-github-action');
    expect(workflow.content).not.toContain('vars.MIGRATION_COMMAND');
  });

  it('defaults to main auto-deploy for staging and manual main promotion for production', () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const project = projectRepo.create({
      name: 'billforge',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/billforge',
    });
    envRepo.create({ projectId: project.id, name: 'staging' });
    envRepo.create({ projectId: project.id, name: 'production' });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          deploy: { strategy: 'branch', trigger: 'ci' },
        },
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          deploy: { strategy: 'branch', trigger: 'ci' },
        },
      },
    });

    const { targets } = resolveBranchDeployTargets(projectRepo.findById(project.id)!);
    expect(targets.map((target) => ({
      env: target.environmentName,
      branch: target.branch,
      autoDeployOnPush: target.autoDeployOnPush,
      promoteFromEnvironment: target.promoteFromEnvironment,
    }))).toEqual([
      { env: 'staging', branch: 'main', autoDeployOnPush: true, promoteFromEnvironment: undefined },
      { env: 'production', branch: 'main', autoDeployOnPush: false, promoteFromEnvironment: 'staging' },
    ]);

    const stagingWorkflow = buildBranchDeployWorkflow('railway', targets[0], { includeStep: false });
    expect(stagingWorkflow.content).toContain('push:');
    expect(stagingWorkflow.content).toContain('branches: [main]');
    expect(stagingWorkflow.content).toContain('workflow_dispatch:');
    expect(stagingWorkflow.content).toContain('commit_sha:');

    const productionWorkflow = buildBranchDeployWorkflow('railway', targets[1], { includeStep: false });
    expect(productionWorkflow.content).not.toContain('  push:\n    branches:');
    expect(productionWorkflow.content).toContain('workflow_dispatch:');
    expect(productionWorkflow.content).toContain('commit_sha:');
    expect(productionWorkflow.content).toContain('ref: ${{ steps.deploy.outputs.sha }}');
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

  it('excludes stale provider bindings for services removed from the spec', () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const project = projectRepo.create({
      name: 'billforge-pruned-worker',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/billforge-pruned-worker',
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
          worker: { serviceId: 'rail-stale-worker' },
        },
      },
    });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });

    const { targets } = resolveBranchDeployTargets(projectRepo.findById(project.id)!);
    expect(targets[0].providerServiceIds).toEqual(['rail-web']);

    const workflow = buildBranchDeployWorkflow('railway', targets[0], { includeStep: false });
    expect(workflow.content).toContain("RAILWAY_SERVICE_IDS: 'rail-web'");
    expect(workflow.content).not.toContain('rail-stale-worker');
  });

  it('builds provider API branch deploy workflows without provider CLIs', () => {
    const baseTarget = {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      autoDeployOnPush: false,
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
    expect(cloudRunWorkflow.content).toContain("CLOUDRUN_JOB_NAMES: ''");
    expect(cloudRunWorkflow.content).toContain('https://run.googleapis.com/v2/projects/');
    expect(cloudRunWorkflow.content).toContain('docker/build-push-action@v6');
    expect(cloudRunWorkflow.content).toContain('await waitOperation(operation, \'service \' + serviceName + \' deployment\')');
    expect(cloudRunWorkflow.content).toContain('await waitReady(url, serviceName, \'service\')');

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

  it('separates Cloud Run service and scheduled job deploy targets', () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const project = projectRepo.create({
      name: 'cloudapp',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'https://github.com/davejohnson/cloudapp',
    });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
          daily: { serviceId: 'gcp-project-daily-schedule', jobName: 'gcp-project-daily', resourceType: 'scheduledJob' },
        },
      },
    });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'cloudrun' },
          services: {
            web: { workloadKind: 'web' },
            daily: { workloadKind: 'cron', cronSchedule: '0 8 * * *' },
          },
          deploy: { strategy: 'branch', branch: 'main' },
        },
      },
    });

    const { targets } = resolveBranchDeployTargets(projectRepo.findById(project.id)!);
    expect(targets[0]).toMatchObject({
      providerServiceIds: ['gcp-project-web'],
      providerJobNames: ['gcp-project-daily'],
      needsServiceNames: true,
      needsJobNames: true,
    });

    const workflow = buildBranchDeployWorkflow('cloudrun', targets[0], { includeStep: false });
    expect(workflow.requiredVariables).toEqual([]);
    expect(workflow.content).toContain("CLOUDRUN_SERVICE_NAMES: 'gcp-project-web'");
    expect(workflow.content).toContain("CLOUDRUN_JOB_NAMES: 'gcp-project-daily'");
    expect(workflow.content).toContain('/jobs/\' + encodeURIComponent(jobName)');
    expect(workflow.content).toContain('await waitOperation(operation, \'job \' + jobName + \' deployment\')');
    expect(workflow.content).toContain('await waitReady(url, jobName, \'job\')');
    expect(workflow.content).not.toContain("CLOUDRUN_SERVICE_NAMES: 'gcp-project-web,gcp-project-daily-schedule'");
  });

  it('never requires a repo Dockerfile: both providers generate one for Node apps', () => {
    const baseTarget = {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: undefined,
      providerEnvironmentId: 'env-1',
      providerServiceIds: ['srv-1'],
      webStartCommand: 'npm run serve',
    };
    for (const provider of ['railway', 'cloudrun'] as const) {
      const workflow = buildBranchDeployWorkflow(provider, baseTarget, { includeStep: false });
      expect(workflow.content).toContain('name: Resolve Dockerfile');
      expect(workflow.content).toContain('file: ${{ steps.dockerfile.outputs.path }}');
      // Repo Dockerfile wins; otherwise a minimal Node image is generated
      // with the web service start command as CMD.
      expect(workflow.content).toContain('if [ -f Dockerfile ]; then');
      expect(workflow.content).toContain('FROM node:20-slim');
      expect(workflow.content).toContain('if [ -f .npmrc ]; then');
      expect(workflow.content).toContain('RUN --mount=type=secret,id=npm_token');
      expect(workflow.content).toContain('npm_token=${{ secrets.NODE_AUTH_TOKEN }}');
      expect(workflow.content).toContain('CMD ["sh", "-lc", "npm run serve"]');
      // The generated Dockerfile step precedes the image build.
      expect(workflow.content.indexOf('Resolve Dockerfile')).toBeLessThan(workflow.content.indexOf('docker/build-push-action@v6'));
    }
    const defaulted = buildBranchDeployWorkflow('railway', { ...baseTarget, webStartCommand: undefined }, { includeStep: false });
    expect(defaulted.content).toContain('CMD ["sh", "-lc", "npm start"]');
  });

});
