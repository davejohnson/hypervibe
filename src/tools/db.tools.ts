import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import type { RailwayCredentials } from '../adapters/providers/railway/railway.adapter.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const connectionRepo = new ConnectionRepository();

// Common migration commands for popular ORMs
const MIGRATION_PRESETS: Record<string, string> = {
  prisma: 'npx prisma migrate deploy',
  'prisma-push': 'npx prisma db push',
  drizzle: 'npx drizzle-kit migrate',
  typeorm: 'npx typeorm migration:run',
  knex: 'npx knex migrate:latest',
  sequelize: 'npx sequelize-cli db:migrate',
  django: 'python manage.py migrate',
  rails: 'rails db:migrate',
  laravel: 'php artisan migrate --force',
};

export function registerDbTools(server: McpServer): void {
  server.tool(
    'db_migrate',
    'Run database migrations on a deployed environment',
    {
      projectName: z.string().optional().describe('Project name (auto-detects if only one)'),
      environment: z.string().optional().describe('Environment name (default: staging)'),
      command: z.string().optional().describe('Migration command (default: auto-detect or prisma)'),
      preset: z
        .enum(['prisma', 'prisma-push', 'drizzle', 'typeorm', 'knex', 'sequelize', 'django', 'rails', 'laravel'])
        .optional()
        .describe('Use a preset migration command'),
      serviceName: z.string().optional().describe('Service to run migration on (default: first service)'),
      dryRun: z.boolean().optional().describe('Show what would be run without executing'),
    },
    async ({ projectName, environment = 'staging', command, preset, serviceName, dryRun }) => {
      // Resolve project
      let project;
      if (projectName) {
        project = projectRepo.findByName(projectName);
      } else {
        const allProjects = projectRepo.findAll();
        if (allProjects.length === 1) {
          project = allProjects[0];
        } else if (allProjects.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'No projects found' }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Multiple projects found. Specify projectName.',
                projects: allProjects.map((p) => p.name),
              }),
            }],
          };
        }
      }

      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      // Resolve environment
      const env = envRepo.findByProjectAndName(project.id, environment);
      if (!env) {
        const allEnvs = envRepo.findByProjectId(project.id);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment not found: ${environment}`,
              available: allEnvs.map((e) => e.name),
            }),
          }],
        };
      }

      // Get bindings
      const bindings = env.platformBindings as {
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };

      if (!bindings.railwayProjectId || !bindings.railwayEnvironmentId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Environment not deployed to Railway' }),
          }],
        };
      }

      // Resolve service
      const services = serviceRepo.findByProjectId(project.id);
      const targetService = serviceName
        ? services.find((s) => s.name === serviceName)
        : services[0];

      if (!targetService) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: serviceName ? `Service not found: ${serviceName}` : 'No services found',
            }),
          }],
        };
      }

      const serviceBinding = bindings.services?.[targetService.name];
      if (!serviceBinding) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Service ${targetService.name} not deployed to Railway`,
            }),
          }],
        };
      }

      // Determine migration command
      let migrationCommand = command;
      if (!migrationCommand && preset) {
        migrationCommand = MIGRATION_PRESETS[preset];
      }
      if (!migrationCommand) {
        // Default to prisma
        migrationCommand = MIGRATION_PRESETS.prisma;
      }

      // Dry run - just show what would happen
      if (dryRun) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              dryRun: true,
              message: 'Would run migration',
              project: project.name,
              environment: env.name,
              service: targetService.name,
              command: migrationCommand,
            }),
          }],
        };
      }

      // Get Railway connection
      const connection = connectionRepo.findByProvider('railway');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No Railway connection found' }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      try {
        const result = await adapter.executeCommand(
          bindings.railwayProjectId,
          bindings.railwayEnvironmentId,
          serviceBinding.serviceId,
          migrationCommand
        );

        if (result.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'Migration completed',
                project: project.name,
                environment: env.name,
                service: targetService.name,
                command: migrationCommand,
                output: result.output,
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: result.error,
                project: project.name,
                environment: env.name,
                command: migrationCommand,
                hint: 'If direct execution is not available, you can run migrations locally using: railway link && railway run ' + migrationCommand,
              }),
            }],
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'db_url',
    'Get the database connection URL for an environment (for local migrations or debugging)',
    {
      projectName: z.string().optional().describe('Project name'),
      environment: z.string().optional().describe('Environment name (default: staging)'),
      serviceName: z.string().optional().describe('Service name'),
    },
    async ({ projectName, environment = 'staging', serviceName }) => {
      // Resolve project
      let project;
      if (projectName) {
        project = projectRepo.findByName(projectName);
      } else {
        const allProjects = projectRepo.findAll();
        if (allProjects.length === 1) {
          project = allProjects[0];
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Specify projectName',
              }),
            }],
          };
        }
      }

      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const env = envRepo.findByProjectAndName(project.id, environment);
      if (!env) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environment}` }),
          }],
        };
      }

      const bindings = env.platformBindings as {
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };

      if (!bindings.railwayProjectId || !bindings.railwayEnvironmentId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Environment not deployed to Railway' }),
          }],
        };
      }

      const services = serviceRepo.findByProjectId(project.id);
      const targetService = serviceName
        ? services.find((s) => s.name === serviceName)
        : services[0];

      if (!targetService || !bindings.services?.[targetService.name]) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Service not found' }),
          }],
        };
      }

      const connection = connectionRepo.findByProvider('railway');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No Railway connection' }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      try {
        const dbUrl = await adapter.getDatabaseUrl(
          bindings.railwayProjectId,
          bindings.railwayEnvironmentId,
          bindings.services[targetService.name].serviceId
        );

        if (dbUrl) {
          // Mask password in output
          const maskedUrl = dbUrl.replace(/:([^:@]+)@/, ':***@');
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                environment: env.name,
                databaseUrl: maskedUrl,
                hint: 'Use this URL to run migrations locally: DATABASE_URL="<url>" npx prisma migrate deploy',
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'No DATABASE_URL found in service variables',
              }),
            }],
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'db_migrate_presets',
    'List available migration command presets',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            presets: Object.entries(MIGRATION_PRESETS).map(([name, command]) => ({
              name,
              command,
            })),
            usage: 'Use with: db_migrate preset="prisma" or db_migrate command="custom command"',
          }),
        }],
      };
    }
  );
}
