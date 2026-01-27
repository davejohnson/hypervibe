import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import type { RailwayCredentials, RailwayProjectDetails } from '../adapters/providers/railway/railway.adapter.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const connectionRepo = new ConnectionRepository();

interface ServiceConfig {
  name: string;
  type: 'web' | 'worker' | 'cron';
  startCommand?: string;
  releaseCommand?: string; // For migrations - runs once before deploy
  cronSchedule?: string;
  healthCheckPath?: string;
  replicas?: number;
  autoscaling?: boolean;
}

interface SetupIssue {
  service: string;
  issue: string;
  severity: 'error' | 'warning' | 'info';
  fix?: string;
}

export function registerSetupTools(server: McpServer): void {
  server.tool(
    'setup_scan',
    'Scan an existing Railway project and identify configuration issues',
    {
      projectName: z.string().optional().describe('Infraprint project name'),
      railwayProjectId: z.string().optional().describe('Railway project ID (if not linked yet)'),
    },
    async ({ projectName, railwayProjectId }) => {
      const connection = connectionRepo.findByProvider('railway');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No Railway connection. Use connection_create first.' }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      // Find Railway project
      let railwayProject: RailwayProjectDetails | null = null;

      if (railwayProjectId) {
        railwayProject = await adapter.getProjectDetails(railwayProjectId);
      } else if (projectName) {
        const project = projectRepo.findByName(projectName);
        if (project) {
          const envs = envRepo.findByProjectId(project.id);
          for (const env of envs) {
            const bindings = env.platformBindings as { railwayProjectId?: string };
            if (bindings.railwayProjectId) {
              railwayProject = await adapter.getProjectDetails(bindings.railwayProjectId);
              break;
            }
          }
        }

        // Try finding by name in Railway
        if (!railwayProject) {
          const found = await adapter.findProjectByName(projectName);
          if (found) {
            railwayProject = await adapter.getProjectDetails(found.id);
          }
        }
      }

      if (!railwayProject) {
        // List available projects
        const projects = await adapter.listProjects();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Project not found. Specify railwayProjectId or projectName.',
              availableProjects: projects.map((p) => ({ id: p.id, name: p.name })),
            }),
          }],
        };
      }

      // Scan for issues
      const issues: SetupIssue[] = [];
      const services: Array<{
        name: string;
        id: string;
        hasGitHub: boolean;
        startCommand?: string;
        healthCheckPath?: string;
        replicas?: number;
        domains: string[];
      }> = [];

      for (const serviceEdge of railwayProject.services.edges) {
        const svc = serviceEdge.node;
        const hasGitHub = svc.repoTriggers.edges.length > 0;
        const instance = svc.serviceInstances.edges[0]?.node;

        const domains = [
          ...(instance?.domains?.serviceDomains?.map((d) => d.domain) || []),
          ...(instance?.domains?.customDomains?.map((d) => d.domain) || []),
        ];

        services.push({
          name: svc.name,
          id: svc.id,
          hasGitHub,
          startCommand: instance?.startCommand,
          healthCheckPath: instance?.healthcheckPath,
          replicas: instance?.numReplicas,
          domains,
        });

        // Check for issues
        if (!hasGitHub) {
          issues.push({
            service: svc.name,
            issue: 'No GitHub repository connected',
            severity: 'warning',
            fix: 'Connect a GitHub repo for automatic deployments',
          });
        }

        if (!instance?.startCommand) {
          issues.push({
            service: svc.name,
            issue: 'No start command configured',
            severity: 'info',
            fix: 'Set a start command (e.g., npm start)',
          });
        }

        if (domains.length > 0 && !instance?.healthcheckPath) {
          issues.push({
            service: svc.name,
            issue: 'Web service without health check',
            severity: 'warning',
            fix: 'Add a health check path (e.g., /health or /api/health)',
          });
        }

        // Check if this looks like a web service without proper config
        const looksLikeWeb = svc.name.toLowerCase().includes('web') ||
                            svc.name.toLowerCase().includes('api') ||
                            svc.name.toLowerCase().includes('server') ||
                            domains.length > 0;

        if (looksLikeWeb && instance?.sleepApplication) {
          issues.push({
            service: svc.name,
            issue: 'Web service has sleep enabled (will have cold starts)',
            severity: 'info',
            fix: 'Disable sleep for production web services',
          });
        }
      }

      // Check for migration setup
      const hasDatabase = railwayProject.plugins.edges.some((p) =>
        p.node.name.toLowerCase().includes('postgres') ||
        p.node.name.toLowerCase().includes('mysql') ||
        p.node.name.toLowerCase().includes('mongo')
      );

      if (hasDatabase && services.length > 0) {
        // Check if any service has a release command for migrations
        // Note: Railway's GraphQL doesn't expose releaseCommand directly,
        // so we'll flag this as something to verify
        issues.push({
          service: '*',
          issue: 'Database detected - verify migrations are configured',
          severity: 'info',
          fix: 'Set releaseCommand in railway.toml or use setup_configure to add it',
        });
      }

      // Check for missing environment variable references
      if (hasDatabase) {
        for (const svc of services) {
          // We'd need to check if DATABASE_URL is set - this requires another API call
          // For now, just note it
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: {
              id: railwayProject.id,
              name: railwayProject.name,
            },
            environments: railwayProject.environments.edges.map((e) => ({
              id: e.node.id,
              name: e.node.name,
            })),
            services,
            plugins: railwayProject.plugins.edges.map((p) => p.node.name),
            issues,
            summary: {
              totalServices: services.length,
              issueCount: issues.length,
              errors: issues.filter((i) => i.severity === 'error').length,
              warnings: issues.filter((i) => i.severity === 'warning').length,
            },
          }),
        }],
      };
    }
  );

  server.tool(
    'setup_configure',
    'Configure a Railway service with proper settings (start command, migrations, health checks)',
    {
      projectName: z.string().optional().describe('Project name'),
      railwayProjectId: z.string().optional().describe('Railway project ID'),
      serviceName: z.string().describe('Service to configure'),
      environmentName: z.string().optional().describe('Environment (default: production)'),
      startCommand: z.string().optional().describe('Start command (e.g., npm start)'),
      releaseCommand: z.string().optional().describe('Release command for migrations (runs once before deploy)'),
      healthCheckPath: z.string().optional().describe('Health check endpoint (e.g., /health)'),
      cronSchedule: z.string().optional().describe('Cron schedule (e.g., "0 * * * *" for hourly)'),
    },
    async ({ projectName, railwayProjectId, serviceName, environmentName = 'production', startCommand, releaseCommand, healthCheckPath, cronSchedule }) => {
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

      // Find project
      let projectId = railwayProjectId;
      if (!projectId && projectName) {
        const found = await adapter.findProjectByName(projectName);
        projectId = found?.id;
      }

      if (!projectId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Project not found' }),
          }],
        };
      }

      const projectDetails = await adapter.getProjectDetails(projectId);
      if (!projectDetails) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Could not fetch project details' }),
          }],
        };
      }

      // Find service
      const service = projectDetails.services.edges.find(
        (s) => s.node.name.toLowerCase() === serviceName.toLowerCase()
      );

      if (!service) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Service not found: ${serviceName}`,
              available: projectDetails.services.edges.map((s) => s.node.name),
            }),
          }],
        };
      }

      // Find environment
      const env = projectDetails.environments.edges.find(
        (e) => e.node.name.toLowerCase() === environmentName.toLowerCase()
      );

      if (!env) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment not found: ${environmentName}`,
              available: projectDetails.environments.edges.map((e) => e.node.name),
            }),
          }],
        };
      }

      // Apply configuration via Railway API
      try {
        const updates: string[] = [];

        // Note: Railway's GraphQL API for updating service settings is complex
        // We'll use the serviceInstanceUpdate mutation
        const client = (adapter as unknown as { client: { request: Function } }).client;

        if (startCommand || healthCheckPath || cronSchedule) {
          const mutation = `
            mutation UpdateServiceInstance($input: ServiceInstanceUpdateInput!) {
              serviceInstanceUpdate(input: $input)
            }
          `;

          const input: Record<string, unknown> = {
            serviceId: service.node.id,
            environmentId: env.node.id,
          };

          if (startCommand) {
            input.startCommand = startCommand;
            updates.push(`Start command: ${startCommand}`);
          }

          if (healthCheckPath) {
            input.healthcheckPath = healthCheckPath;
            updates.push(`Health check: ${healthCheckPath}`);
          }

          if (cronSchedule) {
            input.cronSchedule = cronSchedule;
            updates.push(`Cron schedule: ${cronSchedule}`);
          }

          await client.request(mutation, { input });
        }

        // Release command needs to be set via railway.toml or service variables
        // We can set it as a variable that the app checks
        if (releaseCommand) {
          // Set as a variable - the app's railway.toml should reference this
          // Or we document that they need to add it to railway.toml
          updates.push(`Release command: ${releaseCommand} (add to railway.toml)`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: 'Service configured',
              project: projectDetails.name,
              service: serviceName,
              environment: environmentName,
              updates,
              note: releaseCommand
                ? 'For migrations, add to railway.toml: [deploy]\\nreleaseCommand = "' + releaseCommand + '"'
                : undefined,
            }),
          }],
        };
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
    'setup_fix',
    'Automatically fix common configuration issues in a Railway project',
    {
      projectName: z.string().optional().describe('Project name'),
      railwayProjectId: z.string().optional().describe('Railway project ID'),
      dryRun: z.boolean().optional().describe('Show what would be fixed without applying'),
    },
    async ({ projectName, railwayProjectId, dryRun }) => {
      // First, scan for issues
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

      // Find project
      let projectId = railwayProjectId;
      if (!projectId && projectName) {
        const found = await adapter.findProjectByName(projectName);
        projectId = found?.id;
      }

      if (!projectId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Project not found' }),
          }],
        };
      }

      const projectDetails = await adapter.getProjectDetails(projectId);
      if (!projectDetails) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Could not fetch project' }),
          }],
        };
      }

      const fixes: Array<{ service: string; action: string; applied: boolean }> = [];

      // Check for database and auto-wire connections
      const hasPostgres = projectDetails.plugins.edges.some((p) =>
        p.node.name.toLowerCase().includes('postgres')
      );
      const hasRedis = projectDetails.plugins.edges.some((p) =>
        p.node.name.toLowerCase().includes('redis')
      );

      for (const envEdge of projectDetails.environments.edges) {
        const railwayEnv = envEdge.node;

        for (const svcEdge of projectDetails.services.edges) {
          const svc = svcEdge.node;

          // Get current variables
          const currentVars = await adapter.getServiceVariables(
            projectDetails.id,
            svc.id,
            railwayEnv.id
          );

          const varsToSet: Record<string, string> = {};

          // Auto-wire database if not set
          if (hasPostgres && !currentVars['DATABASE_URL']) {
            const postgresPlugin = projectDetails.plugins.edges.find((p) =>
              p.node.name.toLowerCase().includes('postgres')
            );
            if (postgresPlugin) {
              varsToSet['DATABASE_URL'] = '${{' + postgresPlugin.node.name + '.DATABASE_URL}}';
              fixes.push({
                service: `${svc.name} (${railwayEnv.name})`,
                action: 'Wire DATABASE_URL to Postgres plugin',
                applied: !dryRun,
              });
            }
          }

          // Auto-wire Redis if not set
          if (hasRedis && !currentVars['REDIS_URL']) {
            const redisPlugin = projectDetails.plugins.edges.find((p) =>
              p.node.name.toLowerCase().includes('redis')
            );
            if (redisPlugin) {
              varsToSet['REDIS_URL'] = '${{' + redisPlugin.node.name + '.REDIS_URL}}';
              fixes.push({
                service: `${svc.name} (${railwayEnv.name})`,
                action: 'Wire REDIS_URL to Redis plugin',
                applied: !dryRun,
              });
            }
          }

          // Apply fixes if not dry run
          if (!dryRun && Object.keys(varsToSet).length > 0) {
            // We need to create a mock environment and service object for setEnvVars
            const mockEnv = {
              id: '',
              projectId: '',
              name: railwayEnv.name,
              platformBindings: {
                railwayProjectId: projectDetails.id,
                railwayEnvironmentId: railwayEnv.id,
                services: { [svc.name]: { serviceId: svc.id } },
              },
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            const mockService = {
              id: '',
              projectId: '',
              name: svc.name,
              buildConfig: {},
              envVarSpec: {},
              createdAt: new Date(),
              updatedAt: new Date(),
            };

            await adapter.setEnvVars(mockEnv, mockService, varsToSet);
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            dryRun: dryRun || false,
            project: projectDetails.name,
            fixesApplied: fixes.filter((f) => f.applied).length,
            fixes,
            note: dryRun ? 'Run without dryRun=true to apply fixes' : undefined,
          }),
        }],
      };
    }
  );
}
