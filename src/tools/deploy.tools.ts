import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { ApprovalRepository } from '../adapters/db/repositories/approval.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { DeployOrchestrator } from '../domain/services/deploy.orchestrator.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { hostingProviderForEnvironment, providerDisplayName } from './hosting-env.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { BuildConfig, WorkloadKind } from '../domain/entities/service.entity.js';
import type { GitHubCredentials } from '../adapters/providers/github/github.adapter.js';
import { normalizeGitRemoteForBuild } from '../lib/git-remote.js';

import { resolveProject } from './resolve-project.js';

const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const runRepo = new RunRepository();
const approvalRepo = new ApprovalRepository();
const connectionRepo = new ConnectionRepository();
const projectRepo = new ProjectRepository();

function toolResponse(data: Record<string, unknown>) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data),
    }],
  };
}

function resolveEnvironment(
  projectId: string,
  environmentId?: string,
  environmentName?: string
) {
  if (environmentId) return envRepo.findById(environmentId);
  if (environmentName) return envRepo.findByProjectAndName(projectId, environmentName);
  // Default to staging if no environment specified
  return envRepo.findByProjectAndName(projectId, 'staging');
}

export function requiresProductionConfirm(project: { policies: Record<string, unknown> }, environmentName: string): boolean {
  const policies = project.policies ?? {};
  const protectedEnvs = Array.isArray(policies.protectedEnvironments)
    ? (policies.protectedEnvironments as unknown[]).map((v) => String(v).toLowerCase())
    : [];
  return protectedEnvs.includes(environmentName.toLowerCase());
}

export function approvalsRequired(project: { policies: Record<string, unknown> }, environmentName: string): boolean {
  if (!requiresProductionConfirm(project, environmentName)) return false;
  const explicit = project.policies?.requireApprovalForProtectedEnvironments;
  if (explicit === false) return false;
  return true;
}

function buildDeploySourceEnvVars(project: Project, adapterName: string): Record<string, string> {
  const sourceRepoUrl = normalizeGitRemoteForBuild(project.gitRemoteUrl);
  if (!sourceRepoUrl) {
    return {};
  }

  const sourceEnvVars: Record<string, string> = {
    HYPERVIBE_SOURCE_REPO_URL: sourceRepoUrl,
    HYPERVIBE_SOURCE_REVISION: 'main',
  };

  if (adapterName === 'cloudrun') {
    const githubConnection = connectionRepo.findBestMatchFromHints('github', getProjectScopeHints(project));
    if (githubConnection) {
      const githubCredentials = getSecretStore().decryptObject<GitHubCredentials>(githubConnection.credentialsEncrypted);
      if (githubCredentials.apiToken) {
        sourceEnvVars.HYPERVIBE_GITHUB_TOKEN = githubCredentials.apiToken;
      }
    }
  }

  return sourceEnvVars;
}

function definedBuildConfigUpdates(updates: {
  workloadKind?: WorkloadKind;
  builder?: 'nixpacks' | 'dockerfile' | 'buildpack';
  dockerfilePath?: string;
  buildCommand?: string;
  startCommand?: string;
  releaseCommand?: string;
  healthCheckPath?: string;
  cronSchedule?: string;
  public?: boolean;
}): Partial<BuildConfig> {
  const buildConfig: Partial<BuildConfig> = {};
  for (const [key, value] of Object.entries(updates) as Array<[keyof BuildConfig, unknown]>) {
    if (value !== undefined) {
      buildConfig[key] = value as never;
    }
  }
  return buildConfig;
}

function removeServiceFromDesiredState(
  desiredState: Record<string, unknown> | undefined,
  serviceName: string
): Record<string, unknown> | undefined {
  if (!desiredState) return undefined;
  const next = { ...desiredState };
  if (Array.isArray(next.services)) {
    next.services = next.services.filter((name) => name !== serviceName);
  }
  for (const key of ['serviceConfig', 'crons'] as const) {
    const value = next[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = { ...(value as Record<string, unknown>) };
      delete record[serviceName];
      next[key] = record;
    }
  }
  return next;
}

function updateServiceInDesiredState(
  desiredState: Record<string, unknown> | undefined,
  previousName: string,
  nextName: string,
  buildConfig: BuildConfig
): Record<string, unknown> | undefined {
  if (!desiredState) return undefined;
  const next = { ...desiredState };
  if (Array.isArray(next.services)) {
    next.services = next.services.map((name) => name === previousName ? nextName : name);
  }

  const serviceConfig = next.serviceConfig && typeof next.serviceConfig === 'object' && !Array.isArray(next.serviceConfig)
    ? { ...(next.serviceConfig as Record<string, unknown>) }
    : {};
  const existingConfig = serviceConfig[previousName] && typeof serviceConfig[previousName] === 'object'
    ? { ...(serviceConfig[previousName] as Record<string, unknown>) }
    : {};
  delete serviceConfig[previousName];
  serviceConfig[nextName] = {
    ...existingConfig,
    ...(buildConfig.startCommand ? { startCommand: buildConfig.startCommand } : {}),
    ...(buildConfig.releaseCommand ? { releaseCommand: buildConfig.releaseCommand } : {}),
    ...(buildConfig.healthCheckPath ? { healthCheckPath: buildConfig.healthCheckPath } : {}),
    ...(typeof buildConfig.public === 'boolean' ? { public: buildConfig.public } : {}),
  };
  if (Object.keys(serviceConfig[nextName] as Record<string, unknown>).length > 0) {
    next.serviceConfig = serviceConfig;
  }

  const crons = next.crons && typeof next.crons === 'object' && !Array.isArray(next.crons)
    ? { ...(next.crons as Record<string, unknown>) }
    : {};
  if (buildConfig.workloadKind === 'cron' || buildConfig.cronSchedule) {
    delete crons[previousName];
    crons[nextName] = {
      schedule: buildConfig.cronSchedule,
      ...(buildConfig.startCommand ? { command: buildConfig.startCommand } : {}),
    };
    next.crons = crons;
  } else if (crons[previousName]) {
    delete crons[previousName];
    next.crons = crons;
  }

  return next;
}

function serviceBindingFor(
  environment: { platformBindings: Record<string, unknown> },
  serviceName: string
): Record<string, unknown> | undefined {
  const bindings = environment.platformBindings;
  const services = bindings.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return undefined;
  const serviceBinding = (services as Record<string, unknown>)[serviceName];
  return serviceBinding && typeof serviceBinding === 'object' && !Array.isArray(serviceBinding)
    ? serviceBinding as Record<string, unknown>
    : undefined;
}

function removeServiceBinding(environmentId: string, environment: { platformBindings: Record<string, unknown> }, serviceName: string) {
  const services = environment.platformBindings.services && typeof environment.platformBindings.services === 'object' && !Array.isArray(environment.platformBindings.services)
    ? { ...(environment.platformBindings.services as Record<string, unknown>) }
    : {};
  delete services[serviceName];
  envRepo.updatePlatformBindings(environmentId, { services });
}

export function registerDeployTools(server: McpServer): void {
  server.tool(
    'deploy',
    'Deploy services to an environment (staging, production, etc.)',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      environmentId: z.string().uuid().optional().describe('Environment ID'),
      environmentName: z.string().optional().describe('Environment name (default: staging)'),
      services: z.array(z.string()).optional().describe('Specific services to deploy (default: all)'),
      envVars: z.record(z.string()).optional().describe('Additional environment variables'),
      confirmProduction: z.boolean().optional().describe('Required when deploying to protected environments'),
      approvalId: z.string().uuid().optional().describe('Approval ID (required when policy requires approvals for protected environments)'),
    },
    async ({ projectId, projectName, environmentId, environmentName, services, envVars, confirmProduction, approvalId }) => {
      // Resolve project
      const project = resolveProject({ projectId, projectName });
      if (!project) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Project not found. Provide either projectId or projectName.',
              }),
            },
          ],
        };
      }

      // Resolve environment
      let environment = resolveEnvironment(project.id, environmentId, environmentName);
      if (!environment) {
        // Auto-create staging environment if it doesn't exist
        const envName = environmentName ?? 'staging';
        environment = envRepo.create({
          projectId: project.id,
          name: envName,
        });
      }

      if (requiresProductionConfirm(project, environment.name) && !confirmProduction) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment "${environment.name}" is protected by project policy. Re-run with confirmProduction=true.`,
            }),
          }],
        };
      }

      if (approvalsRequired(project, environment.name)) {
        if (!approvalId) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Approval required for protected environment "${environment.name}". Create one with approval_request_create and re-run with approvalId.`,
                requiredAction: 'deploy',
              }),
            }],
          };
        }

        const validation = approvalRepo.validateForAction(approvalId, project.id, environment.name, 'deploy');
        if (!validation.ok) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: validation.error }),
            }],
          };
        }
      }

      // Get hosting adapter for project's platform
      const platform = project.defaultPlatform || 'cloudrun';
      const adapterResult = await adapterFactory.getHostingAdapter(project);
      if (!adapterResult.success || !adapterResult.adapter) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: adapterResult.error || `No verified ${platform} connection. Use connection_create and connection_verify first.`,
              }),
            },
          ],
        };
      }

      const adapter = adapterResult.adapter;

      // Resolve services
      let servicesToDeploy = serviceRepo.findByProjectId(project.id);
      if (services && services.length > 0) {
        servicesToDeploy = servicesToDeploy.filter((s) => services.includes(s.name));
      }

      if (servicesToDeploy.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'No services found to deploy. Create services first or check service names.',
              }),
            },
          ],
        };
      }

      // Execute deployment
      const orchestrator = new DeployOrchestrator();
      const deployEnvVars = {
        ...buildDeploySourceEnvVars(project, adapter.name),
        ...(envVars ?? {}),
      };
      const result = await orchestrator.execute({
        project,
        environment,
        services: servicesToDeploy,
        envVars: Object.keys(deployEnvVars).length > 0 ? deployEnvVars : undefined,
        adapter,
      });

      if (approvalsRequired(project, environment.name) && approvalId) {
        approvalRepo.consume(approvalId);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: result.success,
              runId: result.run.id,
              status: result.run.status,
              urls: result.urls,
              serviceUrls: result.serviceUrls,
              primaryUrl: result.primaryUrl,
              errors: result.errors.length > 0 ? result.errors : undefined,
              createdResources: result.createdResources,
              rollback: result.rollback,
              intent: syncProjectIntent(project.id),
              message: result.success
                ? `Deployment completed for ${servicesToDeploy.length} service(s)`
                : `Deployment had errors`,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'deploy_status',
    'Check the status of a deployment run',
    {
      runId: z.string().uuid().describe('Run ID to check'),
    },
    async ({ runId }) => {
      const run = runRepo.findById(runId);

      if (!run) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Run not found: ${runId}`,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              run: {
                id: run.id,
                type: run.type,
                status: run.status,
                startedAt: run.startedAt,
                completedAt: run.completedAt,
                error: run.error,
                receipts: run.receipts,
              },
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'deploy_rollback',
    'Rollback by redeploying services from the most recent successful deploy run.',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      environmentName: z.string().optional().describe('Environment name (default: staging)'),
      toRunId: z.string().uuid().optional().describe('Specific successful deploy run ID to roll back to'),
      services: z.array(z.string()).optional().describe('Specific services to rollback (default: all in target run)'),
      confirmProduction: z.boolean().optional().describe('Required when rolling back protected environments'),
      approvalId: z.string().uuid().optional().describe('Approval ID (required when policy requires approvals for protected environments)'),
    },
    async ({ projectId, projectName, environmentName = 'staging', toRunId, services, confirmProduction, approvalId }) => {
      const project = resolveProject({ projectId, projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Project not found. Provide projectId or projectName.' }),
          }],
        };
      }

      const environment = resolveEnvironment(project.id, undefined, environmentName);
      if (!environment) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environmentName}` }),
          }],
        };
      }

      if (requiresProductionConfirm(project, environment.name) && !confirmProduction) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment "${environment.name}" is protected by project policy. Re-run with confirmProduction=true.`,
            }),
          }],
        };
      }

      if (approvalsRequired(project, environment.name)) {
        if (!approvalId) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Approval required for protected environment "${environment.name}". Create one with approval_request_create and re-run with approvalId.`,
                requiredAction: 'deploy.rollback',
              }),
            }],
          };
        }

        const validation = approvalRepo.validateForAction(approvalId, project.id, environment.name, 'deploy.rollback');
        if (!validation.ok) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: validation.error }),
            }],
          };
        }
      }

      let targetRun = toRunId ? runRepo.findById(toRunId) : null;
      if (toRunId && (!targetRun || targetRun.status !== 'succeeded' || targetRun.type !== 'deploy')) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Run ${toRunId} is not a successful deploy run` }),
          }],
        };
      }

      if (!targetRun) {
        const runs = runRepo.findByEnvironmentId(environment.id, 50);
        targetRun = runs.find((r) => r.type === 'deploy' && r.status === 'succeeded') ?? null;
      }

      if (!targetRun) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No successful deploy run found to rollback to' }),
          }],
        };
      }

      const rollbackServiceNames = targetRun.receipts
        .map((r) => r.step)
        .filter((step) => step.startsWith('deploy_'))
        .map((step) => step.replace(/^deploy_/, ''));

      const allServices = serviceRepo.findByProjectId(project.id);
      let servicesToDeploy = allServices.filter((s) => rollbackServiceNames.includes(s.name));
      if (services && services.length > 0) {
        servicesToDeploy = servicesToDeploy.filter((s) => services.includes(s.name));
      }

      if (servicesToDeploy.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No services resolved for rollback. Check run contents or provided services.',
            }),
          }],
        };
      }

      const adapterResult = await adapterFactory.getHostingAdapter(project);
      if (!adapterResult.success || !adapterResult.adapter) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: adapterResult.error || 'No hosting adapter available for rollback',
            }),
          }],
        };
      }

      const orchestrator = new DeployOrchestrator();
      const deployEnvVars = buildDeploySourceEnvVars(project, adapterResult.adapter.name);
      const rollback = await orchestrator.execute({
        project,
        environment,
        services: servicesToDeploy,
        envVars: Object.keys(deployEnvVars).length > 0 ? deployEnvVars : undefined,
        adapter: adapterResult.adapter,
      });

      if (approvalsRequired(project, environment.name) && approvalId) {
        approvalRepo.consume(approvalId);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: rollback.success,
            rollbackFromRunId: targetRun.id,
            rollbackRunId: rollback.run.id,
            status: rollback.run.status,
            services: servicesToDeploy.map((s) => s.name),
            urls: rollback.urls,
            errors: rollback.errors.length ? rollback.errors : undefined,
            createdResources: rollback.createdResources,
            rollback: rollback.rollback,
            intent: syncProjectIntent(project.id),
            note: 'This rollback re-triggers deployment for the last known-good service set. It does not restore provider-side manual config outside hypervibe state.',
          }),
        }],
      };
    }
  );

  server.tool(
    'service_create',
    'Create a new service in a project',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      name: z.string().min(1).describe('Service name (e.g., api, web, worker)'),
      workloadKind: z.enum(['web', 'worker', 'cron', 'job']).optional().describe('Workload kind (web, worker, cron, job)'),
      builder: z.enum(['nixpacks', 'dockerfile', 'buildpack']).optional().describe('Build method'),
      dockerfilePath: z.string().optional().describe('Path to Dockerfile if using dockerfile builder'),
      buildCommand: z.string().optional().describe('Build command'),
      startCommand: z.string().optional().describe('Start/worker/cron command'),
      releaseCommand: z.string().optional().describe('Release/migration command for supported providers'),
      healthCheckPath: z.string().optional().describe('Health check path for web services'),
      cronSchedule: z.string().optional().describe('Cron schedule for scheduled workloads, e.g. "*/5 * * * *"'),
      public: z.boolean().optional().describe('Whether a web service should be publicly reachable'),
    },
    async ({ projectId, projectName, name, workloadKind, builder, dockerfilePath, buildCommand, startCommand, releaseCommand, healthCheckPath, cronSchedule, public: publicService }) => {
      const project = resolveProject({ projectId, projectName });
      if (!project) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Project not found. Provide either projectId or projectName.',
              }),
            },
          ],
        };
      }

      if (workloadKind === 'cron' && !cronSchedule?.trim()) {
        return toolResponse({
          success: false,
          error: 'Cron services require cronSchedule, e.g. "*/5 * * * *".',
        });
      }

      // Check if service already exists
      const existing = serviceRepo.findByProjectAndName(project.id, name);
      if (existing) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Service "${name}" already exists in project "${project.name}"`,
                service: existing,
              }),
            },
          ],
        };
      }

      const service = serviceRepo.create({
        projectId: project.id,
        name,
        buildConfig: {
          ...(workloadKind ? { workloadKind } : {}),
          builder: builder ?? 'nixpacks',
          ...(dockerfilePath ? { dockerfilePath } : {}),
          ...(buildCommand ? { buildCommand } : {}),
          ...(startCommand ? { startCommand } : {}),
          ...(releaseCommand ? { releaseCommand } : {}),
          ...(healthCheckPath ? { healthCheckPath } : {}),
          ...(cronSchedule ? { cronSchedule } : {}),
          ...(typeof publicService === 'boolean' ? { public: publicService } : {}),
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Service "${name}" created for project "${project.name}"`,
              service,
              intent: syncProjectIntent(project.id),
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'service_update',
    'Update a service or cron workload configuration in a project',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      serviceName: z.string().min(1).describe('Current service name'),
      name: z.string().min(1).optional().describe('New service name'),
      workloadKind: z.enum(['web', 'worker', 'cron', 'job']).optional().describe('Workload kind (web, worker, cron, job)'),
      builder: z.enum(['nixpacks', 'dockerfile', 'buildpack']).optional().describe('Build method'),
      dockerfilePath: z.string().optional().describe('Path to Dockerfile if using dockerfile builder'),
      buildCommand: z.string().optional().describe('Build command'),
      startCommand: z.string().optional().describe('Start/worker/cron command'),
      releaseCommand: z.string().optional().describe('Release/migration command for supported providers'),
      healthCheckPath: z.string().optional().describe('Health check path for web services'),
      cronSchedule: z.string().optional().describe('Cron schedule for scheduled workloads, e.g. "*/5 * * * *"'),
      public: z.boolean().optional().describe('Whether a web service should be publicly reachable'),
    },
    async ({ projectId, projectName, serviceName, name, workloadKind, builder, dockerfilePath, buildCommand, startCommand, releaseCommand, healthCheckPath, cronSchedule, public: publicService }) => {
      const project = resolveProject({ projectId, projectName });
      if (!project) {
        return toolResponse({
          success: false,
          error: 'Project not found. Provide either projectId or projectName.',
        });
      }

      const service = serviceRepo.findByProjectAndName(project.id, serviceName);
      if (!service) {
        return toolResponse({
          success: false,
          error: `Service "${serviceName}" not found in project "${project.name}"`,
        });
      }

      const nextName = name ?? service.name;
      if (nextName !== service.name) {
        const existing = serviceRepo.findByProjectAndName(project.id, nextName);
        if (existing) {
          return toolResponse({
            success: false,
            error: `Service "${nextName}" already exists in project "${project.name}"`,
          });
        }
      }

      const buildConfig = {
        ...service.buildConfig,
        ...definedBuildConfigUpdates({
          workloadKind,
          builder,
          dockerfilePath,
          buildCommand,
          startCommand,
          releaseCommand,
          healthCheckPath,
          cronSchedule,
          public: publicService,
        }),
      };
      if ((buildConfig.workloadKind === 'cron' || workloadKind === 'cron') && !buildConfig.cronSchedule?.trim()) {
        return toolResponse({
          success: false,
          error: 'Cron services require cronSchedule, e.g. "*/5 * * * *".',
        });
      }

      const updated = serviceRepo.update(service.id, {
        name: nextName,
        buildConfig,
      });
      if (!updated) {
        return toolResponse({
          success: false,
          error: `Failed to update service "${service.name}"`,
        });
      }

      const desiredState = project.policies?.desiredState && typeof project.policies.desiredState === 'object' && !Array.isArray(project.policies.desiredState)
        ? project.policies.desiredState as Record<string, unknown>
        : undefined;
      const nextDesiredState = updateServiceInDesiredState(desiredState, service.name, updated.name, updated.buildConfig);
      if (nextDesiredState) {
        projectRepo.update(project.id, {
          policies: {
            ...(project.policies ?? {}),
            desiredState: nextDesiredState,
          },
        });
      }

      return toolResponse({
        success: true,
        message: `Service "${service.name}" updated`,
        service: updated,
        intent: syncProjectIntent(project.id),
      });
    }
  );

  server.tool(
    'service_delete',
    'Delete a service or cron workload from a project, optionally deleting bound provider resources first',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      serviceName: z.string().min(1).describe('Service/cron name to delete'),
      environmentName: z.string().optional().describe('Limit provider cleanup to one environment. Defaults to every environment with a binding.'),
      deleteProviderResources: z.boolean().optional().describe('Delete bound provider resources before deleting local service (default true)'),
      confirm: z.boolean().optional().describe('Set true to delete. Preview mode returns planned changes.'),
    },
    async ({ projectId, projectName, serviceName, environmentName, deleteProviderResources = true, confirm = false }) => {
      const project = resolveProject({ projectId, projectName });
      if (!project) {
        return toolResponse({
          success: false,
          error: 'Project not found. Provide either projectId or projectName.',
        });
      }

      const service = serviceRepo.findByProjectAndName(project.id, serviceName);
      if (!service) {
        return toolResponse({
          success: true,
          message: `Service "${serviceName}" does not exist in project "${project.name}". No changes needed.`,
        });
      }

      const environments = environmentName
        ? [envRepo.findByProjectAndName(project.id, environmentName)].filter((env): env is NonNullable<typeof env> => Boolean(env))
        : envRepo.findByProjectId(project.id).filter((env) => env.name !== 'local');
      if (environmentName && environments.length === 0) {
        return toolResponse({
          success: false,
          error: `Environment "${environmentName}" not found in project "${project.name}"`,
        });
      }

      const bindings = environments
        .map((environment) => ({
          environment,
          binding: serviceBindingFor(environment, service.name),
        }))
        .filter((entry) => entry.binding);
      const plannedChanges = [
        ...bindings.map(({ environment, binding }) => ({
          action: deleteProviderResources ? 'delete_provider_resource' : 'remove_local_binding',
          environment: environment.name,
          provider: providerDisplayName(hostingProviderForEnvironment(project, environment)),
          resourceId: binding?.schedulerJobName ?? binding?.serviceId ?? binding?.jobName,
          binding,
        })),
        {
          action: 'delete_local_service',
          service: service.name,
        },
      ];

      if (!confirm) {
        return toolResponse({
          success: true,
          mode: 'preview',
          project: { id: project.id, name: project.name },
          service,
          plannedChanges,
          message: 'Call again with confirm=true to delete this service/cron workload.',
        });
      }

      const providerResults: Array<Record<string, unknown>> = [];
      if (deleteProviderResources) {
        for (const { environment, binding } of bindings) {
          const provider = hostingProviderForEnvironment(project, environment);
          const resourceId = binding?.schedulerJobName ?? binding?.serviceId ?? binding?.jobName;
          if (typeof resourceId !== 'string' || resourceId.length === 0) {
            providerResults.push({
              environment: environment.name,
              provider,
              success: false,
              error: `Missing provider resource ID for ${service.name}`,
            });
            continue;
          }

          const adapterResult = await adapterFactory.getProviderAdapter(provider, project);
          if (!adapterResult.success || !adapterResult.adapter) {
            providerResults.push({
              environment: environment.name,
              provider,
              resourceId,
              success: false,
              error: adapterResult.error || `No ${provider} adapter available`,
            });
            continue;
          }

          const adapter = adapterResult.adapter as { deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string; message?: string }> };
          if (typeof adapter.deleteService !== 'function') {
            providerResults.push({
              environment: environment.name,
              provider,
              resourceId,
              success: false,
              error: `${providerDisplayName(provider)} does not support provider resource deletion yet`,
            });
            continue;
          }

          const deleted = await adapter.deleteService(resourceId);
          providerResults.push({
            environment: environment.name,
            provider,
            resourceId,
            success: deleted.success,
            message: deleted.message,
            error: deleted.error,
          });
        }

        const failures = providerResults.filter((result) => result.success !== true);
        if (failures.length > 0) {
          return toolResponse({
            success: false,
            error: `Provider cleanup failed for ${failures.length} environment(s). Local service was not deleted.`,
            providerResults,
          });
        }
      }

      for (const { environment } of bindings) {
        removeServiceBinding(environment.id, environment, service.name);
      }
      const deletedLocal = serviceRepo.delete(service.id);
      const desiredState = project.policies?.desiredState && typeof project.policies.desiredState === 'object' && !Array.isArray(project.policies.desiredState)
        ? project.policies.desiredState as Record<string, unknown>
        : undefined;
      const nextDesiredState = removeServiceFromDesiredState(desiredState, service.name);
      if (nextDesiredState) {
        projectRepo.update(project.id, {
          policies: {
            ...(project.policies ?? {}),
            desiredState: nextDesiredState,
          },
        });
      }

      return toolResponse({
        success: deletedLocal,
        mode: 'executed',
        message: deletedLocal
          ? `Deleted service "${service.name}" from project "${project.name}"`
          : `Service "${service.name}" was not deleted`,
        providerResults,
        intent: syncProjectIntent(project.id),
      });
    }
  );

  server.tool(
    'service_list',
    'List services in a project',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
    },
    async ({ projectId, projectName }) => {
      const project = resolveProject({ projectId, projectName });
      if (!project) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Project not found. Provide either projectId or projectName.',
              }),
            },
          ],
        };
      }

      const services = serviceRepo.findByProjectId(project.id);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: { id: project.id, name: project.name },
              count: services.length,
              services,
            }),
          },
        ],
      };
    }
  );
}
