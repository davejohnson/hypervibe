import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'crypto';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { resolveBranchDeployTargets, buildBranchDeployWorkflow } from '../github-ops.service.js';
import { resolveReviewedBranchDeployTargets } from '../managed-ci-targets.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import { managedCiReleaseTarget } from '../managed-ci-targets.js';
import { cloudRunContainerBuildStartCommand } from '../../../adapters/providers/gcp/cloudrun-ci.release-runtime.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';

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

  it('generates a shared Railway image for distinct web, worker and cron commands', () => {
    const project = new ProjectRepository().create({ name: 'multi-service', defaultPlatform: 'railway' });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          services: {
            worker: { workloadKind: 'worker', startCommand: 'npm run worker' },
            web: { workloadKind: 'web', startCommand: 'npm start', public: true },
            cron: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 8 * * *' },
          },
        },
      },
    });
    const { targets, migration } = resolveReviewedBranchDeployTargets(project, spec);
    const workflow = buildBranchDeployWorkflow('railway', targets[0]!, migration);
    expect(workflow.content).toContain('FROM node:24-slim');
    expect(workflow.content).toContain('CMD ["sh", "-lc", "npm start"]');
    expect(workflow.content).not.toContain('requires an explicit service startCommand');
    // Execute the emitted shell branch without Docker or provider access.
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
    const step = workflow.content.split('      - name: Resolve Dockerfile\n')[1]!
      .split('      - uses: docker/setup-buildx-action')[0]!;
    const script = step.split('        run: |\n')[1]!
      .split('\n').map((line) => line.replace(/^          /, '')).join('\n');
    execFileSync('sh', ['-eu', '-c', script], {
      cwd: tempDir,
      env: { ...process.env, GITHUB_OUTPUT: path.join(tempDir, 'outputs') },
    });
    const dockerfile = fs.readFileSync(path.join(tempDir, 'Dockerfile.hypervibe'), 'utf8');
    expect(dockerfile).toContain('FROM node:24-slim');
    expect(dockerfile).toContain('CMD ["sh", "-lc", "npm start"]');
    expect(spec.environments.staging!.services.worker!.startCommand).toBe('npm run worker');
    expect(spec.environments.staging!.services.cron!.startCommand).toBe('npm run cron');
  });

  it.each([
    ['missing worker command', {
      web: { workloadKind: 'web', startCommand: 'npm start' },
      worker: { workloadKind: 'worker' },
    }, undefined],
    ['missing web command', {
      web: { workloadKind: 'web' },
      worker: { workloadKind: 'worker', startCommand: 'npm run worker' },
    }, undefined],
    ['conflicting web commands', {
      web: { workloadKind: 'web', startCommand: 'npm start' },
      api: { workloadKind: 'web', startCommand: 'npm run api' },
    }, undefined],
    ['common worker commands', {
      first: { workloadKind: 'worker', startCommand: ' npm run worker ' },
      second: { workloadKind: 'worker', startCommand: 'npm run worker' },
    }, 'npm run worker'],
    ['conflicting worker commands', {
      first: { workloadKind: 'worker', startCommand: 'npm run first' },
      second: { workloadKind: 'worker', startCommand: 'npm run second' },
    }, undefined],
  ])('preserves explicit command requirements for %s', (_name, services, expected) => {
    const project = new ProjectRepository().create({ name: 'command-selection', defaultPlatform: 'railway' });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          services,
        },
      },
    });
    const { targets } = resolveReviewedBranchDeployTargets(project, spec);
    expect(targets[0]!.containerStartCommand).toBe(expected);
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

    const workflow = buildBranchDeployWorkflow('railway', {
      ...targets[0],
      containerStartCommand: 'npm start',
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
    }, migration);
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
    expect(workflow.content).toContain('rollback:');
    expect(workflow.content).toContain('expected_latest_run_id:');
    expect(workflow.content).toContain("core.setOutput('operation', operation)");
    expect(workflow.content).toContain('name: Verify rollback release evidence');
    expect(workflow.content).toContain("if: steps.deploy.outputs.operation == 'rollback'");
    expect(workflow.content).toContain('listWorkflowRunArtifacts');
    expect(workflow.content).toContain('Rollback dispatch is stale');
    expect(workflow.content).toContain('run.data.path !== workflowPath');
    expect(workflow.content).toContain('actions: read');
    expect(workflow.content).toContain('environment: production');
    expect(workflow.content).toContain('ref: ${{ steps.deploy.outputs.sha }}');
    expect(workflow.content).toContain('persist-credentials: false');
    expect(workflow.content).toContain('name: "Deployment safety gate: verify Hypervibe reconciliation"');
    expect(workflow.content).toContain('HYPERVIBE_APPLIED_SPEC_HASH: ${{ vars.HYPERVIBE_APPLIED_SPEC_HASH }}');
    expect(workflow.content).toContain('HYPERVIBE_DEPLOY_SHA: ${{ steps.deploy.outputs.sha }}');
    expect(workflow.content).toContain("readFileSync('.hypervibe/spec.json', 'utf8')");
    expect(workflow.content).toContain('Deployment blocked — Hypervibe reconciliation required');
    expect(workflow.content).toContain('This is not an application build or test failure. No image was built and nothing was deployed.');
    expect(workflow.content).toContain('group: hypervibe-deploy-production');
    expect(workflow.content).toContain('cancel-in-progress: false');
    expect(workflow.content).toContain('run: npm run migrate');
    expect(workflow.content).toContain("if: steps.deploy.outputs.operation != 'rollback'");
    // Migrations need dependencies installed on the runner; the deploy steps
    // build a container image and never run npm ci themselves.
    expect(workflow.content.indexOf('npm ci')).toBeGreaterThan(-1);
    expect(workflow.content.indexOf('npm ci')).toBeLessThan(workflow.content.indexOf('run: npm run migrate'));
    expect(workflow.content.indexOf('Deployment safety gate: verify Hypervibe reconciliation'))
      .toBeLessThan(workflow.content.indexOf('npm ci'));
    expect(workflow.content).toContain('actions/setup-node@v6');
    expect(workflow.content).toContain('docker/build-push-action@v6');
    expect(workflow.content).toContain('COPY . .');
    expect(workflow.content).toContain('RUN --mount=type=secret,id=npm_token,required=false');
    expect(workflow.content).toContain('npm_token=${{ secrets.NODE_AUTH_TOKEN }}');
    expect(workflow.content).toContain('packages: write');
    expect(workflow.content).toContain('username: ${{ github.actor }}');
    expect(workflow.content).toContain('password: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow.content).toContain('Verify Railway image pull credentials');
    expect(workflow.content).toContain('username: ${{ secrets.IMAGE_REGISTRY_USERNAME }}');
    expect(workflow.content).toContain("docker buildx imagetools inspect \"${{ steps.deploy.outputs.operation == 'rollback' && steps.rollback_evidence.outputs.image_uri || steps.promotion_release.outputs.image_uri || steps.release_image.outputs.image_uri }}\"");
    expect(workflow.content).toContain('serviceInstanceUpdate');
    expect(workflow.content).toContain('IMAGE_REGISTRY_USERNAME: ${{ secrets.IMAGE_REGISTRY_USERNAME }}');
    expect(workflow.content).toContain('IMAGE_REGISTRY_TOKEN: ${{ secrets.IMAGE_REGISTRY_TOKEN }}');
    expect(workflow.content).toContain('username: process.env.IMAGE_REGISTRY_USERNAME');
    expect(workflow.content).toContain('password: process.env.IMAGE_REGISTRY_TOKEN');
    expect(workflow.content).toContain('DEPLOY_SHA: ${{ steps.deploy.outputs.sha }}');
    expect(workflow.content).toContain('uses: actions/github-script@v9');
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
    expect(workflow.content).toContain('retention-days: 90');
  });

  it('uses a real bound staging environment as legacy cross-provider promotion evidence', () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const project = projectRepo.create({
      name: 'legacy-cross-provider',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/legacy-cross-provider',
      policies: {
        desiredState: {
          services: ['web'],
          deploy: {
            strategy: 'branch',
            branches: { staging: 'main', production: 'main' },
          },
        },
      },
    });
    envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'staging-web' } },
      },
    });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-production',
        services: { web: { serviceId: 'production-web' } },
      },
    });

    const { targets } = resolveBranchDeployTargets(projectRepo.findById(project.id)!);
    const staging = targets.find((target) => target.environmentName === 'staging')!;
    const production = targets.find((target) => target.environmentName === 'production')!;

    expect(staging.programFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(production).toMatchObject({
      promoteFromEnvironment: 'staging',
      promoteFromProvider: 'cloudrun',
      promoteFromServiceNames: ['web'],
      promoteFromProgramFingerprint: staging.programFingerprint,
    });

    const workflow = buildBranchDeployWorkflow('railway', production, { includeStep: false });
    expect(workflow.content).toContain(
      'HYPERVIBE_PROMOTE_FROM_WORKFLOW: ".github/workflows/deploy-cloudrun-staging.yml"'
    );
  });

  it('restores a verified Railway image digest without rebuilding the target SHA', () => {
    const target: BranchDeployTarget = {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-env',
      providerServiceIds: ['rail-web'],
      providerJobNames: [],
      runtime: { kind: 'node' as const, version: '24', installCommand: 'npm ci' },
    };
    const content = buildBranchDeployWorkflow(
      'railway',
      target,
      { includeStep: true, command: 'npm run migrate' }
    ).content;
    const checkoutStep = content.slice(
      content.indexOf('      - uses: actions/checkout@v7'),
      content.indexOf('\n      - ', content.indexOf('      - uses: actions/checkout@v7') + 1)
    );
    const buildAction = content.indexOf('uses: docker/build-push-action@v6');
    const buildStep = content.slice(
      content.lastIndexOf('      - ', buildAction),
      content.indexOf('\n      - ', buildAction)
    );

    expect(content).toContain('name: Download rollback release evidence');
    expect(content).toContain('id: rollback_evidence');
    expect(content).toContain('evidence.target.resources');
    expect(checkoutStep).toContain("if: steps.deploy.outputs.operation != 'rollback'");
    expect(checkoutStep).toContain('persist-credentials: false');
    expect(buildStep).toContain("if: steps.deploy.outputs.operation != 'rollback'");
    expect(content).toContain(
      "IMAGE_URI: ${{ steps.deploy.outputs.operation == 'rollback' && steps.rollback_evidence.outputs.image_uri || steps.promotion_release.outputs.image_uri || steps.release_image.outputs.image_uri }}"
    );
    expect(content).toContain('imageUri: imageUri || null');
  });

  it('resolves the exact rollback image from downloaded release evidence', async () => {
    const targetSha = '0123456789abcdef0123456789abcdef01234567';
    const imageUri = `ghcr.io/dave/app@sha256:${'a'.repeat(64)}`;
    const target: BranchDeployTarget = {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-env',
      providerServiceIds: ['rail-web'],
      providerJobNames: [],
      programFingerprint: 'c'.repeat(64),
    };
    const releaseTarget = managedCiReleaseTarget({
      provider: 'railway',
      environmentName: 'production',
      scope: { providerProjectId: 'rail-project', providerEnvironmentId: 'rail-env' },
      resources: [{
        logicalName: 'web',
        workloadKind: 'web',
        providerResourceType: 'service',
        providerResourceId: 'rail-web',
      }],
    });
    target.releaseTarget = releaseTarget;
    const content = buildBranchDeployWorkflow('railway', target, { includeStep: false }).content;
    const script = extractGitHubScript(content, 'Resolve immutable rollback image');
    const evidencePath = path.join(tempDir, 'hypervibe-server-release.json');
    const evidence = {
      version: 3,
      provider: 'railway',
      environment: 'production',
      source: { repository: 'dave/app', sha: targetSha },
      target: {
        scope: releaseTarget.scope,
        bindingsFingerprint: releaseTarget.bindingsFingerprint,
        resources: releaseTarget.resources.map((resource) => ({ ...resource, imageUri })),
      },
      programFingerprint: 'c'.repeat(64),
      verifiedAt: '2026-09-10T12:00:00.000Z',
    };
    const core = { setOutput: vi.fn(), info: vi.fn() };
    const execute = new AsyncFunction('require', 'process', 'core', script);

    const validate = (candidate: unknown) => {
      fs.writeFileSync(evidencePath, JSON.stringify(candidate));
      return execute(
        (moduleName: string) => {
          if (moduleName === 'fs') return { readFileSync: fs.readFileSync };
          if (moduleName === 'crypto') return { createHash };
          throw new Error(`Unexpected module request: ${moduleName}`);
        },
        {
          env: {
            HYPERVIBE_RELEASE_EVIDENCE_PATH: evidencePath,
            HYPERVIBE_ROLLBACK_PROVIDER: 'railway',
            HYPERVIBE_ROLLBACK_ENVIRONMENT: 'production',
            HYPERVIBE_ROLLBACK_SHA: targetSha,
            HYPERVIBE_ROLLBACK_SERVICES: JSON.stringify(['web']),
            HYPERVIBE_ROLLBACK_TARGET_SCOPE: JSON.stringify(releaseTarget.scope),
            HYPERVIBE_ROLLBACK_RESOURCES: JSON.stringify(releaseTarget.resources),
            HYPERVIBE_ROLLBACK_BINDINGS_FINGERPRINT: releaseTarget.bindingsFingerprint,
            HYPERVIBE_ROLLBACK_PROGRAM_FINGERPRINT: 'c'.repeat(64),
            GITHUB_REPOSITORY: 'dave/app',
          },
        },
        core
      );
    };

    await expect(validate(evidence)).resolves.toBeUndefined();

    expect(core.setOutput).toHaveBeenCalledWith('image_uri', imageUri);
    expect(core.info).toHaveBeenCalledWith(`Resolved immutable rollback image ${imageUri}`);

    await expect(validate({
      ...evidence,
      target: { ...evidence.target, resources: [] },
    })).rejects.toThrow(/Rollback release evidence/);
    await expect(validate({
      ...evidence,
      target: { ...evidence.target, bindingsFingerprint: 'f'.repeat(64) },
    })).rejects.toThrow(/Rollback release evidence/);
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

  it('verifies exact rollback release evidence before deployment', async () => {
    const targetSha = '0123456789abcdef0123456789abcdef01234567';
    const target = {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-env',
      providerServiceIds: ['rail-web'],
      providerJobNames: [],
    };
    const generated = buildBranchDeployWorkflow('railway', target, { includeStep: false });
    const script = extractGitHubScript(generated.content, 'Verify rollback release evidence');
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: { workflow_runs: [{ id: 900 }, { id: 99 }] },
    });
    const listWorkflowRunArtifacts = vi.fn();
    const getWorkflowRun = vi.fn().mockResolvedValue({
      data: {
        id: 42,
        conclusion: 'success',
        path: '.github/workflows/deploy-railway-production.yml',
      },
    });
    const paginate = vi.fn().mockResolvedValue([{
      id: 7,
      name: `hypervibe-server-release-production-${targetSha}`,
      expired: false,
      workflow_run: { id: 42 },
    }]);
    const github = {
      paginate,
      rest: { actions: { listWorkflowRuns, listWorkflowRunArtifacts, getWorkflowRun } },
    };
    const core = { info: vi.fn() };
    const execute = new AsyncFunction('github', 'context', 'process', 'core', script);

    await expect(execute(
      github,
      { repo: { owner: 'dave', repo: 'app' }, runId: 900 },
      {
        env: {
          HYPERVIBE_ENVIRONMENT: 'production',
          HYPERVIBE_ROLLBACK_SHA: targetSha,
          HYPERVIBE_WORKFLOW_REF: 'dave/app/.github/workflows/deploy-railway-production.yml@refs/heads/main',
          HYPERVIBE_EXPECTED_LATEST_RUN_ID: '99',
          HYPERVIBE_SOURCE_ARTIFACT_ID: '7',
          HYPERVIBE_SOURCE_WORKFLOW_RUN_ID: '42',
        },
      },
      core
    )).resolves.toBeUndefined();

    expect(listWorkflowRuns).toHaveBeenCalledWith({
      owner: 'dave',
      repo: 'app',
      workflow_id: '.github/workflows/deploy-railway-production.yml',
      per_page: 10,
    });
    expect(paginate).toHaveBeenCalledWith(listWorkflowRunArtifacts, {
      owner: 'dave',
      repo: 'app',
      run_id: 42,
      per_page: 100,
    });
    expect(getWorkflowRun).toHaveBeenCalledWith({ owner: 'dave', repo: 'app', run_id: 42 });
    expect(core.info).toHaveBeenCalledWith('Verified rollback evidence from successful workflow run 42');
  });

  it('rejects a stale rollback dispatch before reading release artifacts', async () => {
    const targetSha = '0123456789abcdef0123456789abcdef01234567';
    const target = {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-env',
      providerServiceIds: ['rail-web'],
      providerJobNames: [],
    };
    const generated = buildBranchDeployWorkflow('railway', target, { includeStep: false });
    const script = extractGitHubScript(generated.content, 'Verify rollback release evidence');
    const listWorkflowRunArtifacts = vi.fn();
    const paginate = vi.fn();
    const github = {
      paginate,
      rest: {
        actions: {
          listWorkflowRuns: vi.fn().mockResolvedValue({
            data: { workflow_runs: [{ id: 900 }, { id: 100 }, { id: 99 }] },
          }),
          listWorkflowRunArtifacts,
          getWorkflowRun: vi.fn(),
        },
      },
    };
    const execute = new AsyncFunction('github', 'context', 'process', 'core', script);

    await expect(execute(
      github,
      { repo: { owner: 'dave', repo: 'app' }, runId: 900 },
      {
        env: {
          HYPERVIBE_ENVIRONMENT: 'production',
          HYPERVIBE_ROLLBACK_SHA: targetSha,
          HYPERVIBE_WORKFLOW_REF: 'dave/app/.github/workflows/deploy-railway-production.yml@refs/heads/main',
          HYPERVIBE_EXPECTED_LATEST_RUN_ID: '99',
          HYPERVIBE_SOURCE_ARTIFACT_ID: '7',
          HYPERVIBE_SOURCE_WORKFLOW_RUN_ID: '42',
        },
      },
      { info: vi.fn() }
    )).rejects.toThrow('Rollback dispatch is stale: expected latest run 99, observed 100');
    expect(paginate).not.toHaveBeenCalled();
    expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
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
      runtime: { kind: 'node', version: '24' },
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
      runtime: target.runtime,
    }))).toEqual([
      { env: 'staging', branch: 'main', autoDeployOnPush: true, promoteFromEnvironment: undefined, runtime: { kind: 'node', version: '24' } },
      { env: 'production', branch: 'main', autoDeployOnPush: false, promoteFromEnvironment: 'staging', runtime: { kind: 'node', version: '24' } },
    ]);

    const stagingWorkflow = buildBranchDeployWorkflow('railway', targets[0], { includeStep: false });
    expect(stagingWorkflow.content).toContain('push:');
    expect(stagingWorkflow.content).toContain('branches: [main]');
    expect(stagingWorkflow.content).toContain(
      "if: github.event_name != 'push' || vars.HYPERVIBE_APPLIED_SPEC_HASH != ''"
    );
    expect(stagingWorkflow.content).toContain('workflow_dispatch:');
    expect(stagingWorkflow.content).toContain('commit_sha:');

    const productionWorkflow = buildBranchDeployWorkflow('railway', targets[1], { includeStep: false });
    expect(productionWorkflow.content).not.toContain('  push:\n    branches:');
    expect(productionWorkflow.content).not.toContain(
      "if: github.event_name != 'push' || vars.HYPERVIBE_APPLIED_SPEC_HASH != ''"
    );
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
      providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      providerRegion: 'us-west1',
    }, { includeStep: false });
    expect(cloudRunWorkflow.requiredSecrets).toEqual(['GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID']);
    expect(cloudRunWorkflow.requiredVariables).toEqual([]);
    expect(cloudRunWorkflow.content).toContain('GCP_REGION: "us-west1"');
    expect(cloudRunWorkflow.content).toContain('GCP_BOUND_PROJECT_ID: "gcp-project"');
    expect(cloudRunWorkflow.content).toContain('process.env.GCP_PROJECT_ID !== process.env.GCP_BOUND_PROJECT_ID');
    expect(cloudRunWorkflow.content).not.toContain('secrets.GCP_REGION');
    expect(cloudRunWorkflow.content).toContain("CLOUDRUN_SERVICE_NAMES: 'cloudrun-web'");
    expect(cloudRunWorkflow.content).toContain("CLOUDRUN_JOB_NAMES: ''");
    expect(cloudRunWorkflow.content).toContain('https://run.googleapis.com/v2/projects/');
    expect(cloudRunWorkflow.content).toContain('docker/build-push-action@v6');
    expect(cloudRunWorkflow.content).toContain(
      'Artifact Registry repository is not bound; run Hypervibe plan and apply before CI deployment'
    );
    expect(cloudRunWorkflow.content).not.toContain("base + '?repositoryId='");
    expect(cloudRunWorkflow.content).toContain('await waitOperation(operation, \'service \' + serviceName + \' deployment\')');
    expect(cloudRunWorkflow.content).toContain("await waitReady(url, serviceName, 'service', process.env.IMAGE_URI, runtimeResource)");

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

    expect(() => buildBranchDeployWorkflow('cloudrun', {
      ...baseTarget,
      providerScope: { projectId: 'gcp-project' },
      providerEnvironmentId: 'not-a-region',
      providerServiceIds: ['cloudrun-web'],
    }, { includeStep: false })).toThrow('has no bound provider project or region');
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
        projectId: 'cloudapp-production',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        services: {
          web: {
            serviceId: 'cloudapp-production-web',
            releaseJobName: 'cloudapp-production-web-migration',
          },
          worker: { serviceId: 'cloudapp-production-worker' },
          daily: { serviceId: 'cloudapp-production-daily-schedule', jobName: 'cloudapp-production-daily', resourceType: 'scheduledJob' },
        },
      },
    });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      runtime: { kind: 'node', version: '22', installCommand: 'npm ci' },
      environments: {
        production: {
          hosting: { provider: 'cloudrun', region: 'us-west1' },
          services: {
            web: { workloadKind: 'web', startCommand: 'npm run web', healthCheckPath: '/healthz' },
            worker: { workloadKind: 'worker', startCommand: 'npm run worker', healthCheckPath: '/ready' },
            daily: { workloadKind: 'cron', cronSchedule: '0 8 * * *', startCommand: 'npm run daily' },
          },
          migrations: { mode: 'releaseCommand', command: 'npm run db:migrate' },
          deploy: { strategy: 'branch', branch: 'main' },
        },
      },
    });

    const { targets } = resolveBranchDeployTargets(projectRepo.findById(project.id)!);
    expect(targets[0]).toMatchObject({
      providerServiceIds: ['cloudapp-production-web', 'cloudapp-production-worker'],
      providerJobNames: ['cloudapp-production-daily'],
      providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      releaseCommands: [{
        serviceName: 'web',
        providerServiceId: 'cloudapp-production-web',
        jobName: 'cloudapp-production-web-migration',
        command: 'npm run db:migrate',
      }],
      needsServiceNames: true,
      needsJobNames: true,
      providerRegion: 'us-west1',
      runtime: { kind: 'node', version: '22', installCommand: 'npm ci' },
      containerStartCommand: 'npm run web',
      runtimeResources: [
        {
          logicalName: 'daily',
          workloadKind: 'cron',
          providerResourceType: 'job',
          providerResourceId: 'cloudapp-production-daily',
          startCommand: 'npm run daily',
          healthCheckPath: null,
        },
        {
          logicalName: 'web',
          workloadKind: 'web',
          providerResourceType: 'service',
          providerResourceId: 'cloudapp-production-web',
          startCommand: 'npm run web',
          healthCheckPath: '/healthz',
        },
        {
          logicalName: 'worker',
          workloadKind: 'worker',
          providerResourceType: 'service',
          providerResourceId: 'cloudapp-production-worker',
          startCommand: 'npm run worker',
          healthCheckPath: '/ready',
        },
      ],
    });
    expect(cloudRunContainerBuildStartCommand(targets[0])).toBe('npm run web');

    const workflow = buildBranchDeployWorkflow('cloudrun', targets[0], { includeStep: false });
    expect(workflow.requiredVariables).toEqual([]);
    expect(workflow.content).toContain('GCP_REGION: "us-west1"');
    expect(workflow.content).toContain('GCP_BOUND_PROJECT_ID: "gcp-project"');
    expect(workflow.content).toContain("process.env.GCP_ARTIFACT_REPOSITORY || 'hypervibe'");
    expect(workflow.content).not.toContain("process.env.GCP_ARTIFACT_REPOSITORY || 'infraprint'");
    expect(workflow.content).toContain("CLOUDRUN_SERVICE_NAMES: 'cloudapp-production-web,cloudapp-production-worker'");
    expect(workflow.content).toContain("CLOUDRUN_JOB_NAMES: 'cloudapp-production-daily'");
    expect(workflow.content).toContain('CLOUDRUN_RELEASE_COMMANDS_B64:');
    expect(workflow.content).toContain('CLOUDRUN_RUNTIME_RESOURCES_B64:');
    expect(workflow.content).toContain('cloudRunContainerWithRuntime');
    expect(workflow.content.match(/Resolve Dockerfile[\s\S]{0,1200}/)?.[0]).toContain(
      'CMD ["sh", "-lc", "npm run web"]'
    );
    expect(workflow.content).toContain('await runCloudRunReleaseCommands({');
    expect(workflow.content.indexOf('await runCloudRunReleaseCommands({')).toBeLessThan(
      workflow.content.indexOf('for (const serviceName of serviceNames)')
    );
    expect(workflow.content).toContain(
      "IMAGE_URI: ${{ steps.deploy.outputs.operation == 'rollback' && steps.rollback_evidence.outputs.image_uri || steps.promotion_release.outputs.image_uri || steps.release_image.outputs.image_uri }}"
    );
    expect(workflow.content).toContain('id: release_image');
    expect(workflow.content).toContain("id: image\n        if: steps.deploy.outputs.operation != 'rollback'");
    expect(workflow.content).toContain("id: gcp\n        if: steps.deploy.outputs.operation != 'rollback'");
    expect(workflow.content).toContain("id: build\n        if: steps.deploy.outputs.operation != 'rollback'");
    expect(workflow.content).toContain("if (process.env.DEPLOY_OPERATION !== 'rollback') {\n              await runCloudRunReleaseCommands({");
    expect(workflow.content).toContain('version: 3,');
    expect(workflow.content).toContain('HYPERVIBE_RELEASE_IMAGE_URI: ${{ steps.deploy.outputs.operation ==');
    expect(workflow.content).toContain('Download rollback release evidence');
    expect(workflow.content.match(/^\s+HYPERVIBE_SOURCE_ARTIFACT_ID:/gm)).toHaveLength(1);
    expect(() => new AsyncFunction(
      'require',
      'process',
      'core',
      'fetch',
      extractGitHubScript(workflow.content, 'Deploy image to Cloud Run')
    )).not.toThrow();
    expect(workflow.content).toContain('/jobs/\' + encodeURIComponent(jobName)');
    expect(workflow.content).toContain('await waitOperation(operation, \'job \' + jobName + \' deployment\')');
    expect(workflow.content).toContain("await waitReady(url, jobName, 'job', process.env.IMAGE_URI, runtimeResource)");
    expect(workflow.content).not.toContain("CLOUDRUN_SERVICE_NAMES: 'cloudapp-production-web,cloudapp-production-daily-schedule'");
  });

  it('generates from an explicit runtime and never invents Node for custom apps', () => {
    const baseTarget = {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: undefined,
      providerEnvironmentId: 'env-1',
      providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      providerRegion: 'us-central1',
      providerServiceIds: ['srv-1'],
      containerStartCommand: 'npm run serve',
      runtime: { kind: 'node' as const, version: '24', installCommand: 'npm ci' },
    };
    for (const provider of ['railway', 'cloudrun'] as const) {
      const workflow = buildBranchDeployWorkflow(provider, baseTarget, { includeStep: false });
      expect(workflow.content).toContain('name: Resolve Dockerfile');
      expect(workflow.content).toContain('file: ${{ steps.dockerfile.outputs.path }}');
      // Repo Dockerfile wins; an explicitly declared runtime can generate a
      // minimal image with the web service start command as CMD.
      expect(workflow.content).toContain('if [ -f Dockerfile ]; then');
      expect(workflow.content).toContain('FROM node:24-slim');
      expect(workflow.content).toContain('COPY . .');
      expect(workflow.content).toContain('RUN --mount=type=secret,id=npm_token,required=false');
      expect(workflow.content).toContain('npm_token=${{ secrets.NODE_AUTH_TOKEN }}');
      expect(workflow.content).toContain('CMD ["sh", "-lc", "npm run serve"]');
      // The generated Dockerfile step precedes the image build.
      expect(workflow.content.indexOf('Resolve Dockerfile')).toBeLessThan(workflow.content.indexOf('docker/build-push-action@v6'));
    }
    const defaulted = buildBranchDeployWorkflow('railway', { ...baseTarget, containerStartCommand: undefined }, { includeStep: false });
    expect(defaulted.content).not.toContain('CMD ["sh", "-lc", "npm start"]');
    expect(defaulted.content).toContain('requires an explicit service startCommand');

    const custom = buildBranchDeployWorkflow('railway', {
      ...baseTarget,
      runtime: undefined,
    }, { includeStep: false });
    expect(custom.content).not.toContain('FROM node:');
    expect(custom.content).not.toContain('FROM python:');
    expect(custom.content).toContain('custom languages require a Dockerfile');
  });

  it('generates builds and migration setup from the declared project runtime', () => {
    const nodeTarget = {
      environmentName: 'staging',
      kind: 'staging' as const,
      branch: 'main',
      autoDeployOnPush: true,
      serviceNames: ['web'],
      providerServiceIds: ['service-1'],
      containerStartCommand: 'npm start',
      runtime: { kind: 'node' as const, version: '24.1', installCommand: 'npm ci' },
    };
    const nodeWorkflow = buildBranchDeployWorkflow(
      'railway',
      nodeTarget,
      { includeStep: true, command: 'npm run migrate' }
    );
    expect(nodeWorkflow.content).toContain('FROM node:24.1-slim');
    expect(nodeWorkflow.content).toContain("node-version: '24.1'");

    const pythonWorkflow = buildBranchDeployWorkflow(
      'railway',
      {
        ...nodeTarget,
        containerStartCommand: 'python app.py',
        runtime: { kind: 'python', version: '3.13', installCommand: 'python -m pip install -r requirements.txt' },
      },
      { includeStep: true, command: 'python manage.py migrate' }
    );
    expect(pythonWorkflow.content).toContain('FROM python:3.13-slim');
    expect(pythonWorkflow.content).toContain("python-version: '3.13'");
    expect(pythonWorkflow.content).toContain('python -m pip install -r requirements.txt');
    expect(pythonWorkflow.content).not.toContain('FROM node:20-slim');
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
            requiredSecrets: ['SENTRY_AUTH_TOKEN'],
          },
          signing: { provider: 'match', gitBranch: 'main' },
          testflight: {
            groups: ['beta'],
            usesNonExemptEncryption: false,
            submitForBetaReview: false,
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
    expect(releaseWorkflow).toContain('runs-on: macos-26');
    expect(releaseWorkflow).toContain('pattern: hypervibe-server-release-development-*');
    expect(releaseWorkflow).toContain('path: ${{ runner.temp }}/hypervibe-server-evidence');
    expect(releaseWorkflow).toContain(
      'HYPERVIBE_SERVER_EVIDENCE_PATH: ${{ runner.temp }}/hypervibe-server-evidence/hypervibe-server-release.json'
    );
    expect(releaseWorkflow).toContain(
      'fs.readFileSync(process.env.HYPERVIBE_SERVER_EVIDENCE_PATH,"utf8")'
    );
    expect(releaseWorkflow).toContain('evidence.version!==3');
    expect(releaseWorkflow).not.toContain('evidence.version!==2');
    expect(releaseWorkflow).toContain('server evidence repository/SHA mismatch');
    expect(releaseWorkflow).toContain('concurrency:');
    expect(releaseWorkflow).toContain('group: hypervibe-deploy-development');
    expect(releaseWorkflow).toContain('  build:');
    expect(releaseWorkflow).toContain('  release:\n    needs: build');
    expect(releaseWorkflow).toContain("node-version: '24'");
    expect(releaseWorkflow).toContain('ruby/setup-ruby@v1');
    expect(releaseWorkflow).toContain("ruby-version: '3.3'");
    expect(releaseWorkflow).toContain('bundler-cache: true');
    expect(releaseWorkflow.indexOf('ruby/setup-ruby@v1'))
      .toBeLessThan(releaseWorkflow.indexOf('Build signed IPA'));
    expect(releaseWorkflow).toContain('Prepare Hypervibe-managed signing assets');
    expect(releaseWorkflow).toContain('bundle exec fastlane match appstore --readonly');
    expect(releaseWorkflow).toContain('MATCH_GIT_BRANCH: "main"');
    expect(releaseWorkflow).toContain('HYPERVIBE_PROVISIONING_PROFILE_NAME');
    expect(releaseWorkflow).toContain('Materialize Hypervibe release runtime');
    expect(releaseWorkflow).toContain('Run Hypervibe-managed TestFlight release');
    expect(releaseWorkflow).not.toContain('project-owned TestFlight release script');
    expect(releaseWorkflow).not.toContain('HYPERVIBE_RELEASE_SCRIPT');
    expect(releaseWorkflow).not.toContain('xcrun altool --upload-app');
    const releaseJobStart = releaseWorkflow.indexOf('\n  release:\n');
    const buildJob = releaseWorkflow.slice(0, releaseJobStart);
    const releaseJob = releaseWorkflow.slice(releaseJobStart);
    expect(buildJob).not.toContain('APP_STORE_CONNECT_PRIVATE_KEY');
    expect(releaseJob).toContain('APP_STORE_CONNECT_PRIVATE_KEY:');
    expect(releaseJob).not.toContain('actions/checkout');
    const buildCommand = buildJob.slice(
      buildJob.indexOf('      - name: Build signed IPA'),
      buildJob.indexOf('      - name: Validate IPA identity')
    );
    expect(buildCommand).toContain('SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}');
    expect(buildCommand).not.toContain('MATCH_PASSWORD');
    expect(buildCommand).not.toContain('MATCH_GIT_BASIC_AUTHORIZATION');
    expect(releaseWorkflow).toContain('Verify release IPA identity');
    expect(releaseWorkflow).toContain('hypervibe-ios-build-development-${{ steps.gate.outputs.sha }}');
    expect(workflow.requiredSecrets).toEqual(expect.arrayContaining([
      'APP_STORE_CONNECT_KEY_ID',
      'APP_STORE_CONNECT_ISSUER_ID',
      'APP_STORE_CONNECT_PRIVATE_KEY',
      'MATCH_GIT_URL',
      'MATCH_PASSWORD',
      'MATCH_GIT_BASIC_AUTHORIZATION',
      'SENTRY_AUTH_TOKEN',
    ]));
  });

});
