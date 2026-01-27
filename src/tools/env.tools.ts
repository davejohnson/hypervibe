import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import { ComposeGenerator } from '../adapters/providers/local/compose.generator.js';
import { integrationRegistry } from '../domain/registry/integration.registry.js';
import type { RailwayCredentials } from '../adapters/providers/railway/railway.adapter.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const connectionRepo = new ConnectionRepository();

export function registerEnvTools(server: McpServer): void {
  // ============================================
  // Generic Env Var Management
  // ============================================

  server.tool(
    'vars_set',
    'Set environment variable(s) across environments. Use scope to target specific environments.',
    {
      projectName: z.string().describe('Project name'),
      vars: z.record(z.string()).describe('Variables to set (key-value pairs)'),
      scope: z
        .enum(['all', 'local', 'deployed', 'staging', 'production'])
        .optional()
        .describe('Which environments to set (default: all)'),
      serviceName: z.string().optional().describe('Specific service (for deployed envs)'),
    },
    async ({ projectName, vars, scope = 'all', serviceName }) => {
      const project = projectRepo.findByName(projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const results: Array<{ environment: string; success: boolean; error?: string }> = [];

      // Get all environments for this project
      const environments = envRepo.findByProjectId(project.id);

      // Determine which environments to target based on scope
      const targetEnvs = environments.filter((env) => {
        if (scope === 'all') return true;
        if (scope === 'local') return env.name === 'local';
        if (scope === 'deployed') return env.name !== 'local';
        if (scope === 'staging') return env.name.includes('staging') || env.name === 'staging';
        if (scope === 'production') return env.name.includes('prod') || env.name === 'production';
        return false;
      });

      // Get Railway connection for deployed environments
      const railwayConnection = connectionRepo.findByProvider('railway');
      let railwayAdapter: RailwayAdapter | null = null;

      if (railwayConnection && targetEnvs.some((e) => e.name !== 'local')) {
        const secretStore = getSecretStore();
        const credentials = secretStore.decryptObject<RailwayCredentials>(
          railwayConnection.credentialsEncrypted
        );
        railwayAdapter = new RailwayAdapter();
        await railwayAdapter.connect(credentials);
      }

      for (const env of targetEnvs) {
        try {
          if (env.name === 'local') {
            // For local, just report what should be added to .env.local
            // (User can regenerate with local_bootstrap)
            results.push({
              environment: env.name,
              success: true,
              error: 'Local vars noted. Run local_bootstrap to regenerate .env.local',
            });
          } else if (railwayAdapter) {
            // For deployed environments, sync to Railway
            const bindings = env.platformBindings as {
              railwayProjectId?: string;
              services?: Record<string, { serviceId: string }>;
            };

            if (!bindings.railwayProjectId) {
              results.push({
                environment: env.name,
                success: false,
                error: 'Environment not deployed to Railway',
              });
              continue;
            }

            // Find service to set vars on
            const services = serviceRepo.findByProjectId(project.id);
            const targetService = serviceName
              ? services.find((s) => s.name === serviceName)
              : services[0]; // Default to first service

            if (!targetService) {
              results.push({
                environment: env.name,
                success: false,
                error: serviceName ? `Service not found: ${serviceName}` : 'No services found',
              });
              continue;
            }

            const result = await railwayAdapter.setEnvVars(env, targetService, vars);
            results.push({
              environment: env.name,
              success: result.success,
              error: result.error,
            });
          } else {
            results.push({
              environment: env.name,
              success: false,
              error: 'No Railway connection for deployed environment',
            });
          }
        } catch (error) {
          results.push({
            environment: env.name,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const successCount = results.filter((r) => r.success).length;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: successCount > 0,
            message: `Set ${Object.keys(vars).length} variable(s) in ${successCount}/${results.length} environment(s)`,
            variables: Object.keys(vars),
            results,
          }),
        }],
      };
    }
  );

  server.tool(
    'vars_get',
    'Get environment variables from a specific environment',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment name'),
      serviceName: z.string().optional().describe('Service name (for deployed envs)'),
    },
    async ({ projectName, environmentName, serviceName }) => {
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

      if (environmentName === 'local') {
        // For local, generate what the vars would be
        const generator = new ComposeGenerator();
        // Get component types from environment
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              environment: environmentName,
              note: 'Local vars are generated. Use local_bootstrap to create .env.local',
            }),
          }],
        };
      }

      // For deployed environments, fetch from Railway
      const railwayConnection = connectionRepo.findByProvider('railway');
      if (!railwayConnection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No Railway connection' }),
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

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(
        railwayConnection.credentialsEncrypted
      );
      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      // Find service
      const services = serviceRepo.findByProjectId(project.id);
      const targetService = serviceName
        ? services.find((s) => s.name === serviceName)
        : services[0];

      if (!targetService || !bindings.services?.[targetService.name]) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Service not found in Railway' }),
          }],
        };
      }

      try {
        const vars = await adapter.getServiceVariables(
          bindings.railwayProjectId,
          bindings.services[targetService.name].serviceId,
          bindings.railwayEnvironmentId
        );

        // Mask secret values
        const maskedVars: Record<string, string> = {};
        for (const [key, value] of Object.entries(vars)) {
          const isSecret = key.toLowerCase().includes('secret') ||
            key.toLowerCase().includes('password') ||
            key.toLowerCase().includes('token') ||
            key.toLowerCase().includes('key');
          maskedVars[key] = isSecret ? '***' : value;
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              environment: environmentName,
              service: targetService.name,
              variables: maskedVars,
              count: Object.keys(vars).length,
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

  // ============================================
  // Integration Plugin System
  // ============================================

  server.tool(
    'integration_list_available',
    'List available integration plugins that can be added to your project',
    {
      category: z
        .enum(['ai', 'commerce', 'communication', 'analytics', 'auth', 'storage', 'other'])
        .optional()
        .describe('Filter by category'),
    },
    async ({ category }) => {
      let plugins = integrationRegistry.all();

      if (category) {
        plugins = integrationRegistry.getByCategory(category);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            count: plugins.length,
            integrations: plugins.map((p) => ({
              name: p.name,
              displayName: p.displayName,
              category: p.category,
              description: p.description,
              setupUrl: p.setupUrl,
              hasGuidedSetup: !!p.guidedSetup,
              hasScopes: !!p.scopes && p.scopes.length > 0,
            })),
          }),
        }],
      };
    }
  );

  server.tool(
    'integration_info',
    'Get detailed information about an integration, including required variables and setup instructions',
    {
      integration: z.string().describe('Integration name (e.g., shopify, anthropic)'),
    },
    async ({ integration }) => {
      const plugin = integrationRegistry.get(integration);

      if (!plugin) {
        const available = integrationRegistry.names();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Integration not found: ${integration}`,
              available,
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            integration: {
              name: plugin.name,
              displayName: plugin.displayName,
              category: plugin.category,
              description: plugin.description,
              setupUrl: plugin.setupUrl,
              documentationUrl: plugin.documentationUrl,
              guidedSetup: plugin.guidedSetup,
              variables: plugin.variables.map((v) => ({
                name: v.name,
                envVar: v.envVar,
                publicEnvVar: v.publicEnvVar,
                description: v.description,
                required: v.required,
                secret: v.secret,
                defaultValue: v.defaultValue,
              })),
              scopes: plugin.scopes?.map((s) => ({
                name: s.name,
                description: s.description,
              })),
            },
          }),
        }],
      };
    }
  );

  server.tool(
    'integration_add',
    'Add an integration to your project. Provide the required credentials and they will be set across all environments.',
    {
      projectName: z.string().describe('Project name'),
      integration: z.string().describe('Integration name (e.g., shopify, anthropic)'),
      credentials: z.record(z.string()).describe('Credentials (use variable names from integration_info)'),
      scopes: z.array(z.string()).optional().describe('Scopes/features to enable'),
      scope: z
        .enum(['all', 'deployed', 'staging', 'production'])
        .optional()
        .describe('Which environments to configure (default: deployed)'),
      serviceName: z.string().optional().describe('Specific service to configure'),
    },
    async ({ projectName, integration, credentials, scopes, scope = 'deployed', serviceName }) => {
      const plugin = integrationRegistry.get(integration);
      if (!plugin) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Integration not found: ${integration}`,
              available: integrationRegistry.names(),
            }),
          }],
        };
      }

      const project = projectRepo.findByName(projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      // Build env vars from credentials
      const envVars: Record<string, string> = {};
      const missingRequired: string[] = [];

      for (const variable of plugin.variables) {
        const value = credentials[variable.name];

        if (value) {
          // Set the main env var
          envVars[variable.envVar] = value;

          // Also set the public version if it exists
          if (variable.publicEnvVar) {
            envVars[variable.publicEnvVar] = value;
          }
        } else if (variable.defaultValue) {
          envVars[variable.envVar] = variable.defaultValue;
          if (variable.publicEnvVar) {
            envVars[variable.publicEnvVar] = variable.defaultValue;
          }
        } else if (variable.required) {
          missingRequired.push(variable.name);
        }
      }

      if (missingRequired.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Missing required credentials',
              missing: missingRequired,
              hint: `Use integration_info integration=${integration} to see what's needed`,
            }),
          }],
        };
      }

      // Get environments
      const environments = envRepo.findByProjectId(project.id);
      const targetEnvs = environments.filter((env) => {
        if (scope === 'all') return true;
        if (scope === 'deployed') return env.name !== 'local';
        if (scope === 'staging') return env.name.includes('staging') || env.name === 'staging';
        if (scope === 'production') return env.name.includes('prod') || env.name === 'production';
        return false;
      });

      if (targetEnvs.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No target environments found. Create environments first or adjust scope.',
            }),
          }],
        };
      }

      // Get Railway connection
      const railwayConnection = connectionRepo.findByProvider('railway');
      if (!railwayConnection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No Railway connection. Use connection_create first.',
            }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const railwayCredentials = secretStore.decryptObject<RailwayCredentials>(
        railwayConnection.credentialsEncrypted
      );
      const railwayAdapter = new RailwayAdapter();
      await railwayAdapter.connect(railwayCredentials);

      const results: Array<{ environment: string; success: boolean; error?: string }> = [];

      for (const env of targetEnvs) {
        try {
          const bindings = env.platformBindings as {
            railwayProjectId?: string;
            services?: Record<string, { serviceId: string }>;
          };

          if (!bindings.railwayProjectId) {
            results.push({
              environment: env.name,
              success: false,
              error: 'Environment not deployed to Railway',
            });
            continue;
          }

          const services = serviceRepo.findByProjectId(project.id);
          const targetService = serviceName
            ? services.find((s) => s.name === serviceName)
            : services[0];

          if (!targetService) {
            results.push({
              environment: env.name,
              success: false,
              error: 'No service found',
            });
            continue;
          }

          const result = await railwayAdapter.setEnvVars(env, targetService, envVars);
          results.push({
            environment: env.name,
            success: result.success,
            error: result.error,
          });
        } catch (error) {
          results.push({
            environment: env.name,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const successCount = results.filter((r) => r.success).length;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: successCount > 0,
            message: `${plugin.displayName} configured in ${successCount}/${results.length} environment(s)`,
            integration: plugin.displayName,
            variablesSet: Object.keys(envVars),
            results,
            nextSteps: plugin.documentationUrl
              ? [`Check the documentation: ${plugin.documentationUrl}`]
              : undefined,
          }),
        }],
      };
    }
  );

  server.tool(
    'integration_scopes',
    'Get recommended API scopes for an integration based on desired features',
    {
      integration: z.string().describe('Integration name'),
      features: z.array(z.string()).describe('Features you want (e.g., "read products", "manage orders")'),
    },
    async ({ integration, features }) => {
      const plugin = integrationRegistry.get(integration);
      if (!plugin) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Integration not found: ${integration}`,
            }),
          }],
        };
      }

      if (!plugin.scopes) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `${plugin.displayName} doesn't have configurable scopes`,
            }),
          }],
        };
      }

      // Match features to scopes (let Claude do the fuzzy matching)
      const availableScopes = plugin.scopes.map((s) => ({
        name: s.name,
        description: s.description,
        additionalVarsNeeded: s.additionalVars,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            integration: plugin.displayName,
            requestedFeatures: features,
            availableScopes,
            hint: 'Select the scopes that match your features. Pass them to integration_add with the scopes parameter.',
          }),
        }],
      };
    }
  );
}
