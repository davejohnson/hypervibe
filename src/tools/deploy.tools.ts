import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { DeployOrchestrator } from '../domain/services/deploy.orchestrator.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';

import { resolveProject } from './resolve-project.js';

const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const runRepo = new RunRepository();

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
    },
    async ({ projectId, projectName, environmentId, environmentName, services, envVars }) => {
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
