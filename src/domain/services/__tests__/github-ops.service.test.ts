import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import {
  buildBranchDeployWorkflow,
  githubActionsServerProgramFingerprint,
  githubActionsWorkflowInputHash,
  resolveBranchDeployTargets,
} from '../github-ops.service.js';
import { resolveReviewedBranchDeployTargets } from '../managed-ci-targets.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import { managedCiReleaseTarget } from '../managed-ci-targets.js';
import { cloudRunContainerBuildStartCommand } from '../../../adapters/providers/gcp/cloudrun-ci.release-runtime.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { MANAGED_CI_RELEASE_EVIDENCE_VERSION } from '../managed-ci-evidence.js';
import {
  extractGitHubScript,
  extractWorkflowShell,
  installReleaseEvidenceValidator,
  releaseEvidenceValidatorRequire,
} from './managed-ci-workflow.test-utils.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function reviewedTarget(
  provider: string,
  target: BranchDeployTarget
): BranchDeployTarget {
  if (target.releaseTarget && target.programFingerprint) return target;
  const providerResources = [
    ...target.providerServiceIds.map((providerResourceId) => ({
      providerResourceId,
      providerResourceType: 'service' as const,
      workloadKind: 'web' as const,
    })),
    ...(target.providerJobNames ?? []).map((providerResourceId) => ({
      providerResourceId,
      providerResourceType: 'job' as const,
      workloadKind: 'cron' as const,
    })),
  ];
  if (providerResources.length !== 1 || target.serviceNames.length !== 1) {
    throw new Error('Test helper accepts only one unambiguous logical-to-provider resource binding');
  }
  return {
    ...target,
    programFingerprint: target.programFingerprint ?? 'c'.repeat(64),
    releaseTarget: target.releaseTarget ?? managedCiReleaseTarget({
      provider,
      environmentName: target.environmentName,
      scope: {
        providerProjectId: target.providerProjectId,
        providerEnvironmentId: target.providerEnvironmentId,
        providerRegion: target.providerRegion,
        providerScope: target.providerScope,
      },
      resources: target.serviceNames.map((logicalName, index) => ({
        logicalName,
        ...providerResources[index]!,
      })),
    }),
  };
}

function executeDockerfileStep(workflowContent: string, directory: string): string {
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  fs.writeFileSync(path.join(directory, 'requirements.txt'), '');
  execFileSync('sh', ['-eu', '-c', extractWorkflowShell(workflowContent, 'Resolve Dockerfile')], {
    cwd: directory,
    env: { ...process.env, GITHUB_OUTPUT: path.join(directory, 'outputs') },
  });
  return fs.readFileSync(path.join(directory, 'Dockerfile.hypervibe'), 'utf8');
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

  it('executes one reviewed Railway workflow for web, worker and cron', async () => {
    const project = new ProjectRepository().create({ name: 'multi-service', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-staging',
        services: {
          web: { serviceId: 'rail-web', workloadKind: 'web' },
          worker: { serviceId: 'rail-worker', workloadKind: 'worker' },
          cron: { serviceId: 'rail-cron', workloadKind: 'cron' },
        },
      },
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          envVars: {
            SEED_CLIENT_TEST_DATA: 'true',
            CARE_PLAN_AI_REQUEST_TIMEOUT_MS: '30000',
          },
          services: {
            worker: { workloadKind: 'worker', startCommand: 'npm run worker' },
            web: { workloadKind: 'web', startCommand: 'npm start', public: true },
            cron: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 8 * * *' },
          },
        },
      },
    });
    new SpecStore().replace(project, spec);
    const { targets, migration } = resolveBranchDeployTargets(project);
    const workflow = buildBranchDeployWorkflow('railway', targets[0]!, migration);
    const target = targets[0]!;
    for (const file of [{ path: workflow.path, content: workflow.content }, ...(workflow.companionFiles ?? [])]
      .filter((candidate) => /\.ya?ml$/.test(candidate.path))) {
      const document = parseDocument(file.content, { uniqueKeys: true });
      expect(document.errors, `${file.path} must be valid YAML with unique keys`).toEqual([]);
    }
    const parsedWorkflow = parseDocument(workflow.content).toJS() as {
      jobs?: { deploy?: { steps?: Array<{ name?: string }> } };
    };
    const generatedSteps = parsedWorkflow.jobs?.deploy?.steps;
    expect(Array.isArray(generatedSteps)).toBe(true);
    const generatedStepNames = generatedSteps!.map((step) => step.name).filter(Boolean);
    for (const stepName of [
      'Prepare release evidence validator',
      'Verify reviewed release target',
      'Deployment safety gate: verify Hypervibe reconciliation',
      'Deploy image to Railway',
      'Write server release evidence',
    ]) {
      expect(generatedStepNames.filter((name) => name === stepName), `${stepName} must appear once`)
        .toHaveLength(1);
    }
    expect(target.releaseTarget?.resources).toEqual([
      {
        logicalName: 'cron',
        workloadKind: 'cron',
        providerResourceType: 'service',
        providerResourceId: 'rail-cron',
      },
      {
        logicalName: 'web',
        workloadKind: 'web',
        providerResourceType: 'service',
        providerResourceId: 'rail-web',
      },
      {
        logicalName: 'worker',
        workloadKind: 'worker',
        providerResourceType: 'service',
        providerResourceId: 'rail-worker',
      },
    ]);
    expect(workflow.content).not.toContain('requires an explicit service startCommand');
    // Execute the emitted shell branch without Docker or provider access.
    const dockerfile = executeDockerfileStep(workflow.content, tempDir);
    expect(dockerfile).toContain('FROM node:24-slim');
    expect(dockerfile).toContain(
      'RUN --mount=type=secret,id=npm_token,required=false if [ -f /run/secrets/npm_token ]; then export NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)"; fi; npm ci --omit=dev'
    );
    expect(dockerfile).toContain('CMD ["sh", "-lc", "npm start"]');

    const validator = installReleaseEvidenceValidator(workflow.content, tempDir);
    expect(workflow.content.match(/name: Prepare release evidence validator/g)).toHaveLength(1);
    expect(workflow.content.match(/function validateReleaseEvidence/g)).toHaveLength(1);
    const verifyReleaseTarget = new AsyncFunction(
      'require',
      'process',
      'core',
      extractGitHubScript(workflow.content, 'Verify reviewed release target')
    );
    await expect(verifyReleaseTarget(
      releaseEvidenceValidatorRequire(validator),
      {
        env: {
          HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath,
          HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
          HYPERVIBE_RELEASE_PROVIDER: 'railway',
          HYPERVIBE_RELEASE_ENVIRONMENT: 'staging',
          HYPERVIBE_RELEASE_SERVICES: JSON.stringify(target.serviceNames),
          HYPERVIBE_RELEASE_TARGET_SCOPE: JSON.stringify(target.releaseTarget!.scope),
          HYPERVIBE_RELEASE_RESOURCES: JSON.stringify(target.releaseTarget!.resources),
          HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT: target.releaseTarget!.bindingsFingerprint,
          HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: target.programFingerprint,
        },
      },
      {}
    )).resolves.toBeUndefined();

    const response = (data: unknown) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data }),
    });
    const fetch = vi.fn(async (_url: string, request: { body: string }) => {
      const payload = JSON.parse(request.body) as {
        query: string;
        variables: { serviceId?: string; id?: string; input?: Record<string, unknown> };
      };
      if (payload.query.includes('ServiceEnvironmentInstance')) {
        return response({
          service: {
            id: payload.variables.serviceId,
            serviceInstances: { edges: [{ node: { environmentId: 'rail-staging' } }] },
          },
        });
      }
      if (payload.query.includes('UpdateServiceImage')) {
        return response({ serviceInstanceUpdate: true });
      }
      if (payload.query.includes('DeployServiceImage')) {
        return response({ serviceInstanceDeployV2: `${payload.variables.serviceId}-deployment` });
      }
      if (payload.query.includes('DeploymentStatus')) {
        return response({
          deployment: {
            id: payload.variables.id,
            status: 'SUCCESS',
            diagnosis: null,
            meta: null,
          },
        });
      }
      throw new Error(`Unexpected Railway operation: ${payload.query}`);
    });
    const providerCore = { info: vi.fn(), warning: vi.fn() };
    const deploy = new AsyncFunction(
      'fetch',
      'process',
      'core',
      extractGitHubScript(workflow.content, 'Deploy image to Railway')
    );
    const emittedServiceIdsYaml = workflow.content.match(/^\s+RAILWAY_SERVICE_IDS:\s*([^\n]+)$/m)?.[1]?.trim();
    expect(emittedServiceIdsYaml).toBe("'rail-web,rail-worker,rail-cron'");
    const emittedServiceIds = emittedServiceIdsYaml!.slice(1, -1);
    await deploy(fetch, {
      env: {
        RAILWAY_API_TOKEN: 'test-token',
        RAILWAY_ENVIRONMENT_ID: 'rail-staging',
        RAILWAY_SERVICE_IDS: emittedServiceIds,
        IMAGE_REGISTRY_USERNAME: 'test-user',
        IMAGE_REGISTRY_TOKEN: 'test-registry-token',
        IMAGE_URI: `ghcr.io/dave/multi-service@sha256:${'b'.repeat(64)}`,
        DEPLOY_SHA: '0123456789abcdef0123456789abcdef01234567',
      },
    }, providerCore);
    const operations = fetch.mock.calls.map(([, request]) => {
      const body = JSON.parse((request as { body: string }).body) as {
        query: string;
        variables: { serviceId?: string; id?: string; input?: Record<string, unknown> };
      };
      return {
        name: ['UpdateServiceImage', 'DeployServiceImage', 'ServiceEnvironmentInstance', 'DeploymentStatus']
          .find((name) => body.query.includes(name)),
        id: body.variables.serviceId ?? body.variables.id,
        input: body.variables.input,
      };
    });
    const expectedServiceIds = ['rail-cron', 'rail-web', 'rail-worker'];
    for (const name of ['UpdateServiceImage', 'DeployServiceImage', 'ServiceEnvironmentInstance']) {
      expect(operations.filter((operation) => operation.name === name).map((operation) => operation.id).sort())
        .toEqual(expectedServiceIds);
    }
    expect(operations.filter((operation) => operation.name === 'DeploymentStatus').map((operation) => operation.id).sort())
      .toEqual(expectedServiceIds.map((id) => `${id}-deployment`));
    expect(operations
      .filter((operation) => operation.name === 'UpdateServiceImage')
      .map((operation) => ({ id: operation.id, input: operation.input }))
      .sort((left, right) => left.id!.localeCompare(right.id!)))
      .toEqual(expectedServiceIds.map((id) => ({
        id,
        input: {
          source: { image: `ghcr.io/dave/multi-service@sha256:${'b'.repeat(64)}` },
          registryCredentials: { username: 'test-user', password: 'test-registry-token' },
        },
      })));
    expect(target.runtimeResources?.map(({ logicalName, startCommand }) => ({ logicalName, startCommand })))
      .toEqual([
        { logicalName: 'cron', startCommand: 'npm run cron' },
        { logicalName: 'web', startCommand: 'npm start' },
        { logicalName: 'worker', startCommand: 'npm run worker' },
      ]);
    expect(fetch).toHaveBeenCalledTimes(12);
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

  it('builds only the production branch-deploy workflow from the reviewed spec', () => {
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
        environmentId: 'rail-production',
        services: { web: { serviceId: 'rail-web', workloadKind: 'web' } },
      },
    });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
      environments: {
        production: {
          hosting: { provider: 'railway' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'release' },
          services: { web: { workloadKind: 'web', startCommand: 'npm start' } },
          migrations: { mode: 'tool', runInDeploy: true, command: 'npm run migrate' },
        },
      },
    });

    const { targets, migration } = resolveBranchDeployTargets(projectRepo.findById(project.id)!);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
        environmentName: 'production',
        kind: 'production',
        branch: 'release',
        autoDeployOnPush: false,
        serviceNames: ['web'],
        providerProjectId: 'rail-project',
        providerEnvironmentId: 'rail-production',
        providerServiceIds: ['rail-web'],
        providerJobNames: [],
        needsServiceNames: true,
        needsJobNames: false,
        programFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        releaseTarget: {
          resources: [expect.objectContaining({ logicalName: 'web', providerResourceId: 'rail-web' })],
        },
      });
    expect(migration.includeStep).toBe(true);
    expect(migration.command).toBe('npm run migrate');

    const triggerChange = { ...targets[0], branch: 'main', autoDeployOnPush: true };
    expect(githubActionsServerProgramFingerprint({
      provider: 'railway',
      target: triggerChange,
      migration,
    })).toBe(targets[0]!.programFingerprint);
    expect(githubActionsWorkflowInputHash({
      provider: 'railway',
      target: triggerChange,
      migration,
    })).not.toBe(githubActionsWorkflowInputHash({
      provider: 'railway',
      target: targets[0]!,
      migration,
    }));

    const workflow = buildBranchDeployWorkflow('railway', targets[0], migration);
    expect(workflow.template).toBe('deploy-railway-production');
    expect(workflow.branch).toBe('release');
    expect(workflow.autoDeployOnPush).toBe(false);
    expect(workflow.environment).toBe('production');
    expect(workflow.requiredSecrets).toEqual(['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN', 'DATABASE_URL']);
    expect(workflow.requiredVariables).toEqual([]);
    expect(workflow.review).toMatchObject({
      title: 'production deployment',
      summary: expect.stringContaining('Railway'),
      mergeEffect: expect.stringContaining('started manually'),
    });
    expect(workflow.content).not.toContain('  push:\n    branches:');
    expect(workflow.content).toContain('workflow_dispatch:');
    expect(workflow.content).toContain('environment: production');
    expect(workflow.content).toContain('group: hypervibe-deploy-production');
    expect(workflow.content).toContain('cancel-in-progress: false');
    expect(workflow.content).toContain('run: npm run migrate');
    expect(workflow.content.indexOf('npm ci')).toBeGreaterThan(-1);
    expect(workflow.content.indexOf('npm ci')).toBeLessThan(workflow.content.indexOf('run: npm run migrate'));
    expect(workflow.content.indexOf('Deployment safety gate: verify Hypervibe reconciliation'))
      .toBeLessThan(workflow.content.indexOf('npm ci'));
    expect(workflow.content).not.toContain('vars.MIGRATION_COMMAND');
  });

  it('refuses to infer managed CI targets from legacy policy state', () => {
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
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-production',
        services: { web: { serviceId: 'production-web' } },
      },
    });

    expect(() => resolveBranchDeployTargets(projectRepo.findById(project.id)!)).toThrow(
      'Managed CI for project "legacy-cross-provider" requires a valid reviewed project spec.'
    );
  });

  it('restores a verified Railway image digest without rebuilding the target SHA', () => {
    const target = reviewedTarget('railway', {
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
    });
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

    expect(checkoutStep).toContain("if: steps.deploy.outputs.operation != 'rollback'");
    expect(checkoutStep).toContain('persist-credentials: false');
    expect(buildStep).toContain("if: steps.deploy.outputs.operation != 'rollback'");
    expect(content).toContain(
      "IMAGE_URI: ${{ steps.deploy.outputs.operation == 'rollback' && steps.rollback_evidence.outputs.image_uri || steps.promotion_release.outputs.image_uri || steps.release_image.outputs.image_uri }}"
    );
  });

  it('retries transient Railway reads without replaying deploy mutations', async () => {
    vi.useFakeTimers();
    const target = reviewedTarget('railway', {
      environmentName: 'staging',
      kind: 'staging' as const,
      branch: 'main',
      autoDeployOnPush: true,
      serviceNames: ['web'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-env',
      providerServiceIds: ['rail-web'],
      providerJobNames: [],
    });
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
    const target = reviewedTarget('railway', {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-env',
      providerServiceIds: ['rail-web'],
      providerJobNames: [],
    });
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
      name: `hypervibe-server-release-v4-production-${targetSha}`,
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
    const target = reviewedTarget('railway', {
      environmentName: 'production',
      kind: 'production' as const,
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-env',
      providerServiceIds: ['rail-web'],
      providerJobNames: [],
    });
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
    expect(stagingWorkflow.content).toContain("if: needs.reconciliation.outputs.ready == 'true'");
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

    const cloudRunWorkflow = buildBranchDeployWorkflow('cloudrun', reviewedTarget('cloudrun', {
      ...baseTarget,
      providerServiceIds: ['cloudrun-web'],
      providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      providerRegion: 'us-west1',
    }), { includeStep: false });
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

    const railwayWorkflow = buildBranchDeployWorkflow('railway', reviewedTarget('railway', {
      ...baseTarget,
      providerServiceIds: ['srv-railway'],
      providerEnvironmentId: 'env-railway',
    }), { includeStep: false });
    expect(railwayWorkflow.requiredSecrets).toEqual(['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(railwayWorkflow.content).toContain('packages: write');

    const combinedContent = [
      cloudRunWorkflow.content,
      railwayWorkflow.content,
    ].join('\n');
    expect(combinedContent).not.toMatch(/railway-github-action|vercel deploy|doctl apps|gcloud /);

    expect(() => buildBranchDeployWorkflow('cloudrun', reviewedTarget('cloudrun', {
      ...baseTarget,
      providerScope: { projectId: 'gcp-project' },
      providerEnvironmentId: 'not-a-region',
      providerServiceIds: ['cloudrun-web'],
    }), { includeStep: false })).toThrow('has no bound provider project or region');
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
    expect(executeDockerfileStep(workflow.content, tempDir)).toContain(
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
    expect(workflow.content).toContain('version: 4,');
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
      const workflow = buildBranchDeployWorkflow(
        provider,
        reviewedTarget(provider, baseTarget),
        { includeStep: false }
      );
      expect(workflow.content).toContain('name: Resolve Dockerfile');
      expect(workflow.content).toContain('file: ${{ steps.dockerfile.outputs.path }}');
      // Repo Dockerfile wins; an explicitly declared runtime can generate a
      // minimal image with the web service start command as CMD.
      expect(workflow.content).toContain('if [ -f Dockerfile ]; then');
      expect(workflow.content).toContain('npm_token=${{ secrets.NODE_AUTH_TOKEN }}');
      const dockerfileDirectory = fs.mkdtempSync(path.join(tempDir, `${provider}-dockerfile-`));
      const dockerfile = executeDockerfileStep(workflow.content, dockerfileDirectory);
      expect(dockerfile).toContain('FROM node:24-slim');
      expect(dockerfile).toContain('COPY . .');
      expect(dockerfile).toContain('RUN --mount=type=secret,id=npm_token,required=false');
      expect(dockerfile).toContain('CMD ["sh", "-lc", "npm run serve"]');
      // The generated Dockerfile step precedes the image build.
      expect(workflow.content.indexOf('Resolve Dockerfile')).toBeLessThan(workflow.content.indexOf('docker/build-push-action@v6'));
    }
    const defaulted = buildBranchDeployWorkflow(
      'railway',
      reviewedTarget('railway', { ...baseTarget, containerStartCommand: undefined }),
      { includeStep: false }
    );
    expect(defaulted.content).not.toContain('CMD ["sh", "-lc", "npm start"]');
    expect(defaulted.content).toContain('requires an explicit service startCommand');

    const custom = buildBranchDeployWorkflow('railway', reviewedTarget('railway', {
      ...baseTarget,
      runtime: undefined,
    }), { includeStep: false });
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
      reviewedTarget('railway', nodeTarget),
      { includeStep: true, command: 'npm run migrate' }
    );
    const nodeDockerfile = executeDockerfileStep(
      nodeWorkflow.content,
      fs.mkdtempSync(path.join(tempDir, 'node-runtime-'))
    );
    expect(nodeDockerfile).toContain('FROM node:24.1-slim');
    expect(nodeWorkflow.content).toContain("node-version: '24.1'");

    const pythonWorkflow = buildBranchDeployWorkflow(
      'railway',
      reviewedTarget('railway', {
        ...nodeTarget,
        containerStartCommand: 'python app.py',
        runtime: { kind: 'python', version: '3.13', installCommand: 'python -m pip install -r requirements.txt' },
      }),
      { includeStep: true, command: 'python manage.py migrate' }
    );
    const pythonDockerfile = executeDockerfileStep(
      pythonWorkflow.content,
      fs.mkdtempSync(path.join(tempDir, 'python-runtime-'))
    );
    expect(pythonDockerfile).toContain('FROM python:3.13-slim');
    expect(pythonWorkflow.content).toContain("python-version: '3.13'");
    expect(pythonDockerfile).toContain('python -m pip install -r requirements.txt');
    expect(pythonDockerfile).not.toContain('FROM node:20-slim');
  });

  it('emits server evidence and a gated iOS release workflow with separate provenance', async () => {
    const target: BranchDeployTarget = {
      environmentName: 'development',
      kind: 'development',
      branch: 'develop',
      autoDeployOnPush: true,
      serviceNames: ['api', 'nightly'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-env',
      providerServiceIds: ['service-1', 'service-2'],
      programFingerprint: 'c'.repeat(64),
      releaseTarget: managedCiReleaseTarget({
        provider: 'railway',
        environmentName: 'development',
        scope: {
          providerProjectId: 'rail-project',
          providerEnvironmentId: 'rail-env',
        },
        resources: [
          {
            logicalName: 'api',
            workloadKind: 'web',
            providerResourceType: 'service',
            providerResourceId: 'service-1',
          },
          {
            logicalName: 'nightly',
            workloadKind: 'cron',
            providerResourceType: 'service',
            providerResourceId: 'service-2',
          },
        ],
      }),
    };
    const workflow = buildBranchDeployWorkflow(
      'railway',
      target,
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
    expect(workflow.content).toContain('hypervibe-server-release-v4-development');
    expect(workflow.companionFiles?.map((file) => file.path)).toEqual([
      '.github/workflows/hypervibe-ios-release-development.yml',
    ]);
    const releaseWorkflow = workflow.companionFiles?.[0].content ?? '';
    expect(releaseWorkflow).toContain('Download verified server release evidence');
    expect(releaseWorkflow).toContain('runs-on: macos-26');
    expect(releaseWorkflow).toContain('hypervibe-server-release-v4-development-');
    expect(releaseWorkflow).toContain('artifact-ids: ${{ steps.provenance.outputs.artifact_id }}');
    expect(releaseWorkflow).toContain('artifact-ids: ${{ needs.build.outputs.server_artifact_id }}');
    expect(releaseWorkflow).toContain('path: ${{ runner.temp }}/hypervibe-server-evidence');
    expect(releaseWorkflow).toContain(
      'HYPERVIBE_SERVER_EVIDENCE_PATH: ${{ runner.temp }}/hypervibe-server-evidence/hypervibe-server-release.json'
    );
    expect(releaseWorkflow).toContain(
      'fs.readFileSync(process.env.HYPERVIBE_SERVER_EVIDENCE_PATH,"utf8")'
    );
    expect(releaseWorkflow).toContain(
      `HYPERVIBE_SERVER_EVIDENCE_VERSION: "${MANAGED_CI_RELEASE_EVIDENCE_VERSION}"`
    );
    expect(releaseWorkflow).toContain(
      'evidence.version!==Number(process.env.HYPERVIBE_SERVER_EVIDENCE_VERSION)'
    );
    expect(releaseWorkflow).toContain('evidence.deploymentContractFingerprint');
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
    const releaseSha = 'a'.repeat(40);
    const imageUri = `ghcr.io/owner/repo@sha256:${'b'.repeat(64)}`;
    const evidence = {
      version: MANAGED_CI_RELEASE_EVIDENCE_VERSION,
      provider: 'railway',
      environment: 'development',
      deploymentContractFingerprint: 'b'.repeat(64),
      source: { repository: 'owner/repo', sha: releaseSha },
      target: {
        scope: target.releaseTarget!.scope,
        bindingsFingerprint: target.releaseTarget!.bindingsFingerprint,
        resources: target.releaseTarget!.resources.map((resource) => ({ ...resource, imageUri })),
      },
      programFingerprint: target.programFingerprint!,
      verifiedAt: '2026-09-11T00:00:00.000Z',
    };
    const releaseDocument = parseDocument(releaseWorkflow, { uniqueKeys: true });
    expect(releaseDocument.errors).toEqual([]);
    const parsedRelease = releaseDocument.toJS() as {
      jobs: { build: { env: Record<string, unknown>; steps: Array<{ name?: string; env?: Record<string, unknown> }> } };
    };
    const gateSteps = parsedRelease.jobs.build.steps.filter((step) => step.name === 'Verify server release gate');
    expect(gateSteps).toHaveLength(1);
    const emittedGateEnvironment = {
      ...parsedRelease.jobs.build.env,
      ...gateSteps[0]!.env,
    };
    const expectedServerRelease = JSON.parse(String(
      emittedGateEnvironment.HYPERVIBE_EXPECTED_SERVER_RELEASE
    )) as { artifactPrefix: string; workflowPath: string };
    expect(expectedServerRelease).toMatchObject({
      artifactPrefix: 'hypervibe-server-release-v4-development-',
      workflowPath: workflow.path,
    });
    const provenanceScript = extractGitHubScript(releaseWorkflow, 'Resolve release provenance');
    const serverRun = {
      id: 91,
      conclusion: 'success',
      head_sha: releaseSha,
      path: workflow.path,
    };
    const serverArtifact = {
      id: 72,
      name: expectedServerRelease.artifactPrefix + releaseSha,
      expired: false,
      workflow_run: { id: serverRun.id, head_sha: releaseSha },
    };
    const provenanceCase = (options: {
      run?: Record<string, unknown>;
      artifacts?: Array<Record<string, unknown>>;
      eventName?: string;
      inputs?: Record<string, string>;
    } = {}) => {
      const getWorkflowRun = vi.fn(async () => ({ data: options.run ?? serverRun }));
      const listWorkflowRunArtifacts = vi.fn();
      const paginate = vi.fn(async () => options.artifacts ?? [serverArtifact]);
      const outputs = new Map<string, string>();
      const result = new AsyncFunction(
        'github',
        'context',
        'process',
        'core',
        provenanceScript
      )(
        { paginate, rest: { actions: { getWorkflowRun, listWorkflowRunArtifacts } } },
        {
          eventName: options.eventName ?? 'workflow_dispatch',
          payload: options.eventName === 'workflow_run'
            ? { workflow_run: { id: serverRun.id } }
            : { inputs: options.inputs ?? { commit_sha: releaseSha, server_run_id: String(serverRun.id) } },
          repo: { owner: 'owner', repo: 'repo' },
        },
        { env: { HYPERVIBE_EXPECTED_SERVER_RELEASE: JSON.stringify(expectedServerRelease) } },
        { setOutput: (name: string, value: string) => outputs.set(name, value) }
      );
      return { getWorkflowRun, listWorkflowRunArtifacts, outputs, paginate, result };
    };

    const provenance = provenanceCase();
    await expect(provenance.result).resolves.toBeUndefined();
    expect(provenance.getWorkflowRun).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      run_id: serverRun.id,
    });
    expect(provenance.paginate).toHaveBeenCalledWith(provenance.listWorkflowRunArtifacts, {
      owner: 'owner',
      repo: 'repo',
      run_id: serverRun.id,
      per_page: 100,
    });
    expect(Object.fromEntries(provenance.outputs)).toEqual({
      artifact_id: String(serverArtifact.id),
      server_run_id: String(serverRun.id),
      sha: releaseSha,
    });
    await expect(provenanceCase({ eventName: 'workflow_run' }).result).resolves.toBeUndefined();

    for (const run of [
      { ...serverRun, path: '.github/workflows/not-managed.yml' },
      { ...serverRun, conclusion: 'failure' },
    ]) {
      const rejected = provenanceCase({ run });
      await expect(rejected.result).rejects.toThrow(
        'Server release evidence must come from a successful run of'
      );
      expect(rejected.paginate).not.toHaveBeenCalled();
    }
    const wrongRequestedSha = provenanceCase({
      inputs: { commit_sha: 'd'.repeat(40), server_run_id: String(serverRun.id) },
    });
    await expect(wrongRequestedSha.result).rejects.toThrow(
      'commit_sha does not match the selected server workflow run'
    );
    expect(wrongRequestedSha.paginate).not.toHaveBeenCalled();
    const mismatchedArtifact = provenanceCase({
      artifacts: [{ ...serverArtifact, name: expectedServerRelease.artifactPrefix + 'd'.repeat(40) }],
    });
    await expect(mismatchedArtifact.result).rejects.toThrow('Expected exactly one unexpired');
    const duplicateArtifacts = provenanceCase({
      artifacts: [serverArtifact, { ...serverArtifact, id: 73 }],
    });
    await expect(duplicateArtifacts.result).rejects.toThrow(/found 2$/);

    const runEvidenceGate = (candidate: unknown, suffix: string) => {
      const evidencePath = path.join(tempDir, `ios-server-evidence-${suffix}.json`);
      const outputPath = path.join(tempDir, `ios-gate-output-${suffix}.txt`);
      fs.writeFileSync(evidencePath, JSON.stringify(candidate));
      execFileSync('bash', ['-eu', '-c', extractWorkflowShell(releaseWorkflow, 'Verify server release gate')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...Object.fromEntries(Object.entries(emittedGateEnvironment).map(([key, value]) => [key, String(value)])),
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: 'owner/repo',
          HYPERVIBE_REQUESTED_SHA: releaseSha,
          HYPERVIBE_SERVER_EVIDENCE_PATH: evidencePath,
        },
      });
      return fs.readFileSync(outputPath, 'utf8');
    };

    expect(runEvidenceGate(evidence, 'accepted')).toBe(`sha=${releaseSha}\n`);
    expect(runEvidenceGate({
      ...evidence,
      deploymentContractFingerprint: 'e'.repeat(64),
    }, 'new-contract')).toBe(`sha=${releaseSha}\n`);

    const mismatches = [
      { ...evidence, provider: 'cloudrun' },
      { ...evidence, programFingerprint: 'd'.repeat(64) },
      { ...evidence, target: { ...evidence.target, scope: { providerProjectId: 'other-project' } } },
      { ...evidence, target: { ...evidence.target, bindingsFingerprint: 'd'.repeat(64) } },
      {
        ...evidence,
        target: {
          ...evidence.target,
          resources: evidence.target.resources.map((resource, index) => (
            index === 0 ? { ...resource, providerResourceId: 'other-service' } : resource
          )),
        },
      },
    ];
    for (const [index, mismatch] of mismatches.entries()) {
      expect(() => runEvidenceGate(mismatch, `mismatch-${index}`))
        .toThrow(/server evidence (?:contract mismatch|does not match the exact reviewed deployment target)/);
    }
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
