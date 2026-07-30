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
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function extractGitHubScript(workflow: string, stepName: string): string {
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
  expect(stepStart).toBeGreaterThan(-1);
  const marker = '          script: |\n';
  const scriptStart = workflow.indexOf(marker, stepStart) + marker.length;
  const nextStep = workflow.indexOf('\n      - ', scriptStart);
  const nextJob = workflow.indexOf('\n\n  failure_evidence:', scriptStart);
  const boundaries = [nextStep, nextJob].filter((index) => index >= 0);
  const scriptEnd = boundaries.length === 0 ? workflow.length : Math.min(...boundaries);
  return workflow
    .slice(scriptStart, scriptEnd)
    .split('\n')
    .map((line) => line.startsWith('            ') ? line.slice(12) : line)
    .join('\n')
    .trimEnd();
}

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
    vi.useRealTimers();
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
    expect(workflow.review).toMatchObject({
      title: 'production deployment',
      summary: expect.stringContaining('Railway'),
      mergeEffect: expect.stringContaining('started manually'),
    });
    expect(workflow.review.details).toEqual(expect.arrayContaining([
      expect.stringContaining('full 40-character commit ID'),
      expect.stringContaining('Retries short-lived Railway'),
      expect.stringContaining('release record'),
      expect.stringContaining('failure details'),
    ]));
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
    expect(workflow.content).toContain('return status === 429 || (status >= 500 && status <= 599)');
    expect(workflow.content).toContain('async function railway(query, variables, options = {})');
    expect(workflow.content).toContain('Retrying Railway');
    expect(workflow.content).toContain("railway(deploymentQuery, { id: deploymentId }, { retryTransient: true })");
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

  it('retries transient Railway reads without replaying deploy mutations', async () => {
    vi.useFakeTimers();
    const target = {
      environmentName: 'staging',
      kind: 'staging' as const,
      branch: 'main',
      autoDeployOnPush: true,
      serviceNames: ['web'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-env',
      providerServiceIds: ['rail-web'],
      providerJobNames: [],
    };
    const generated = buildBranchDeployWorkflow('railway', target, { includeStep: false });
    const script = extractGitHubScript(generated.content, 'Deploy image to Railway');
    const response = (status: number, data: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(data),
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, {
        data: {
          service: {
            id: 'rail-web',
            serviceInstances: { edges: [{ node: { environmentId: 'rail-env' } }] },
          },
        },
      }))
      .mockResolvedValueOnce(response(200, { data: { serviceInstanceUpdate: true } }))
      .mockResolvedValueOnce(response(200, { data: { serviceInstanceDeployV2: 'deployment-1' } }))
      .mockResolvedValueOnce(response(503, { errors: [{ message: 'upstream connection termination' }] }))
      .mockResolvedValueOnce(response(200, {
        data: {
          deployment: {
            id: 'deployment-1',
            status: 'SUCCESS',
            diagnosis: null,
            meta: null,
          },
        },
      }));
    const core = { info: vi.fn(), warning: vi.fn() };
    const execute = new AsyncFunction('fetch', 'process', 'core', script);
    const execution = execute(fetch, {
      env: {
        RAILWAY_API_TOKEN: 'test-token',
        RAILWAY_ENVIRONMENT_ID: 'rail-env',
        RAILWAY_SERVICE_IDS: 'rail-web',
        IMAGE_REGISTRY_USERNAME: 'test-user',
        IMAGE_REGISTRY_TOKEN: 'test-registry-token',
        IMAGE_URI: 'ghcr.io/example/app:sha',
        DEPLOY_SHA: '0123456789abcdef0123456789abcdef01234567',
      },
    }, core);

    await vi.runAllTimersAsync();
    await expect(execution).resolves.toBeUndefined();
    const queries = fetch.mock.calls.map(([, request]) =>
      JSON.parse(String((request as { body: string }).body)).query as string
    );
    expect(queries.filter((query) => query.includes('UpdateServiceImage'))).toHaveLength(1);
    expect(queries.filter((query) => query.includes('DeployServiceImage'))).toHaveLength(1);
    expect(queries.filter((query) => query.includes('DeploymentStatus'))).toHaveLength(2);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Retrying Railway DeploymentStatus after API 503')
    );
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
    expect(combinedContent).not.toMatch(/railway-github-action|vercel deploy|doctl apps|gcloud /);
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

  it('emits server evidence and a gated iOS release workflow with separate provenance', () => {
    const workflow = buildBranchDeployWorkflow(
      'railway',
      {
        environmentName: 'development',
        kind: 'development',
        branch: 'develop',
        autoDeployOnPush: true,
        serviceNames: ['api'],
        providerServiceIds: ['service-1'],
      },
      { includeStep: false },
      {
        bundleId: 'com.example.app',
        platform: 'IOS',
        capabilities: [],
        testflight: { groups: { beta: { internal: false, testers: [] } } },
        release: {
          services: ['api'],
          trigger: 'after-server-deploy',
          build: {
            workingDirectory: 'apps/ios',
            command: 'bundle exec fastlane build',
            ipaPath: 'build/Example.ipa',
            requiredSecrets: ['MATCH_PASSWORD'],
          },
          testflight: {
            groups: ['beta'],
            usesNonExemptEncryption: false,
            submitForBetaReview: false,
            scriptPath: 'scripts/hypervibe-ios-release.mjs',
          },
        },
      }
    );

    expect(workflow.path).toBe('.github/workflows/deploy-railway-development.yml');
    expect(workflow.content).toContain('Write server release evidence');
    expect(workflow.content).toContain('hypervibe-server-release-development');
    expect(workflow.companionFiles?.map((file) => file.path)).toEqual([
      '.github/workflows/hypervibe-ios-release-development.yml',
    ]);
    const releaseWorkflow = workflow.companionFiles?.[0].content ?? '';
    expect(releaseWorkflow).toContain('Download verified server release evidence');
    expect(releaseWorkflow).toContain('server evidence repository/SHA mismatch');
    expect(releaseWorkflow).toContain('concurrency:');
    expect(releaseWorkflow).toContain('group: hypervibe-deploy-development');
    expect(releaseWorkflow).toContain("node-version: '20'");
    expect(releaseWorkflow).toContain('Run project-owned TestFlight release script');
    expect(releaseWorkflow).toContain('node "$HYPERVIBE_RELEASE_SCRIPT"');
    expect(releaseWorkflow).toContain('HYPERVIBE_RELEASE_SCRIPT: "scripts/hypervibe-ios-release.mjs"');
    expect(releaseWorkflow).not.toContain('xcrun altool --upload-app');
    const jobConfiguration = releaseWorkflow.slice(0, releaseWorkflow.indexOf('    steps:'));
    expect(jobConfiguration).not.toContain('APP_STORE_CONNECT_PRIVATE_KEY');
    expect(releaseWorkflow.indexOf('Build signed IPA'))
      .toBeLessThan(releaseWorkflow.indexOf('APP_STORE_CONNECT_PRIVATE_KEY:'));
    expect(workflow.requiredSecrets).toEqual(expect.arrayContaining([
      'APP_STORE_CONNECT_KEY_ID',
      'APP_STORE_CONNECT_ISSUER_ID',
      'APP_STORE_CONNECT_PRIVATE_KEY',
      'MATCH_PASSWORD',
    ]));
  });

});
