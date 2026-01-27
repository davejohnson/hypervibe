import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import { StripeAdapter } from '../adapters/providers/stripe/stripe.adapter.js';
import type { RailwayCredentials } from '../adapters/providers/railway/railway.adapter.js';
import type { StripeCredentials, StripeMode } from '../adapters/providers/stripe/stripe.adapter.js';

const connectionRepo = new ConnectionRepository();
const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

export function registerLogsTools(server: McpServer): void {
  // Simple error fetching - minimal parameters needed
  server.tool(
    'errors_recent',
    'Get recent errors from production. Auto-detects project and environment.',
    {
      projectName: z.string().optional().describe('Project name (auto-detects if only one project)'),
      environment: z.string().optional().describe('Environment name (defaults to production/prod)'),
      limit: z.number().optional().describe('Max errors to return (default 20)'),
    },
    async ({ projectName, environment, limit = 20 }) => {
      // Auto-detect project if not specified
      let project;
      if (projectName) {
        project = projectRepo.findByName(projectName);
      } else {
        const allProjects = projectRepo.findAll();
        if (allProjects.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'No projects found' }),
            }],
          };
        }
        if (allProjects.length === 1) {
          project = allProjects[0];
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

      // Find production environment (try common names)
      const envNames = environment
        ? [environment]
        : ['production', 'prod', 'main', 'live'];

      let env = null;
      for (const envName of envNames) {
        env = envRepo.findByProjectAndName(project.id, envName);
        if (env) break;
      }

      if (!env) {
        const allEnvs = envRepo.findByProjectId(project.id);
        if (allEnvs.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'No environments found' }),
            }],
          };
        }
        // Fall back to first non-local environment
        env = allEnvs.find((e) => e.name !== 'local') || allEnvs[0];
      }

      const bindings = env.platformBindings as {
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };

      if (!bindings.railwayProjectId || !bindings.railwayEnvironmentId || !bindings.services) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Environment not deployed to Railway' }),
          }],
        };
      }

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
        const allErrors: Array<{
          service: string;
          timestamp: string;
          message: string;
          severity?: string;
        }> = [];

        // Fetch logs from all services
        for (const [serviceName, serviceBinding] of Object.entries(bindings.services)) {
          const deployments = await adapter.getDeployments(
            bindings.railwayProjectId,
            bindings.railwayEnvironmentId,
            serviceBinding.serviceId,
            1
          );

          if (deployments.length === 0) continue;

          const logs = await adapter.getDeploymentLogs(deployments[0].id, 500);

          // Filter to errors
          const errors = logs.filter((l) =>
            l.severity === 'error' ||
            l.message.toLowerCase().includes('error') ||
            l.message.toLowerCase().includes('exception') ||
            l.message.toLowerCase().includes('failed') ||
            l.message.toLowerCase().includes('crash') ||
            l.message.toLowerCase().includes('fatal')
          );

          for (const error of errors) {
            allErrors.push({
              service: serviceName,
              timestamp: error.timestamp,
              message: error.message,
              severity: error.severity,
            });
          }
        }

        // Sort by timestamp descending and limit
        allErrors.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const recentErrors = allErrors.slice(0, limit);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: project.name,
              environment: env.name,
              errorCount: recentErrors.length,
              totalFound: allErrors.length,
              errors: recentErrors,
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
    'logs_deployments',
    'List recent deployments for a service with their status',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment name'),
      serviceName: z.string().optional().describe('Service name (optional, shows all if not specified)'),
      limit: z.number().optional().describe('Number of deployments to show (default 10)'),
    },
    async ({ projectName, environmentName, serviceName, limit = 10 }) => {
      const project = projectRepo.findByName(projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const environment = envRepo.findByProjectAndName(project.id, environmentName);
      if (!environment) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environmentName}` }),
          }],
        };
      }

      const bindings = environment.platformBindings as {
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
        let serviceId: string | undefined;
        if (serviceName && bindings.services?.[serviceName]) {
          serviceId = bindings.services[serviceName].serviceId;
        }

        const deployments = await adapter.getDeployments(
          bindings.railwayProjectId,
          bindings.railwayEnvironmentId,
          serviceId,
          limit
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: projectName,
              environment: environmentName,
              service: serviceName || 'all',
              count: deployments.length,
              deployments: deployments.map((d) => ({
                id: d.id,
                status: d.status,
                createdAt: d.createdAt,
                url: d.staticUrl,
              })),
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
    'logs_service',
    'Get runtime logs from a deployed service',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment name'),
      serviceName: z.string().describe('Service name'),
      lines: z.number().optional().describe('Number of log lines (default 100)'),
      errorsOnly: z.boolean().optional().describe('Show only error/warning logs'),
    },
    async ({ projectName, environmentName, serviceName, lines = 100, errorsOnly = false }) => {
      const project = projectRepo.findByName(projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const environment = envRepo.findByProjectAndName(project.id, environmentName);
      if (!environment) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environmentName}` }),
          }],
        };
      }

      const bindings = environment.platformBindings as {
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

      if (!bindings.services?.[serviceName]) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Service ${serviceName} not found in environment` }),
          }],
        };
      }

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
        // Get the latest deployment
        const deployments = await adapter.getDeployments(
          bindings.railwayProjectId,
          bindings.railwayEnvironmentId,
          bindings.services[serviceName].serviceId,
          1
        );

        if (deployments.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'No deployments found for service' }),
            }],
          };
        }

        const latestDeployment = deployments[0];
        let logs = await adapter.getDeploymentLogs(latestDeployment.id, lines);

        // Filter to errors only if requested
        if (errorsOnly) {
          logs = logs.filter((l) =>
            l.severity === 'error' ||
            l.severity === 'warn' ||
            l.message.toLowerCase().includes('error') ||
            l.message.toLowerCase().includes('exception') ||
            l.message.toLowerCase().includes('failed')
          );
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: projectName,
              environment: environmentName,
              service: serviceName,
              deploymentId: latestDeployment.id,
              deploymentStatus: latestDeployment.status,
              logCount: logs.length,
              logs: logs.map((l) => ({
                timestamp: l.timestamp,
                severity: l.severity || 'info',
                message: l.message,
              })),
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
    'logs_build',
    'Get build logs for a deployment',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment name'),
      serviceName: z.string().describe('Service name'),
      deploymentId: z.string().optional().describe('Specific deployment ID (defaults to latest)'),
    },
    async ({ projectName, environmentName, serviceName, deploymentId }) => {
      const project = projectRepo.findByName(projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const environment = envRepo.findByProjectAndName(project.id, environmentName);
      if (!environment) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environmentName}` }),
          }],
        };
      }

      const bindings = environment.platformBindings as {
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

      if (!bindings.services?.[serviceName]) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Service ${serviceName} not found in environment` }),
          }],
        };
      }

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
        let targetDeploymentId = deploymentId;

        if (!targetDeploymentId) {
          const deployments = await adapter.getDeployments(
            bindings.railwayProjectId,
            bindings.railwayEnvironmentId,
            bindings.services[serviceName].serviceId,
            1
          );

          if (deployments.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: 'No deployments found for service' }),
              }],
            };
          }

          targetDeploymentId = deployments[0].id;
        }

        const buildLogs = await adapter.getBuildLogs(targetDeploymentId);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: projectName,
              environment: environmentName,
              service: serviceName,
              deploymentId: targetDeploymentId,
              buildLogs: buildLogs || 'No build logs available',
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
    'logs_errors_summary',
    'Get a summary of recent errors across services in an environment',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment name'),
    },
    async ({ projectName, environmentName }) => {
      const project = projectRepo.findByName(projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const environment = envRepo.findByProjectAndName(project.id, environmentName);
      if (!environment) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environmentName}` }),
          }],
        };
      }

      const bindings = environment.platformBindings as {
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };

      if (!bindings.railwayProjectId || !bindings.railwayEnvironmentId || !bindings.services) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Environment not deployed to Railway' }),
          }],
        };
      }

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
        const serviceErrors: Array<{
          service: string;
          deploymentStatus: string;
          errorCount: number;
          recentErrors: Array<{ timestamp: string; message: string }>;
        }> = [];

        for (const [serviceName, serviceBinding] of Object.entries(bindings.services)) {
          const deployments = await adapter.getDeployments(
            bindings.railwayProjectId,
            bindings.railwayEnvironmentId,
            serviceBinding.serviceId,
            1
          );

          if (deployments.length === 0) continue;

          const deployment = deployments[0];
          const logs = await adapter.getDeploymentLogs(deployment.id, 200);

          const errors = logs.filter((l) =>
            l.severity === 'error' ||
            l.message.toLowerCase().includes('error') ||
            l.message.toLowerCase().includes('exception') ||
            l.message.toLowerCase().includes('failed') ||
            l.message.toLowerCase().includes('crash')
          );

          serviceErrors.push({
            service: serviceName,
            deploymentStatus: deployment.status,
            errorCount: errors.length,
            recentErrors: errors.slice(0, 5).map((e) => ({
              timestamp: e.timestamp,
              message: e.message.substring(0, 200),
            })),
          });
        }

        const totalErrors = serviceErrors.reduce((sum, s) => sum + s.errorCount, 0);
        const failedDeployments = serviceErrors.filter((s) =>
          s.deploymentStatus === 'FAILED' || s.deploymentStatus === 'CRASHED'
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: projectName,
              environment: environmentName,
              summary: {
                totalServices: serviceErrors.length,
                totalErrors,
                failedDeployments: failedDeployments.length,
                healthyServices: serviceErrors.filter((s) => s.errorCount === 0 && s.deploymentStatus === 'SUCCESS').length,
              },
              services: serviceErrors,
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
    'logs_stripe_webhooks',
    'Check recent Stripe webhook delivery attempts and failures',
    {
      mode: z.enum(['sandbox', 'live']).describe('Stripe mode'),
      webhookId: z.string().optional().describe('Specific webhook endpoint ID (optional)'),
    },
    async ({ mode, webhookId }) => {
      const connection = connectionRepo.findByProvider('stripe');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No Stripe connection found' }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<StripeCredentials>(connection.credentialsEncrypted);
      const adapter = new StripeAdapter();
      adapter.connect(credentials);

      try {
        const webhooks = await adapter.listWebhookEndpoints(mode as StripeMode);

        const webhookStatuses = webhooks
          .filter((w) => !webhookId || w.id === webhookId)
          .map((w) => ({
            id: w.id,
            url: w.url,
            status: w.status,
            enabledEvents: w.enabled_events.length,
            description: w.description,
          }));

        // Note: Stripe doesn't expose webhook delivery logs via API directly
        // We can only see the endpoint status
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode,
              webhooks: webhookStatuses,
              note: 'For detailed webhook delivery logs, check the Stripe Dashboard: https://dashboard.stripe.com/webhooks',
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
}
