import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { DeployOrchestrator } from '../domain/services/deploy.orchestrator.js';
import { CloudflareAdapter, type CloudflareCredentials } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import { SendGridAdapter, type SendGridCredentials } from '../adapters/providers/sendgrid/sendgrid.adapter.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { InfraTransaction } from '../domain/services/infra.transaction.js';
import {
  snapshotComponentRecord,
  snapshotEnvironmentBindings,
} from '../domain/services/local-state.transaction.js';
import { resolveProject } from './resolve-project.js';
import { buildRailwayGitHubRepoAccessHelp, isRailwayGitHubRepoAccessError } from './railway-help.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Receipt } from '../domain/ports/provider.port.js';
import type { IHostingAdapter } from '../domain/ports/hosting.port.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
const DB_PROVIDERS = ['supabase', 'rds', 'cloudsql', 'railway'] as const;

interface GoldenPathPlanItem {
  action: string;
  status: 'ok' | 'needed' | 'blocked';
  detail: string;
}

interface DesiredState {
  environmentName: string;
  services: string[];
  serviceName?: string;
  domain?: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
  serviceConfig?: Record<string, {
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
  }>;
  deploy?: {
    strategy?: 'branch' | 'manual';
    branches?: {
      staging?: string;
      production?: string;
    };
  };
  migrations?: {
    mode?: 'none' | 'releaseCommand' | 'tool';
    runInDeploy?: boolean;
    command?: string;
  };
}

interface ExistingDatabaseState {
  status: 'missing' | 'match' | 'mismatch';
  component?: Component;
  provider?: string;
  envVars?: Record<string, string>;
  connectionUrl?: string;
}

interface GitDeploySource {
  repo: string;
  branch: string;
}

type SourceConfigurableHostingAdapter = {
  connectServiceToRepo?: (params: { serviceId: string; repo: string; branch: string }) => Promise<Receipt>;
};

function normalizeServices(services: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const service of services) {
    if (typeof service !== 'string') continue;
    const trimmed = service.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized.length > 0 ? normalized : ['web'];
}

function explicitServicesOrNull(services: unknown): string[] | null {
  if (!Array.isArray(services)) return null;

  const normalized = services
    .filter((service): service is string => typeof service === 'string')
    .map((service) => service.trim())
    .filter((service) => service.length > 0);

  if (normalized.length === 0) return null;
  return normalizeServices(normalized);
}

function normalizeServiceConfig(
  serviceConfig: unknown
): DesiredState['serviceConfig'] | undefined {
  if (!serviceConfig || typeof serviceConfig !== 'object' || Array.isArray(serviceConfig)) {
    return undefined;
  }

  const normalized: NonNullable<DesiredState['serviceConfig']> = {};
  for (const [serviceName, rawConfig] of Object.entries(serviceConfig as Record<string, unknown>)) {
    if (!serviceName.trim() || !rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) continue;
    const configRecord = rawConfig as Record<string, unknown>;
    const nextConfig: NonNullable<DesiredState['serviceConfig']>[string] = {};

    if (typeof configRecord.startCommand === 'string' && configRecord.startCommand.trim().length > 0) {
      nextConfig.startCommand = configRecord.startCommand.trim();
    }
    if (typeof configRecord.releaseCommand === 'string' && configRecord.releaseCommand.trim().length > 0) {
      nextConfig.releaseCommand = configRecord.releaseCommand.trim();
    }
    if (typeof configRecord.healthCheckPath === 'string' && configRecord.healthCheckPath.trim().length > 0) {
      nextConfig.healthCheckPath = configRecord.healthCheckPath.trim();
    }
    if (typeof configRecord.cronSchedule === 'string' && configRecord.cronSchedule.trim().length > 0) {
      nextConfig.cronSchedule = configRecord.cronSchedule.trim();
    }

    if (Object.keys(nextConfig).length > 0) {
      normalized[serviceName.trim()] = nextConfig;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function getComponentProvider(component: Component | null): string | undefined {
  if (!component) return undefined;
  const bindings = component.bindings as Record<string, unknown>;
  return typeof bindings.provider === 'string' && bindings.provider.length > 0 ? bindings.provider : undefined;
}

function buildEnvVarsFromComponent(component: Component): { envVars: Record<string, string>; connectionUrl?: string } {
  const bindings = component.bindings as Record<string, unknown>;
  const envVars: Record<string, string> = {};
  const connectionUrl =
    (typeof bindings.connectionUrl === 'string' && bindings.connectionUrl.length > 0
      ? bindings.connectionUrl
      : undefined)
    ?? (typeof bindings.connectionString === 'string' && bindings.connectionString.length > 0
      ? bindings.connectionString
      : undefined);

  if (getComponentProvider(component) === 'railway') {
    const pluginName =
      typeof bindings.pluginName === 'string' && bindings.pluginName.trim().length > 0
        ? bindings.pluginName.trim()
        : undefined;
    if (pluginName) {
      envVars.DATABASE_URL = '${{' + pluginName + '.DATABASE_URL}}';
      envVars.DIRECT_URL = '${{' + pluginName + '.DATABASE_PRIVATE_URL}}';
      return { envVars, connectionUrl };
    }
  }

  if (connectionUrl) {
    envVars.DATABASE_URL = connectionUrl;
    envVars.DIRECT_URL = connectionUrl;
  }
  if (typeof bindings.pooledUrl === 'string' && bindings.pooledUrl.length > 0) {
    envVars.DATABASE_POOLER_URL = bindings.pooledUrl;
  }
  if (typeof bindings.host === 'string' && bindings.host.length > 0) {
    envVars.PGHOST = bindings.host;
    envVars.DB_HOST = bindings.host;
  }
  if (typeof bindings.port === 'number' || typeof bindings.port === 'string') {
    const port = String(bindings.port);
    envVars.PGPORT = port;
    envVars.DB_PORT = port;
  }
  if (typeof bindings.username === 'string' && bindings.username.length > 0) {
    envVars.PGUSER = bindings.username;
    envVars.DB_USER = bindings.username;
  }
  if (typeof bindings.password === 'string' && bindings.password.length > 0) {
    envVars.PGPASSWORD = bindings.password;
    envVars.DB_PASSWORD = bindings.password;
  }
  if (typeof bindings.database === 'string' && bindings.database.length > 0) {
    envVars.PGDATABASE = bindings.database;
    envVars.DB_NAME = bindings.database;
  }

  return { envVars, connectionUrl };
}

function resolveExistingDatabaseState(
  environmentId: string,
  desiredProvider: (typeof DB_PROVIDERS)[number]
): ExistingDatabaseState {
  const component = componentRepo.findByEnvironmentAndType(environmentId, 'postgres');
  if (!component) {
    return { status: 'missing' };
  }

  const provider = getComponentProvider(component);
  if (provider === desiredProvider) {
    const { envVars, connectionUrl } = buildEnvVarsFromComponent(component);
    return {
      status: 'match',
      component,
      provider,
      envVars,
      connectionUrl,
    };
  }

  return {
    status: 'mismatch',
    component,
    provider,
  };
}

function parseGitHubRepoFromRemote(remoteUrl?: string): string | null {
  if (!remoteUrl) {
    return null;
  }

  const normalized = remoteUrl.trim().replace(/\.git$/i, '');

  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }
    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
  } catch {
    // Not a URL format, continue with SSH-like parsing.
  }

  const sshMatch = normalized.match(/^(?:ssh:\/\/)?(?:git@)?github\.com[:/](.+)$/i);
  if (!sshMatch) {
    return null;
  }

  const parts = sshMatch[1].replace(/^\/+/, '').split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

function classifyDeployEnvironment(environmentName: string): 'staging' | 'production' | null {
  const normalized = environmentName.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod' || normalized.includes('prod')) {
    return 'production';
  }
  if (normalized === 'staging' || normalized === 'stage' || normalized.includes('stag')) {
    return 'staging';
  }
  return null;
}

function resolveGitDeploySource(
  project: { gitRemoteUrl?: string },
  environmentName: string,
  deploy?: DesiredState['deploy']
): { source: GitDeploySource | null; error?: string } {
  if (deploy?.strategy !== 'branch') {
    return { source: null };
  }

  const kind = classifyDeployEnvironment(environmentName);
  if (!kind) {
    return {
      source: null,
      error: `Branch deploy strategy only supports staging/production environments; could not map "${environmentName}" to a deploy branch.`,
    };
  }

  const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repo) {
    return {
      source: null,
      error: 'Project gitRemoteUrl is missing or is not a GitHub remote, so Railway repo-linked deploys cannot be configured.',
    };
  }

  const branch = kind === 'production'
    ? deploy?.branches?.production ?? 'main'
    : deploy?.branches?.staging ?? 'staging';

  return {
    source: {
      repo,
      branch,
    },
  };
}

export function resolveDesiredState(
  policyState: Partial<DesiredState> | undefined,
  overrides: Partial<DesiredState>
): DesiredState {
  const overrideServices = explicitServicesOrNull(overrides.services);
  const policyServices = explicitServicesOrNull(policyState?.services);
  const fallbackPrimaryService =
    (typeof overrides.serviceName === 'string' && overrides.serviceName.trim().length > 0
      ? overrides.serviceName.trim()
      : undefined)
    ?? (typeof policyState?.serviceName === 'string' && policyState.serviceName.trim().length > 0
      ? policyState.serviceName.trim()
      : undefined)
    ?? 'web';
  const fallbackServices = overrideServices
    ?? policyServices
    ?? [fallbackPrimaryService];

  return {
    environmentName: overrides.environmentName ?? policyState?.environmentName ?? 'staging',
    services: fallbackServices,
    serviceName: fallbackServices[0],
    domain: overrides.domain ?? policyState?.domain,
    databaseProvider: overrides.databaseProvider ?? policyState?.databaseProvider ?? 'supabase',
    setupEmail: overrides.setupEmail ?? policyState?.setupEmail ?? true,
    serviceConfig: normalizeServiceConfig(overrides.serviceConfig) ?? normalizeServiceConfig(policyState?.serviceConfig),
    deploy: overrides.deploy ?? policyState?.deploy,
    migrations: overrides.migrations ?? policyState?.migrations,
  };
}

const deployDesiredSchema = z.object({
  strategy: z.enum(['branch', 'manual']).optional(),
  branches: z
    .object({
      staging: z.string().min(1).optional(),
      production: z.string().min(1).optional(),
    })
    .optional(),
});

const migrationDesiredSchema = z.object({
  mode: z.enum(['none', 'releaseCommand', 'tool']).optional(),
  runInDeploy: z.boolean().optional(),
  command: z.string().min(1).optional(),
});

const serviceRuntimeConfigSchema = z.object({
  startCommand: z.string().min(1).optional(),
  releaseCommand: z.string().min(1).optional(),
  healthCheckPath: z.string().min(1).optional(),
  cronSchedule: z.string().min(1).optional(),
});

const serviceConfigSchema = z.record(z.string().min(1), serviceRuntimeConfigSchema);

function buildPlan(params: {
  projectName: string;
  environmentName: string;
  services: string[];
  domain?: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
  serviceConfig?: DesiredState['serviceConfig'];
  deploy?: DesiredState['deploy'];
}): GoldenPathPlanItem[] {
  const project = resolveProject({ projectName: params.projectName });
  const plan: GoldenPathPlanItem[] = [];
  const targetPlatform = (project?.defaultPlatform ?? 'railway').toLowerCase();

  if (!project) {
    plan.push({
      action: 'project_create',
      status: 'needed',
      detail: `Create project "${params.projectName}"`,
    });
  } else {
    plan.push({
      action: 'project_create',
      status: 'ok',
      detail: `Project "${params.projectName}" already exists`,
    });
  }

  const effectiveProject = project ?? projectRepo.findByName(params.projectName) ?? null;
  const scopeHints = effectiveProject ? getProjectScopeHints(effectiveProject) : [];
  const env = effectiveProject ? envRepo.findByProjectAndName(effectiveProject.id, params.environmentName) : null;

  plan.push({
    action: 'env_create',
    status: env ? 'ok' : 'needed',
    detail: env
      ? `Environment "${params.environmentName}" exists`
      : `Create environment "${params.environmentName}"`,
  });

  for (const serviceName of params.services) {
    const service = effectiveProject ? serviceRepo.findByProjectAndName(effectiveProject.id, serviceName) : null;
    plan.push({
      action: 'service_create',
      status: service ? 'ok' : 'needed',
      detail: service ? `Service "${serviceName}" exists` : `Create service "${serviceName}"`,
    });
  }

  const existingDatabase = env ? resolveExistingDatabaseState(env.id, params.databaseProvider) : { status: 'missing' as const };
  const dbConnection = connectionRepo.findBestMatchFromHints(params.databaseProvider, scopeHints);
  plan.push({
    action: 'db_provision',
    status:
      existingDatabase.status === 'match'
        ? 'ok'
        : dbConnection
          ? 'needed'
          : 'blocked',
    detail:
      existingDatabase.status === 'match'
        ? `Postgres already managed on ${params.databaseProvider}`
        : existingDatabase.status === 'mismatch'
          ? dbConnection
            ? `Switch postgres from ${existingDatabase.provider ?? 'unknown'} to ${params.databaseProvider}`
            : `Missing verified ${params.databaseProvider} connection to replace existing ${existingDatabase.provider ?? 'unknown'} postgres`
          : dbConnection
            ? `Provision postgres on ${params.databaseProvider}`
            : `Missing verified ${params.databaseProvider} connection`,
  });

  const railwayConnection = connectionRepo.findBestMatchFromHints('railway', scopeHints);
  for (const serviceName of params.services) {
    plan.push({
      action: 'deploy',
      status: railwayConnection ? 'needed' : 'blocked',
      detail: railwayConnection
        ? `Deploy service "${serviceName}" to Railway`
        : 'Missing verified Railway connection',
    });
  }

  for (const serviceName of params.services) {
    const runtimeConfig = params.serviceConfig?.[serviceName];
    if (!runtimeConfig) continue;
    const parts: string[] = [];
    if (runtimeConfig.startCommand) parts.push(`start=${runtimeConfig.startCommand}`);
    if (runtimeConfig.healthCheckPath) parts.push(`health=${runtimeConfig.healthCheckPath}`);
    if (runtimeConfig.cronSchedule) parts.push(`cron=${runtimeConfig.cronSchedule}`);
    if (runtimeConfig.releaseCommand) parts.push(`release=${runtimeConfig.releaseCommand}`);
    plan.push({
      action: 'service_configure',
      status: runtimeConfig.releaseCommand && targetPlatform === 'railway' ? 'blocked' : 'needed',
      detail:
        runtimeConfig.releaseCommand && targetPlatform === 'railway'
          ? `Configure service "${serviceName}" (${parts.join(', ')}). Railway releaseCommand is not API-configurable; use migrations.mode=tool or railway.toml.`
          : `Configure service "${serviceName}" (${parts.join(', ')})`,
    });
  }

  const deploySource = project ? resolveGitDeploySource(project, params.environmentName, params.deploy) : { source: null };
  if (params.deploy?.strategy === 'branch') {
    for (const serviceName of params.services) {
      plan.push({
        action: 'deploy_source_configure',
        status: deploySource.source ? 'needed' : 'blocked',
        detail: deploySource.source
          ? `Connect service "${serviceName}" to GitHub ${deploySource.source.repo}#${deploySource.source.branch}`
          : deploySource.error ?? `Unable to configure branch deploy source for service "${serviceName}"`,
      });
    }
  }

  if (params.domain) {
    const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);
    plan.push({
      action: 'dns_configure',
      status: cfConnection ? 'needed' : 'blocked',
      detail: cfConnection
        ? `Configure DNS for ${params.domain}`
        : `Missing verified Cloudflare connection for ${params.domain}`,
    });
  }

  if (params.setupEmail) {
    const sgConnection = connectionRepo.findBestMatchFromHints('sendgrid', scopeHints);
    plan.push({
      action: 'sendgrid_setup',
      status: sgConnection ? 'needed' : 'blocked',
      detail: sgConnection ? 'Sync SendGrid key and domain auth' : 'Missing verified SendGrid connection',
    });
  }

  return plan;
}

export function isProtectedEnvironment(project: { policies: Record<string, unknown> }, environmentName: string): boolean {
  const protectedEnvs = Array.isArray(project.policies?.protectedEnvironments)
    ? (project.policies.protectedEnvironments as unknown[]).map((v) => String(v).toLowerCase())
    : [];
  return protectedEnvs.includes(environmentName.toLowerCase());
}

export function infraApprovalsRequiredForEnvironment(
  project: { policies: Record<string, unknown> },
  environmentName: string
): boolean {
  if (!isProtectedEnvironment(project, environmentName)) return false;
  return project.policies?.requireApprovalForProtectedEnvironments !== false;
}

async function executeBootstrap(params: {
  projectName: string;
  environmentName: string;
  services: string[];
  domain?: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
  serviceConfig?: DesiredState['serviceConfig'];
  deploy?: DesiredState['deploy'];
}): Promise<{ success: boolean; summary: Record<string, unknown> }> {
  const tx = new InfraTransaction();
  let project = resolveProject({ projectName: params.projectName });
  if (!project) {
    project = projectRepo.create({ name: params.projectName, defaultPlatform: 'railway' });
    const createdProjectId = project.id;
    tx.addStep({
      id: `project:${createdProjectId}`,
      label: 'project_create',
      resource: { provider: 'hypervibe', type: 'project', id: createdProjectId, name: project.name },
      compensate: async () => ({
        success: projectRepo.delete(createdProjectId),
        message: `Deleted local project ${createdProjectId}`,
      }),
    });
  }

  let environment = envRepo.findByProjectAndName(project.id, params.environmentName);
  if (!environment) {
    environment = envRepo.create({ projectId: project.id, name: params.environmentName });
    const createdEnvironmentId = environment.id;
    tx.addStep({
      id: `environment:${createdEnvironmentId}`,
      label: 'env_create',
      resource: { provider: 'hypervibe', type: 'environment', id: createdEnvironmentId, name: environment.name },
      compensate: async () => ({
        success: envRepo.delete(createdEnvironmentId),
        message: `Deleted local environment ${createdEnvironmentId}`,
      }),
    });
  }

  const services = params.services.map((serviceName) => {
    let service = serviceRepo.findByProjectAndName(project.id, serviceName);
    const runtimeConfig = params.serviceConfig?.[serviceName];
    if (!service) {
      service = serviceRepo.create({
        projectId: project.id,
        name: serviceName,
        buildConfig: {
          builder: 'nixpacks',
          ...(runtimeConfig?.startCommand ? { startCommand: runtimeConfig.startCommand } : {}),
          ...(runtimeConfig?.releaseCommand ? { releaseCommand: runtimeConfig.releaseCommand } : {}),
          ...(runtimeConfig?.healthCheckPath ? { healthCheckPath: runtimeConfig.healthCheckPath } : {}),
          ...(runtimeConfig?.cronSchedule ? { cronSchedule: runtimeConfig.cronSchedule } : {}),
        },
      });
      const createdServiceId = service.id;
      tx.addStep({
        id: `service:${createdServiceId}`,
        label: 'service_create',
        resource: { provider: 'hypervibe', type: 'service', id: createdServiceId, name: service.name },
        compensate: async () => ({
          success: serviceRepo.delete(createdServiceId),
          message: `Deleted local service ${createdServiceId}`,
        }),
      });
    } else if (runtimeConfig) {
      service = serviceRepo.update(service.id, {
        buildConfig: {
          ...service.buildConfig,
          ...(runtimeConfig.startCommand ? { startCommand: runtimeConfig.startCommand } : {}),
          ...(runtimeConfig.releaseCommand ? { releaseCommand: runtimeConfig.releaseCommand } : {}),
          ...(runtimeConfig.healthCheckPath ? { healthCheckPath: runtimeConfig.healthCheckPath } : {}),
          ...(runtimeConfig.cronSchedule ? { cronSchedule: runtimeConfig.cronSchedule } : {}),
        },
      }) ?? service;
    }
    return service;
  });

  if (services.length === 0) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: 'No services resolved for infrastructure apply',
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const existingDatabase = resolveExistingDatabaseState(environment.id, params.databaseProvider);
  let dbProvision: {
    component: Component;
    receipt: { success: boolean; message: string; error?: string; data?: Record<string, unknown> };
    connectionUrl?: string;
    envVars?: Record<string, string>;
  };

  if (existingDatabase.status === 'match' && existingDatabase.component) {
    dbProvision = {
      component: existingDatabase.component,
      receipt: {
        success: true,
        message: `Reusing existing postgres on ${params.databaseProvider}`,
        data: {
          phase: 'reuseExisting',
          provider: params.databaseProvider,
          componentId: existingDatabase.component.externalId ?? existingDatabase.component.id,
        },
      },
      connectionUrl: existingDatabase.connectionUrl,
      envVars: existingDatabase.envVars,
    };
  } else {
    const dbAdapterResult = await adapterFactory.getDatabaseAdapter(params.databaseProvider, project);
    if (!dbAdapterResult.success || !dbAdapterResult.adapter) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          error: dbAdapterResult.error || 'Database adapter unavailable',
          rollback: cleanup,
          transaction: { created: tx.listResources() },
        },
      };
    };

    snapshotEnvironmentBindings({
      tx,
      envRepo,
      environmentId: environment.id,
      label: 'environment_bindings_db_provision',
    });
    dbProvision = await dbAdapterResult.adapter.provision('postgres', environment, {
      databaseName: project.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
    });
    if (!dbProvision.receipt.success) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          error: dbProvision.receipt.error || dbProvision.receipt.message,
          rollback: cleanup,
          transaction: { created: tx.listResources() },
          debug: {
            phase: 'db_provision',
            provider: params.databaseProvider,
            receiptData: dbProvision.receipt.data ?? null,
          },
        },
      };
    }
    const dbReceiptData = (dbProvision.receipt.data ?? {}) as Record<string, unknown>;
    const provisionProjectId =
      (typeof dbReceiptData.projectId === 'string' ? dbReceiptData.projectId : null) ??
      (typeof dbReceiptData.railwayProjectId === 'string' ? dbReceiptData.railwayProjectId : null);
    const provisionCreatedProject = dbReceiptData.ensureProjectCreated === true;
    if (params.databaseProvider === 'railway' && provisionCreatedProject && provisionProjectId) {
      tx.addStep({
        id: `provider-project:${provisionProjectId}`,
        label: 'db_provision_ensure_project',
        resource: {
          provider: 'railway',
          type: 'project',
          id: provisionProjectId,
          name: params.projectName,
        },
        compensate: async () => {
          const hosting = await adapterFactory.getHostingAdapter(project!);
          if (!hosting.success || !hosting.adapter || typeof hosting.adapter.deleteProject !== 'function') {
            return {
              success: false,
              error: `Manual cleanup required: railway project ${provisionProjectId}`,
            };
          }
          const deleted = await hosting.adapter.deleteProject(provisionProjectId);
          return {
            success: deleted.success,
            error: deleted.error,
            message: deleted.success ? `Deleted provider project ${provisionProjectId}` : undefined,
          };
        },
      });
    }
    // DB provisioning may update provider bindings; refresh the environment object before deploy planning.
    environment = envRepo.findById(environment.id) ?? environment;
    tx.addStep({
      id: `database:${dbProvision.component.externalId ?? dbProvision.component.id}`,
      label: 'db_provision',
      resource: {
        provider: params.databaseProvider,
        type: dbProvision.component.type,
        id: dbProvision.component.externalId ?? dbProvision.component.id,
        metadata: { environmentId: environment.id },
      },
      compensate: async () => dbAdapterResult.adapter!.destroy(dbProvision.component),
    });

    const existingComponent = componentRepo.findByEnvironmentAndType(environment.id, 'postgres');
    if (existingComponent) {
      snapshotComponentRecord({
        tx,
        componentRepo,
        component: existingComponent,
        label: 'component_record_update',
      });
      componentRepo.update(existingComponent.id, {
        bindings: dbProvision.component.bindings,
        externalId: dbProvision.component.externalId ?? undefined,
      });
    } else {
      const createdComponent = componentRepo.create({
        environmentId: environment.id,
        type: 'postgres',
        bindings: dbProvision.component.bindings,
        externalId: dbProvision.component.externalId ?? undefined,
      });
      tx.addStep({
        id: `component:${createdComponent.id}`,
        label: 'component_record_create',
        resource: { provider: 'hypervibe', type: 'component', id: createdComponent.id, name: 'postgres' },
        compensate: async () => ({
          success: componentRepo.delete(createdComponent.id),
          message: `Deleted local component ${createdComponent.id}`,
        }),
      });
    }
  }

  const hostingResult = await adapterFactory.getHostingAdapter(project);
  if (!hostingResult.success || !hostingResult.adapter) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: hostingResult.error || 'Hosting adapter unavailable',
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const unsupportedReleaseCommands = Object.entries(params.serviceConfig ?? {})
    .filter(([, config]) => Boolean(config?.releaseCommand))
    .map(([serviceName]) => serviceName);
  if (unsupportedReleaseCommands.length > 0 && !hostingResult.adapter.capabilities.supportsReleaseCommand) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `Provider ${hostingResult.adapter.name} does not support releaseCommand via API for services: ${unsupportedReleaseCommands.join(', ')}. Use migrations.mode=tool or configure railway.toml manually.`,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const orchestrator = new DeployOrchestrator();
  const deploy = await orchestrator.execute({
    project,
    environment,
    services,
    envVars: dbProvision.envVars,
    adapter: hostingResult.adapter,
  });

  const summary: Record<string, unknown> = {
    project: project.name,
    environment: environment.name,
    service: services[0]?.name,
    services: services.map((service) => service.name),
    deploymentRunId: deploy.run.id,
    deploymentSuccess: deploy.success,
    urls: deploy.urls,
    deploymentCreatedResources: deploy.createdResources,
    deploymentRollback: deploy.rollback,
    transaction: {
      created: tx.listResources(),
    },
    debug: {
      dbProvision: {
        provider: params.databaseProvider,
        receiptData: dbProvision.receipt.data ?? null,
      },
    },
  };

  if (!deploy.success) {
    const cleanup = await tx.rollback();
    summary.rollback = cleanup;
    return {
      success: false,
      summary: {
        ...summary,
        error: deploy.errors.join('; ') || 'Deploy failed',
      },
    };
  }

  const deploySource = resolveGitDeploySource(project, params.environmentName, params.deploy);
  if (params.deploy?.strategy === 'branch') {
    if (!deploySource.source) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: deploySource.error || 'Branch deploy source configuration is incomplete',
          rollback: cleanup,
        },
      };
    }

    const latestEnvironment = envRepo.findById(environment.id) ?? environment;
    const latestBindings = latestEnvironment.platformBindings as Record<string, unknown>;
    const boundServices = (latestBindings.services as Record<string, { serviceId: string; url?: string }> | undefined) ?? {};
    const sourceAdapter = hostingResult.adapter as IHostingAdapter & SourceConfigurableHostingAdapter;

    if (typeof sourceAdapter.connectServiceToRepo !== 'function') {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: `Provider ${hostingResult.adapter.name} does not support repo-linked deploy source configuration`,
          rollback: cleanup,
        },
      };
    }

    const sourceFailures: string[] = [];
    let repoAccessHelp: ReturnType<typeof buildRailwayGitHubRepoAccessHelp> | undefined;
    for (const service of services) {
      const serviceId = boundServices[service.name]?.serviceId;
      if (!serviceId) {
        sourceFailures.push(`${service.name}: missing bound provider service ID`);
        continue;
      }

      const receipt = await sourceAdapter.connectServiceToRepo({
        serviceId,
        repo: deploySource.source.repo,
        branch: deploySource.source.branch,
      });
      if (!receipt.success) {
        const error = receipt.error || receipt.message;
        sourceFailures.push(`${service.name}: ${error}`);
        if (!repoAccessHelp && isRailwayGitHubRepoAccessError(error)) {
          repoAccessHelp = buildRailwayGitHubRepoAccessHelp(deploySource.source.repo);
        }
      }
    }

    if (sourceFailures.length > 0) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: `Failed to configure deploy source for ${sourceFailures.join('; ')}`,
          rollback: cleanup,
          ...(repoAccessHelp
            ? {
                help: repoAccessHelp,
                nextSteps: repoAccessHelp.nextSteps,
              }
            : {}),
        },
      };
    }

    summary.deploySource = {
      strategy: 'branch',
      repo: deploySource.source.repo,
      branch: deploySource.source.branch,
      services: services.map((service) => service.name),
    };
  }

  const scopeHints = getProjectScopeHints(project);
  const secretStore = getSecretStore();

  if (params.setupEmail) {
    const sgConnection = connectionRepo.findBestMatchFromHints('sendgrid', scopeHints);
    if (sgConnection) {
      const sgCreds = secretStore.decryptObject<SendGridCredentials>(sgConnection.credentialsEncrypted);
      const latestEnvironment = envRepo.findById(environment.id) ?? environment;
      const sendgridFailures: string[] = [];
      for (const service of services) {
        const receipt = await hostingResult.adapter.setEnvVars(latestEnvironment, service, {
          SENDGRID_API_KEY: sgCreds.apiKey,
        });
        if (!receipt.success) {
          sendgridFailures.push(`${service.name}: ${receipt.error || receipt.message}`);
        }
      }
      summary.sendgridApiKeySynced = sendgridFailures.length === 0;
      if (sendgridFailures.length > 0) {
        summary.sendgridApiKeySyncError = sendgridFailures.join('; ');
      }

      if (params.domain) {
        const sgAdapter = new SendGridAdapter();
        sgAdapter.connect(sgCreds);
        const existingDomains = await sgAdapter.listDomainAuthentications();
        const existingAuth = existingDomains.find((d) => d.domain.toLowerCase() === params.domain!.toLowerCase());
        const auth = existingAuth ?? await sgAdapter.createDomainAuthentication(params.domain, { default: false });
        const records = [auth.dns.dkim1, auth.dns.dkim2, auth.dns.mail_cname].filter(
          (r): r is NonNullable<typeof r> => Boolean(r)
        );

        const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);
        if (cfConnection) {
          const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
          const cfAdapter = new CloudflareAdapter();
          cfAdapter.connect(cfCreds);
          const zone = await cfAdapter.findZoneByName(params.domain);
          if (zone) {
            const dnsResults: Array<{ name: string; type: string; action: string }> = [];
            for (const record of records) {
              const upsert = await cfAdapter.upsertDnsRecord(zone.id, record.host, record.type, record.data, {
                proxied: false,
              });
              dnsResults.push({ name: record.host, type: record.type, action: upsert.action });
            }
            summary.sendgridDnsSynced = true;
            summary.sendgridDnsRecords = dnsResults;
          } else {
            summary.sendgridDnsSynced = false;
            summary.sendgridDnsError = `Cloudflare zone not found for ${params.domain}`;
          }
        } else {
          summary.sendgridDnsSynced = false;
          summary.sendgridDnsError = 'No Cloudflare connection available for domain DNS setup';
        }
      }
    } else {
      summary.sendgridApiKeySynced = false;
      summary.sendgridApiKeySyncError = 'No SendGrid connection found';
    }
  }

  if (params.domain && deploy.urls[0]) {
    try {
      const targetHost = new URL(deploy.urls[0]).hostname;
      const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);
      if (cfConnection) {
        const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
        const cfAdapter = new CloudflareAdapter();
        cfAdapter.connect(cfCreds);
        const zone = await cfAdapter.findZoneByName(params.domain);
        if (zone) {
          const result = await cfAdapter.upsertDnsRecord(zone.id, params.domain, 'CNAME', targetHost, { proxied: true });
          summary.domainDnsConfigured = true;
          summary.domainDns = { name: params.domain, type: 'CNAME', target: targetHost, action: result.action };
        }
      }
    } catch {
      summary.domainDnsConfigured = false;
    }
  }

  summary.intent = syncProjectIntent(project.id);
  return { success: deploy.success, summary };
}

export function registerInfraTools(server: McpServer): void {
  server.tool(
    'infra_plan',
    'Generate a desired-state plan (Terraform-style) for Railway + DB + DNS + SendGrid.',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().optional().describe('Environment (default: staging)'),
      services: z.array(z.string().min(1)).optional().describe('Service names to converge (default: ["web"])'),
      serviceName: z.string().optional().describe('Service name (default: web)'),
      domain: z.string().optional().describe('Optional domain for DNS configuration'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Database provider (default: supabase)'),
      setupEmail: z.boolean().optional().describe('Include SendGrid setup checks (default: true)'),
      serviceConfig: serviceConfigSchema.optional().describe('Per-service runtime config to include in the plan'),
    },
    async ({
      projectName,
      environmentName,
      services,
      serviceName,
      domain,
      databaseProvider,
      setupEmail,
      serviceConfig,
    }) => {
      const project = resolveProject({ projectName });
      const policyState = (project?.policies?.desiredState as Partial<DesiredState> | undefined) ?? {};
      const desired = resolveDesiredState(policyState, {
        environmentName,
        services,
        serviceName,
        domain,
        databaseProvider,
        setupEmail,
        serviceConfig,
      });

      const plan = buildPlan({
        projectName,
        environmentName: desired.environmentName,
        services: desired.services,
        domain: desired.domain,
        databaseProvider: desired.databaseProvider,
        setupEmail: desired.setupEmail,
        serviceConfig: desired.serviceConfig,
        deploy: desired.deploy,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            mode: 'plan',
            projectName,
            desired,
            environmentName: desired.environmentName,
            serviceName: desired.serviceName,
            services: desired.services,
            plan,
            summary: {
              needed: plan.filter((p) => p.status === 'needed').length,
              blocked: plan.filter((p) => p.status === 'blocked').length,
              ok: plan.filter((p) => p.status === 'ok').length,
            },
          }),
        }],
      };
    }
  );

  server.tool(
    'stack_bootstrap',
    'Bootstrap full web stack quickly: project/env/service, DB provisioning, deploy, optional DNS and SendGrid.',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().optional().describe('Environment (default: staging)'),
      services: z.array(z.string().min(1)).optional().describe('Service names to bootstrap (default: ["web"])'),
      serviceName: z.string().optional().describe('Service name (default: web)'),
      domain: z.string().optional().describe('Optional domain to configure'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Database provider (default: supabase)'),
      setupEmail: z.boolean().optional().describe('Configure SendGrid (default: true)'),
      serviceConfig: serviceConfigSchema.optional().describe('Per-service runtime config to apply during bootstrap'),
      confirm: z.boolean().optional().describe('Set true to apply changes'),
      approvalId: z.string().uuid().optional().describe('Approval ID for protected environments (action: infra.apply)'),
    },
    async ({
      projectName,
      environmentName,
      services,
      serviceName,
      domain,
      databaseProvider,
      setupEmail,
      serviceConfig,
      confirm = false,
      approvalId,
    }) => {
      const existingProject = resolveProject({ projectName });
      const policyState = (existingProject?.policies?.desiredState as Partial<DesiredState> | undefined) ?? {};
      const resolvedDesired = resolveDesiredState(policyState, {
        environmentName,
        services,
        serviceName,
        domain,
        databaseProvider,
        setupEmail,
        serviceConfig,
      });
      const previewPlan = buildPlan({
        projectName,
        environmentName: resolvedDesired.environmentName,
        services: resolvedDesired.services,
        domain: resolvedDesired.domain,
        databaseProvider: resolvedDesired.databaseProvider,
        setupEmail: resolvedDesired.setupEmail,
        serviceConfig: resolvedDesired.serviceConfig,
        deploy: resolvedDesired.deploy,
      });

      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              message: 'Call again with confirm=true to execute bootstrap.',
              desired: resolvedDesired,
              plan: previewPlan,
            }),
          }],
        };
      }

      if (existingProject && isProtectedEnvironment(existingProject, resolvedDesired.environmentName)) {
        const requireApprovals = infraApprovalsRequiredForEnvironment(existingProject, resolvedDesired.environmentName);
        if (requireApprovals) {
          if (!approvalId) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Approval required for protected environment "${resolvedDesired.environmentName}". Create one with approval_request_create and re-run with approvalId.`,
                  requiredAction: 'infra.apply',
                }),
              }],
            };
          }
          const { ApprovalRepository } = await import('../adapters/db/repositories/approval.repository.js');
          const approvalRepo = new ApprovalRepository();
          const validation = approvalRepo.validateForAction(approvalId, existingProject.id, resolvedDesired.environmentName, 'infra.apply');
          if (!validation.ok) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: validation.error }),
              }],
            };
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment "${resolvedDesired.environmentName}" is protected by project policy. Use deploy/rollback tools with explicit production confirm.`,
            }),
          }],
        };
      }

      const executed = await executeBootstrap({
        projectName,
        environmentName: resolvedDesired.environmentName,
        services: resolvedDesired.services,
        domain: resolvedDesired.domain,
        databaseProvider: resolvedDesired.databaseProvider,
        setupEmail: resolvedDesired.setupEmail,
        serviceConfig: resolvedDesired.serviceConfig,
        deploy: resolvedDesired.deploy,
      });
      if (!executed.success && executed.summary.error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: executed.summary.error,
              summary: executed.summary,
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: executed.success,
            ...executed.summary,
          }),
        }],
      };
    }
  );

  server.tool(
    'infra_desired_set',
    'Persist desired stack state on project policies for team/repeatable apply flows.',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().optional().describe('Desired environment (default: staging)'),
      services: z.array(z.string().min(1)).optional().describe('Desired services to converge (default: ["web"])'),
      serviceName: z.string().optional().describe('Desired service (default: web)'),
      domain: z.string().optional().describe('Optional desired domain'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Desired DB provider (default: supabase)'),
      setupEmail: z.boolean().optional().describe('Include SendGrid setup (default: true)'),
      serviceConfig: serviceConfigSchema.optional().describe('Desired per-service runtime config'),
      deploy: deployDesiredSchema.optional().describe('Desired deploy strategy and branch mapping'),
      migrations: migrationDesiredSchema.optional().describe('Desired migration behavior during deploy'),
    },
    async ({
      projectName,
      environmentName = 'staging',
      services,
      serviceName = 'web',
      domain,
      databaseProvider = 'supabase',
      setupEmail = true,
      serviceConfig,
      deploy,
      migrations,
    }) => {
      const project = resolveProject({ projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const desiredState = resolveDesiredState(undefined, {
        environmentName,
        services,
        serviceName,
        domain,
        databaseProvider,
        setupEmail,
        serviceConfig,
        deploy,
        migrations,
      });
      const nextPolicies = { ...(project.policies ?? {}), desiredState };
      const updated = projectRepo.update(project.id, { policies: nextPolicies });
      const intent = syncProjectIntent(project.id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: updated?.name ?? project.name,
            desiredState,
            intent,
          }),
        }],
      };
    }
  );

  server.tool(
    'infra_desired_get',
    'Read persisted desired stack state for a project.',
    {
      projectName: z.string().describe('Project name'),
    },
    async ({ projectName }) => {
      const project = resolveProject({ projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: project.name,
            desiredState: (project.policies?.desiredState as Record<string, unknown> | undefined) ?? null,
          }),
        }],
      };
    }
  );

  server.tool(
    'infra_apply',
    'Apply persisted desired state (or explicit state) to create/update provider infrastructure. Use this for new setup and retries; use project_import only to adopt already-existing live projects.',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().optional().describe('Override desired environment'),
      services: z.array(z.string().min(1)).optional().describe('Override desired services to converge'),
      serviceName: z.string().optional().describe('Override desired service'),
      domain: z.string().optional().describe('Override desired domain'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Override desired DB provider'),
      setupEmail: z.boolean().optional().describe('Override desired email setup'),
      serviceConfig: serviceConfigSchema.optional().describe('Override desired per-service runtime config'),
      deploy: deployDesiredSchema.optional().describe('Override desired deploy strategy and branches'),
      migrations: migrationDesiredSchema.optional().describe('Override desired migration behavior'),
      confirm: z.boolean().optional().describe('Set true to apply'),
      approvalId: z.string().uuid().optional().describe('Approval ID for protected environments (action: infra.apply)'),
    },
    async ({ projectName, environmentName, services, serviceName, domain, databaseProvider, setupEmail, serviceConfig, deploy, migrations, confirm = false, approvalId }) => {
      const project = resolveProject({ projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const policyState = (project.policies?.desiredState as Partial<DesiredState> | undefined) ?? {};
      const desired = resolveDesiredState(policyState, {
        environmentName,
        services,
        serviceName,
        domain,
        databaseProvider,
        setupEmail,
        serviceConfig,
        deploy,
        migrations,
      });

      const plan = buildPlan({
        projectName,
        environmentName: desired.environmentName,
        services: desired.services,
        domain: desired.domain,
        databaseProvider: desired.databaseProvider,
        setupEmail: desired.setupEmail,
        serviceConfig: desired.serviceConfig,
        deploy: desired.deploy,
      });

      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              desired,
              services: desired.services,
              plan,
              message: 'Call again with confirm=true to apply desired state.',
            }),
          }],
        };
      }

      if (isProtectedEnvironment(project, desired.environmentName)) {
        const requireApprovals = infraApprovalsRequiredForEnvironment(project, desired.environmentName);
        if (requireApprovals) {
          if (!approvalId) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Approval required for protected environment "${desired.environmentName}". Create one with approval_request_create and re-run with approvalId.`,
                  requiredAction: 'infra.apply',
                }),
              }],
            };
          }
          const { ApprovalRepository } = await import('../adapters/db/repositories/approval.repository.js');
          const approvalRepo = new ApprovalRepository();
          const validation = approvalRepo.validateForAction(approvalId, project.id, desired.environmentName, 'infra.apply');
          if (!validation.ok) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: validation.error }),
              }],
            };
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment "${desired.environmentName}" is protected by project policy.`,
            }),
          }],
        };
      }

      const executed = await executeBootstrap({
        projectName,
        environmentName: desired.environmentName,
        services: desired.services,
        domain: desired.domain,
        databaseProvider: desired.databaseProvider,
        setupEmail: desired.setupEmail,
        serviceConfig: desired.serviceConfig,
        deploy: desired.deploy,
      });
      if (!executed.success && executed.summary.error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: executed.summary.error, summary: executed.summary }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: executed.success,
            desired,
            ...executed.summary,
          }),
        }],
      };
    }
  );
}
