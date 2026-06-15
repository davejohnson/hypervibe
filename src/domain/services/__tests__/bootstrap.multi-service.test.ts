import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { adapterFactory } from '../adapter.factory.js';
import { CLOUD_PREPARE_PROFILES } from '../cloud-prepare.js';
import { CloudflareAdapter } from '../../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { IDatabaseAdapter } from '../../ports/database.port.js';
import type { IHostingAdapter } from '../../ports/hosting.port.js';
import { executeBootstrap } from '../bootstrap.service.js';
import { resolveDesiredState, resolveDatabaseProviderForProject, normalizeCrons, type DesiredState } from '../spec.service.js';

type JsonObj = Record<string, unknown>;


async function applyInfra(args: {
  projectName: string;
  environmentName?: string;
  services?: string[];
  crons?: Record<string, { schedule: string; command?: string; timeZone?: string }>;
  serviceName?: string;
  domain?: string;
  databaseProvider?: 'supabase' | 'rds' | 'cloudsql' | 'railway';
  setupEmail?: boolean;
  serviceConfig?: Record<string, Record<string, unknown>>;
  envVars?: Record<string, string>;
  deploy?: Record<string, unknown>;
  confirm?: boolean;
}): Promise<JsonObj> {
  // Replicates the legacy infra_apply handler: resolve desired state from
  // project policies plus overrides, then run the bootstrap converge.
  const project = new ProjectRepository().findByName(args.projectName);
  const policyState = (project?.policies?.desiredState ?? {}) as Partial<DesiredState>;
  const resolvedDatabaseProvider = project
    ? resolveDatabaseProviderForProject(project, policyState, {
      environmentName: args.environmentName,
      databaseProvider: args.databaseProvider,
    })
    : args.databaseProvider;
  const desired = resolveDesiredState(policyState, {
    environmentName: args.environmentName,
    services: args.services,
    crons: normalizeCrons(args.crons),
    serviceName: args.serviceName,
    domain: args.domain,
    databaseProvider: resolvedDatabaseProvider,
    setupEmail: args.setupEmail,
    serviceConfig: args.serviceConfig as Partial<DesiredState>['serviceConfig'],
    envVars: args.envVars,
    deploy: args.deploy as Partial<DesiredState>['deploy'],
  });
  const executed = await executeBootstrap({
    projectName: args.projectName,
    environmentName: desired.environmentName,
    services: desired.services,
    crons: desired.crons,
    domain: desired.domain,
    databaseProvider: desired.databaseProvider,
    setupEmail: desired.setupEmail,
    serviceConfig: desired.serviceConfig,
    envVars: desired.envVars,
    deploy: desired.deploy,
  });
  if (!executed.success && executed.summary.error) {
    return { success: false, error: executed.summary.error, summary: executed.summary } as JsonObj;
  }
  return { success: executed.success, ...executed.summary } as JsonObj;
}

describe('infra_apply multi-service convergence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-infra-multi-service-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('provisions one shared database and deploys all desired services in a single apply', async () => {
    const projectRepo = new ProjectRepository();
    const serviceRepo = new ServiceRepository();
    const project = projectRepo.create({ name: 'multi-service-project', defaultPlatform: 'railway' });

    const provisionCalls: string[] = [];
    const deployCalls: string[] = [];

    const fakeDatabaseAdapter: IDatabaseAdapter = {
      name: 'railway',
      capabilities: {
        supportedDatabases: ['postgres'],
        supportedCaches: [],
        supportsPooling: false,
        supportsReadReplicas: false,
        supportsPointInTimeRecovery: false,
        serverlessOptimized: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async provision(type, environment) {
        provisionCalls.push(`${type}:${environment.name}`);
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type: 'postgres',
            bindings: {
              provider: 'railway',
              connectionString: 'postgres://shared-db',
            },
            externalId: 'rail-db-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: true,
            message: 'db ready',
            data: {
              providerProjectId: 'rail-project-1',
              ensureProjectCreated: false,
            },
          },
          connectionUrl: 'postgres://shared-db',
          envVars: {
            DATABASE_URL: 'postgres://shared-db',
            DIRECT_URL: 'postgres://shared-db',
          },
        };
      },
      async getConnectionUrl() {
        return 'postgres://shared-db';
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };

    const fakeHostingAdapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'bound',
          data: {
            projectId: 'rail-project-1',
            environmentId: 'rail-env-1',
          },
        };
      },
      async deploy(service) {
        deployCalls.push(service.name);
        return {
          serviceId: `deploy-${service.name}`,
          externalId: `rail-${service.name}`,
          url: `https://${service.name}.example.com`,
          status: 'deployed',
          receipt: {
            success: true,
            message: 'deployed',
            data: {
              environmentId: 'rail-env-1',
            },
          },
        };
      },
      async setEnvVars() {
        return {
          success: true,
          message: 'vars synced',
        };
      },
      async getDeployStatus(_environment, deploymentId) {
        return {
          status: 'deployed',
          url: `https://${deploymentId}.example.com`,
        };
      },
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: fakeDatabaseAdapter,
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });

    const payload = await applyInfra({
      projectName: project.name,
      environmentName: 'staging',
      services: ['web', 'worker'],
      databaseProvider: 'railway',
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(payload.services).toEqual(['web', 'worker']);
    expect(provisionCalls).toEqual(['postgres:staging']);
    expect(deployCalls).toEqual(['web', 'worker']);
    const createdServices = serviceRepo.findByProjectId(project.id).map((service) => service.name);
    expect(createdServices).toEqual(['web', 'worker']);
  });

  it('reuses an existing managed postgres component during apply', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const componentRepo = new ComponentRepository();
    const project = projectRepo.create({ name: 'reuse-db-project', defaultPlatform: 'railway' });
    const environment = envRepo.create({ projectId: project.id, name: 'production' });

    componentRepo.create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'railway',
        pluginName: 'postgres-db',
        connectionUrl: 'postgres://shared-db',
      },
      externalId: 'rail-db-existing',
    });

    const deployCalls: string[] = [];
    const deployEnvVarCalls: Array<{ serviceName: string; vars: Record<string, string> }> = [];

    const databaseAdapterSpy = vi.spyOn(adapterFactory, 'getDatabaseAdapter');
    const fakeHostingAdapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'bound',
          data: {
            projectId: 'rail-project-1',
            environmentId: 'rail-env-1',
          },
        };
      },
      async deploy(service, _environment, vars) {
        deployCalls.push(service.name);
        deployEnvVarCalls.push({ serviceName: service.name, vars });
        return {
          serviceId: `deploy-${service.name}`,
          externalId: `rail-${service.name}`,
          url: `https://${service.name}.example.com`,
          status: 'deployed',
          receipt: {
            success: true,
            message: 'deployed',
            data: {
              environmentId: 'rail-env-1',
            },
          },
        };
      },
      async setEnvVars() {
        return {
          success: true,
          message: 'vars synced',
        };
      },
      async getDeployStatus(_environment, deploymentId) {
        return {
          status: 'deployed',
          url: `https://${deploymentId}.example.com`,
        };
      },
    };

    databaseAdapterSpy.mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedDatabases: ['postgres'],
          supportedCaches: [],
          supportsPooling: false,
          supportsReadReplicas: false,
          supportsPointInTimeRecovery: false,
          serverlessOptimized: false,
        },
        async connect() {},
        async verify() {
          return { success: true };
        },
        async provision() {
          throw new Error('db provision should not be called when a matching component already exists');
        },
        async getConnectionUrl() {
          return 'postgres://shared-db';
        },
        async destroy() {
          return { success: true, message: 'destroyed' };
        },
      } as IDatabaseAdapter,
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });

    const payload = await applyInfra({
      projectName: project.name,
      environmentName: 'production',
      services: ['web', 'worker'],
      databaseProvider: 'railway',
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(databaseAdapterSpy).not.toHaveBeenCalled();
    expect(deployCalls).toEqual(['web', 'worker']);
    expect(serviceRepo.findByProjectId(project.id).map((service) => service.name)).toEqual(['web', 'worker']);
    expect(deployEnvVarCalls).toEqual([
      {
        serviceName: 'web',
        vars: {
          DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
          DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
        },
      },
      {
        serviceName: 'worker',
        vars: {
          DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
          DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
        },
      },
    ]);
  });

  it('shows per-service runtime configuration in preview and persists it for apply', async () => {
    const projectRepo = new ProjectRepository();
    const serviceRepo = new ServiceRepository();
    const project = projectRepo.create({
      name: 'service-config-project',
      defaultPlatform: 'railway',
    });

    const fakeDatabaseAdapter: IDatabaseAdapter = {
      name: 'railway',
      capabilities: {
        supportedDatabases: ['postgres'],
        supportedCaches: [],
        supportsPooling: false,
        supportsReadReplicas: false,
        supportsPointInTimeRecovery: false,
        serverlessOptimized: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async provision(_type, environment) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type: 'postgres',
            bindings: {
              provider: 'railway',
              pluginName: 'postgres-db',
              connectionString: 'postgres://shared-db',
            },
            externalId: 'rail-db-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: true,
            message: 'db ready',
            data: {
              providerProjectId: 'rail-project-1',
              ensureProjectCreated: false,
            },
          },
          connectionUrl: 'postgres://shared-db',
          envVars: {
            DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
            DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
          },
        };
      },
      async getConnectionUrl() {
        return 'postgres://shared-db';
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };

    const fakeHostingAdapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'bound',
          data: {
            projectId: 'rail-project-1',
            environmentId: 'rail-env-1',
          },
        };
      },
      async deploy(service) {
        return {
          serviceId: `deploy-${service.name}`,
          externalId: `rail-${service.name}`,
          url: `https://${service.name}.example.com`,
          status: 'deployed',
          receipt: {
            success: true,
            message: 'deployed',
            data: {
              environmentId: 'rail-env-1',
            },
          },
        };
      },
      async setEnvVars() {
        return {
          success: true,
          message: 'vars synced',
        };
      },
      async getDeployStatus(_environment, deploymentId) {
        return {
          status: 'deployed',
          url: `https://${deploymentId}.example.com`,
        };
      },
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: fakeDatabaseAdapter,
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });

    const applyPayload = await applyInfra({
      projectName: project.name,
      environmentName: 'production',
      services: ['web', 'worker'],
      databaseProvider: 'railway',
      setupEmail: false,
      serviceConfig: {
        web: {
          startCommand: 'npm start',
          healthCheckPath: '/health',
        },
        worker: {
          startCommand: 'npm run worker',
          cronSchedule: '0 * * * *',
        },
      },
      confirm: true,
    });

    expect(applyPayload.success).toBe(true);
    expect(applyPayload.services).toEqual(['web']);
    expect(applyPayload.crons).toEqual(['worker']);
    expect(serviceRepo.findByProjectAndName(project.id, 'web')?.buildConfig).toMatchObject({
      workloadKind: 'web',
      builder: 'nixpacks',
      startCommand: 'npm start',
      healthCheckPath: '/health',
    });
    expect(serviceRepo.findByProjectAndName(project.id, 'worker')?.buildConfig).toMatchObject({
      workloadKind: 'cron',
      builder: 'nixpacks',
      startCommand: 'npm run worker',
      cronSchedule: '0 * * * *',
    });
  });

  it('configures repo-linked deploy sources for all services during apply', async () => {
    const projectRepo = new ProjectRepository();
    const project = projectRepo.create({
      name: 'branch-source-apply-project',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'git@github.com:davejohnson/billforge.git',
    });

    const fakeDatabaseAdapter: IDatabaseAdapter = {
      name: 'railway',
      capabilities: {
        supportedDatabases: ['postgres'],
        supportedCaches: [],
        supportsPooling: false,
        supportsReadReplicas: false,
        supportsPointInTimeRecovery: false,
        serverlessOptimized: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async provision(_type, environment) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type: 'postgres',
            bindings: {
              provider: 'railway',
              pluginName: 'postgres-db',
              connectionString: 'postgres://shared-db',
            },
            externalId: 'rail-db-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: true,
            message: 'db ready',
            data: {
              providerProjectId: 'rail-project-1',
              ensureProjectCreated: false,
            },
          },
          connectionUrl: 'postgres://shared-db',
          envVars: {
            DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
            DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
          },
        };
      },
      async getConnectionUrl() {
        return 'postgres://shared-db';
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };

    const connectServiceToRepo = vi.fn(async () => ({
      success: true,
      message: 'connected',
    }));

    const fakeHostingAdapter: IHostingAdapter & {
      connectServiceToRepo: typeof connectServiceToRepo;
    } = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'bound',
          data: {
            projectId: 'rail-project-1',
            environmentId: 'rail-env-1',
          },
        };
      },
      async deploy(service) {
        return {
          serviceId: `deploy-${service.name}`,
          externalId: `rail-${service.name}`,
          url: `https://${service.name}.example.com`,
          status: 'deployed',
          receipt: {
            success: true,
            message: 'deployed',
            data: {
              environmentId: 'rail-env-1',
            },
          },
        };
      },
      async setEnvVars() {
        return {
          success: true,
          message: 'vars synced',
        };
      },
      async getDeployStatus(_environment, deploymentId) {
        return {
          status: 'deployed',
          url: `https://${deploymentId}.example.com`,
        };
      },
      connectServiceToRepo,
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: fakeDatabaseAdapter,
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });

    const payload = await applyInfra({
      projectName: project.name,
      environmentName: 'production',
      services: ['web', 'worker'],
      databaseProvider: 'railway',
      setupEmail: false,
      deploy: {
        strategy: 'branch',
        trigger: 'native',
        branches: {
          production: 'main',
        },
      },
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(payload.deploySource).toEqual({
      strategy: 'branch',
      trigger: 'native',
      repo: 'davejohnson/billforge',
      branch: 'main',
      services: ['web', 'worker'],
    });
    expect(connectServiceToRepo.mock.calls).toEqual([
      [{ serviceId: 'rail-web', repo: 'davejohnson/billforge', branch: 'main' }],
      [{ serviceId: 'rail-worker', repo: 'davejohnson/billforge', branch: 'main' }],
    ]);

    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    const bindings = environment.platformBindings as {
      services?: Record<string, { source?: { repo?: string; branch?: string } }>;
    };
    expect(bindings.services?.web?.source).toEqual({ repo: 'davejohnson/billforge', branch: 'main' });
    expect(bindings.services?.worker?.source).toEqual({ repo: 'davejohnson/billforge', branch: 'main' });
  });

  it('returns Railway GitHub app guidance when repo-linked deploy source access is denied', async () => {
    const projectRepo = new ProjectRepository();
    const project = projectRepo.create({
      name: 'branch-source-repo-access-project',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'git@github.com:davejohnson/billforge.git',
    });

    const fakeDatabaseAdapter: IDatabaseAdapter = {
      name: 'railway',
      capabilities: {
        supportedDatabases: ['postgres'],
        supportedCaches: [],
        supportsPooling: false,
        supportsReadReplicas: false,
        supportsPointInTimeRecovery: false,
        serverlessOptimized: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async provision(_type, environment) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type: 'postgres',
            bindings: {
              provider: 'railway',
              pluginName: 'postgres-db',
              connectionString: 'postgres://shared-db',
            },
            externalId: 'rail-db-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: true,
            message: 'db ready',
            data: {
              providerProjectId: 'rail-project-1',
              ensureProjectCreated: false,
            },
          },
          connectionUrl: 'postgres://shared-db',
          envVars: {
            DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
            DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
          },
        };
      },
      async getConnectionUrl() {
        return 'postgres://shared-db';
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };

    const fakeHostingAdapter: IHostingAdapter & {
      connectServiceToRepo: (params: { serviceId: string; repo: string; branch: string }) => Promise<{ success: boolean; message: string; error?: string }>;
    } = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'bound',
          data: {
            projectId: 'rail-project-1',
            environmentId: 'rail-env-1',
          },
        };
      },
      async deploy(service) {
        return {
          serviceId: `deploy-${service.name}`,
          externalId: `rail-${service.name}`,
          url: `https://${service.name}.example.com`,
          status: 'deployed',
          receipt: {
            success: true,
            message: 'deployed',
            data: {
              environmentId: 'rail-env-1',
            },
          },
        };
      },
      async setEnvVars() {
        return {
          success: true,
          message: 'vars synced',
        };
      },
      async getDeployStatus(_environment, deploymentId) {
        return {
          status: 'deployed',
          url: `https://${deploymentId}.example.com`,
        };
      },
      async connectServiceToRepo() {
        return {
          success: false,
          message: 'failed',
          error: 'User does not have access to the repo',
        };
      },
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: fakeDatabaseAdapter,
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });

    const payload = await applyInfra({
      projectName: project.name,
      environmentName: 'production',
      services: ['web'],
      databaseProvider: 'railway',
      setupEmail: false,
      deploy: {
        strategy: 'branch',
        trigger: 'native',
        branches: {
          production: 'main',
        },
      },
      confirm: true,
    });

    expect(payload.success).toBe(false);
    const summary = payload.summary as JsonObj;
    expect(String(summary.error)).toContain('Failed to configure deploy source');
    expect(summary.help).toMatchObject({
      code: 'railway_github_repo_access',
      helpTool: 'railway_setup_help',
      repo: 'davejohnson/billforge',
    });
    const nextSteps = summary.nextSteps as string[];
    expect(nextSteps.some((step) => step.includes('grant it access to davejohnson/billforge'))).toBe(true);
    expect(nextSteps.some((step) => step.includes('project member has connected their GitHub account'))).toBe(true);
    expect(nextSteps.some((step) => step.includes('pending permission updates'))).toBe(true);
    expect(nextSteps.some((step) => step.includes('rerun hv_status or hv_plan'))).toBe(true);
  });

  it('attaches a Railway custom domain and syncs the required DNS records to Cloudflare', async () => {
    const projectRepo = new ProjectRepository();
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();
    const project = projectRepo.create({ name: 'domain-attach-project', defaultPlatform: 'railway' });

    const cloudflareConnection = connectionRepo.create({
      provider: 'cloudflare',
      scope: 'usebillforge.com',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'cf-token' }),
    });
    connectionRepo.updateStatus(cloudflareConnection.id, 'verified');

    const fakeDatabaseAdapter: IDatabaseAdapter = {
      name: 'railway',
      capabilities: {
        supportedDatabases: ['postgres'],
        supportedCaches: [],
        supportsPooling: false,
        supportsReadReplicas: false,
        supportsPointInTimeRecovery: false,
        serverlessOptimized: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async provision(_type, environment) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type: 'postgres',
            bindings: {
              provider: 'railway',
              pluginName: 'postgres-db',
              connectionString: 'postgres://shared-db',
            },
            externalId: 'rail-db-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: true,
            message: 'db ready',
            data: {
              providerProjectId: 'rail-project-1',
              ensureProjectCreated: false,
            },
          },
          connectionUrl: 'postgres://shared-db',
          envVars: {
            DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
            DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
          },
        };
      },
      async getConnectionUrl() {
        return 'postgres://shared-db';
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };

    const attachCustomDomain = vi.fn(async () => ({
      success: true,
      message: 'attached',
      data: {
        domain: 'usebillforge.com',
        customDomainId: 'cd_123',
        created: true,
        dnsRecords: [
          { name: 'usebillforge.com', type: 'CNAME', value: 'web-production.up.railway.app' },
          { name: '_railway.usebillforge.com', type: 'TXT', value: 'verify-token' },
        ],
      },
    }));

    const fakeHostingAdapter: IHostingAdapter & {
      attachCustomDomain: typeof attachCustomDomain;
    } = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'bound',
          data: {
            projectId: 'rail-project-1',
            environmentId: 'rail-env-1',
          },
        };
      },
      async deploy(service) {
        return {
          serviceId: `deploy-${service.name}`,
          externalId: `rail-${service.name}`,
          url: undefined,
          status: 'deployed',
          receipt: {
            success: true,
            message: 'deployed',
            data: {
              environmentId: 'rail-env-1',
            },
          },
        };
      },
      async setEnvVars() {
        return {
          success: true,
          message: 'vars synced',
        };
      },
      async getDeployStatus() {
        return {
          status: 'deployed',
          url: undefined,
        };
      },
      attachCustomDomain,
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: fakeDatabaseAdapter,
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });
    vi.spyOn(CloudflareAdapter.prototype, 'connect').mockImplementation(() => {});
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1',
      name: 'usebillforge.com',
      status: 'active',
      paused: false,
      type: 'full',
      name_servers: [],
    });
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord')
      .mockResolvedValue({
        record: {
          id: 'rec-1',
          zone_id: 'zone-1',
          zone_name: 'usebillforge.com',
          name: 'usebillforge.com',
          type: 'CNAME',
          content: 'web-production.up.railway.app',
          proxied: false,
          proxiable: true,
          ttl: 1,
          created_on: new Date().toISOString(),
          modified_on: new Date().toISOString(),
        },
        action: 'created',
      });

    const payload = await applyInfra({
      projectName: project.name,
      environmentName: 'production',
      services: ['web'],
      databaseProvider: 'railway',
      domain: 'usebillforge.com',
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(attachCustomDomain).toHaveBeenCalledWith({
      serviceId: 'rail-web',
      environmentId: 'rail-env-1',
      domain: 'usebillforge.com',
    });
    expect(upsertDnsRecord.mock.calls).toEqual([
      ['zone-1', 'usebillforge.com', 'CNAME', 'web-production.up.railway.app', { proxied: false }],
      ['zone-1', '_railway.usebillforge.com', 'TXT', 'verify-token', { proxied: false }],
    ]);
    expect(payload.customDomainAttached).toBe(true);
    expect(payload.domainDnsConfigured).toBe(true);
  });

  it('allows protected infra_apply with confirm=true', async () => {
    const projectRepo = new ProjectRepository();
    const serviceRepo = new ServiceRepository();
    const project = projectRepo.create({ name: 'protected-approved-infra-project', defaultPlatform: 'railway' });
    projectRepo.update(project.id, {
      policies: {
        protectedEnvironments: ['production'],
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
      envVarSpec: {},
    });
    const fakeDatabaseAdapter: IDatabaseAdapter = {
      name: 'railway',
      capabilities: {
        supportedDatabases: ['postgres'],
        supportedCaches: [],
        supportsPooling: false,
        supportsReadReplicas: false,
        supportsPointInTimeRecovery: false,
        serverlessOptimized: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async provision(_type, environment) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type: 'postgres',
            bindings: { provider: 'railway', connectionString: 'postgres://shared-db' },
            externalId: 'rail-db-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: true,
            message: 'db ready',
            data: { providerProjectId: 'rail-project-1' },
          },
          connectionUrl: 'postgres://shared-db',
          envVars: { DATABASE_URL: 'postgres://shared-db' },
        };
      },
      async getConnectionUrl() {
        return 'postgres://shared-db';
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };

    const fakeHostingAdapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return { success: true, message: 'bound', data: { projectId: 'rail-project-1', environmentId: 'rail-env-1' } };
      },
      async deploy(service) {
        return {
          serviceId: service.id,
          externalId: `rail-${service.name}`,
          status: 'deployed',
          receipt: { success: true, message: 'deployed', data: { environmentId: 'rail-env-1' } },
        };
      },
      async setEnvVars() {
        return { success: true, message: 'vars synced' };
      },
      async getDeployStatus() {
        return { status: 'deployed' };
      },
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: fakeDatabaseAdapter });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeHostingAdapter });

    const payload = await applyInfra({
      projectName: project.name,
      environmentName: 'production',
      services: ['web'],
      databaseProvider: 'railway',
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(true);
  });

  it('normalizes Cloud Run web services to public during infra_apply unless explicitly private', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const cloudrunProfile = CLOUD_PREPARE_PROFILES.cloudrun;
    const project = projectRepo.create({
      name: 'cloudrun-public-web-project',
      defaultPlatform: 'cloudrun',
      policies: {
        cloudPreparation: {
          cloudrun: {
            provider: 'cloudrun',
            version: cloudrunProfile.version,
            preparedAt: new Date().toISOString(),
            gcpProjectId: 'gcp-project',
            deployServiceAccountEmail: 'deploy@gcp-project.iam.gserviceaccount.com',
            requiredApis: cloudrunProfile.requiredApis,
            requiredRoles: cloudrunProfile.requiredRoles,
          },
        },
      },
    });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: {
        workloadKind: 'web',
        builder: 'dockerfile',
        startCommand: 'npm start',
        public: false,
      },
      envVarSpec: {},
    });

    const deployedPublicFlags: Array<boolean | undefined> = [];
    const fakeDatabaseAdapter: IDatabaseAdapter = {
      name: 'cloudsql',
      capabilities: {
        supportedDatabases: ['postgres'],
        supportedCaches: [],
        supportsPooling: false,
        supportsReadReplicas: false,
        supportsPointInTimeRecovery: true,
        serverlessOptimized: true,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async provision(_type, environment) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type: 'postgres',
            bindings: {
              provider: 'cloudsql',
              connectionString: 'postgres://cloudsql',
            },
            externalId: 'cloudsql-instance',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: { success: true, message: 'provisioned' },
        };
      },
      async getConnectionUrl() {
        return 'postgres://cloudsql';
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };
    const fakeHostingAdapter: IHostingAdapter = {
      name: 'cloudrun',
      capabilities: {
        supportedBuilders: ['dockerfile', 'nixpacks'],
        supportsAutoWiring: false,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: false,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return { success: true, message: 'bound', data: { projectId: 'gcp-project', environmentId: 'us-central1' } };
      },
      async deploy(service) {
        deployedPublicFlags.push(service.buildConfig.public);
        return {
          serviceId: service.id,
          externalId: `gcp-${service.name}`,
          status: 'deployed',
          url: 'https://web.run.app',
          receipt: { success: true, message: 'deployed', data: { environmentId: 'us-central1' } },
        };
      },
      async setEnvVars() {
        return { success: true, message: 'vars synced' };
      },
      async getDeployStatus() {
        return { status: 'deployed' };
      },
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: fakeDatabaseAdapter });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeHostingAdapter });

    const payload = await applyInfra({
      projectName: project.name,
      environmentName: 'production',
      services: ['web'],
      databaseProvider: 'cloudsql',
      serviceConfig: {
        web: {
          startCommand: 'npm start',
          healthCheckPath: '/api/health',
        },
      },
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(deployedPublicFlags).toEqual([true]);
    expect(serviceRepo.findByProjectAndName(project.id, 'web')?.buildConfig.public).toBe(true);

    const privatePayload = await applyInfra({
      projectName: project.name,
      environmentName: 'production',
      services: ['web'],
      databaseProvider: 'cloudsql',
      serviceConfig: {
        web: {
          startCommand: 'npm start',
          healthCheckPath: '/api/health',
          public: false,
        },
      },
      setupEmail: false,
      confirm: true,
    });

    expect(privatePayload.success).toBe(true);
    expect(deployedPublicFlags).toEqual([true, false]);
    expect(serviceRepo.findByProjectAndName(project.id, 'web')?.buildConfig.public).toBe(false);
  });

  it('blocks Cloud Run infra_apply before provisioning when cloud_prepare has not been recorded', async () => {
    const projectRepo = new ProjectRepository();
    const project = projectRepo.create({
      name: 'unprepared-cloudrun-project',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'git@github.com:davejohnson/hls-property-care.git',
    });
    const databaseAdapterSpy = vi.spyOn(adapterFactory, 'getDatabaseAdapter');
    const hostingAdapterSpy = vi.spyOn(adapterFactory, 'getHostingAdapter');

    const payload = await applyInfra({
      projectName: project.name,
      environmentName: 'production',
      services: ['web'],
      databaseProvider: 'cloudsql',
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Run hv_connect provider="cloudrun" action="prepare" confirm=true before applying');
    expect(payload.summary).toMatchObject({
      action: 'cloud_prepare',
      provider: 'cloudrun',
      requiredVersion: 'gcp-cloudrun-v1',
    });
    expect(databaseAdapterSpy).not.toHaveBeenCalled();
    expect(hostingAdapterSpy).not.toHaveBeenCalled();
  });
});
