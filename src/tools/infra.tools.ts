import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { ApprovalRepository } from '../adapters/db/repositories/approval.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { DeployOrchestrator } from '../domain/services/deploy.orchestrator.js';
import { CloudflareAdapter, type CloudflareCredentials } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import { SendGridAdapter, assessSendGridScopes, type SendGridCredentials } from '../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { GitHubCredentials } from '../adapters/providers/github/github.adapter.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { InfraTransaction } from '../domain/services/infra.transaction.js';
import { buildDatabaseEnvVarsFromComponent } from '../domain/services/database-env.js';
import { getCloudPrepareProfile, isCloudPrepared } from '../domain/services/cloud-prepare.js';
import {
  snapshotComponentRecord,
  snapshotEnvironmentBindings,
} from '../domain/services/local-state.transaction.js';
import { resolveProject } from './resolve-project.js';
import { parseGitHubRepoFromRemote, normalizeGitRemoteForBuild } from '../lib/git-remote.js';
import { hostingProviderForEnvironment } from './hosting-env.js';
import { buildRailwayGitHubRepoAccessHelp, isRailwayGitHubRepoAccessError } from './railway-help.js';
import type { Component } from '../domain/entities/component.entity.js';
import { serviceWorkloadKind, type WorkloadKind } from '../domain/entities/service.entity.js';
import type { Receipt } from '../domain/ports/provider.port.js';
import type { IHostingAdapter } from '../domain/ports/hosting.port.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
const approvalRepo = new ApprovalRepository();
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
  crons?: Record<string, {
    schedule: string;
    command?: string;
    timeZone?: string;
  }>;
  domain?: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
  serviceConfig?: Record<string, {
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
    public?: boolean;
  }>;
  envVars?: Record<string, string>;
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

type DesiredCronConfig = NonNullable<DesiredState['crons']>[string];

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

type DomainConfigurableHostingAdapter = {
  attachCustomDomain?: (params: { serviceId: string; environmentId: string; domain: string }) => Promise<Receipt>;
};

type DatabaseEnsuringAdapter = {
  ensureDatabase?: (component: Component, databaseName?: string) => Promise<Receipt>;
};

async function ensureDatabaseIfSupported(
  adapter: unknown,
  component: Component,
  databaseName?: string
): Promise<Receipt | undefined> {
  const databaseAdapter = adapter as DatabaseEnsuringAdapter;
  if (typeof databaseAdapter.ensureDatabase !== 'function') {
    return undefined;
  }
  return databaseAdapter.ensureDatabase(component, databaseName);
}

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
    if (typeof configRecord.public === 'boolean') {
      nextConfig.public = configRecord.public;
    }

    if (Object.keys(nextConfig).length > 0) {
      normalized[serviceName.trim()] = nextConfig;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeCrons(crons: unknown): DesiredState['crons'] | undefined {
  if (!crons || typeof crons !== 'object' || Array.isArray(crons)) {
    return undefined;
  }

  const normalized: NonNullable<DesiredState['crons']> = {};
  for (const [cronName, rawConfig] of Object.entries(crons as Record<string, unknown>)) {
    const name = cronName.trim();
    if (!name || !rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) continue;
    const config = rawConfig as Record<string, unknown>;
    const schedule = typeof config.schedule === 'string' && config.schedule.trim().length > 0
      ? config.schedule.trim()
      : typeof config.cronSchedule === 'string' && config.cronSchedule.trim().length > 0
        ? config.cronSchedule.trim()
        : undefined;
    if (!schedule) continue;

    normalized[name] = {
      schedule,
      ...(typeof config.command === 'string' && config.command.trim().length > 0
        ? { command: config.command.trim() }
        : {}),
      ...(typeof config.startCommand === 'string' && config.startCommand.trim().length > 0
        ? { command: config.startCommand.trim() }
        : {}),
      ...(typeof config.timeZone === 'string' && config.timeZone.trim().length > 0
        ? { timeZone: config.timeZone.trim() }
        : {}),
    };
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function splitDesiredWorkloads(params: {
  services: string[];
  serviceConfig?: DesiredState['serviceConfig'];
  crons?: DesiredState['crons'];
}): {
  services: string[];
  serviceConfig?: DesiredState['serviceConfig'];
  crons?: DesiredState['crons'];
} {
  const crons: NonNullable<DesiredState['crons']> = { ...(params.crons ?? {}) };
  const serviceConfig: NonNullable<DesiredState['serviceConfig']> = {};

  for (const [name, config] of Object.entries(params.serviceConfig ?? {})) {
    if (config.cronSchedule) {
      crons[name] = {
        schedule: config.cronSchedule,
        ...(config.startCommand ? { command: config.startCommand } : {}),
      };
      continue;
    }

    serviceConfig[name] = config;
  }

  const cronNames = new Set(Object.keys(crons));
  const services = params.services.filter((serviceName) => !cronNames.has(serviceName));

  return {
    services,
    serviceConfig: Object.keys(serviceConfig).length > 0 ? serviceConfig : undefined,
    crons: Object.keys(crons).length > 0 ? crons : undefined,
  };
}

function workloadKindForServiceName(serviceName: string, index: number): WorkloadKind {
  const normalized = serviceName.toLowerCase();
  if (/worker|queue|consumer|processor/.test(normalized)) return 'worker';
  if (/job|task|migrate/.test(normalized)) return 'job';
  return index === 0 ? 'web' : 'worker';
}

function defaultPublicForWorkload(workloadKind: WorkloadKind): boolean {
  return workloadKind === 'web';
}

function normalizeEnvVars(envVars: unknown): Record<string, string> | undefined {
  if (!envVars || typeof envVars !== 'object' || Array.isArray(envVars)) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(envVars as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || typeof rawValue !== 'string') continue;
    normalized[key] = rawValue;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function getComponentProvider(component: Component | null): string | undefined {
  if (!component) return undefined;
  const bindings = component.bindings as Record<string, unknown>;
  return typeof bindings.provider === 'string' && bindings.provider.length > 0 ? bindings.provider : undefined;
}

function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'railway':
      return 'Railway';
    case 'cloudrun':
      return 'GCP Cloud Run';
    case 'apprunner':
      return 'AWS App Runner';
    default:
      return provider;
  }
}

function buildEnvVarsFromComponent(component: Component): { envVars: Record<string, string>; connectionUrl?: string } {
  return buildDatabaseEnvVarsFromComponent(component);
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

function inferExistingDatabaseProvider(
  projectId: string,
  environmentName: string
): (typeof DB_PROVIDERS)[number] | undefined {
  const environment = envRepo.findByProjectAndName(projectId, environmentName);
  if (!environment) {
    return undefined;
  }

  const component = componentRepo.findByEnvironmentAndType(environment.id, 'postgres');
  const provider = getComponentProvider(component);
  if (!provider) {
    return undefined;
  }

  return DB_PROVIDERS.includes(provider as (typeof DB_PROVIDERS)[number])
    ? (provider as (typeof DB_PROVIDERS)[number])
    : undefined;
}

function resolveDatabaseProviderForProject(
  project: { id: string },
  policyState: Partial<DesiredState> | undefined,
  overrides: { environmentName?: string; databaseProvider?: (typeof DB_PROVIDERS)[number] }
): (typeof DB_PROVIDERS)[number] {
  return overrides.databaseProvider
    ?? policyState?.databaseProvider
    ?? inferExistingDatabaseProvider(project.id, overrides.environmentName ?? policyState?.environmentName ?? 'staging')
    ?? 'supabase';
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
  const normalizedCrons = normalizeCrons(overrides.crons) ?? normalizeCrons(policyState?.crons);
  const normalizedServiceConfig = normalizeServiceConfig(overrides.serviceConfig) ?? normalizeServiceConfig(policyState?.serviceConfig);
  const fallbackPrimaryService =
    (typeof overrides.serviceName === 'string' && overrides.serviceName.trim().length > 0
      ? overrides.serviceName.trim()
      : undefined)
    ?? (typeof policyState?.serviceName === 'string' && policyState.serviceName.trim().length > 0
      ? policyState.serviceName.trim()
      : undefined)
    ?? 'web';
  const hasExplicitServiceIntent = Boolean(overrideServices ?? policyServices ?? overrides.serviceName ?? policyState?.serviceName);
  const fallbackServices = overrideServices
    ?? policyServices
    ?? (normalizedCrons && !hasExplicitServiceIntent ? [] : undefined)
    ?? [fallbackPrimaryService];
  const workloads = splitDesiredWorkloads({
    services: fallbackServices,
    serviceConfig: normalizedServiceConfig,
    crons: normalizedCrons,
  });

  return {
    environmentName: overrides.environmentName ?? policyState?.environmentName ?? 'staging',
    services: workloads.services,
    serviceName: workloads.services[0] ?? Object.keys(workloads.crons ?? {})[0] ?? fallbackPrimaryService,
    crons: workloads.crons,
    domain: overrides.domain ?? policyState?.domain,
    databaseProvider: overrides.databaseProvider ?? policyState?.databaseProvider ?? 'supabase',
    setupEmail: overrides.setupEmail ?? policyState?.setupEmail ?? true,
    serviceConfig: workloads.serviceConfig,
    envVars: normalizeEnvVars(overrides.envVars) ?? normalizeEnvVars(policyState?.envVars),
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
  public: z.boolean().optional(),
});

const cronConfigSchema = z.object({
  schedule: z.string().min(1).optional(),
  cronSchedule: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  startCommand: z.string().min(1).optional(),
  timeZone: z.string().min(1).optional(),
}).refine((value) => Boolean(value.schedule ?? value.cronSchedule), {
  message: 'Cron jobs require schedule or cronSchedule',
});

const serviceConfigSchema = z.record(z.string().min(1), serviceRuntimeConfigSchema);
const cronsSchema = z.record(z.string().min(1), cronConfigSchema);
const envVarsSchema = z.record(z.string());

function buildPlan(params: {
  projectName: string;
  environmentName: string;
  services: string[];
  crons?: DesiredState['crons'];
  domain?: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
  serviceConfig?: DesiredState['serviceConfig'];
  deploy?: DesiredState['deploy'];
}): GoldenPathPlanItem[] {
  const project = resolveProject({ projectName: params.projectName });
  const plan: GoldenPathPlanItem[] = [];

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
  const targetPlatform = effectiveProject && env
    ? hostingProviderForEnvironment(effectiveProject, env)
    : (effectiveProject?.defaultPlatform ?? 'cloudrun').toLowerCase();

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

  for (const cronName of Object.keys(params.crons ?? {})) {
    const service = effectiveProject ? serviceRepo.findByProjectAndName(effectiveProject.id, cronName) : null;
    const isCron = service ? serviceWorkloadKind(service) === 'cron' : false;
    plan.push({
      action: 'cron_create',
      status: service && isCron ? 'ok' : 'needed',
      detail: service && isCron ? `Cron job "${cronName}" exists` : `Create cron job "${cronName}"`,
    });
  }

  const existingDatabase = env ? resolveExistingDatabaseState(env.id, params.databaseProvider) : { status: 'missing' as const };
  const dbConnection = connectionRepo.findBestMatchFromHints(params.databaseProvider, scopeHints);
  const hostingConnection = connectionRepo.findBestMatchFromHints(targetPlatform, scopeHints);
  const cloudPrepareProfile = getCloudPrepareProfile(targetPlatform);
  const cloudPrepared = cloudPrepareProfile ? isCloudPrepared(effectiveProject, targetPlatform) : true;
  if (cloudPrepareProfile) {
    plan.push({
      action: 'cloud_prepare',
      status: !effectiveProject || !hostingConnection
        ? 'blocked'
        : cloudPrepared ? 'ok' : 'needed',
      detail: !effectiveProject
        ? `Create project before preparing ${cloudPrepareProfile.label}`
        : !hostingConnection
          ? `Missing verified ${providerDisplayName(targetPlatform)} connection`
          : cloudPrepared
            ? `${cloudPrepareProfile.label} is prepared for Hypervibe deploys`
            : `Prepare ${cloudPrepareProfile.label} with cloud_prepare before deploy`,
    });
  }
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

  const hostingLabel = providerDisplayName(targetPlatform);
  for (const serviceName of params.services) {
    plan.push({
      action: 'deploy',
      status: hostingConnection && cloudPrepared ? 'needed' : 'blocked',
      detail: !hostingConnection
        ? `Missing verified ${hostingLabel} connection`
        : !cloudPrepared
          ? `Run cloud_prepare for ${hostingLabel} before deploying service "${serviceName}"`
          : `Deploy service "${serviceName}" to ${hostingLabel}`,
    });
  }

  for (const [cronName, cronConfig] of Object.entries(params.crons ?? {})) {
    plan.push({
      action: 'cron_deploy',
      status: hostingConnection && cloudPrepared ? 'needed' : 'blocked',
      detail: !hostingConnection
        ? `Missing verified ${hostingLabel} connection`
        : !cloudPrepared
          ? `Run cloud_prepare for ${hostingLabel} before deploying cron job "${cronName}"`
          : `Deploy cron job "${cronName}" (${cronConfig.schedule}) to ${hostingLabel}`,
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
    if (typeof runtimeConfig.public === 'boolean') parts.push(`public=${runtimeConfig.public}`);
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
    for (const serviceName of [...params.services, ...Object.keys(params.crons ?? {})]) {
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
  crons?: DesiredState['crons'];
  domain?: string;
  databaseProvider: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
  serviceConfig?: DesiredState['serviceConfig'];
  envVars?: DesiredState['envVars'];
  deploy?: DesiredState['deploy'];
}): Promise<{ success: boolean; summary: Record<string, unknown> }> {
  const tx = new InfraTransaction();
  let project = resolveProject({ projectName: params.projectName });
  if (!project) {
    project = projectRepo.create({ name: params.projectName, defaultPlatform: 'cloudrun' });
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
  const scopeHints = getProjectScopeHints(project);

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

  const serviceWorkloads = params.services.map((serviceName, index) => {
    let service = serviceRepo.findByProjectAndName(project.id, serviceName);
    const runtimeConfig = params.serviceConfig?.[serviceName];
    const workloadKind = service?.buildConfig.workloadKind ?? workloadKindForServiceName(serviceName, index);
    const publicAccess = typeof runtimeConfig?.public === 'boolean'
      ? runtimeConfig.public
      : defaultPublicForWorkload(workloadKind);
    if (!service) {
      service = serviceRepo.create({
        projectId: project.id,
        name: serviceName,
        buildConfig: {
          workloadKind,
          builder: 'nixpacks',
          ...(runtimeConfig?.startCommand ? { startCommand: runtimeConfig.startCommand } : {}),
          ...(runtimeConfig?.releaseCommand ? { releaseCommand: runtimeConfig.releaseCommand } : {}),
          ...(runtimeConfig?.healthCheckPath ? { healthCheckPath: runtimeConfig.healthCheckPath } : {}),
          public: publicAccess,
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
    } else {
      const nextBuildConfig = {
        ...service.buildConfig,
        workloadKind,
        ...(runtimeConfig?.startCommand ? { startCommand: runtimeConfig.startCommand } : {}),
        ...(runtimeConfig?.releaseCommand ? { releaseCommand: runtimeConfig.releaseCommand } : {}),
        ...(runtimeConfig?.healthCheckPath ? { healthCheckPath: runtimeConfig.healthCheckPath } : {}),
        public: publicAccess,
      };
      const buildConfigChanged = JSON.stringify(service.buildConfig) !== JSON.stringify(nextBuildConfig);
      if (buildConfigChanged) {
        service = serviceRepo.update(service.id, {
          buildConfig: nextBuildConfig,
        }) ?? service;
      }
    }
    return service;
  });
  const cronWorkloads = Object.entries(params.crons ?? {}).map(([cronName, cronConfig]) => {
    let service = serviceRepo.findByProjectAndName(project.id, cronName);
    if (!service) {
      service = serviceRepo.create({
        projectId: project.id,
        name: cronName,
        buildConfig: {
          workloadKind: 'cron',
          builder: 'nixpacks',
          cronSchedule: cronConfig.schedule,
          ...(cronConfig.command ? { startCommand: cronConfig.command } : {}),
        },
      });
      const createdServiceId = service.id;
      tx.addStep({
        id: `service:${createdServiceId}`,
        label: 'cron_create',
        resource: { provider: 'hypervibe', type: 'cron', id: createdServiceId, name: service.name },
        compensate: async () => ({
          success: serviceRepo.delete(createdServiceId),
          message: `Deleted local cron job ${createdServiceId}`,
        }),
      });
    } else {
      service = serviceRepo.update(service.id, {
        buildConfig: {
          ...service.buildConfig,
          workloadKind: 'cron',
          builder: service.buildConfig.builder ?? 'nixpacks',
          cronSchedule: cronConfig.schedule,
          ...(cronConfig.command ? { startCommand: cronConfig.command } : {}),
        },
      }) ?? service;
    }
    return service;
  });
  const workloads = [...serviceWorkloads, ...cronWorkloads];

  if (workloads.length === 0) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: 'No workloads resolved for infrastructure apply',
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const targetPlatform = hostingProviderForEnvironment(project, environment);
  const cloudPrepareProfile = getCloudPrepareProfile(targetPlatform);
  if (cloudPrepareProfile && !isCloudPrepared(project, targetPlatform)) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `${cloudPrepareProfile.label} is not prepared for Hypervibe deploys. Run cloud_prepare provider="${targetPlatform}" confirm=true before infra_apply.`,
        action: 'cloud_prepare',
        provider: targetPlatform,
        requiredVersion: cloudPrepareProfile.version,
        requiredApis: cloudPrepareProfile.requiredApis,
        requiredRoles: cloudPrepareProfile.requiredRoles,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const existingDatabase = resolveExistingDatabaseState(environment.id, params.databaseProvider);
  let dbEnsureReceipt: Receipt | undefined;
  let dbProvision: {
    component: Component;
    receipt: { success: boolean; message: string; error?: string; data?: Record<string, unknown> };
    connectionUrl?: string;
    envVars?: Record<string, string>;
  };

  if (existingDatabase.status === 'match' && existingDatabase.component) {
    if (params.databaseProvider === 'cloudsql') {
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
      }
      dbEnsureReceipt = await ensureDatabaseIfSupported(dbAdapterResult.adapter, existingDatabase.component);
      if (dbEnsureReceipt && !dbEnsureReceipt.success) {
        const cleanup = await tx.rollback();
        return {
          success: false,
          summary: {
            error: dbEnsureReceipt.error || dbEnsureReceipt.message,
            rollback: cleanup,
            transaction: { created: tx.listResources() },
            debug: {
              phase: 'db_ensure',
              provider: params.databaseProvider,
              receiptData: dbEnsureReceipt.data ?? null,
            },
          },
        };
      }
    }
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
      databaseName: 'app',
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
      (typeof dbReceiptData.providerProjectId === 'string' ? dbReceiptData.providerProjectId : null);
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

  const hostingProject = project.defaultPlatform?.toLowerCase() === targetPlatform
    ? project
    : { ...project, defaultPlatform: targetPlatform };
  const hostingResult = await adapterFactory.getHostingAdapter(hostingProject);
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
  const hostingAdapter = hostingResult.adapter as unknown as IHostingAdapter;
  if (!hostingAdapter.capabilities || typeof hostingAdapter.deploy !== 'function') {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `Provider ${targetPlatform} is not a hosting adapter`,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const unsupportedReleaseCommands = Object.entries(params.serviceConfig ?? {})
    .filter(([, config]) => Boolean(config?.releaseCommand))
    .map(([serviceName]) => serviceName);
  if (unsupportedReleaseCommands.length > 0 && !hostingAdapter.capabilities.supportsReleaseCommand) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `Provider ${hostingAdapter.name} does not support releaseCommand/predeploy configuration via API for services: ${unsupportedReleaseCommands.join(', ')}. Move the command to migrations.mode="tool" or remove releaseCommand from serviceConfig.`,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const orchestrator = new DeployOrchestrator();
  const deploySource = resolveGitDeploySource(project, params.environmentName, params.deploy);
  const sourceRepoUrl = normalizeGitRemoteForBuild(project.gitRemoteUrl);
  const secretStore = getSecretStore();
  const githubConnection = sourceRepoUrl && hostingAdapter.name === 'cloudrun'
    ? connectionRepo.findBestMatchFromHints('github', scopeHints)
    : null;
  const githubCredentials = githubConnection
    ? secretStore.decryptObject<GitHubCredentials>(githubConnection.credentialsEncrypted)
    : null;
  const sourceEnvVars: Record<string, string> = sourceRepoUrl
    ? {
        HYPERVIBE_SOURCE_REPO_URL: sourceRepoUrl,
        HYPERVIBE_SOURCE_REVISION: deploySource.source?.branch ?? params.deploy?.branches?.production ?? 'main',
        ...(githubCredentials?.apiToken ? { HYPERVIBE_GITHUB_TOKEN: githubCredentials.apiToken } : {}),
      }
    : {};
  const deployEnvVars = {
    ...sourceEnvVars,
    ...(dbProvision.envVars ?? {}),
    ...(params.envVars ?? {}),
  };
  const deploy = await orchestrator.execute({
    project,
    environment,
    services: workloads,
    envVars: Object.keys(deployEnvVars).length > 0 ? deployEnvVars : undefined,
    adapter: hostingAdapter,
  });

  const summary: Record<string, unknown> = {
    project: project.name,
    environment: environment.name,
    service: serviceWorkloads[0]?.name ?? cronWorkloads[0]?.name,
    services: serviceWorkloads.map((service) => service.name),
    ...(cronWorkloads.length > 0 ? { crons: cronWorkloads.map((service) => service.name) } : {}),
    deploymentRunId: deploy.run.id,
    deploymentSuccess: deploy.success,
    urls: deploy.urls,
    serviceUrls: deploy.serviceUrls,
    primaryUrl: deploy.primaryUrl,
    deploymentCreatedResources: deploy.createdResources,
    deploymentRollback: deploy.rollback,
    transaction: {
      created: tx.listResources(),
    },
    debug: {
      dbProvision: {
        provider: params.databaseProvider,
        receiptData: dbProvision.receipt.data ?? null,
        databaseEnsureReceipt: dbEnsureReceipt
          ? {
              success: dbEnsureReceipt.success,
              message: dbEnsureReceipt.message,
              data: dbEnsureReceipt.data ?? null,
            }
          : undefined,
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
    const sourceAdapter = hostingAdapter as IHostingAdapter & SourceConfigurableHostingAdapter;

    if (typeof sourceAdapter.connectServiceToRepo !== 'function') {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: `Provider ${hostingAdapter.name} does not support repo-linked deploy source configuration`,
          rollback: cleanup,
        },
      };
    }

    const sourceFailures: string[] = [];
    let repoAccessHelp: ReturnType<typeof buildRailwayGitHubRepoAccessHelp> | undefined;
    for (const service of workloads) {
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
      services: serviceWorkloads.map((service) => service.name),
      ...(cronWorkloads.length > 0 ? { crons: cronWorkloads.map((service) => service.name) } : {}),
    };
  }

  if (params.setupEmail) {
    const sgConnection = connectionRepo.findBestMatchFromHints('sendgrid', scopeHints);
    if (sgConnection) {
      const sgCreds = secretStore.decryptObject<SendGridCredentials>(sgConnection.credentialsEncrypted);
      const sgAdapter = new SendGridAdapter();
      sgAdapter.connect(sgCreds);
      const sendgridPermissions = assessSendGridScopes(await sgAdapter.getScopes());
      const missingSendgridScopes: Record<string, string[]> = {};
      if (!sendgridPermissions.hasMailSend) {
        missingSendgridScopes.mailSend = sendgridPermissions.missingScopes.mailSend;
      }
      if (params.domain) {
        if (!sendgridPermissions.canManageDomainAuthentication) {
          missingSendgridScopes.domainAuthentication = sendgridPermissions.missingScopes.domainAuthentication;
        }
      } else if (!sendgridPermissions.canManageDomainAuthentication && !sendgridPermissions.canManageSenderVerification) {
        missingSendgridScopes.domainAuthentication = sendgridPermissions.missingScopes.domainAuthentication;
        missingSendgridScopes.senderVerification = sendgridPermissions.missingScopes.senderVerification;
      }

      if (Object.keys(missingSendgridScopes).length > 0) {
        return {
          success: false,
          summary: {
            ...summary,
            sendgridApiKeySynced: false,
            sendgridApiKeySyncError: `SendGrid API key is valid but cannot complete setupEmail. ${sendgridPermissions.recommendation}`,
            sendgridMissingScopes: missingSendgridScopes,
          },
        };
      }

      const latestEnvironment = envRepo.findById(environment.id) ?? environment;
      const sendgridFailures: string[] = [];
      for (const service of workloads) {
        const receipt = await hostingAdapter.setEnvVars(latestEnvironment, service, {
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

  let providerDomainConfigured = false;
  if (params.domain) {
    try {
      const latestEnvironment = envRepo.findById(environment.id) ?? environment;
      const latestBindings = latestEnvironment.platformBindings as Record<string, unknown>;
      const boundServices = (latestBindings.services as Record<string, { serviceId: string; url?: string }> | undefined) ?? {};
      const boundEnvironmentId =
        typeof latestBindings.environmentId === 'string' ? latestBindings.environmentId : null;
      const domainAdapter = hostingAdapter as IHostingAdapter & DomainConfigurableHostingAdapter;
      const targetService = serviceWorkloads[0];
      const targetServiceId = targetService ? boundServices[targetService.name]?.serviceId : undefined;

      if (targetService && targetServiceId && boundEnvironmentId && typeof domainAdapter.attachCustomDomain === 'function') {
        const receipt = await domainAdapter.attachCustomDomain({
          serviceId: targetServiceId,
          environmentId: boundEnvironmentId,
          domain: params.domain,
        });

        if (!receipt.success) {
          summary.customDomainAttached = false;
          summary.customDomainError = receipt.error || receipt.message;
        } else {
          providerDomainConfigured = true;
          summary.customDomainAttached = true;
          summary.customDomain = {
            domain: params.domain,
            service: targetService.name,
            created: receipt.data?.created === true,
          };

          const dnsRecords = Array.isArray(receipt.data?.dnsRecords)
            ? receipt.data.dnsRecords as Array<Record<string, unknown>>
            : [];
          const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);

          if (!cfConnection) {
            summary.domainDnsConfigured = false;
            summary.domainDnsError = `No Cloudflare connection available for ${params.domain}`;
          } else {
            const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
            const cfAdapter = new CloudflareAdapter();
            cfAdapter.connect(cfCreds);
            const zone = await cfAdapter.findZoneByName(params.domain);
            if (!zone) {
              summary.domainDnsConfigured = false;
              summary.domainDnsError = `Cloudflare zone not found for ${params.domain}`;
            } else if (dnsRecords.length === 0) {
              summary.domainDnsConfigured = false;
              summary.domainDnsError = `Railway did not return required DNS records for ${params.domain}`;
            } else {
              const results: Array<{ name: string; type: string; target: string; action: string }> = [];
              for (const record of dnsRecords) {
                const name = typeof record.name === 'string' ? record.name : '';
                const type = typeof record.type === 'string' ? record.type : '';
                const value = typeof record.value === 'string' ? record.value : '';
                if (!name || !type || !value) {
                  continue;
                }

                const upsert = await cfAdapter.upsertDnsRecord(zone.id, name, type, value, {
                  proxied: false,
                });
                results.push({ name, type, target: value, action: upsert.action });
              }
              summary.domainDnsConfigured = results.length > 0;
              summary.domainDnsRecords = results;
              if (results.length === 0) {
                summary.domainDnsError = `Railway returned no usable DNS records for ${params.domain}`;
              }
            }
          }
        }
      }
    } catch (error) {
      summary.customDomainAttached = false;
      summary.customDomainError = error instanceof Error ? error.message : String(error);
      summary.domainDnsConfigured = false;
    }
  }

  if (!providerDomainConfigured && params.domain && deploy.urls[0]) {
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
        } else {
          summary.domainDnsConfigured = false;
          summary.domainDnsError = `Cloudflare zone not found for ${params.domain}`;
        }
      } else {
        summary.domainDnsConfigured = false;
        summary.domainDnsError = `No Cloudflare connection available for ${params.domain}`;
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
      crons: cronsSchema.optional().describe('Scheduled jobs to converge, keyed by cron name'),
      serviceName: z.string().optional().describe('Service name (default: web)'),
      domain: z.string().optional().describe('Optional domain for DNS configuration'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Database provider (defaults to desired state, then existing managed DB provider, then supabase)'),
      setupEmail: z.boolean().optional().describe('Include SendGrid setup checks (default: true)'),
      serviceConfig: serviceConfigSchema.optional().describe('Per-service runtime config to include in the plan'),
    },
    async ({
      projectName,
      environmentName,
      services,
      crons,
      serviceName,
      domain,
      databaseProvider,
      setupEmail,
      serviceConfig,
    }) => {
      const project = resolveProject({ projectName });
      const policyState = (project?.policies?.desiredState as Partial<DesiredState> | undefined) ?? {};
      const resolvedDatabaseProvider = project
        ? resolveDatabaseProviderForProject(project, policyState, { environmentName, databaseProvider })
        : (databaseProvider ?? policyState?.databaseProvider ?? 'supabase');
      const desired = resolveDesiredState(policyState, {
        environmentName,
        services,
        crons: normalizeCrons(crons),
        serviceName,
        domain,
        databaseProvider: resolvedDatabaseProvider,
        setupEmail,
        serviceConfig,
      });

      const plan = buildPlan({
        projectName,
        environmentName: desired.environmentName,
        services: desired.services,
        crons: desired.crons,
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
            crons: desired.crons,
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
      crons: cronsSchema.optional().describe('Scheduled jobs to bootstrap, keyed by cron name'),
      serviceName: z.string().optional().describe('Service name (default: web)'),
      domain: z.string().optional().describe('Optional domain to configure'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Database provider (defaults to desired state, then existing managed DB provider, then supabase)'),
      setupEmail: z.boolean().optional().describe('Configure SendGrid (default: true)'),
      serviceConfig: serviceConfigSchema.optional().describe('Per-service runtime config to apply during bootstrap'),
      confirm: z.boolean().optional().describe('Set true to apply changes'),
      approvalId: z.string().uuid().optional().describe('Approval ID for protected environments (action: infra.apply)'),
    },
    async ({
      projectName,
      environmentName,
      services,
      crons,
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
      const resolvedDatabaseProvider = existingProject
        ? resolveDatabaseProviderForProject(existingProject, policyState, { environmentName, databaseProvider })
        : (databaseProvider ?? policyState?.databaseProvider ?? 'supabase');
      const resolvedDesired = resolveDesiredState(policyState, {
        environmentName,
        services,
        crons: normalizeCrons(crons),
        serviceName,
        domain,
        databaseProvider: resolvedDatabaseProvider,
        setupEmail,
        serviceConfig,
      });
      const previewPlan = buildPlan({
        projectName,
        environmentName: resolvedDesired.environmentName,
        services: resolvedDesired.services,
        crons: resolvedDesired.crons,
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

      let approvalToConsume: string | undefined;
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
          const validation = approvalRepo.validateForAction(approvalId, existingProject.id, resolvedDesired.environmentName, 'infra.apply');
          if (!validation.ok) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: validation.error }),
              }],
            };
          }
          approvalToConsume = approvalId;
        }
      }

      const executed = await executeBootstrap({
        projectName,
        environmentName: resolvedDesired.environmentName,
        services: resolvedDesired.services,
        crons: resolvedDesired.crons,
        domain: resolvedDesired.domain,
        databaseProvider: resolvedDesired.databaseProvider,
        setupEmail: resolvedDesired.setupEmail,
        serviceConfig: resolvedDesired.serviceConfig,
        envVars: resolvedDesired.envVars,
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
      if (approvalToConsume && executed.success) {
        approvalRepo.consume(approvalToConsume);
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
      crons: cronsSchema.optional().describe('Desired scheduled jobs keyed by cron name'),
      serviceName: z.string().optional().describe('Desired service (default: web)'),
      domain: z.string().optional().describe('Optional desired domain'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Desired DB provider (defaults to existing managed DB provider when present, otherwise supabase)'),
      setupEmail: z.boolean().optional().describe('Include SendGrid setup (default: true)'),
      serviceConfig: serviceConfigSchema.optional().describe('Desired per-service runtime config'),
      envVars: envVarsSchema.optional().describe('Advanced environment variables to provide during deploy'),
      deploy: deployDesiredSchema.optional().describe('Desired deploy strategy and branch mapping'),
      migrations: migrationDesiredSchema.optional().describe('Desired migration behavior during deploy'),
    },
    async ({
      projectName,
      environmentName = 'staging',
      services,
      crons,
      serviceName,
      domain,
      databaseProvider,
      setupEmail = true,
      serviceConfig,
      envVars,
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

      const policyState = (project.policies?.desiredState as Partial<DesiredState> | undefined) ?? {};
      const resolvedDatabaseProvider = resolveDatabaseProviderForProject(project, policyState, {
        environmentName,
        databaseProvider,
      });
      const desiredState = resolveDesiredState(policyState, {
        environmentName,
        services,
        crons: normalizeCrons(crons),
        serviceName,
        domain,
        databaseProvider: resolvedDatabaseProvider,
        setupEmail,
        serviceConfig,
        envVars,
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
      crons: cronsSchema.optional().describe('Override desired scheduled jobs keyed by cron name'),
      serviceName: z.string().optional().describe('Override desired service'),
      domain: z.string().optional().describe('Override desired domain'),
      databaseProvider: z.enum(DB_PROVIDERS).optional().describe('Override desired DB provider'),
      setupEmail: z.boolean().optional().describe('Override desired email setup'),
      serviceConfig: serviceConfigSchema.optional().describe('Override desired per-service runtime config'),
      envVars: envVarsSchema.optional().describe('Override advanced deploy environment variables'),
      deploy: deployDesiredSchema.optional().describe('Override desired deploy strategy and branches'),
      migrations: migrationDesiredSchema.optional().describe('Override desired migration behavior'),
      confirm: z.boolean().optional().describe('Set true to apply'),
      approvalId: z.string().uuid().optional().describe('Approval ID for protected environments (action: infra.apply)'),
    },
    async ({ projectName, environmentName, services, crons, serviceName, domain, databaseProvider, setupEmail, serviceConfig, envVars, deploy, migrations, confirm = false, approvalId }) => {
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
      const resolvedDatabaseProvider = resolveDatabaseProviderForProject(project, policyState, {
        environmentName,
        databaseProvider,
      });
      const desired = resolveDesiredState(policyState, {
        environmentName,
        services,
        crons: normalizeCrons(crons),
        serviceName,
        domain,
        databaseProvider: resolvedDatabaseProvider,
        setupEmail,
        serviceConfig,
        envVars,
        deploy,
        migrations,
      });

      const plan = buildPlan({
        projectName,
        environmentName: desired.environmentName,
        services: desired.services,
        crons: desired.crons,
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
              crons: desired.crons,
              plan,
              message: 'Call again with confirm=true to apply desired state.',
            }),
          }],
        };
      }

      let approvalToConsume: string | undefined;
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
          const validation = approvalRepo.validateForAction(approvalId, project.id, desired.environmentName, 'infra.apply');
          if (!validation.ok) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: validation.error }),
              }],
            };
          }
          approvalToConsume = approvalId;
        }
      }

      const executed = await executeBootstrap({
        projectName,
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
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: executed.summary.error, summary: executed.summary }),
          }],
        };
      }
      if (approvalToConsume && executed.success) {
        approvalRepo.consume(approvalToConsume);
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
