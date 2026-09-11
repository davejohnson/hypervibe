import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../../../adapters/providers/railway/railway-database.factory.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../../adapters/providers/gcp/cloudsql.adapter.js';
import '../../../adapters/providers/aws/s3.adapter.js';
import '../../../adapters/providers/azure/azure-container-apps.adapter.js';
import '../../../adapters/providers/azure/azure-managed-redis.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { PlanService } from '../plan.service.js';
import { ConvergeExecutor, orderActions } from '../converge.executor.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { AppStoreConnectAdapter } from '../../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { isIosAction } from '../../services/appstore-plan.service.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import type { Project } from '../../entities/project.entity.js';
import type { Environment } from '../../entities/environment.entity.js';
import {
  buildBranchDeployWorkflow,
  resolveBranchDeployTargets,
} from '../../services/github-ops.service.js';
import {
  githubActionsWorkflowInputHash,
  workflowFiles,
  workflowFilesContentHash,
} from '../../services/ci-deploy.service.js';
import { environmentDeploymentContractHash } from '../../services/deployment-contract.service.js';
import { StripeAdapter } from '../../../adapters/providers/stripe/stripe.adapter.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { createToolContext } from '../../../application/context.js';
import * as environmentMaintenanceService from '../../services/environment-maintenance.service.js';
import { applyStorageAction, STORAGE_OPERATIONS } from '../../services/storage-plan.service.js';
import { CACHE_OPERATIONS } from '../../services/cache-plan.service.js';
import '../../../application/devops-providers.js';

let project: Project;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function seedVerifiedConnection(
  provider: string,
  credentials: Record<string, unknown>,
  scope?: string
) {
  const connections = new ConnectionRepository();
  const connection = connections.create({
    provider,
    ...(scope !== undefined ? { scope } : {}),
    credentialsEncrypted: getSecretStore().encryptObject(credentials),
  });
  connections.updateStatus(connection.id, 'verified');
  return connection;
}

function railwayWorkflowFixture(targetProject: Project, environmentName: string) {
  const { targets, migration } = resolveBranchDeployTargets(targetProject);
  const target = targets.find((candidate) => candidate.environmentName === environmentName)!;
  const workflow = buildBranchDeployWorkflow('railway', target, migration);
  return {
    workflow,
    binding: {
      contentHash: workflowFilesContentHash(workflowFiles(workflow)),
      inputHash: githubActionsWorkflowInputHash({ provider: 'railway', target, migration }),
    },
  };
}

function mockLiveWorkflow(workflow: ReturnType<typeof buildBranchDeployWorkflow>) {
  return vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(
    async (_owner, _repo, filePath) => workflowFiles(workflow)
      .find((file) => file.path === filePath)?.content ?? null
  );
}

function seedAcceptedRailwayCiProject(params: {
  name: string;
  packageReadToken: string;
  syncedPackageReadToken?: string;
  githubScope?: string;
  unverifiedScopedShadow?: boolean;
}): Project {
  const ciProject = new ProjectRepository().create({
    name: params.name,
    defaultPlatform: 'railway',
    gitRemoteUrl: `https://github.com/dave/${params.name}`,
  });
  new SpecStore().replace(ciProject, {
    version: 1,
    project: ciProject.name,
    gitRemoteUrl: ciProject.gitRemoteUrl,
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: { startCommand: 'npm start' } },
        email: { enabled: false },
        envVars: {},
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
      },
    },
  });
  seedVerifiedConnection('github', {
    apiToken: 'gh-token',
    login: 'dave',
    packageReadToken: params.packageReadToken,
  }, params.githubScope);
  if (params.unverifiedScopedShadow) {
    new ConnectionRepository().create({
      provider: 'github',
      scope: `dave/${params.name}`,
      credentialsEncrypted: getSecretStore().encryptObject({
        apiToken: 'bad-scoped-token',
        login: 'dave',
      }),
    });
  }
  seedVerifiedConnection('railway', { apiToken: 'railway-token' });

  const environments = new EnvironmentRepository();
  const environment = environments.create({
    projectId: ciProject.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: { web: { serviceId: 'svc-1' } },
    },
  });
  const { workflow, binding } = railwayWorkflowFixture(ciProject, 'production');
  environments.updatePlatformBindings(environment.id, {
    ci: {
      deployBranch: {
        [workflow.path]: {
          ...binding,
          syncedSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
          syncedSecretHashes: {
            RAILWAY_API_TOKEN: sha256('railway-token'),
            IMAGE_REGISTRY_USERNAME: sha256('dave'),
            IMAGE_REGISTRY_TOKEN: sha256(params.syncedPackageReadToken ?? params.packageReadToken),
          },
        },
      },
    },
  });
  mockObservingAdapter({
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    projectId: 'rp-1',
    environmentId: 'rail-env-1',
    services: [{
      name: 'web',
      externalId: 'svc-1',
      workloadKind: 'web',
      customDomains: [],
      config: { startCommand: 'npm start' },
      envVarKeys: [],
      envVarHashes: {},
      status: 'running',
    }],
    databases: [],
    partial: false,
    warnings: [],
  });
  mockLiveWorkflow(workflow);
  return ciProject;
}

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-plan-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  project = new ProjectRepository().create({ name: 'plan-test', defaultPlatform: 'railway' });
  vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
  vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets').mockResolvedValue([
    'RAILWAY_API_TOKEN',
    'IMAGE_REGISTRY_USERNAME',
    'IMAGE_REGISTRY_TOKEN',
    'DATABASE_URL',
  ]);
  new SpecStore().replace(project, {
    version: 1,
    project: project.name,
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: { web: { startCommand: 'npm start' } },
        envVars: { NODE_ENV: 'staging' },
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockObservingAdapter(observed: ObservedState, extra: Record<string, unknown> = {}) {
  const normalizedObserved: ObservedState = {
    ...observed,
    services: observed.services.map((service) => ({
      ...service,
      sourceState: service.sourceState ?? (service.source ? 'connected' : 'disconnected'),
    })),
  };
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
    success: true,
    adapter: {
      ...extra,
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {},
      verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('unused'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      observe: async () => normalizedObserved,
    },
  });
}

describe('PlanService.plan', () => {
  it('defers an initially unbound Cloud Run seed until managed CI has exact provider bindings', async () => {
    project = new ProjectRepository().update(project.id, {
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'https://github.com/davejohnson/cloudrun-seed-app.git',
    })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      runtime: {
        kind: 'node',
        version: '22',
        installCommand: 'npm ci',
      },
      environments: {
        staging: {
          hosting: { provider: 'cloudrun', region: 'us-central1' },
          services: {
            web: {
              workloadKind: 'web' as const,
              startCommand: 'npm start',
              healthCheckPath: '/ready',
              public: true,
            },
          },
          database: {
            provider: 'cloudsql',
            engine: 'postgres',
            seedCommand: 'npm run db:seed',
          },
          email: { enabled: false },
          envVars: {},
          envFile: { mode: 'off' },
          deploy: {
            strategy: 'branch',
            trigger: 'ci',
            branch: 'main',
          },
        },
      },
    });

    const result = await new PlanService().plan(project, 'staging', {
      includeEnvFile: false,
    });

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.scope).toBe('managed-ci-bindings');
    expect(plan.actions.find((action) => action.metadata?.operation === 'githubActionsRelease'))
      .toBeUndefined();
    expect(plan.actions.find((action) => action.metadata?.operation === 'databaseSeed'))
      .toBeUndefined();
    expect(plan.actions.some((action) => action.resource.kind === 'ci')).toBe(false);
    expect(plan.warnings).toContainEqual(expect.stringContaining(
      'Managed CI reconciliation is deferred until provider identity changes converge.'
    ));
    expect(new RunRepository().findById(plan.planRunId)?.status).toBe('succeeded');
  });

  it('freezes the repository HEAD into a managed Cloud Run deployment plan', async () => {
    const oldCwd = process.cwd();
    const oldDisableRepoSpec = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-source-sha-plan-'));
    const spec = {
      version: 1,
      project: 'source-sha-app',
      gitRemoteUrl: 'https://github.com/davejohnson/source-sha-app.git',
      environments: {
        staging: {
          hosting: { provider: 'cloudrun', region: 'us-central1' },
          services: { web: { workloadKind: 'web', public: true } },
          email: { enabled: false },
          envVars: {},
          envFile: { mode: 'off' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    };
    mkdirSync(path.join(root, '.hypervibe'));
    writeFileSync(path.join(root, '.hypervibe', 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@hypervibe.dev'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Hypervibe Test'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', spec.gitRemoteUrl], { cwd: root });
    execFileSync('git', ['add', '.hypervibe/spec.json'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'test fixture'], { cwd: root, stdio: 'ignore' });
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      process.chdir(root);
      const sourceProject = new ProjectRepository().create({
        name: spec.project,
        defaultPlatform: 'cloudrun',
        gitRemoteUrl: spec.gitRemoteUrl,
      });
      new EnvironmentRepository().create({
        projectId: sourceProject.id,
        name: 'staging',
        platformBindings: {
          provider: 'cloudrun',
          projectId: 'source-sha-gcp-project',
          environmentId: 'us-central1',
          providerScope: {
            projectId: 'source-sha-gcp-project',
            region: 'us-central1',
          },
          services: { web: { serviceId: 'source-sha-web' } },
        },
      });

      const result = await new PlanService().plan(sourceProject, 'staging', {
        includeEnvFile: false,
      });

      expect(result).not.toHaveProperty('error');
      const plan = result as Exclude<typeof result, { error: string }>;
      expect(plan.specSource).toEqual({
        kind: 'repo',
        path: path.join(realpathSync(root), '.hypervibe', 'spec.json'),
      });
      expect(new RunRepository().findById(plan.planRunId)?.plan).toMatchObject({
        sourceCommitSha: expectedSha,
      });

      spec.environments.staging.envVars = { UNCOMMITTED: 'true' };
      writeFileSync(path.join(root, '.hypervibe', 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
      const dirtyResult = await new PlanService().plan(sourceProject, 'staging', {
        includeEnvFile: false,
      });
      expect(dirtyResult).toEqual({
        error: expect.stringContaining('will not plan a first Cloud Run release'),
      });
    } finally {
      process.chdir(oldCwd);
      if (oldDisableRepoSpec === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisableRepoSpec;
    }
  });

  it('errors when the project has no spec', async () => {
    const bare = new ProjectRepository().create({ name: 'no-spec' });
    expect(bare.defaultPlatform).toBe('unconfigured');
    const result = await new PlanService().plan(bare, 'staging');
    expect(result).toMatchObject({ error: expect.stringContaining('hv_spec') });
  });

  it('errors when the environment is not in the spec', async () => {
    const result = await new PlanService().plan(project, 'production');
    expect(result).toMatchObject({ error: expect.stringContaining('production') });
  });

  it('rejects unsupported application-managed queue options before observation or plan persistence', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          database: { provider: 'railway' },
          services: { jobs: { workloadKind: 'worker' } },
          queues: { jobs: { ackDeadlineSeconds: 120 } },
        },
      },
    });
    const providerAdapter = vi.spyOn(adapterFactory, 'getProviderAdapter');
    const hostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapter');
    const databaseAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');

    const result = await new PlanService().plan(project, 'staging');

    expect(result).toEqual({
      error: expect.stringContaining('do not support ackDeadlineSeconds'),
    });
    expect(providerAdapter).not.toHaveBeenCalled();
    expect(hostingAdapter).not.toHaveBeenCalled();
    expect(databaseAdapter).not.toHaveBeenCalled();
    expect(new EnvironmentRepository().findByProjectId(project.id)).toEqual([]);
    expect(new RunRepository().findByProjectId(project.id)).toEqual([]);
  });

  it('orders a compatible same-cloud cache behind a differently named hosting project', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'azure-container-apps' },
          cache: { provider: 'azure-managed-redis', engine: 'redis' },
          services: {},
        },
      },
    });

    const result = await new PlanService().plan(project, 'production');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions.find((action) => action.id === 'cache:azure-managed-redis'))
      .toMatchObject({
        type: 'create',
        dependsOn: ['project:azure-container-apps'],
      });
  });

  it('plans GitHub collaboration only on the canonical environment and blocks missing GitHub connection', async () => {
    const projectRepo = new ProjectRepository();
    project = projectRepo.update(project.id, { gitRemoteUrl: 'https://github.com/davejohnson/plan-test' })!;
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      collaboration: {},
      environments: {
        staging: { hosting: { provider: 'railway' }, services: { web: {} } },
        production: { hosting: { provider: 'railway' }, services: { web: {} } },
      },
    });

    const production = await new PlanService().plan(project, 'production');
    expect(production).not.toHaveProperty('error');
    const productionPlan = production as Exclude<typeof production, { error: string }>;
    expect(productionPlan.actions.find((action) => action.id === 'repo:github-collaboration')).toMatchObject({
      type: 'update',
      resource: { kind: 'repo', name: 'davejohnson/plan-test', provider: 'github' },
    });
    expect(productionPlan.blocked).toEqual([
      expect.objectContaining({ provider: 'github', scope: 'davejohnson/plan-test' }),
    ]);
    expect(productionPlan.blocked[0]?.reason).toContain('https://github.com/settings/tokens');

    const staging = await new PlanService().plan(project, 'staging');
    expect(staging).not.toHaveProperty('error');
    const stagingPlan = staging as Exclude<typeof staging, { error: string }>;
    expect(stagingPlan.actions.find((action) => action.id === 'repo:github-collaboration')).toBeUndefined();
  });

  it('produces a verified plan from observed state and persists the plan run', async () => {
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'node old.js' },
        envVarKeys: ['NODE_ENV'],
        envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'staging');
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(true);
    const web = plan.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.diff).toContainEqual({ field: 'startCommand', from: 'node old.js', to: 'npm start' });

    const run = new RunRepository().findById(plan.planRunId)!;
    expect(run.type).toBe('plan');
    const doc = run.plan as Record<string, unknown>;
    expect(doc.kind).toBe('hv_plan');
    expect(doc.specRevision).toBe(plan.specRevision);
    expect(doc.observedFingerprint).toBeTruthy();
  });

  it('plans Redis before service wiring through the shared provider lifecycle', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          cache: {
            provider: 'railway', engine: 'redis', region: 'ca-central-1',
            network: 'default', subnetwork: 'default', tier: 'BASIC', size: '1gb',
          },
          envVars: { NODE_ENV: 'staging' },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 's-1' } },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: {},
      envVarSpec: {},
    });
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    const configureCacheTarget = vi.fn();
    const observeCache = vi.fn(async () => null);
    vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedCaches: ['redis'], supportsTls: true, supportsHighAvailability: false,
          supportsPersistence: true, serverlessOptimized: false,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        configureTarget: configureCacheTarget,
        provision: async () => { throw new Error('unused'); },
        getConnectionUrl: async () => null,
        destroy: async () => ({ success: true, message: 'unused' }),
        observeCache,
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: ['NODE_ENV'],
        envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [],
      caches: [],
      completeness: { caches: 'unknown' },
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions.find((action) => action.id === 'cache:railway')).toMatchObject({
      type: 'create',
      verified: true,
      billable: true,
      resource: { kind: 'cache', name: 'redis', provider: 'railway' },
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: 'ca-central-1', network: 'default', subnetwork: 'default',
        tier: 'BASIC', size: '1gb',
      },
    });
    expect(plan.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      dependsOn: expect.arrayContaining(['cache:railway']),
    });
    expect(plan.blocked).toEqual([]);
    expect(configureCacheTarget).toHaveBeenCalledWith({
      projectName: project.name,
      region: 'ca-central-1', network: 'default', subnetwork: 'default',
      tier: 'BASIC', size: '1gb',
    });
    expect(observeCache).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'staging' }),
      undefined,
      expect.objectContaining({ projectName: project.name, region: 'ca-central-1' })
    );
  });

  it('persists hash-only Stripe environment drift with service dependencies', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          payments: {
            stripe: {
              catalog: {
                products: {
                  starter: {
                    name: 'Invoice Perfect Starter',
                    prices: {
                      monthly: {
                        unitAmount: 4900,
                        currency: 'cad',
                        interval: 'month',
                        envVar: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 's-1' } },
        payments: {
          stripe: {
            environment: 'staging',
            catalog: {
              products: {
                starter: {
                  productId: 'prod_starter',
                  name: 'Invoice Perfect Starter',
                  prices: {
                    monthly: {
                      priceId: 'price_starter_month',
                      envVar: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
                      unitAmount: 4900,
                      currency: 'cad',
                      interval: 'month',
                    },
                  },
                },
              },
            },
            webhooks: {},
          },
        },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web' });
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    seedVerifiedConnection('stripe', { secretKey: 'sk_test_staging' }, 'staging');
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'node old.js' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(StripeAdapter.prototype, 'listProducts').mockResolvedValue([{
      id: 'prod_starter',
      name: 'Invoice Perfect Starter',
      description: null,
      active: true,
      metadata: {},
      created: 1,
      updated: 1,
    }]);
    vi.spyOn(StripeAdapter.prototype, 'listPrices').mockResolvedValue([{
      id: 'price_starter_month',
      product: 'prod_starter',
      active: true,
      currency: 'cad',
      unit_amount: 4900,
      recurring: { interval: 'month', interval_count: 1 },
      type: 'recurring',
      metadata: {},
      nickname: null,
      created: 1,
    }]);

    const result = await new PlanService().plan(project, 'staging');
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    const payment = plan.actions.find((action) =>
      action.metadata?.operation === 'stripeHostingEnvSync'
    )!;
    expect(payment).toMatchObject({
      type: 'update',
      dependsOn: ['service:web'],
      diff: [{ field: 'env:STRIPE_STARTER_MONTHLY_PRICE_ID' }],
    });
    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(document.integrationFingerprints).toMatchObject({ stripe: expect.any(String) });
    expect(JSON.stringify(document)).not.toContain('sk_test_staging');
  });

  it('deploys the exact desired commit before running a newly declared seed command', async () => {
    project = new ProjectRepository().update(project.id, {
      gitRemoteUrl: 'https://github.com/dave/plan-test',
    })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          database: {
            provider: 'railway',
            engine: 'postgres',
            seedCommand: 'npm run db:seed:personas -- --dataset=invoice-perfect-v1',
          },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          payments: {
            stripe: {
              environment: 'staging',
              services: ['web'],
              credentials: { secretKeyEnvVar: 'STRIPE_SECRET_KEY' },
              catalog: {
                products: {
                  starter: {
                    name: 'Invoice Perfect Starter',
                    prices: {
                      monthly: {
                        unitAmount: 4900,
                        currency: 'cad',
                        interval: 'month',
                        envVar: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
                      },
                    },
                  },
                },
              },
              webhooks: {
                billing: {
                  url: 'https://development.example.com/webhooks/stripe',
                  service: 'web',
                  envVar: 'STRIPE_WEBHOOK_SECRET',
                  events: ['customer.subscription.updated'],
                },
              },
            },
          },
        },
      },
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 's-1' } },
      },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'db-1',
      bindings: { provider: 'railway', projectId: 'rp-1', serviceId: 'db-1' },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web' });
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    seedVerifiedConnection('stripe', { secretKey: 'rk_test_staging' }, 'staging');
    seedVerifiedConnection('github', {
      apiToken: 'github-token',
      login: 'dave',
      packageReadToken: 'package-token',
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [{
        provider: 'railway',
        engine: 'postgres',
        externalId: 'db-1',
        status: 'running',
      }],
      partial: false,
      warnings: [],
    }, {
      getServiceVariables: async () => ({
        DATABASE_PUBLIC_URL: 'postgresql://test:password@db.example.test:5432/app',
      }),
    });
    vi.spyOn(StripeAdapter.prototype, 'listProducts').mockResolvedValue([]);
    vi.spyOn(StripeAdapter.prototype, 'listPrices').mockResolvedValue([]);
    vi.spyOn(StripeAdapter.prototype, 'listWebhookEndpoints').mockResolvedValue([]);
    const { workflow, binding } = railwayWorkflowFixture(project, 'staging');
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      ci: {
        deployBranch: {
          [workflow.path]: {
            ...binding,
            syncedSecrets: [
              'DATABASE_URL',
              'RAILWAY_API_TOKEN',
              'IMAGE_REGISTRY_USERNAME',
              'IMAGE_REGISTRY_TOKEN',
            ],
            syncedSecretHashes: {
              DATABASE_URL: sha256('postgresql://test:password@db.example.test:5432/app'),
              RAILWAY_API_TOKEN: sha256('railway-token'),
              IMAGE_REGISTRY_USERNAME: sha256('dave'),
              IMAGE_REGISTRY_TOKEN: sha256('package-token'),
            },
          },
        },
      },
    });
    mockLiveWorkflow(workflow);
    vi.spyOn(GitHubAdapter.prototype, 'getEnvironmentVariable').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({
      ref: 'refs/heads/main',
      object: { sha: 'a'.repeat(40) },
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
      total_count: 0,
      workflow_runs: [],
    });

    const result = await new PlanService().plan(project, 'staging');
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    const seed = plan.actions.find((action) => action.metadata?.operation === 'databaseSeed');
    const release = plan.actions.find((action) => action.metadata?.operation === 'githubActionsRelease');
    const appliedSpecHash = plan.actions.find((action) =>
      action.id === 'ci:github-actions:staging:applied-spec-hash'
    );

    expect(seed).toMatchObject({
      type: 'update',
      dependsOn: expect.arrayContaining(['ci:github-actions:staging:release']),
    });
    expect(release).toMatchObject({
      type: 'update',
      resource: { kind: 'ci', name: 'release:staging', provider: 'github' },
      metadata: {
        targetSha: 'a'.repeat(40),
        workflow: '.github/workflows/deploy-railway-staging.yml',
      },
      dependsOn: expect.arrayContaining([
        'ci:github-actions:staging:applied-spec-hash',
      ]),
    });
    expect(appliedSpecHash).toMatchObject({
      dependsOn: expect.arrayContaining([
        'payment:stripe:staging:catalog:product:starter',
        'payment:stripe:staging:catalog:price:starter:monthly',
        'payment:stripe:staging:hosting-env:web',
        'payment:stripe:staging:webhook:billing',
      ]),
    });
    expect(appliedSpecHash?.dependsOn).not.toContain(seed?.id);
    const orderedIds = orderActions(plan.actions).map((action) => action.id);
    expect(orderedIds.indexOf(appliedSpecHash!.id)).toBeLessThan(orderedIds.indexOf(release!.id));
    expect(orderedIds.indexOf(release!.id)).toBeLessThan(orderedIds.indexOf(seed!.id));
  });

  it('plans bound Stripe webhook deletion before destroying its hosting service', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {},
        },
      },
    });
    const endpoint = {
      id: 'we_billing',
      url: 'https://billing.example.com/api/webhooks/stripe',
      status: 'enabled' as const,
      enabled_events: ['checkout.session.completed'],
      metadata: {},
      created: 1,
    };
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 's-1' } },
        payments: {
          stripe: {
            environment: 'staging',
            webhooks: {
              billing: {
                endpointId: endpoint.id,
                url: endpoint.url,
                events: endpoint.enabled_events,
                service: 'web',
                envVar: 'STRIPE_WEBHOOK_SECRET',
                valueHash: hashEnvValue('bound-signing-value'),
              },
            },
          },
        },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web' });
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    seedVerifiedConnection('stripe', { secretKey: 'sk_test_staging' }, 'staging');
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: {},
        envVarKeys: ['STRIPE_WEBHOOK_SECRET'],
        envVarHashes: { STRIPE_WEBHOOK_SECRET: hashEnvValue('bound-signing-value') },
        status: 'running',
      }],
      databases: [],
      completeness: { services: 'complete' },
      partial: false,
      warnings: [],
    });
    vi.spyOn(StripeAdapter.prototype, 'listWebhookEndpoints').mockResolvedValue([endpoint]);

    const result = await new PlanService().plan(project, 'staging');
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    const webhookDestroy = plan.actions.find((action) =>
      action.metadata?.operation === 'stripeWebhookDestroy'
    );
    const serviceDestroy = plan.actions.find((action) =>
      action.resource.kind === 'service'
      && action.resource.name === 'web'
      && action.type === 'destroy'
    );
    expect(webhookDestroy).toMatchObject({
      type: 'destroy',
      requiresConfirm: true,
      resource: { kind: 'payment', name: 'billing', provider: 'stripe' },
      metadata: { endpointId: endpoint.id, service: 'web' },
    });
    expect(serviceDestroy?.dependsOn).toContain(webhookDestroy?.id);
    const document = new RunRepository().findById(plan.planRunId)!.plan;
    expect(JSON.stringify(document)).not.toContain('bound-signing-value');
  });

  it('requires env-var retirement to be a separate release after service config converges', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'staging', NEW_API_TOKEN_NAME: 'enabled' },
          removeEnvVars: ['OLD_API_TOKEN_NAME'],
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 's-1' } },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: ['NODE_ENV', 'OLD_API_TOKEN_NAME'],
        envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'staging');
    expect(result).toMatchObject({
      error: expect.stringContaining('two-release rollout'),
    });
  });

  it('does not allow tombstones for environment keys owned by declared infrastructure', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          database: { provider: 'railway' },
          removeEnvVars: ['DATABASE_URL'],
        },
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      services: [],
      databases: [],
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'staging');
    expect(result).toMatchObject({
      error: expect.stringContaining('Hypervibe-managed infrastructure keys'),
    });
  });

  it('falls back to unverified local diff when the provider has no adapter', async () => {
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(false);
    expect(plan.actions.every((a) => !a.verified)).toBe(true);
    // Unknown provider observation must not authorize environment creation.
    expect(plan.actions.find((a) => a.id === 'environment:staging')).toMatchObject({
      type: 'update',
      metadata: {
        operation: 'hostingEnvironmentEnsure',
        blockedReason: 'environment_observation_unknown',
      },
    });
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'staging')).toBeTruthy();
  });

  it('reuses a shared Railway project binding when planning a new environment', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          database: { provider: 'railway', engine: 'postgres' },
          envVars: { NODE_ENV: 'production' },
        },
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          database: { provider: 'railway', engine: 'postgres' },
          envVars: { NODE_ENV: 'staging' },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-canonical',
        environmentId: 'rail-env-prod',
        services: { web: { serviceId: 'svc-prod' } },
      },
    });
    const observedBindings: Record<string, unknown>[] = [];
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedBuilders: ['nixpacks'],
          supportedComponents: ['postgres'],
          supportsAutoWiring: true,
          supportsHealthChecks: true,
          supportsCronSchedule: true,
          supportsReleaseCommand: false,
          supportsMultiEnvironment: true,
          managedTls: true,
          supportsObserve: true,
        },
        connect: async () => {},
        verify: async () => ({ success: true }),
        ensureProject: async () => ({ success: true, message: 'ok' }),
        ensureComponent: async () => { throw new Error('unused'); },
        deploy: async () => { throw new Error('unused'); },
        setEnvVars: async () => ({ success: true, message: 'ok' }),
        observe: async (environment: Environment) => {
          observedBindings.push(environment.platformBindings);
          return {
            provider: 'railway',
            observedAt: new Date().toISOString(),
            projectExists: true,
            projectId: 'rail-project-canonical',
            services: [],
            databases: [],
            completeness: {
              project: 'complete',
              environment: 'complete',
              services: 'complete',
              databases: 'complete',
              storage: 'complete',
            },
            partial: false,
            warnings: ['Could not resolve Railway environment for "staging"'],
          };
        },
      },
    });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions.find((a) => a.id === 'project:railway')).toBeUndefined();
    expect(plan.actions.find((a) => a.id === 'environment:staging')?.type).toBe('create');
    expect(plan.actions.find((a) => a.id === 'service:web')?.type).toBe('create');
    expect(plan.actions.find((a) => a.id === 'database:railway')?.type).toBe('create');
    expect(observedBindings[0]).toMatchObject({
      provider: 'railway',
      projectId: 'rail-project-canonical',
    });
    expect(plan.warnings).toContain(
      'Reusing Railway project binding rail-project-canonical from environment "production" for environment "staging".'
    );
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'staging')?.platformBindings).toMatchObject({
      provider: 'railway',
      projectId: 'rail-project-canonical',
    });
  });

  it('uses a derived datastore observer when same-provider hosting service observation is incomplete', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {},
          database: { provider: 'railway', engine: 'postgres' },
        },
      },
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'tea-owner-1',
        services: {},
      },
    });
    const component = new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'database-1',
      bindings: {
        provider: 'railway',
        projectId: 'tea-owner-1',
        instanceId: 'database-1',
      },
    });
    seedVerifiedConnection('railway', { apiKey: 'derived-provider-key' });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedBuilders: ['dockerfile'],
          supportedComponents: [],
          supportsAutoWiring: false,
          supportsHealthChecks: true,
          supportsCronSchedule: true,
          supportsReleaseCommand: false,
          supportsMultiEnvironment: false,
          managedTls: true,
          supportsObserve: true,
        },
        connect: async () => {},
        verify: async () => ({ success: true }),
        ensureProject: async () => ({ success: true, message: 'ok' }),
        ensureComponent: async () => { throw new Error('unused'); },
        deploy: async () => { throw new Error('unused'); },
        setEnvVars: async () => ({ success: true, message: 'ok' }),
        observe: async () => ({
          provider: 'railway',
          observedAt: new Date().toISOString(),
          projectExists: true,
          projectId: 'tea-owner-1',
          services: [],
          databases: [{
            provider: 'railway',
            engine: 'postgres',
            externalId: 'database-extra',
            name: 'unmanaged-postgres',
            status: 'running',
          }],
          caches: [],
          completeness: {
            project: 'complete',
            environment: 'complete',
            services: 'unknown',
            databases: 'complete',
            caches: 'unknown',
            storage: 'complete',
          },
          partial: false,
          warnings: [],
        }),
      },
    });
    const observeDatabase = vi.fn(async (
      _environment: Environment,
      observedComponent?: typeof component | null
    ) => {
      expect(observedComponent?.externalId).toBe('database-1');
      return {
        provider: 'railway',
        engine: 'postgres',
        externalId: 'database-1',
        name: 'plan-test-staging-postgres',
        status: 'running',
      };
    });
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedDatabases: ['postgres'],
          supportsPooling: true,
          supportsReadReplicas: true,
          supportsPointInTimeRecovery: true,
          serverlessOptimized: false,
        },
        connect: async () => {},
        verify: async () => ({ success: true }),
        provision: async () => { throw new Error('unused'); },
        getConnectionUrl: async () => null,
        destroy: async () => ({ success: true, message: 'unused' }),
        observeDatabase,
      } as never,
    });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions.find((action) => action.id === 'database:railway'))
      .toMatchObject({ type: 'noop', verified: true });
    expect(observeDatabase).toHaveBeenCalledOnce();
    expect(plan.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'database',
      detail: expect.stringContaining('database-extra'),
    }));
  });

  it('reconciles a bound Railway database when hosting reports its provider service as a workload', async () => {
    const databaseId = '6b5f-railway-postgres-service';
    const seedCommand = 'npm run db:seed';
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {},
          database: { provider: 'railway', engine: 'postgres', seedCommand },
        },
      },
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-1',
        environmentId: 'rail-environment-1',
        services: {},
      },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: databaseId,
      bindings: {
        provider: 'railway',
        projectId: 'rail-project-1',
        environmentId: 'rail-environment-1',
        serviceId: databaseId,
        resourceKind: 'service',
        pluginName: 'Postgres',
        seed: {
          commandHash: sha256(seedCommand),
          seededAt: '2026-09-07T12:00:00.000Z',
        },
      },
    });
    const observedState: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rail-project-1',
      environmentId: 'rail-environment-1',
      services: [{
        name: 'Postgres',
        externalId: databaseId,
        workloadKind: 'web',
        customDomains: [],
        config: {},
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'complete',
      },
      partial: false,
      warnings: [],
    };
    mockObservingAdapter(structuredClone(observedState));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: createRailwayDatabaseAdapter({
        hostingAdapter: { observe: async () => structuredClone(observedState) } as never,
        envRepo: new EnvironmentRepository(),
      }),
    });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect({
      database: plan.actions.find((action) => action.id === 'database:railway')?.type,
      seed: plan.actions.find((action) => action.id === 'database:railway:seed')?.type,
      unmanaged: plan.unmanaged.filter((item) => item.name === 'Postgres'),
    }).toEqual({ database: 'noop', seed: 'noop', unmanaged: [] });

    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      services: { web: { serviceId: databaseId } },
    });
    const conflicted = await new PlanService().plan(project, 'staging');
    expect(conflicted).toEqual({
      error: expect.stringContaining('bound as both the database and application service web'),
    });
  });

  it('plans Railway environment scaffolding before storage when a shared project has no target environment', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
        },
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {}, worker: { workloadKind: 'worker' } },
          database: { provider: 'railway', engine: 'postgres' },
          storage: {
            documents: {
              provider: 'railway',
              type: 'bucket',
              region: 'sjc',
              injectInto: ['web', 'worker'],
            },
          },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-canonical',
        environmentId: 'rail-env-prod',
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-canonical',
        environmentId: 'rail-env-stale',
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rail-project-canonical',
      services: [],
      databases: [],
      storage: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'unknown',
        databases: 'unknown',
        storage: 'unknown',
      },
      partial: true,
      warnings: ['Railway environment "staging" does not exist'],
    });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    const environmentAction = plan.actions.find((action) => action.id === 'environment:staging');
    expect(environmentAction).toMatchObject({
      type: 'create',
      resource: { kind: 'environment', provider: 'railway' },
      metadata: { operation: 'hostingEnvironmentEnsure' },
    });
    expect(plan.actions.find((action) => action.id === 'project:railway')).toBeUndefined();
    for (const actionId of [
      'storage:documents',
      'database:railway',
      'service:web',
      'service:worker',
    ]) {
      expect(plan.actions.find((action) => action.id === actionId)?.dependsOn)
        .toContain('environment:staging');
    }
  });

  it('creates and binds the Railway environment before returning pending for a fresh plan', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
        },
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          storage: {
            documents: {
              provider: 'railway',
              type: 'bucket',
              region: 'sjc',
              injectInto: ['web'],
            },
          },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-canonical',
        environmentId: 'rail-env-prod',
      },
    });
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    const missingEnvironmentObservation: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rail-project-canonical',
      services: [],
      databases: [],
      storage: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'unknown',
        databases: 'unknown',
        storage: 'unknown',
      },
      partial: true,
      warnings: ['Railway environment "staging" does not exist'],
    };
    mockObservingAdapter(missingEnvironmentObservation);
    const ensureEnvironment = vi.fn(async () => ({
      success: true,
      message: 'Created Railway environment: staging',
      data: {
        projectId: 'rail-project-canonical',
        environmentId: 'rail-env-staging',
        created: true,
      },
    }));
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: { supportsObserve: true },
        ensureEnvironment,
      },
    } as never);
    const storageAdapter = vi.spyOn(adapterFactory, 'getStorageAdapter');

    const planned = await new PlanService().plan(project, 'staging');
    expect(planned).not.toHaveProperty('error');
    const plan = planned as Exclude<typeof planned, { error: string }>;
    const currentSpec = new SpecStore().get(project)!;

    const outcome = await executePlanApply(createToolContext(), {
      project,
      spec: currentSpec.spec,
      specRevision: currentSpec.revision,
      planId: plan.planRunId,
      confirmActions: [],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: expect.arrayContaining([
          expect.objectContaining({
            actionId: 'environment:staging',
            status: 'pending',
          }),
          expect.objectContaining({
            actionId: 'storage:documents',
            status: 'aborted',
          }),
        ]),
      },
    });
    expect(ensureEnvironment).toHaveBeenCalledOnce();
    expect(storageAdapter).not.toHaveBeenCalled();
    expect(
      new EnvironmentRepository()
        .findByProjectAndName(project.id, 'staging')
        ?.platformBindings
    ).toMatchObject({
      provider: 'railway',
      projectId: 'rail-project-canonical',
      environmentId: 'rail-env-staging',
    });
  });

  it('plans storage creation after the bound Railway environment confirms an empty storage list', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          storage: {
            documents: {
              provider: 'railway',
              type: 'bucket',
              region: 'sjc',
              injectInto: ['web'],
            },
          },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-canonical',
        environmentId: 'rail-env-staging',
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rail-project-canonical',
      environmentId: 'rail-env-staging',
      services: [],
      databases: [],
      storage: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'complete',
        storage: 'complete',
      },
      partial: false,
      warnings: [],
    });
    const storageAdapter = vi.spyOn(adapterFactory, 'getStorageAdapter');

    const result = await new PlanService().plan(project, 'staging');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions.find((action) => action.id === 'environment:staging')).toBeUndefined();
    expect(plan.actions.find((action) => action.id === 'storage:documents')).toMatchObject({
      type: 'create',
      billable: true,
      metadata: expect.not.objectContaining({
        blockedReason: 'storage_observation_unknown',
      }),
    });
    expect(storageAdapter).not.toHaveBeenCalled();
  });

  it('resolves standalone storage scope read-only before first-use observation', async () => {
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp', environmentId: 're' },
    });
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { web: {} },
      storage: {
        documents: { provider: 's3', type: 'bucket', region: 'us-west-2', injectInto: ['web'] },
      },
      email: { enabled: false },
      envVars: {},
    });
    mockObservingAdapter({
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
      projectId: 'rp', environmentId: 're', services: [], databases: [], storage: [],
      completeness: {
        project: 'complete', environment: 'complete', services: 'complete',
        databases: 'complete', caches: 'complete', storage: 'complete',
      },
      partial: false, warnings: [],
    });
    const resolveObservationContext = vi.fn(async () => ({
      receipt: { success: true, message: 'scope resolved read-only' },
      context: { accountId: '123456789012', region: 'us-west-2' },
    }));
    const observe = vi.fn(async () => []);
    vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 's3',
        resolveObservationContext,
        observe,
      },
    } as never);

    const result = await new PlanService().observeEnvironment(project, environment, environmentSpec);

    expect(resolveObservationContext).toHaveBeenCalledWith(project.name, environment, 'us-west-2');
    expect(observe).toHaveBeenCalledWith(environment, { accountId: '123456789012', region: 'us-west-2' });
    expect(result.observed?.completeness?.storage).toBe('complete');
    expect(result.observed?.completeness?.storageByProvider).toEqual({ s3: 'complete' });
  });

  it('observes a removed persisted storage provider and records its failure as provider-unknown', async () => {
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp',
        environmentId: 're',
        storageProviders: { s3: { accountId: '123456789012', region: 'us-west-2' } },
        storage: {
          archives: {
            provider: 's3',
            externalId: 'plan-test-archives',
            region: 'us-west-2',
            services: [],
            envKeys: [],
          },
        },
      },
    });
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { web: {} },
    });
    mockObservingAdapter({
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
      projectId: 'rp', environmentId: 're', services: [], databases: [], storage: [],
      completeness: {
        project: 'complete', environment: 'complete', services: 'complete',
        databases: 'complete', caches: 'complete', storage: 'complete',
      },
      partial: false, warnings: [],
    });
    const observe = vi.fn(async () => {
      throw new Error('AWS inventory unavailable');
    });
    vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 's3', observe },
    } as never);

    const result = await new PlanService().observeEnvironment(project, environment, environmentSpec);

    expect(observe).toHaveBeenCalledWith(environment, { accountId: '123456789012', region: 'us-west-2' });
    expect(result.observed?.completeness?.storage).toBe('unknown');
    expect(result.observed?.completeness?.storageByProvider).toEqual({ s3: 'unknown' });
    expect(result.observed?.warnings).toContain('Storage observation failed (s3): AWS inventory unavailable');
  });

  it('keeps equal storage ids in different provider scopes as distinct observations', async () => {
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'current-project',
        environmentId: 'current-environment',
        storage: {
          first: {
            provider: 'railway', externalId: 'bucket-reused', region: 'sjc', services: [], envKeys: [],
            instanceScope: { projectId: 'project-one', environmentId: 'environment-one' },
          },
          second: {
            provider: 'railway', externalId: 'bucket-reused', region: 'sjc', services: [], envKeys: [],
            instanceScope: { projectId: 'project-two', environmentId: 'environment-two' },
          },
        },
      },
    });
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { web: {} },
    });
    mockObservingAdapter({
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
      projectId: 'current-project', environmentId: 'current-environment', services: [], databases: [], storage: [],
      completeness: {
        project: 'complete', environment: 'complete', services: 'complete',
        databases: 'complete', caches: 'complete', storage: 'complete',
      },
      partial: false, warnings: [],
    });
    const observe = vi.fn(async (_environment: Environment, context: Record<string, string>) => (
      context.projectId === 'current-project'
        ? []
        : [{
            provider: 'railway',
            kind: 'object' as const,
            externalId: 'bucket-reused',
            instanceScope: context,
            name: `bucket-${context.projectId}`,
            region: 'sjc',
            status: 'ready' as const,
          }]
    ));
    vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 'railway', observe },
    } as never);

    const result = await new PlanService().observeEnvironment(project, environment, environmentSpec);

    expect(result.observed?.storage).toHaveLength(2);
    expect(result.observed?.storage?.map((item) => item.instanceScope)).toEqual(expect.arrayContaining([
      { projectId: 'project-one', environmentId: 'environment-one' },
      { projectId: 'project-two', environmentId: 'environment-two' },
    ]));
    expect(result.observed?.completeness?.storageByProvider).toEqual({ railway: 'complete' });
  });

  it('preserves a partial storage create id and scope in the failed apply receipt', async () => {
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp', environmentId: 're' },
    });
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { web: {} },
      storage: {
        documents: { provider: 's3', type: 'bucket', region: 'us-west-2', injectInto: [] },
      },
    });
    const instanceScope = { accountId: '123456789012', region: 'us-west-2' };
    vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 's3',
        runtimeEnvKeys: () => [],
        ensureContext: async () => ({
          receipt: { success: true, message: 'context ready' },
          context: instanceScope,
        }),
        ensureBucket: async () => ({
          receipt: {
            success: false,
            message: 'configuration and rollback failed',
            error: 'rollback denied',
            data: { externalId: 'partial-bucket', recoveryRequired: true },
          },
          externalId: 'partial-bucket',
          context: instanceScope,
        }),
      },
    } as never);

    const result = await applyStorageAction({
      project,
      envName: 'staging',
      environmentSpec,
      action: {
        id: 'storage:documents',
        type: 'create',
        resource: { kind: 'storage', name: 'documents', provider: 's3' },
        verified: true,
        reason: 'Create documents bucket',
        billable: true,
        metadata: { operation: STORAGE_OPERATIONS.ensure, storageName: 'documents' },
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: 'rollback denied',
      data: {
        externalId: 'partial-bucket',
        instanceScope,
        recoveryRequired: true,
      },
    });
  });

  it('does not guess the shared provider project when sibling environment bindings disagree', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'staging' },
        },
      },
    });
    const envRepo = new EnvironmentRepository();
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rail-project-1' },
    });
    envRepo.create({
      projectId: project.id,
      name: 'preview',
      platformBindings: { provider: 'railway', projectId: 'rail-project-2' },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'unused' });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).toMatchObject({
      error: expect.stringContaining('multiple existing railway project bindings'),
    });
  });

  it('repairs an empty stale Railway project binding from the shared project binding', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'production' },
        },
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'staging' },
        },
      },
    });
    const envRepo = new EnvironmentRepository();
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rail-project-canonical' },
    });
    const staging = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { projectId: 'rail-project-stale' },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.actions.find((a) => a.id === 'project:railway')).toBeUndefined();
    expect(plan.warnings).toContain(
      'Replaced stale Railway project binding rail-project-stale with shared project binding rail-project-canonical from environment "production" for environment "staging".'
    );
    expect(envRepo.findById(staging.id)?.platformBindings).toMatchObject({
      provider: 'railway',
      projectId: 'rail-project-canonical',
    });
  });

  it('refuses to repair a stale shared project binding when service ids are still attached', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'production' },
        },
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'staging' },
        },
      },
    });
    const envRepo = new EnvironmentRepository();
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rail-project-canonical' },
    });
    envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-stale',
        environmentId: 'rail-env-stale',
        services: { web: { serviceId: 'svc-stale' } },
      },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'unused' });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).toMatchObject({
      error: expect.stringContaining('will not guess because "staging" still has provider environment/service bindings'),
    });
  });

  it('reports blocked providers without verified connections', async () => {
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });
    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.blocked).toContainEqual(expect.objectContaining({ provider: 'railway' }));
  });

  it('accepts an existing primary cloud connection for its storage adapter', () => {
    const connection = new ConnectionRepository().create({
      provider: 'ecs',
      credentialsEncrypted: 'encrypted-for-preflight-only',
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');

    expect(new PlanService().providerPreflight(['s3'])).toEqual([]);
  });

  it('requires a Cloudflare connection that matches the requested domain scope', () => {
    const connRepo = new ConnectionRepository();
    const other = connRepo.create({ provider: 'cloudflare', scope: 'other.com', credentialsEncrypted: 'x' });
    connRepo.updateStatus(other.id, 'verified');

    const service = new PlanService();
    const blocked = service.preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'apreskeys.com',
      email: { enabled: false },
      envVars: {},
    });
    expect(blocked).toContainEqual(expect.objectContaining({
      provider: 'cloudflare',
      reason: expect.stringContaining('apreskeys.com'),
    }));

    const matching = connRepo.create({ provider: 'cloudflare', scope: 'apreskeys.com', credentialsEncrypted: 'x' });
    connRepo.updateStatus(matching.id, 'verified');
    const unblocked = service.preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'apreskeys.com',
      email: { enabled: false },
      envVars: {},
    });
    expect(unblocked.some((entry) => entry.provider === 'cloudflare')).toBe(false);
  });

  it('uses the parent Cloudflare zone scope for subdomain preflight', () => {
    const connRepo = new ConnectionRepository();
    const failedSubdomain = connRepo.create({ provider: 'cloudflare', scope: 'staging.apreskeys.com', credentialsEncrypted: 'x' });
    connRepo.updateStatus(failedSubdomain.id, 'failed');

    const service = new PlanService();
    const missing = service.preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'staging.apreskeys.com',
      email: { enabled: false },
      envVars: {},
    });
    expect(missing).toContainEqual(expect.objectContaining({
      provider: 'cloudflare',
      scope: 'apreskeys.com',
      reason: expect.stringContaining('apreskeys.com'),
    }));

    const parent = connRepo.create({ provider: 'cloudflare', scope: 'apreskeys.com', credentialsEncrypted: 'x' });
    connRepo.updateStatus(parent.id, 'verified');
    const unblocked = service.preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'staging.apreskeys.com',
      email: { enabled: false },
      envVars: {},
    });
    expect(unblocked.some((entry) => entry.provider === 'cloudflare')).toBe(false);
  });

  it('requests the complete replacement credential roles when adding Cloudflare Registrar access', () => {
    seedVerifiedConnection('cloudflare', {
      apiToken: 'cfat_dns',
      accountId: 'account-1',
    }, 'example.com');

    const blocked = new PlanService().preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'example.com',
      domainRegistration: { provider: 'cloudflare', years: 1, register: true },
      email: { enabled: false },
      envVars: {},
    });

    expect(blocked.filter((entry) => entry.provider === 'cloudflare')).toEqual([
      expect.objectContaining({
        requiredCredentialKeys: ['apiToken', 'accountId', 'registrarApiToken'],
        reason: expect.stringContaining('CLOUDFLARE_REGISTRAR_API_TOKEN'),
      }),
    ]);
  });

  it('omits Cloudflare accountId when a user-token connection only needs Registrar replacement', () => {
    seedVerifiedConnection('cloudflare', {
      apiToken: 'cfut_dns',
      registrarApiToken: 'cfat_wrong_kind',
    }, 'example.com');

    const blocked = new PlanService().preflight({
      hosting: { provider: 'railway' },
      services: {},
      domain: 'example.com',
      domainRegistration: { provider: 'cloudflare', years: 1, register: true },
      email: { enabled: false },
      envVars: {},
    });

    expect(blocked.filter((entry) => entry.provider === 'cloudflare')).toEqual([
      expect.objectContaining({
        requiredCredentialKeys: ['apiToken', 'registrarApiToken'],
        reason: expect.stringContaining('stored registrarApiToken is an Account API Token'),
      }),
    ]);
  });

  it('warns when observation fails for a tracked environment', async () => {
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1' },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(false);
    expect(plan.warnings.some((w) => w.includes('Cannot observe'))).toBe(true);
  });

  it('warns when the Railway GitHub App cannot access the branch-deploy repo', async () => {
    project = new ProjectRepository().update(project.id, { gitRemoteUrl: 'https://github.com/dave/seq-planner.git' })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
        },
      },
    });
    mockObservingAdapter(
      {
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      },
      { isGitHubRepoAccessible: async () => false }
    );

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.warnings.some((w) => w.includes("Railway's GitHub App cannot access dave/seq-planner"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('github.com/apps/railway-app'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('project member has connected GitHub'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('pending Railway GitHub App permission updates'))).toBe(true);
  });

  it('resolves an explicit native deploy branch for an arbitrary environment name', () => {
    project = new ProjectRepository().update(project.id, {
      gitRemoteUrl: 'git@github.com:dave/preview-app.git',
    })!;

    expect(new PlanService().expectedDeploySource(project, 'qa-7', {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web' } },
      deploy: { strategy: 'branch', trigger: 'native', branch: 'release/qa-7' },
      email: { enabled: false },
      envVars: {},
    })).toEqual({ repo: 'dave/preview-app', branch: 'release/qa-7' });
  });

  it('warns when branch strategy is set but the project has no GitHub remote', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
        },
      },
    });
    mockObservingAdapter(
      {
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      },
      { isGitHubRepoAccessible: async () => true }
    );

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.warnings.some((w) => w.includes('no GitHub remote'))).toBe(true);
  });

  it('uses spec gitRemoteUrl when the project record has no GitHub remote', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: 'git@github.com:dave/spec-backed.git',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
        },
      },
    });
    const isGitHubRepoAccessible = vi.fn(async () => true);
    mockObservingAdapter(
      {
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      },
      { isGitHubRepoAccessible }
    );

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(isGitHubRepoAccessible).toHaveBeenCalledWith('dave/spec-backed');
    expect(plan.warnings.some((w) => w.includes('no GitHub remote'))).toBe(false);
  });

  it('does not warn when the repo is accessible to Railway', async () => {
    project = new ProjectRepository().update(project.id, { gitRemoteUrl: 'git@github.com:dave/seq-planner.git' })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
        },
      },
    });
    mockObservingAdapter(
      {
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      },
      { isGitHubRepoAccessible: async () => true }
    );

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.warnings.some((w) => w.includes('GitHub App'))).toBe(false);
    expect(plan.warnings.some((w) => w.includes('no GitHub remote'))).toBe(false);
  });

  it('stages a live Railway native-source disconnect before CI workflow convergence', async () => {
    project = new ProjectRepository().update(project.id, {
      gitRemoteUrl: 'git@github.com:dave/invoice-perfect.git',
    })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-production',
        services: {
          web: {
            serviceId: 'svc-web',
            source: { repo: 'dave/invoice-perfect', branch: 'main' },
          },
        },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { startCommand: 'npm start' },
      envVarSpec: {},
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-production',
      services: [{
        name: 'web',
        externalId: 'svc-web',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        source: { repo: 'dave/invoice-perfect', branch: 'main' },
        sourceState: 'connected',
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const sourceAction = plan.actions.find((action) => action.id === 'service:web:deploy-source');
    const ciAction = plan.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch');
    const markerAction = plan.actions.find((action) => action.id === 'ci:github-actions:production:applied-spec-hash');

    expect(sourceAction).toMatchObject({
      type: 'update',
      verified: true,
      metadata: {
        operation: 'providerNativeDeploySourceDisconnect',
        serviceId: 'svc-web',
        desiredDeployMode: 'ci',
      },
    });
    expect(ciAction).toBeUndefined();
    expect(markerAction).toBeUndefined();
    expect(plan.actions).toHaveLength(1);
    expect(plan.warnings).toContain(
      'Railway provider-native deploy-source reconciliation is required before this environment has CI-only deployment ownership.'
    );
    expect(plan.warnings).toContain(
      'This plan is limited to provider-native deploy-source reconciliation. Re-run hv_plan after it converges to review remaining infrastructure drift.'
    );
  });

  it('stages manual production source disconnects before storage and environment drift', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: {
            web: { startCommand: 'npm start' },
            worker: { workloadKind: 'worker', startCommand: 'npm run worker' },
          },
          envVars: { RELEASE_CHANNEL: 'production' },
          storage: {
            documents: {
              provider: 'railway',
              type: 'bucket',
              region: 'sjc',
              injectInto: ['web', 'worker'],
            },
          },
          deploy: { strategy: 'manual' },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-production',
        services: {
          web: {
            serviceId: 'svc-web',
            source: { repo: 'dave/billforge', branch: 'main' },
          },
          worker: {
            serviceId: 'svc-worker',
            source: { repo: 'dave/billforge', branch: 'main' },
          },
        },
      },
    });
    for (const name of ['web', 'worker']) {
      new ServiceRepository().create({
        projectId: project.id,
        name,
        buildConfig: {},
        envVarSpec: {},
      });
    }
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-production',
      services: ['web', 'worker'].map((name) => ({
        name,
        externalId: `svc-${name}`,
        workloadKind: name === 'worker' ? 'worker' : 'web',
        customDomains: [],
        config: {},
        source: { repo: 'dave/billforge', branch: 'main' },
        sourceState: 'connected' as const,
        envVarKeys: [],
        envVarHashes: {},
        status: 'running' as const,
      })),
      databases: [],
      storage: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'complete',
        storage: 'complete',
      },
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;

    expect(plan.actions.map((action) => action.id)).toEqual([
      'service:web:deploy-source',
      'service:worker:deploy-source',
    ]);
    expect(plan.actions.every((action) => action.billable !== true)).toBe(true);
    expect(plan.actions.every((action) => action.metadata?.operation === 'providerNativeDeploySourceDisconnect')).toBe(true);

    const filteredResult = await new PlanService().plan(project, 'production', {
      serviceFilter: ['web'],
    });
    const filteredPlan = filteredResult as Exclude<typeof filteredResult, { error: string }>;
    expect(filteredPlan.actions.map((action) => action.id)).toEqual([
      'service:web:deploy-source',
      'service:worker:deploy-source',
    ]);
  });

  it('isolates required workflow publication from service drift and unconfirmed billable work', async () => {
    project = new ProjectRepository().update(project.id, {
      gitRemoteUrl: 'git@github.com:dave/stable-services.git',
    })!;
    const services = {
      web: { workloadKind: 'web' as const, startCommand: 'npm start', public: true },
      worker: { workloadKind: 'worker' as const, startCommand: 'npm run worker', public: false },
      cron: {
        workloadKind: 'cron' as const,
        startCommand: 'npm run cron',
        cronSchedule: '0 8 * * *',
        public: false,
      },
    };
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
      secrets: {
        UNRELATED_RUNTIME_TOKEN: {
          principal: 'github:alice',
          environments: ['staging'],
        },
      },
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services,
          database: { provider: 'railway', engine: 'postgres' },
          envVars: {
            SEED_CLIENT_TEST_DATA: 'true',
            CARE_PLAN_AI_REQUEST_TIMEOUT_MS: '30000',
          },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    seedVerifiedConnection('github', {
      apiToken: 'gh-token',
      login: 'dave',
      packageReadToken: 'package-token',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-staging',
        services: Object.fromEntries(
          Object.entries(services).map(([name, service]) => [
            name,
            { serviceId: `svc-${name}`, workloadKind: service.workloadKind },
          ])
        ),
      },
    });
    for (const name of Object.keys(services)) {
      new ServiceRepository().create({
        projectId: project.id,
        name,
        buildConfig: { runtime: { kind: 'node', version: '22', installCommand: 'npm ci' } },
        envVarSpec: {},
      });
    }
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-staging',
      services: Object.entries(services).map(([name, service]) => ({
        name,
        externalId: `svc-${name}`,
        workloadKind: service.workloadKind,
        customDomains: [],
        config: {
          startCommand: service.startCommand,
          public: service.public,
          ...('cronSchedule' in service ? { cronSchedule: service.cronSchedule } : {}),
        },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running' as const,
      })),
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'getEnvironmentVariable').mockResolvedValue(null);

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.scope).toBe('managed-ci-publication');
    expect(plan.actions).toHaveLength(1);
    const ciAction = plan.actions[0]!;
    expect(ciAction).toMatchObject({
      id: 'ci:github-actions:staging:deploy-branch',
      type: 'create',
      metadata: { workflowPublicationRequired: true },
    });
    expect(ciAction.dependsOn).toBeUndefined();
    expect(plan.actions.some((action) => action.billable || action.requiresConfirm)).toBe(false);
    expect(plan.blocked).toEqual([]);
    const storedPlan = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(storedPlan.observedFingerprint).toBeNull();
    expect(storedPlan).not.toHaveProperty('inputRequired');
    expect(storedPlan).not.toHaveProperty('integrationFingerprints');
    expect(storedPlan).not.toHaveProperty('overrides');

    const filtered = await new PlanService().plan(project, 'staging', { serviceFilter: ['web'] });
    expect(filtered).toMatchObject({
      error: expect.stringContaining('cannot safely skip pending managed CI reconciliation'),
    });

    const currentSpec = new SpecStore().get(project)!;
    const execute = vi.spyOn(ConvergeExecutor.prototype, 'execute').mockResolvedValue({
      success: true,
      receipts: [],
    });
    const observe = vi.spyOn(PlanService.prototype, 'observeEnvironment');
    const preflight = await executePlanApply(createToolContext(), {
      project,
      spec: currentSpec.spec,
      specRevision: currentSpec.revision,
      planId: plan.planRunId,
      confirmActions: [],
    });
    expect(preflight).toMatchObject({ kind: 'executed' });
    expect(execute).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    execute.mockRestore();
    observe.mockRestore();

  });

  it('reconciles the HLS env-only contract change without republishing managed CI', async () => {
    project = new ProjectRepository().update(project.id, {
      gitRemoteUrl: 'https://github.com/dave/hls-property-care.git',
    })!;
    const specs = new SpecStore();
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { web: { startCommand: 'npm start' } },
      email: { enabled: false },
      envVars: {},
      envFile: { mode: 'off' },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    });
    specs.replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: { staging: environmentSpec },
    });
    const environments = new EnvironmentRepository();
    const environment = environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'hls-project',
        environmentId: 'hls-staging',
        services: { web: { serviceId: 'hls-web' } },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web' });
    const {
      workflow: acceptedWorkflow,
      binding: acceptedWorkflowBinding,
    } = railwayWorkflowFixture(project, 'staging');
    const oldContractHash = environmentDeploymentContractHash(
      specs.get(project)!.spec,
      'staging'
    );
    specs.replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        staging: {
          ...environmentSpec,
          envVars: {
            SEED_CLIENT_TEST_DATA: 'true',
            CARE_PLAN_AI_REQUEST_TIMEOUT_MS: '30000',
          },
        },
      },
    });
    const desired = specs.get(project)!;
    const desiredContractHash = environmentDeploymentContractHash(desired.spec, 'staging');
    expect(desiredContractHash).not.toBe(oldContractHash);
    const desiredWorkflow = railwayWorkflowFixture(project, 'staging');
    expect(desiredWorkflow.workflow.content).toBe(acceptedWorkflow.content);
    expect(desiredWorkflow.binding).toEqual(acceptedWorkflowBinding);

    seedVerifiedConnection('github', {
      apiToken: 'github-token',
      login: 'dave',
      packageReadToken: 'package-token',
    });
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    environments.updatePlatformBindings(environment.id, {
      ci: {
        deployBranch: {
          [acceptedWorkflow.path]: {
            ...acceptedWorkflowBinding,
            managedPaths: [acceptedWorkflow.path],
            syncedSecrets: [
              'RAILWAY_API_TOKEN',
              'IMAGE_REGISTRY_USERNAME',
              'IMAGE_REGISTRY_TOKEN',
            ],
            syncedSecretHashes: {
              RAILWAY_API_TOKEN: sha256('railway-token'),
              IMAGE_REGISTRY_USERNAME: sha256('dave'),
              IMAGE_REGISTRY_TOKEN: sha256('package-token'),
            },
          },
        },
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'hls-project',
      environmentId: 'hls-staging',
      services: [{
        name: 'web',
        externalId: 'hls-web',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: ['CARE_PLAN_AI_REQUEST_TIMEOUT_MS', 'SEED_CLIENT_TEST_DATA'],
        envVarHashes: {
          CARE_PLAN_AI_REQUEST_TIMEOUT_MS: hashEnvValue('30000'),
          SEED_CLIENT_TEST_DATA: hashEnvValue('true'),
        },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    mockLiveWorkflow(acceptedWorkflow);
    vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets').mockResolvedValue([
      'RAILWAY_API_TOKEN',
      'IMAGE_REGISTRY_USERNAME',
      'IMAGE_REGISTRY_TOKEN',
    ]);
    vi.spyOn(GitHubAdapter.prototype, 'getEnvironmentVariable').mockResolvedValue({
      name: 'HYPERVIBE_APPLIED_SPEC_HASH',
      value: oldContractHash,
    });
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'dave',
      scopes: ['repo', 'workflow'],
    });
    const setEnvironmentVariable = vi.spyOn(GitHubAdapter.prototype, 'setEnvironmentVariable')
      .mockResolvedValue();
    const publishWorkflow = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');
    const triggerWorkflow = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow');

    const result = await new PlanService().plan(project, 'staging');
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.scope).toBe('full');
    expect(plan.actions.filter((action) => action.type !== 'noop')).toEqual([
      expect.objectContaining({
        id: 'ci:github-actions:staging:applied-spec-hash',
        metadata: expect.objectContaining({ desiredHash: desiredContractHash }),
      }),
    ]);
    expect(plan.actions.some((action) => action.metadata?.workflowPublicationRequired === true))
      .toBe(false);

    const outcome = await executePlanApply(createToolContext(), {
      project,
      spec: desired.spec,
      specRevision: desired.revision,
      planId: plan.planRunId,
      confirmActions: [],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: true,
        receipts: expect.arrayContaining([
          expect.objectContaining({
            actionId: 'ci:github-actions:staging:applied-spec-hash',
            status: 'succeeded',
          }),
        ]),
      },
    });
    expect(setEnvironmentVariable).toHaveBeenCalledWith(
      'dave',
      'hls-property-care',
      'staging',
      'HYPERVIBE_APPLIED_SPEC_HASH',
      desiredContractHash
    );
    expect(publishWorkflow).not.toHaveBeenCalled();
    expect(triggerWorkflow).not.toHaveBeenCalled();
    expect(environments.findById(environment.id)?.platformBindings).toMatchObject({
      ci: { appliedSpecHash: { hash: desiredContractHash } },
    });
  });

  it('stages GitLab CI publication only after exact provider bindings converge', async () => {
    const repositoryScope = 'https://gitlab.com/acme/staged-app';
    project = new ProjectRepository().update(project.id, {
      gitRemoteUrl: `${repositoryScope}.git`,
    })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      runtime: { kind: 'node', version: '22' },
      devops: {
        code: { provider: 'gitlab', scope: repositoryScope },
        ci: { provider: 'gitlab-ci' },
        canonicalEnvironment: 'staging',
      },
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web', startCommand: 'npm start' } },
          envFile: { mode: 'off' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    seedVerifiedConnection('gitlab', {
      apiToken: 'gitlab-api-token',
      instanceUrl: 'https://gitlab.com',
      registryUsername: 'gitlab+deploy-token-1',
      registryReadToken: 'gitlab-registry-read-token',
    }, repositoryScope);
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    const environments = new EnvironmentRepository();
    const environment = environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-staging',
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rail-project',
      environmentId: 'rail-staging',
      services: [],
      databases: [],
      partial: false,
      warnings: [],
    });

    const unboundResult = await new PlanService().plan(project, 'staging');
    const unbound = unboundResult as Exclude<typeof unboundResult, { error: string }>;
    expect(unbound.scope).toBe('managed-ci-bindings');
    expect(unbound.actions).toEqual([
      expect.objectContaining({ id: 'service:web', type: 'create' }),
    ]);
    expect(unbound.actions.some((action) => action.resource.kind === 'ci')).toBe(false);

    environments.updatePlatformBindings(environment.id, {
      services: {
        web: {
          serviceId: 'rail-web',
          workloadKind: 'web',
          resourceType: 'service',
        },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: {},
      envVarSpec: {},
    });
    vi.restoreAllMocks();
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rail-project',
      environmentId: 'rail-staging',
      services: [{
        name: 'web',
        externalId: 'rail-web',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    const requests: Array<{ method: string; path: string }> = [];
    const commitSha = 'a'.repeat(40);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const decodedPath = decodeURIComponent(url.pathname);
      requests.push({ method, path: decodedPath });
      const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
      if (method === 'GET' && decodedPath.endsWith('/user')) {
        return respond({ id: 3, username: 'hypervibe' });
      }
      if (method === 'GET' && /\/api\/v4\/projects\/(?:42|acme\/staged-app)$/.test(decodedPath)) {
        return respond({
          id: 42,
          path_with_namespace: 'acme/staged-app',
          default_branch: 'main',
          web_url: repositoryScope,
          http_url_to_repo: `${repositoryScope}.git`,
          ssh_url_to_repo: 'git@gitlab.com:acme/staged-app.git',
          ci_config_path: '.gitlab-ci.yml',
          permissions: { project_access: { access_level: 40 } },
          ci_pipeline_variables_minimum_override_role: 'no_one_allowed',
          ci_forward_deployment_enabled: true,
          ci_forward_deployment_rollback_allowed: false,
          container_registry_access_level: 'private',
        });
      }
      if (method === 'GET' && decodedPath.endsWith('/projects/42/runners')) {
        return respond([{
          id: 100,
          runner_type: 'instance_type',
          status: 'online',
          paused: false,
          tag_list: ['saas-linux-small-amd64'],
        }]);
      }
      if (method === 'GET' && decodedPath.includes('/repository/files/')) {
        return respond({ message: 'not found' }, 404);
      }
      if (method === 'GET' && decodedPath.endsWith('/repository/branches/main')) {
        return respond({ name: 'main', commit: { id: commitSha } });
      }
      throw new Error(`Unexpected GitLab request: ${method} ${url}`);
    });

    const publicationResult = await new PlanService().plan(project, 'staging');
    const publication = publicationResult as Exclude<typeof publicationResult, { error: string }>;
    expect(publication.scope).toBe('managed-ci-publication');
    expect(publication.actions).toEqual([
      expect.objectContaining({
        id: 'ci:gitlab-ci:configuration',
        type: 'update',
        resource: { kind: 'ci', name: 'configuration', provider: 'gitlab-ci' },
        dependsOn: undefined,
        metadata: expect.objectContaining({
          operation: 'ciConfigurationSync',
          workflowPublicationRequired: true,
        }),
      }),
    ]);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('isolates new and replaced service identities with only their prerequisites', async () => {
    project = new ProjectRepository().update(project.id, {
      gitRemoteUrl: 'git@github.com:dave/binding-stage.git',
    })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {
            web: { startCommand: 'npm start' },
            worker: { workloadKind: 'worker', startCommand: 'npm run worker' },
            jobs: {
              workloadKind: 'cron',
              cronSchedule: '*/5 * * * *',
              startCommand: 'npm run jobs',
            },
          },
          database: { provider: 'railway', engine: 'postgres' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    seedVerifiedConnection('github', {
      apiToken: 'gh-token',
      login: 'dave',
      packageReadToken: 'package-token',
    });
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-staging',
        services: {
          web: { serviceId: 'svc-web', workloadKind: 'web' },
          jobs: { serviceId: 'svc-jobs', workloadKind: 'worker' },
        },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { runtime: { kind: 'node', version: '22', installCommand: 'npm ci' } },
      envVarSpec: {},
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-staging',
      services: [
        {
          name: 'web',
          externalId: 'svc-web',
          workloadKind: 'web',
          customDomains: [],
          config: { startCommand: 'npm start' },
          envVarKeys: [],
          envVarHashes: {},
          status: 'running',
        },
        {
          name: 'jobs',
          externalId: 'svc-jobs',
          workloadKind: 'worker',
          customDomains: [],
          config: { startCommand: 'npm run jobs' },
          envVarKeys: [],
          envVarHashes: {},
          status: 'running',
        },
      ],
      databases: [],
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.scope).toBe('managed-ci-bindings');
    expect(orderActions(plan.actions).map((action) => action.id)).toEqual([
      'database:railway',
      'service:worker',
      'service:jobs',
    ]);
    expect(plan.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'create',
      billable: true,
    });
    expect(plan.actions.find((action) => action.id === 'service:worker')).toMatchObject({
      type: 'create',
      dependsOn: ['database:railway'],
    });
    expect(plan.actions.find((action) => action.id === 'service:jobs')).toMatchObject({
      type: 'replace',
      dependsOn: ['database:railway'],
    });
    expect(plan.actions.some((action) => action.id === 'service:web')).toBe(false);
    expect(plan.actions.some((action) => action.resource.kind === 'ci')).toBe(false);
    expect(plan.warnings).toContain(
      'Managed CI reconciliation is deferred until provider identity changes converge. Apply this binding stage, then re-run hv_plan.'
    );

    const handler = vi.fn();
    const apply = await new ConvergeExecutor().execute({
      planRunId: plan.planRunId,
      currentSpecRevision: plan.specRevision,
      handler,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(apply.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'database:railway', status: 'skipped_requires_confirm' }),
      expect.objectContaining({ actionId: 'service:worker', status: 'aborted' }),
      expect.objectContaining({ actionId: 'service:jobs', status: 'aborted' }),
    ]));
  });

  it('removes deleted worker ids from the desired CI workflow', async () => {
    project = new ProjectRepository().update(project.id, { gitRemoteUrl: 'git@github.com:dave/pruned-worker-app.git' })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: {
          web: { serviceId: 'svc-web' },
          worker: { serviceId: 'svc-worker' },
        },
      },
    });
    seedVerifiedConnection('github', {
      apiToken: 'gh-token',
      login: 'dave',
      packageReadToken: 'package-token',
    });
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [
        {
          name: 'web',
          externalId: 'svc-web',
          workloadKind: 'web',
          customDomains: [],
          config: {},
          envVarKeys: [],
          envVarHashes: {},
          status: 'running',
        },
        {
          name: 'worker',
          externalId: 'svc-worker',
          workloadKind: 'worker',
          customDomains: [],
          config: {},
          envVarKeys: [],
          envVarHashes: {},
          status: 'running',
        },
      ],
      databases: [],
      partial: false,
      warnings: [],
    });

    const desiredTarget = resolveBranchDeployTargets(project).targets.find(
      (target) => target.environmentName === 'production'
    )!;
    expect(desiredTarget.serviceNames).toEqual(['web']);
    expect(desiredTarget.providerServiceIds).toEqual(['svc-web']);
    expect(desiredTarget.releaseTarget?.resources).toEqual([{
      logicalName: 'web',
      workloadKind: 'web',
      providerResourceType: 'service',
      providerResourceId: 'svc-web',
    }]);
    const { workflow: desiredWorkflow, binding } = railwayWorkflowFixture(project, 'production');
    expect(desiredWorkflow.content).toContain("RAILWAY_SERVICE_IDS: 'svc-web'");
    expect(desiredWorkflow.content).not.toContain('svc-worker');
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      ci: { deployBranch: { [desiredWorkflow.path]: { contentHash: 'old', inputHash: 'old' } } },
    });
    const getFile = vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue('old workflow');

    const publicationResult = await new PlanService().plan(project, 'production');
    const publication = publicationResult as Exclude<typeof publicationResult, { error: string }>;
    expect(publication.scope).toBe('managed-ci-publication');
    expect(publication.actions.some((action) => action.type === 'destroy')).toBe(false);
    const ci = publication.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch')!;
    expect(ci.type).toBe('update');
    expect((ci.metadata?.workflow as { aggregateContentHash: string }).aggregateContentHash)
      .toBe(binding.contentHash);

    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      ci: { deployBranch: { [desiredWorkflow.path]: binding } },
    });
    getFile.mockImplementation(async (_owner, _repo, filePath) => workflowFiles(desiredWorkflow)
      .find((file) => file.path === filePath)?.content ?? null);
    const cleanupResult = await new PlanService().plan(project, 'production');
    const cleanup = cleanupResult as Exclude<typeof cleanupResult, { error: string }>;
    expect(cleanup.actions.find((action) => action.id === 'service:worker:destroy'))
      .toMatchObject({ type: 'destroy' });
  });

  it('publishes CI before exposing confirm-gated previous-provider destroys', async () => {
    project = new ProjectRepository().update(project.id, { gitRemoteUrl: 'git@github.com:dave/apreskeys.com.git' })!;
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          email: { enabled: false },
          envVars: {},
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    seedVerifiedConnection('github', {
      apiToken: 'gh-token',
      login: 'dave',
      packageReadToken: 'package-token',
    });
    seedVerifiedConnection('railway', { apiToken: 'railway-token' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
        previousHosting: {
          provider: 'cloudrun',
          projectId: 'gcp-1',
          services: { web: { serviceId: 'cr-web' }, cron: { serviceId: 'cr-cron' } },
        },
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web',
        externalId: 'svc-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    const getFile = vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);

    const publicationResult = await new PlanService().plan(project, 'production');
    const publication = publicationResult as Exclude<typeof publicationResult, { error: string }>;
    expect(publication.scope).toBe('managed-ci-publication');
    expect(publication.actions).toEqual([
      expect.objectContaining({ id: 'ci:github-actions:production:deploy-branch' }),
    ]);
    expect(publication.actions[0]?.requiresConfirm).not.toBe(true);

    const { workflow, binding } = railwayWorkflowFixture(project, 'production');
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      ci: { deployBranch: { [workflow.path]: binding } },
    });
    getFile.mockImplementation(async (_owner, _repo, filePath) => workflowFiles(workflow)
      .find((file) => file.path === filePath)?.content ?? null);
    const cleanupResult = await new PlanService().plan(project, 'production');
    const cleanup = cleanupResult as Exclude<typeof cleanupResult, { error: string }>;
    const destroyIds = cleanup.actions
      .filter((action) => action.metadata?.operation === 'previousHostingDestroy')
      .map((action) => action.id);
    expect(destroyIds.sort()).toEqual(['service:cron:previous-destroy', 'service:web:previous-destroy']);
  });

  it('blocks a second hosting-provider switch while the first provider cleanup is still retained', async () => {
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'current-gcp-project',
        environmentId: 'us-central1',
        services: { web: { serviceId: 'current-gcp-web' } },
        previousHosting: {
          provider: 'vercel',
          projectId: 'vercel-team',
          services: { web: { serviceId: 'vercel-team:old-vercel-web' } },
        },
      },
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: false,
      services: [],
      databases: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'complete',
        storage: 'complete',
      },
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'staging');

    expect(result).toMatchObject({
      error: expect.stringContaining('vercel'),
    });
    expect((new EnvironmentRepository().findByProjectAndName(project.id, 'staging')!
      .platformBindings as Record<string, unknown>)).toMatchObject({
      provider: 'cloudrun',
      previousHosting: { provider: 'vercel' },
    });
  });

  it('replans CI deploys when a previously synced GitHub Actions secret value is stale', async () => {
    const ciProject = seedAcceptedRailwayCiProject({
      name: 'ci-stale-secret-app',
      packageReadToken: 'new-package-token',
      syncedPackageReadToken: 'old-package-token',
    });

    const result = await new PlanService().plan(ciProject, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const ci = plan.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch')!;
    expect(ci.type).toBe('update');
    expect(ci.reason).toContain('provider secrets need syncing');
    expect(ci.metadata?.missingProviderSecrets).toBeUndefined();
    expect(ci.metadata?.staleProviderSecrets).toEqual(['IMAGE_REGISTRY_TOKEN']);
  });

  it('uses repo-scoped GitHub package credentials when planning CI deploy secrets', async () => {
    const ciProject = seedAcceptedRailwayCiProject({
      name: 'ci-scoped-secret-app',
      packageReadToken: 'scoped-package-token',
      githubScope: 'dave/ci-scoped-secret-app',
    });

    const result = await new PlanService().plan(ciProject, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const ci = plan.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch')!;
    expect(ci.type).toBe('noop');
    expect(ci.metadata?.missingProviderSecrets).toBeUndefined();
    expect(ci.metadata?.staleProviderSecrets).toBeUndefined();
  });

  it('falls back to a verified global GitHub package credential when a repo-scoped connection is unverified', async () => {
    const ciProject = seedAcceptedRailwayCiProject({
      name: 'ci-shadowed-secret-app',
      packageReadToken: 'global-package-token',
      unverifiedScopedShadow: true,
    });

    const result = await new PlanService().plan(ciProject, 'production');
    const plan = result as Exclude<typeof result, { error: string }>;
    const ci = plan.actions.find((action) => action.id === 'ci:github-actions:production:deploy-branch')!;
    expect(ci.type).toBe('noop');
    expect(ci.metadata?.missingProviderSecrets).toBeUndefined();
    expect(ci.metadata?.staleProviderSecrets).toBeUndefined();
  });

  describe('plan options (serviceFilter / envVarOverrides)', () => {
    function seedTwoServiceSpec() {
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' }, worker: { workloadKind: 'worker' } },
            domain: 'example.com',
            envVars: { NODE_ENV: 'staging' },
          },
        },
      });
    }

    function seedObservedRailwayWeb(): Environment {
      const environment = new EnvironmentRepository().create({
        projectId: project.id,
        name: 'staging',
        platformBindings: {
          provider: 'railway',
          projectId: 'rp-1',
          environmentId: 're-1',
          services: { web: { serviceId: 's-1' } },
        },
      });
      new ServiceRepository().create({
        projectId: project.id,
        name: 'web',
        buildConfig: {},
        envVarSpec: {},
      });
      mockObservingAdapter({
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: true,
        projectId: 'rp-1',
        environmentId: 're-1',
        services: [{
          name: 'web',
          externalId: 's-1',
          workloadKind: 'web',
          customDomains: [],
          config: { startCommand: 'npm start' },
          envVarKeys: ['NODE_ENV'],
          envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        }],
        databases: [],
        partial: false,
        warnings: [],
      });
      return environment;
    }

    it('rejects a filter naming services not in the spec', async () => {
      seedTwoServiceSpec();
      const result = await new PlanService().plan(project, 'staging', { serviceFilter: ['web', 'ghost'] });
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('ghost');
    });

    it('filters to the subset, drops domain actions, never destroys, and records overrides', async () => {
      seedTwoServiceSpec();
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

      const result = await new PlanService().plan(project, 'staging', {
        serviceFilter: ['web'],
        envVarOverrides: { DEBUG: '1' },
      });
      expect(result).not.toHaveProperty('error');
      const plan = result as Exclude<typeof result, { error: string }>;

      const kinds = plan.actions.map((action) => `${action.resource.kind}:${action.resource.name}`);
      expect(kinds).toContain('service:web');
      expect(kinds).not.toContain('service:worker');
      expect(plan.actions.some((action) => action.resource.kind === 'domain')).toBe(false);
      expect(plan.actions.some((action) => action.type === 'destroy')).toBe(false);
      expect(plan.warnings.some((warning) => warning.includes('Partial plan'))).toBe(true);
      const actionIds = new Set(plan.actions.map((action) => action.id));
      for (const action of plan.actions) {
        expect(
          (action.dependsOn ?? [])
            .filter((dependency) => !actionIds.has(dependency))
        ).toEqual([]);
      }

      const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
      const overrides = doc.overrides as Record<string, unknown>;
      expect(overrides.services).toEqual(['web']);
      expect(overrides.envVarKeys).toEqual(['DEBUG']);
      // Values are encrypted, never plaintext in the stored plan document.
      expect(typeof overrides.envVarsEncrypted).toBe('string');
      expect(JSON.stringify(doc)).not.toContain('"DEBUG":"1"');
      expect(getSecretStore().decryptObject(overrides.envVarsEncrypted as string)).toEqual({ DEBUG: '1' });
    });

    it('reflects envVar overrides in the diff without touching the spec', async () => {
      seedObservedRailwayWeb();

      const result = await new PlanService().plan(project, 'staging', { envVarOverrides: { DEBUG: '1' } });
      const plan = result as Exclude<typeof result, { error: string }>;
      const web = plan.actions.find((action) => action.id === 'service:web')!;
      expect(web.type).toBe('update');
      expect(web.diff?.some((entry) => entry.field === 'env:DEBUG')).toBe(true);

      // Spec on disk is untouched by the override.
      const spec = new SpecStore().get(project)!.spec;
      expect(spec.environments.staging.envVars).toEqual({ NODE_ENV: 'staging' });
    });

    it('loads app runtime vars from a deploy env file without storing plaintext or provider tokens', async () => {
      const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-env-file-')), '.env');
      writeFileSync(envFile, [
        'SENDGRID_API_KEY=SG.local-secret',
        'SESSION_SECRET=',
        'NODE_ENV=from-dotenv',
        'WEBHOOK_URL=http://localhost:4040/hook',
        'LOCAL_DEBUG_FLAG=true',
        'RAILWAY_API_TOKEN=railway-provider-token',
        'NPM_TOKEN=npm-provider-token',
        '',
      ].join('\n'));
      seedObservedRailwayWeb();

      const result = await new PlanService().plan(project, 'staging', { envFile });
      const plan = result as Exclude<typeof result, { error: string }>;
      const web = plan.actions.find((action) => action.id === 'service:web')!;

      expect(web.type).toBe('update');
      expect(web.diff?.some((entry) => entry.field === 'env:SENDGRID_API_KEY')).toBe(true);
      expect(web.diff?.some((entry) => entry.field === 'env:RAILWAY_API_TOKEN')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:NPM_TOKEN')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:NODE_ENV')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:LOCAL_DEBUG_FLAG')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:WEBHOOK_URL')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:SESSION_SECRET')).toBe(false);
      expect(plan.warnings).toContainEqual(expect.stringContaining(`Loaded 1 deploy env var(s) from ${envFile}`));
      expect(plan.warnings).toContainEqual(expect.stringContaining('Ignored 2 .env key(s) that do not match envFile policy: LOCAL_DEBUG_FLAG, NODE_ENV'));
      expect(plan.warnings).toContainEqual(expect.stringContaining('Skipped 1 .env key(s) with local-only values in runtime mode: WEBHOOK_URL'));
      expect(plan.warnings).toContainEqual(expect.stringContaining('Skipped 2 provider-only .env key(s): NPM_TOKEN, RAILWAY_API_TOKEN'));
      expect(plan.warnings).toContainEqual(expect.stringContaining('Missing values for 1 selected .env key(s): SESSION_SECRET'));

      const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
      const overrides = doc.overrides as Record<string, unknown>;
      expect(overrides.envFilePath).toBe(envFile);
      expect(overrides.envFileKeys).toEqual(['SENDGRID_API_KEY']);
      expect(JSON.stringify(doc)).not.toContain('SG.local-secret');
      expect(JSON.stringify(doc)).not.toContain('railway-provider-token');
      expect(JSON.stringify(doc)).not.toContain('npm-provider-token');
      expect(JSON.stringify(doc)).not.toContain('localhost:4040');
      expect(getSecretStore().decryptObject(overrides.envFileVarsEncrypted as string)).toEqual({
        SENDGRID_API_KEY: 'SG.local-secret',
      });
    });

    it('creates the environment-specific env file from base .env before loading deploy vars', async () => {
      const oldCwd = process.cwd();
      const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-env-fallback-plan-'));
      mkdirSync(path.join(root, 'app'));
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:davejohnson/plan-test.git'], {
        cwd: root,
        stdio: 'ignore',
      });
      project = new ProjectRepository().update(project.id, {
        gitRemoteUrl: 'https://github.com/davejohnson/plan-test',
      })!;
      const realRoot = realpathSync(root);
      const baseEnvFile = path.join(realRoot, '.env');
      const stagingEnvFile = path.join(realRoot, '.env.staging');
      writeFileSync(baseEnvFile, 'SENDGRID_API_KEY=SG.base\n');
      seedObservedRailwayWeb();

      try {
        process.chdir(path.join(root, 'app'));
        const result = await new PlanService().plan(project, 'staging', { includeEnvFile: true });
        const plan = result as Exclude<typeof result, { error: string }>;

        expect(plan.warnings).toContainEqual(expect.stringContaining(`Created environment-specific deploy env file at ${stagingEnvFile}`));
        expect(plan.warnings).toContainEqual(expect.stringContaining(`from base ${baseEnvFile}`));
        expect(existsSync(stagingEnvFile)).toBe(true);
        const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
        const overrides = doc.overrides as Record<string, unknown>;
        expect(overrides.envFilePath).toBe(stagingEnvFile);
        expect(overrides.envFileKeys).toEqual(['SENDGRID_API_KEY']);
      } finally {
        process.chdir(oldCwd);
      }
    });

    it('refuses implicit env-file access when the selected project belongs to a different repository', async () => {
      const oldCwd = process.cwd();
      const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-cross-project-env-'));
      mkdirSync(path.join(root, 'app'));
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:davejohnson/invoice-express.git'], {
        cwd: root,
        stdio: 'ignore',
      });
      writeFileSync(path.join(root, '.env'), 'SENDGRID_API_KEY=SG.invoice-perfect\n');
      const environmentEnvFile = path.join(realpathSync(root), '.env.staging');
      project = new ProjectRepository().update(project.id, {
        gitRemoteUrl: 'git@github.com:davejohnson/hls-property-care.git',
      })!;
      seedObservedRailwayWeb();

      try {
        process.chdir(path.join(root, 'app'));
        const result = await new PlanService().plan(project, 'staging', { includeEnvFile: true });

        expect(result).toEqual({
          error: expect.stringContaining('Refusing implicit deploy env-file access'),
        });
        expect((result as { error: string }).error).toContain('davejohnson/invoice-express');
        expect((result as { error: string }).error).toContain('davejohnson/hls-property-care');
        expect(existsSync(environmentEnvFile)).toBe(false);
        expect(new RunRepository().findByProjectId(project.id)).toEqual([]);

        project = new ProjectRepository().update(project.id, {
          gitRemoteUrl: '../hls-property-care.git',
        })!;
        const unverifiable = await new PlanService().plan(project, 'staging', { includeEnvFile: true });
        expect(unverifiable).toEqual({
          error: expect.stringContaining('selected project "plan-test" repository "unknown"'),
        });
        expect(existsSync(environmentEnvFile)).toBe(false);
        expect(new RunRepository().findByProjectId(project.id)).toEqual([]);

        project = new ProjectRepository().update(project.id, {
          gitRemoteUrl: 'git@github.com:davejohnson/hls-property-care.git',
        })!;

        const skipped = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
        expect(skipped).not.toHaveProperty('error');
        expect(existsSync(environmentEnvFile)).toBe(false);

        const explicit = await new PlanService().plan(project, 'staging', {
          envFile: path.join(root, '.env'),
        });
        expect(explicit).not.toHaveProperty('error');
        expect((explicit as Exclude<typeof explicit, { error: string }>).warnings).toContainEqual(
          expect.stringContaining(`Loaded 1 deploy env var(s) from ${path.join(root, '.env')}`)
        );

        new SpecStore().replace(project, {
          version: 1,
          project: project.name,
          environments: {
            staging: {
              hosting: { provider: 'railway' },
              services: { web: { startCommand: 'npm start' } },
              envVars: { NODE_ENV: 'staging' },
              envFile: { mode: 'off' },
            },
          },
        });
        const disabledByPolicy = await new PlanService().plan(project, 'staging', { includeEnvFile: true });
        expect(disabledByPolicy).not.toHaveProperty('error');
        expect(existsSync(environmentEnvFile)).toBe(false);
      } finally {
        process.chdir(oldCwd);
      }
    });

    it('uses spec envFile policy to include custom runtime keys and exclude unwanted keys', async () => {
      const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-env-policy-')), '.env');
      writeFileSync(envFile, [
        'CUSTOM_WORKER_FLAG=true',
        'LOCAL_DEBUG_FLAG=true',
        'SESSION_SECRET=session-runtime',
        '',
      ].join('\n'));
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            envVars: { NODE_ENV: 'staging' },
            envFile: {
              mode: 'explicit',
              include: ['CUSTOM_WORKER_FLAG', 'SESSION_SECRET'],
              exclude: ['SESSION_SECRET'],
            },
          },
        },
      });
      seedObservedRailwayWeb();

      const result = await new PlanService().plan(project, 'staging', { envFile });
      const plan = result as Exclude<typeof result, { error: string }>;
      const web = plan.actions.find((action) => action.id === 'service:web')!;

      expect(web.diff?.some((entry) => entry.field === 'env:CUSTOM_WORKER_FLAG')).toBe(true);
      expect(web.diff?.some((entry) => entry.field === 'env:SESSION_SECRET')).toBe(false);
      expect(web.diff?.some((entry) => entry.field === 'env:LOCAL_DEBUG_FLAG')).toBe(false);
      expect(plan.warnings).toContainEqual(expect.stringContaining('Excluded 1 .env key(s) by envFile.exclude: SESSION_SECRET'));
      expect(plan.warnings).toContainEqual(expect.stringContaining('Ignored 1 .env key(s) that do not match envFile policy: LOCAL_DEBUG_FLAG'));
      const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
      const overrides = doc.overrides as Record<string, unknown>;
      expect(overrides.envFileKeys).toEqual(['CUSTOM_WORKER_FLAG']);
      expect(getSecretStore().decryptObject(overrides.envFileVarsEncrypted as string)).toEqual({
        CUSTOM_WORKER_FLAG: 'true',
      });
    });

    it('does not let deploy env files override managed database env vars', async () => {
      const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-env-db-')), '.env');
      writeFileSync(envFile, [
        'DATABASE_URL=postgres://local-dev-db',
        'SENDGRID_API_KEY=SG.local-secret',
        '',
      ].join('\n'));
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            database: { provider: 'railway', engine: 'postgres' },
            envVars: { NODE_ENV: 'staging' },
          },
        },
      });
      const environment = seedObservedRailwayWeb();
      new ComponentRepository().create({
        environmentId: environment.id,
        type: 'postgres',
        bindings: { provider: 'railway', connectionString: 'postgres://managed-db' },
      });

      const result = await new PlanService().plan(project, 'staging', { envFile });
      const plan = result as Exclude<typeof result, { error: string }>;
      const web = plan.actions.find((action) => action.id === 'service:web')!;

      expect(web.diff?.some((entry) => entry.field === 'env:DATABASE_URL')).toBe(true);
      expect(plan.warnings).toContainEqual(expect.stringContaining('Ignored 1 .env key(s) because Hypervibe manages them from infrastructure: DATABASE_URL'));
      const doc = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
      const overrides = doc.overrides as Record<string, unknown>;
      expect(overrides.envFileKeys).toEqual(['SENDGRID_API_KEY']);
      expect(getSecretStore().decryptObject(overrides.envFileVarsEncrypted as string)).toEqual({
        SENDGRID_API_KEY: 'SG.local-secret',
      });
    });
  });

  describe('iOS planning', () => {
    const BUNDLE = 'com.example.app';

    function replaceSpecWithIos() {
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            envVars: { NODE_ENV: 'staging' },
            ios: {
              bundleId: BUNDLE,
              capabilities: ['PUSH_NOTIFICATIONS'],
              testflight: { groups: { Beta: { testers: ['a@example.com'] } } },
            },
          },
        },
      });
    }

    it('appends iOS actions after all non-iOS actions when the spec declares ios', async () => {
      replaceSpecWithIos();
      seedVerifiedConnection('appstoreconnect', { keyId: 'K1', issuerId: 'I1', privateKey: 'pk' });
      new EnvironmentRepository().create({
        projectId: project.id,
        name: 'staging',
        platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
      });
      new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
      mockObservingAdapter({
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: true,
        projectId: 'rp-1',
        environmentId: 're-1',
        services: [{
          name: 'web',
          externalId: 's-1',
          workloadKind: 'web',
          customDomains: [],
          config: { startCommand: 'node old.js' },
          envVarKeys: ['NODE_ENV'],
          envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        }],
        databases: [],
        partial: false,
        warnings: [],
      });
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier').mockResolvedValue(null);
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(null);
      vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue([]);
      vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaTesters').mockResolvedValue([]);

      const result = await new PlanService().plan(project, 'staging');
      expect(result).not.toHaveProperty('error');
      const plan = result as Exclude<typeof result, { error: string }>;

      const ids = plan.actions.map((action) => action.id);
      expect(ids).toEqual(expect.arrayContaining([
        `ios:bundle-id:${BUNDLE}`,
        `ios:capabilities:${BUNDLE}`,
        `ios:app:${BUNDLE}`,
        'ios:group:Beta',
        'ios:testers:Beta',
      ]));

      // iOS actions are appended last, after every non-iOS action.
      const iosIndexes = plan.actions.flatMap((action, index) => (isIosAction(action) ? [index] : []));
      const nonIosIndexes = plan.actions.flatMap((action, index) => (isIosAction(action) ? [] : [index]));
      expect(iosIndexes.length).toBeGreaterThan(0);
      expect(nonIosIndexes.length).toBeGreaterThan(0);
      expect(Math.min(...iosIndexes)).toBeGreaterThan(Math.max(...nonIosIndexes));

      // Nothing exists Apple-side, so the chain is verified creates/updates.
      expect(plan.actions.find((action) => action.id === `ios:bundle-id:${BUNDLE}`)).toMatchObject({ type: 'create', verified: true });
      expect(plan.warnings.some((warning) => warning.includes('iOS'))).toBe(false);
    });

    it('plans no iOS actions when the spec has no ios section', async () => {
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });
      const observe = vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier');

      const result = await new PlanService().plan(project, 'staging');
      const plan = result as Exclude<typeof result, { error: string }>;
      expect(plan.actions.some(isIosAction)).toBe(false);
      expect(plan.actions.some((action) => action.id.startsWith('ios:'))).toBe(false);
      expect(observe).not.toHaveBeenCalled();
    });

    it('merges a Cannot-plan-iOS warning and plans zero iOS actions without an appstoreconnect connection', async () => {
      replaceSpecWithIos();
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

      const result = await new PlanService().plan(project, 'staging');
      const plan = result as Exclude<typeof result, { error: string }>;
      expect(plan.actions.some(isIosAction)).toBe(false);
      expect(plan.warnings.some((warning) => warning.includes('Cannot plan iOS') && warning.includes(BUNDLE))).toBe(true);
    });
  });

  it('clears blocked when a verified connection exists', async () => {
    const connRepo = new ConnectionRepository();
    const created = connRepo.create({ provider: 'railway', credentialsEncrypted: 'x' });
    connRepo.updateStatus(created.id, 'verified');
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'mock' });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.blocked).toEqual([]);
  });

  it('isolates a pending environment data migration from service and ordinary database mutations', async () => {
    const connectionRepo = new ConnectionRepository();
    const connection = connectionRepo.create({ provider: 'railway', credentialsEncrypted: 'x' });
    connectionRepo.updateStatus(connection.id, 'verified');
    const cloudflare = connectionRepo.create({ provider: 'cloudflare', credentialsEncrypted: 'x' });
    connectionRepo.updateStatus(cloudflare.id, 'verified');
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          database: { provider: 'railway', engine: 'postgres' },
          maintenance: { enabled: true },
        },
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          database: { provider: 'railway', engine: 'postgres' },
          maintenance: { enabled: true },
          dataMigration: {
            id: 'initial-production-launch',
            fromEnvironment: 'staging',
            include: { database: true, storage: [] },
          },
        },
      },
    });
    const source = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'staging-env',
        maintenance: { state: 'active' },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'production-env',
        maintenance: { state: 'active' },
      },
    });
    new ComponentRepository().create({
      environmentId: source.id,
      type: 'postgres',
      bindings: { provider: 'railway', instanceId: 'source-db' },
      externalId: 'source-db',
    });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'production-env',
      services: [],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(environmentMaintenanceService, 'observeEnvironmentMaintenance').mockImplementation(
      async ({ environment }) => ({
        state: 'active',
        stage: 'verified',
        edge: {
          state: 'active',
          hostname: `${environment.name}.example.com`,
          markerVerified: true,
        },
        workloads: {
          web: {
            state: 'suspended',
            serviceId: `${environment.name}-web`,
            workloadKind: 'web',
            wasRunning: true,
          },
        },
        database: { state: 'fenced' },
      })
    );

    const result = await new PlanService().plan(project, 'production');
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      id: 'data-migration:initial-production-launch:database',
      type: 'update',
      resource: { kind: 'database', provider: 'railway' },
      dataBearing: true,
      requiresConfirm: true,
      metadata: { operation: 'dataMigrationDatabaseCopy', sourceComponentId: expect.any(String) },
    });
    expect(plan.warnings).toContainEqual(expect.stringContaining('isolated apply stage'));
    expect(plan.blocked).toEqual([]);
    expect(new RunRepository().findById(plan.planRunId)?.plan).toMatchObject({
      lockEnvironmentIds: [source.id],
    });
  });
});
