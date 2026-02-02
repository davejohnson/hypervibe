import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { resolveProject } from './resolve-project.js';

const envRepo = new EnvironmentRepository();
const auditRepo = new AuditRepository();

export function registerEnvironmentTools(server: McpServer): void {
  server.tool(
    'env_create',
    'Create a new environment for a project (e.g., local, staging, production)',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      name: z.string().min(1).describe('Environment name (local, staging, production, or custom)'),
    },
    async ({ projectId, projectName, name }) => {
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

      // Check if environment already exists
      const existing = envRepo.findByProjectAndName(project.id, name);
      if (existing) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Environment "${name}" already exists for project "${project.name}"`,
                environment: existing,
              }),
            },
          ],
        };
      }

      // Create environment
      const environment = envRepo.create({
        projectId: project.id,
        name,
      });

      // Audit log
      auditRepo.create({
        action: 'environment.created',
        resourceType: 'environment',
        resourceId: environment.id,
        details: { projectId: project.id, name },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Environment "${name}" created for project "${project.name}"`,
              environment,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'env_list',
    'List environments for a project',
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

      const environments = envRepo.findByProjectId(project.id);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: { id: project.id, name: project.name },
              count: environments.length,
              environments,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'env_get',
    'Get details of a specific environment',
    {
      environmentId: z.string().uuid().optional().describe('Environment ID'),
      projectId: z.string().uuid().optional().describe('Project ID (with environmentName)'),
      projectName: z.string().optional().describe('Project name (with environmentName)'),
      environmentName: z.string().optional().describe('Environment name'),
    },
    async ({ environmentId, projectId, projectName, environmentName }) => {
      let environment;

      if (environmentId) {
        environment = envRepo.findById(environmentId);
      } else if (environmentName) {
        const project = resolveProject({ projectId, projectName });
        if (!project) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: 'Project not found. Provide either projectId or projectName with environmentName.',
                }),
              },
            ],
          };
        }
        environment = envRepo.findByProjectAndName(project.id, environmentName);
      }

      if (!environment) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Environment not found',
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
              environment,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'env_delete',
    'Delete an environment',
    {
      environmentId: z.string().uuid().optional().describe('Environment ID'),
      projectId: z.string().uuid().optional().describe('Project ID (with environmentName)'),
      projectName: z.string().optional().describe('Project name (with environmentName)'),
      environmentName: z.string().optional().describe('Environment name'),
    },
    async ({ environmentId, projectId, projectName, environmentName }) => {
      let environment;

      if (environmentId) {
        environment = envRepo.findById(environmentId);
      } else if (environmentName) {
        const project = resolveProject({ projectId, projectName });
        if (!project) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: 'Project not found. Provide either projectId or projectName with environmentName.',
                }),
              },
            ],
          };
        }
        environment = envRepo.findByProjectAndName(project.id, environmentName);
      }

      if (!environment) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Environment not found',
              }),
            },
          ],
        };
      }

      envRepo.delete(environment.id);

      auditRepo.create({
        action: 'environment.deleted',
        resourceType: 'environment',
        resourceId: environment.id,
        details: { name: environment.name },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Environment "${environment.name}" deleted successfully`,
            }),
          },
        ],
      };
    }
  );
}
