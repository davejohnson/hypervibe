import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import { StripeAdapter } from '../adapters/providers/stripe/stripe.adapter.js';
import type { RailwayCredentials } from '../adapters/providers/railway/railway.adapter.js';
import type { StripeCredentials, StripeMode } from '../adapters/providers/stripe/stripe.adapter.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { resolveProject, resolveProjectOrError } from './resolve-project.js';

const connectionRepo = new ConnectionRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

type UnifiedLog = {
  timestamp: string;
  severity: string;
  message: string;
};

export function detectProviderName(projectDefaultPlatform: string | undefined, bindingsProvider: string | undefined): string {
  return (bindingsProvider || projectDefaultPlatform || 'railway').toLowerCase();
}

export function isErrorLike(log: UnifiedLog): boolean {
  const message = log.message.toLowerCase();
  const severity = (log.severity || '').toLowerCase();
  return (
    severity === 'error' ||
    severity === 'warn' ||
    message.includes('error') ||
    message.includes('exception') ||
    message.includes('failed') ||
    message.includes('crash') ||
    message.includes('fatal')
  );
}

async function fetchProviderLogs(
  provider: string,
  environment: {
    platformBindings: unknown;
    name: string;
  },
  serviceName: string,
  lines: number
): Promise<{ deploymentStatus?: string; deploymentId?: string; logs: UnifiedLog[] }> {
  const bindings = environment.platformBindings as {
    projectId?: string;
    railwayProjectId?: string;
    railwayEnvironmentId?: string;
    services?: Record<string, { serviceId: string }>;
  };

  if (provider === 'railway') {
    if (!bindings.railwayProjectId || !bindings.railwayEnvironmentId || !bindings.services?.[serviceName]) {
      throw new Error('Environment/service not fully bound to Railway');
    }
    const connection = connectionRepo.findByProvider('railway');
    if (!connection) {
      throw new Error('No Railway connection found');
    }

    const secretStore = getSecretStore();
    const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
    const adapter = new RailwayAdapter();
    await adapter.connect(credentials);

    const deployments = await adapter.getDeployments(
      bindings.railwayProjectId,
      bindings.railwayEnvironmentId,
      bindings.services[serviceName].serviceId,
      1
    );
    if (deployments.length === 0) {
      return { logs: [] };
    }

    const latestDeployment = deployments[0];
    const logs = await adapter.getDeploymentLogs(latestDeployment.id, lines);
    return {
      deploymentStatus: latestDeployment.status,
      deploymentId: latestDeployment.id,
      logs: logs.map((l) => ({
        timestamp: l.timestamp,
        severity: l.severity || 'info',
        message: l.message,
      })),
    };
  }

  if (provider === 'render') {
    const serviceId = bindings.services?.[serviceName]?.serviceId;
    if (!serviceId) {
      throw new Error(`Service ${serviceName} is not bound to Render`);
    }

    const result = await adapterFactory.getProviderAdapter('render');
    if (!result.success || !result.adapter) {
      throw new Error(result.error || 'Failed to create Render adapter');
    }
    const adapter = result.adapter as unknown as {
      getServiceLogs: (serviceId: string, limit?: number) => Promise<UnifiedLog[]>;
    };
    if (typeof adapter.getServiceLogs !== 'function') {
      throw new Error('Render logs are not supported by this adapter version');
    }
    const logs = await adapter.getServiceLogs(serviceId, lines);
    return { deploymentStatus: 'unknown', logs };
  }

  if (provider === 'vercel') {
    const projectId = bindings.projectId;
    if (!projectId) {
      throw new Error('Environment is not bound to Vercel projectId');
    }

    const result = await adapterFactory.getProviderAdapter('vercel');
    if (!result.success || !result.adapter) {
      throw new Error(result.error || 'Failed to create Vercel adapter');
    }
    const adapter = result.adapter as unknown as {
      listDeployments: (projectId: string, limit?: number) => Promise<Array<{ id: string; readyState?: string }>>;
      getDeploymentEvents: (deploymentId: string, limit?: number) => Promise<UnifiedLog[]>;
    };
    if (typeof adapter.listDeployments !== 'function' || typeof adapter.getDeploymentEvents !== 'function') {
      throw new Error('Vercel logs are not supported by this adapter version');
    }
    const deployments = await adapter.listDeployments(projectId, 1);
    if (deployments.length === 0) {
      return { logs: [] };
    }
    const latestDeployment = deployments[0];
    const logs = await adapter.getDeploymentEvents(latestDeployment.id, lines);
    return {
      deploymentStatus: latestDeployment.readyState ?? 'unknown',
      deploymentId: latestDeployment.id,
      logs,
    };
  }

  throw new Error(`Logs are not yet supported for provider: ${provider}`);
}

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
      const result = resolveProjectOrError({ projectName });
      if ('error' in result) return result.error;
      const project = result.project;

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
        provider?: string;
        services?: Record<string, { serviceId: string }>;
      };
      const provider = detectProviderName(project.defaultPlatform, bindings.provider);

      if (!bindings.services || Object.keys(bindings.services).length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No bound services found in environment' }),
          }],
        };
      }

      try {
        const allErrors: Array<{
          service: string;
          timestamp: string;
          message: string;
          severity?: string;
        }> = [];

        // Fetch logs from all services
        for (const serviceName of Object.keys(bindings.services)) {
          const { logs } = await fetchProviderLogs(provider, env, serviceName, 500);
          const errors = logs.filter(isErrorLike);

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
              provider,
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
      const project = resolveProject({ projectName });
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
        provider?: string;
        projectId?: string;
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };
      const provider = detectProviderName(project.defaultPlatform, bindings.provider);

      try {
        if (provider === 'railway') {
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
                provider,
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
        }

        if (provider === 'vercel') {
          if (!bindings.projectId) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: 'Environment is not bound to Vercel projectId' }),
              }],
            };
          }

          const result = await adapterFactory.getProviderAdapter('vercel', project);
          if (!result.success || !result.adapter) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: result.error || 'Failed to create Vercel adapter' }),
              }],
            };
          }
          const adapter = result.adapter as unknown as {
            listDeployments: (projectId: string, limit?: number) => Promise<Array<{
              id: string;
              readyState?: string;
              createdAt?: number;
              url?: string;
              name?: string;
            }>>;
          };
          const deployments = await adapter.listDeployments(bindings.projectId, limit);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                project: projectName,
                environment: environmentName,
                provider,
                service: serviceName || 'all',
                count: deployments.length,
                deployments: deployments.map((d) => ({
                  id: d.id,
                  status: d.readyState ?? 'unknown',
                  createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
                  url: d.url ? `https://${d.url}` : undefined,
                  service: d.name,
                })),
              }),
            }],
          };
        }

        if (provider === 'render') {
          const result = await adapterFactory.getProviderAdapter('render', project);
          if (!result.success || !result.adapter) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: result.error || 'Failed to create Render adapter' }),
              }],
            };
          }
          const adapter = result.adapter as unknown as {
            listServiceDeployments: (serviceId: string, limit?: number) => Promise<Array<{
              id: string;
              status: string;
              createdAt: string;
            }>>;
          };
          if (typeof adapter.listServiceDeployments !== 'function') {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: 'Render deployments are not supported by this adapter version',
                }),
              }],
            };
          }

          const targetServices = serviceName
            ? [{ name: serviceName, serviceId: bindings.services?.[serviceName]?.serviceId }]
            : Object.entries(bindings.services ?? {}).map(([name, svc]) => ({ name, serviceId: svc.serviceId }));

          const deployments: Array<{
            id: string;
            status: string;
            createdAt?: string;
            service?: string;
          }> = [];

          for (const svc of targetServices) {
            if (!svc.serviceId) continue;
            const items = await adapter.listServiceDeployments(svc.serviceId, limit);
            for (const d of items) {
              deployments.push({
                id: d.id,
                status: d.status,
                createdAt: d.createdAt,
                service: svc.name,
              });
            }
          }

          deployments.sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bt - at;
          });
          const sliced = deployments.slice(0, limit);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                project: projectName,
                environment: environmentName,
                provider,
                service: serviceName || 'all',
                count: sliced.length,
                deployments: sliced,
              }),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `logs_deployments currently supports Railway, Vercel, and Render only (provider: ${provider}).`,
              provider,
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
      const project = resolveProject({ projectName });
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
        provider?: string;
        services?: Record<string, { serviceId: string }>;
      };
      const provider = detectProviderName(project.defaultPlatform, bindings.provider);

      if (!bindings.services?.[serviceName]) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Service ${serviceName} not found in environment` }),
          }],
        };
      }

      try {
        const { deploymentId, deploymentStatus, logs: allLogs } = await fetchProviderLogs(provider, environment, serviceName, lines);
        let logs = allLogs;

        // Filter to errors only if requested
        if (errorsOnly) {
          logs = logs.filter(isErrorLike);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              project: projectName,
              environment: environmentName,
              provider,
              service: serviceName,
              deploymentId: deploymentId ?? null,
              deploymentStatus: deploymentStatus ?? 'unknown',
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
      const project = resolveProject({ projectName });
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
        provider?: string;
        projectId?: string;
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };
      const provider = detectProviderName(project.defaultPlatform, bindings.provider);

      if (!bindings.services?.[serviceName]) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Service ${serviceName} not found in environment` }),
          }],
        };
      }

      try {
        if (provider === 'railway') {
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
                provider,
                service: serviceName,
                deploymentId: targetDeploymentId,
                buildLogs: buildLogs || 'No build logs available',
              }),
            }],
          };
        }

        if (provider === 'vercel') {
          if (!bindings.projectId) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: 'Environment is not bound to Vercel projectId' }),
              }],
            };
          }
          const result = await adapterFactory.getProviderAdapter('vercel', project);
          if (!result.success || !result.adapter) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: result.error || 'Failed to create Vercel adapter' }),
              }],
            };
          }
          const adapter = result.adapter as unknown as {
            listDeployments: (projectId: string, limit?: number) => Promise<Array<{ id: string }>>;
            getDeploymentEvents: (deploymentId: string, limit?: number) => Promise<UnifiedLog[]>;
          };

          let targetDeploymentId = deploymentId;
          if (!targetDeploymentId) {
            const deployments = await adapter.listDeployments(bindings.projectId, 1);
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

          const events = await adapter.getDeploymentEvents(targetDeploymentId, 200);
          const buildLogs = events.map((e) => `[${e.timestamp}] ${e.severity || 'info'} ${e.message}`).join('\n');

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                project: projectName,
                environment: environmentName,
                provider,
                service: serviceName,
                deploymentId: targetDeploymentId,
                buildLogs: buildLogs || 'No build logs available',
              }),
            }],
          };
        }

        if (provider === 'render') {
          const serviceId = bindings.services?.[serviceName]?.serviceId;
          if (!serviceId) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: `Service ${serviceName} not bound to Render` }),
              }],
            };
          }
          const result = await adapterFactory.getProviderAdapter('render', project);
          if (!result.success || !result.adapter) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: result.error || 'Failed to create Render adapter' }),
              }],
            };
          }
          const adapter = result.adapter as unknown as {
            listServiceDeployments: (serviceId: string, limit?: number) => Promise<Array<{ id: string }>>;
            getDeploymentLogs: (serviceId: string, deploymentId: string, limit?: number) => Promise<UnifiedLog[]>;
          };
          if (
            typeof adapter.listServiceDeployments !== 'function' ||
            typeof adapter.getDeploymentLogs !== 'function'
          ) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: 'Render build logs are not supported by this adapter version',
                }),
              }],
            };
          }

          let targetDeploymentId = deploymentId;
          if (!targetDeploymentId) {
            const deployments = await adapter.listServiceDeployments(serviceId, 1);
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

          const events = await adapter.getDeploymentLogs(serviceId, targetDeploymentId, 200);
          const buildLogs = events.map((e) => `[${e.timestamp}] ${e.severity || 'info'} ${e.message}`).join('\n');

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                project: projectName,
                environment: environmentName,
                provider,
                service: serviceName,
                deploymentId: targetDeploymentId,
                buildLogs: buildLogs || 'No build logs available',
              }),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `logs_build currently supports Railway, Vercel, and Render only (provider: ${provider}).`,
              provider,
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
      const project = resolveProject({ projectName });
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
        provider?: string;
        services?: Record<string, { serviceId: string }>;
      };
      const provider = detectProviderName(project.defaultPlatform, bindings.provider);

      if (!bindings.services || Object.keys(bindings.services).length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No bound services found in environment' }),
          }],
        };
      }

      try {
        const serviceErrors: Array<{
          service: string;
          deploymentStatus: string;
          errorCount: number;
          recentErrors: Array<{ timestamp: string; message: string }>;
        }> = [];

        for (const serviceName of Object.keys(bindings.services)) {
          const { deploymentStatus, logs } = await fetchProviderLogs(provider, environment, serviceName, 200);
          const errors = logs.filter(isErrorLike);

          serviceErrors.push({
            service: serviceName,
            deploymentStatus: deploymentStatus ?? 'unknown',
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
              provider,
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
