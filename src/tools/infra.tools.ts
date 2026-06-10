import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { getCloudPrepareProfile, isCloudPrepared } from '../domain/services/cloud-prepare.js';
import {
  DB_PROVIDERS,
  type DesiredState,
  normalizeCrons,
  resolveDatabaseProviderForProject,
  resolveDesiredState,
  resolveExistingDatabaseState,
} from '../domain/services/spec.service.js';
import { resolveGitDeploySource } from '../domain/services/deploy-source.js';
import { isProtectedEnvironment } from '../domain/services/policy.service.js';
import { executeBootstrap } from '../domain/services/bootstrap.service.js';
import { resolveProject } from './resolve-project.js';
import { hostingProviderForEnvironment } from '../domain/services/hosting-env.service.js';
import { serviceWorkloadKind } from '../domain/entities/service.entity.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const connectionRepo = new ConnectionRepository();

interface GoldenPathPlanItem {
  action: string;
  status: 'ok' | 'needed' | 'blocked';
  detail: string;
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
    },
    async ({ projectName, environmentName, services, crons, serviceName, domain, databaseProvider, setupEmail, serviceConfig, envVars, deploy, migrations, confirm = false }) => {
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
