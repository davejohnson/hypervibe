import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import type { RailwayCredentials, RailwayProjectDetails } from '../adapters/providers/railway/railway.adapter.js';

import { resolveProject } from './resolve-project.js';
import { buildRailwayGitHubRepoAccessHelp, isRailwayGitHubRepoAccessError } from './railway-help.js';

const envRepo = new EnvironmentRepository();
const connectionRepo = new ConnectionRepository();
const serviceRepo = new ServiceRepository();

interface SetupIssue {
  service: string;
  issue: string;
  severity: 'error' | 'warning' | 'info';
  fix?: string;
}

function parseGitHubRepoFromRemote(remoteUrl?: string): string | null {
  if (!remoteUrl) {
    return null;
  }

  const normalized = remoteUrl.trim().replace(/\.git$/i, '');

  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }
    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
  } catch {
    // Not a URL format, continue with SSH-like parsing.
  }

  const sshMatch = normalized.match(/^(?:ssh:\/\/)?(?:git@)?github\.com[:/](.+)$/i);
  if (!sshMatch) {
    return null;
  }

  const parts = sshMatch[1].replace(/^\/+/, '').split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

async function resolveRailwayProjectDetails(
  adapter: RailwayAdapter,
  params: { projectName?: string; railwayProjectId?: string }
): Promise<RailwayProjectDetails | null> {
  if (params.railwayProjectId) {
    return await adapter.getProjectDetails(params.railwayProjectId);
  }

  if (!params.projectName) {
    return null;
  }

  const project = resolveProject({ projectName: params.projectName });
  if (project) {
    const envs = envRepo.findByProjectId(project.id);
    for (const env of envs) {
      const bindings = env.platformBindings as { projectId?: string; railwayProjectId?: string };
      const providerProjectId = bindings.projectId || bindings.railwayProjectId;
      if (!providerProjectId) continue;
      const details = await adapter.getProjectDetails(providerProjectId);
      if (details) {
        return details;
      }
    }
  }

  const found = await adapter.findProjectByName(params.projectName);
  if (!found) {
    return null;
  }

  return await adapter.getProjectDetails(found.id);
}

export function registerSetupTools(server: McpServer): void {
  server.tool(
    'setup_scan',
    'Scan an existing Railway project and identify configuration issues',
    {
      projectName: z.string().optional().describe('Hypervibe project name'),
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
      const railwayProject = await resolveRailwayProjectDetails(adapter, { projectName, railwayProjectId });

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
    'Configure a Railway service with proper settings (start command, migrations, health checks, repo/branch deploy source)',
    {
      projectName: z.string().optional().describe('Project name'),
      railwayProjectId: z.string().optional().describe('Railway project ID'),
      serviceName: z.string().describe('Service to configure'),
      environmentName: z.string().optional().describe('Environment (default: production)'),
      repo: z.string().optional().describe('GitHub repository to connect for Railway auto-deploy (owner/repo). Defaults from project gitRemoteUrl when available'),
      branch: z.string().optional().describe('Git branch to connect for Railway auto-deploy (e.g., main)'),
      startCommand: z.string().optional().describe('Start command (e.g., npm start)'),
      releaseCommand: z.string().optional().describe('Release command for migrations (runs once before deploy)'),
      healthCheckPath: z.string().optional().describe('Health check endpoint (e.g., /health)'),
      cronSchedule: z.string().optional().describe('Cron schedule (e.g., "0 * * * *" for hourly)'),
    },
    async ({ projectName, railwayProjectId, serviceName, environmentName = 'production', repo, branch, startCommand, releaseCommand, healthCheckPath, cronSchedule }) => {
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
      const project = resolveProject({ projectName });

      // Find project
      const projectDetails = await resolveRailwayProjectDetails(adapter, { projectName, railwayProjectId });
      if (!projectDetails) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Project not found' }),
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
        const wantsRepoLink = typeof repo === 'string' || typeof branch === 'string';

        if (wantsRepoLink) {
          const resolvedBranch = branch?.trim();
          const resolvedRepo = repo?.trim() || parseGitHubRepoFromRemote(project?.gitRemoteUrl);

          if (!resolvedBranch) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: 'branch is required when configuring a Railway GitHub deploy source',
                }),
              }],
            };
          }

          if (!resolvedRepo) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: 'repo is required when configuring a Railway GitHub deploy source. Pass repo explicitly or set the Hypervibe project gitRemoteUrl to a GitHub remote.',
                }),
              }],
            };
          }

          const receipt = await adapter.connectServiceToRepo({
            serviceId: service.node.id,
            repo: resolvedRepo,
            branch: resolvedBranch,
          });
          if (!receipt.success) {
            const error = receipt.error || receipt.message;
            const help = isRailwayGitHubRepoAccessError(error)
              ? buildRailwayGitHubRepoAccessHelp(resolvedRepo)
              : undefined;
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error,
                  ...(help ? { help, nextSteps: help.nextSteps } : {}),
                }),
              }],
            };
          }

          updates.push(`Deploy source: ${resolvedRepo}#${resolvedBranch}`);
        }

        if (startCommand || healthCheckPath || cronSchedule) {
          const receipt = await adapter.updateServiceInstanceConfig({
            serviceId: service.node.id,
            environmentId: env.node.id,
            startCommand,
            healthcheckPath: healthCheckPath,
            cronSchedule,
          });
          if (!receipt.success) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: receipt.error || receipt.message,
                }),
              }],
            };
          }

          if (startCommand) {
            updates.push(`Start command: ${startCommand}`);
          }
          if (healthCheckPath) {
            updates.push(`Health check: ${healthCheckPath}`);
          }
          if (cronSchedule) {
            updates.push(`Cron schedule: ${cronSchedule}`);
          }
        }

        // Release command needs to be set via railway.toml or service variables
        // We can set it as a variable that the app checks
        if (releaseCommand) {
          // Set as a variable - the app's railway.toml should reference this
          // Or we document that they need to add it to railway.toml
          updates.push(`Release command: ${releaseCommand} (add to railway.toml)`);
        }

        if (project) {
          const localService = serviceRepo.findByProjectAndName(project.id, serviceName);
          if (localService) {
            serviceRepo.update(localService.id, {
              buildConfig: {
                ...localService.buildConfig,
                ...(startCommand ? { startCommand } : {}),
                ...(releaseCommand ? { releaseCommand } : {}),
                ...(healthCheckPath ? { healthCheckPath } : {}),
                ...(cronSchedule ? { cronSchedule } : {}),
              },
            });
          }
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

}
