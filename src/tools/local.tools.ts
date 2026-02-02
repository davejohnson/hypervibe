import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { ComposeGenerator } from '../adapters/providers/local/compose.generator.js';
import type { ComponentType } from '../domain/entities/component.entity.js';
import { resolveProject } from './resolve-project.js';

const envRepo = new EnvironmentRepository();
const componentRepo = new ComponentRepository();
const auditRepo = new AuditRepository();

export function registerLocalTools(server: McpServer): void {
  server.tool(
    'local_bootstrap',
    'Generate compose.yaml and .env.local files for local development',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      outputDir: z.string().optional().describe('Output directory (default: current directory)'),
      components: z
        .array(z.enum(['postgres', 'redis', 'mysql', 'mongodb']))
        .optional()
        .describe('Components to include (default: postgres)'),
    },
    async ({ projectId, projectName, outputDir, components }) => {
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

      // Get or create local environment
      let localEnv = envRepo.findByProjectAndName(project.id, 'local');
      if (!localEnv) {
        localEnv = envRepo.create({
          projectId: project.id,
          name: 'local',
        });
      }

      // Default to postgres if no components specified
      const componentTypes: ComponentType[] = components ?? ['postgres'];

      // Create or update components
      for (const componentType of componentTypes) {
        let component = componentRepo.findByEnvironmentAndType(localEnv.id, componentType);
        if (!component) {
          const generator = new ComposeGenerator();
          const bindings = generator.getComponentBindings(componentType);
          component = componentRepo.create({
            environmentId: localEnv.id,
            type: componentType,
            bindings,
          });
        }
      }

      // Generate files
      const generator = new ComposeGenerator();
      const composeContent = generator.generateCompose(project, componentTypes);
      const envContent = generator.generateEnvLocal(project, componentTypes);

      // Determine output directory
      const targetDir = outputDir ?? process.cwd();

      // Write files
      const composeFilePath = path.join(targetDir, 'compose.yaml');
      const envFilePath = path.join(targetDir, '.env.local');

      try {
        fs.writeFileSync(composeFilePath, composeContent, 'utf-8');
        fs.writeFileSync(envFilePath, envContent, 'utf-8');
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Failed to write files: ${error}`,
              }),
            },
          ],
        };
      }

      // Audit log
      auditRepo.create({
        action: 'local.bootstrap',
        resourceType: 'environment',
        resourceId: localEnv.id,
        details: {
          projectId: project.id,
          components: componentTypes,
          files: [composeFilePath, envFilePath],
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Local development environment bootstrapped for "${project.name}"`,
              files: {
                compose: composeFilePath,
                env: envFilePath,
              },
              components: componentTypes,
              instructions: [
                'To start local services:',
                '  docker compose up -d',
                '',
                'To stop local services:',
                '  docker compose down',
                '',
                'Environment variables are in .env.local',
              ].join('\n'),
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'component_create',
    'Add a component (database, cache) to an environment',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      environmentName: z.string().optional().describe('Environment name (default: local)'),
      type: z.enum(['postgres', 'redis', 'mysql', 'mongodb']).describe('Component type'),
    },
    async ({ projectId, projectName, environmentName, type }) => {
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

      const envName = environmentName ?? 'local';
      let environment = envRepo.findByProjectAndName(project.id, envName);
      if (!environment) {
        environment = envRepo.create({
          projectId: project.id,
          name: envName,
        });
      }

      // Check if component already exists
      const existing = componentRepo.findByEnvironmentAndType(environment.id, type);
      if (existing) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Component "${type}" already exists in environment "${envName}"`,
                component: existing,
              }),
            },
          ],
        };
      }

      // Get default bindings for local
      const generator = new ComposeGenerator();
      const bindings = generator.getComponentBindings(type);

      const component = componentRepo.create({
        environmentId: environment.id,
        type,
        bindings,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Component "${type}" added to environment "${envName}"`,
              component,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'component_list',
    'List components in an environment',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      environmentName: z.string().optional().describe('Environment name'),
    },
    async ({ projectId, projectName, environmentName }) => {
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

      const environments = environmentName
        ? [envRepo.findByProjectAndName(project.id, environmentName)].filter(Boolean)
        : envRepo.findByProjectId(project.id);

      const result: Array<{
        environment: string;
        components: Array<{ type: string; bindings: Record<string, unknown> }>;
      }> = [];

      for (const env of environments) {
        if (!env) continue;
        const components = componentRepo.findByEnvironmentId(env.id);
        result.push({
          environment: env.name,
          components: components.map((c) => ({
            type: c.type,
            bindings: c.bindings,
          })),
        });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: { id: project.id, name: project.name },
              environments: result,
            }),
          },
        ],
      };
    }
  );
}
