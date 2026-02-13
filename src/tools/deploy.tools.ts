import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { ApprovalRepository } from '../adapters/db/repositories/approval.repository.js';
import { DeployOrchestrator } from '../domain/services/deploy.orchestrator.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';

import { resolveProject } from './resolve-project.js';

const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const runRepo = new RunRepository();
const approvalRepo = new ApprovalRepository();

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

function requiresProductionConfirm(project: { policies: Record<string, unknown> }, environmentName: string): boolean {
  const policies = project.policies ?? {};
  const protectedEnvs = Array.isArray(policies.protectedEnvironments)
    ? (policies.protectedEnvironments as unknown[]).map((v) => String(v).toLowerCase())
    : [];
  return protectedEnvs.includes(environmentName.toLowerCase());
}

function approvalsRequired(project: { policies: Record<string, unknown> }, environmentName: string): boolean {
  if (!requiresProductionConfirm(project, environmentName)) return false;
  const explicit = project.policies?.requireApprovalForProtectedEnvironments;
  if (explicit === false) return false;
  return true;
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
      const platform = project.defaultPlatform || 'railway';
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
      const result = await orchestrator.execute({
        project,
        environment,
        services: servicesToDeploy,
        envVars,
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
              errors: result.errors.length > 0 ? result.errors : undefined,
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
      const rollback = await orchestrator.execute({
        project,
        environment,
        services: servicesToDeploy,
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
      builder: z.enum(['nixpacks', 'dockerfile', 'buildpack']).optional().describe('Build method'),
      dockerfilePath: z.string().optional().describe('Path to Dockerfile if using dockerfile builder'),
    },
    async ({ projectId, projectName, name, builder, dockerfilePath }) => {
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
          builder: builder ?? 'nixpacks',
          dockerfilePath,
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
            }),
          },
        ],
      };
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
