import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import type { RailwayProjectDetails } from '../adapters/providers/railway/railway.adapter.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { createProjectSchema } from '../schemas/project.schema.js';
import type { RailwayCredentials } from '../domain/entities/connection.entity.js';
import type { ComponentType } from '../domain/entities/component.entity.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

export function registerProjectTools(server: McpServer): void {
  server.tool(
    'project_create',
    'Create a new infrastructure project',
    {
      name: z.string().min(1).max(100).describe('Project name'),
      defaultPlatform: z.string().optional().describe('Default deployment platform (default: railway)'),
    },
    async ({ name, defaultPlatform }) => {
      // Check if project already exists
      const existing = projectRepo.findByName(name);
      if (existing) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Project "${name}" already exists`,
                project: existing,
              }),
            },
          ],
        };
      }

      // Validate input
      const input = createProjectSchema.parse({ name, defaultPlatform });

      // Create project
      const project = projectRepo.create(input);

      // Audit log
      auditRepo.create({
        action: 'project.created',
        resourceType: 'project',
        resourceId: project.id,
        details: { name: project.name },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Project "${name}" created successfully`,
              project,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'project_list',
    'List all infrastructure projects',
    {},
    async () => {
      const projects = projectRepo.findAll();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: projects.length,
              projects,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'project_get',
    'Get details of a specific project',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
    },
    async ({ projectId, projectName }) => {
      if (!projectId && !projectName) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Either projectId or projectName must be provided',
              }),
            },
          ],
        };
      }

      const project = projectId
        ? projectRepo.findById(projectId)
        : projectRepo.findByName(projectName!);

      if (!project) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Project not found`,
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
              project,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'project_delete',
    'Delete an infrastructure project',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
    },
    async ({ projectId, projectName }) => {
      if (!projectId && !projectName) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Either projectId or projectName must be provided',
              }),
            },
          ],
        };
      }

      const project = projectId
        ? projectRepo.findById(projectId)
        : projectRepo.findByName(projectName!);

      if (!project) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Project not found',
              }),
            },
          ],
        };
      }

      projectRepo.delete(project.id);

      auditRepo.create({
        action: 'project.deleted',
        resourceType: 'project',
        resourceId: project.id,
        details: { name: project.name },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Project "${project.name}" deleted successfully`,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'project_import',
    'Import an existing Railway project into Infraprint',
    {
      name: z.string().optional().describe('Railway project name to import. If omitted, lists available projects.'),
      environmentMappings: z
        .record(z.string(), z.string())
        .optional()
        .describe('Map Railway environment names to Infraprint types (e.g., {"prod-us-east": "production", "blue": "staging"})'),
    },
    async ({ name, environmentMappings }) => {
      // Get Railway connection
      const connection = connectionRepo.findByProvider('railway');
      if (!connection) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'No Railway connection configured. Use connection_add first.',
              }),
            },
          ],
        };
      }

      // Connect to Railway
      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      try {
        // No name provided - list all projects
        if (!name) {
          const projects = await adapter.listProjects();

          // Get summary info for each project
          const projectSummaries = await Promise.all(
            projects.map(async (p) => {
              const details = await adapter.getProjectDetails(p.id);
              return {
                name: p.name,
                railwayId: p.id,
                environmentCount: details?.environments.edges.length ?? 0,
                serviceCount: details?.services.edges.length ?? 0,
              };
            })
          );

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  message: `Found ${projects.length} Railway projects. Use project_import with a name to import one.`,
                  projects: projectSummaries,
                }),
              },
            ],
          };
        }

        // Find the project by name
        const railwayProject = await adapter.findProjectByName(name);
        if (!railwayProject) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Railway project "${name}" not found`,
                }),
              },
            ],
          };
        }

        // Get full project details
        const details = await adapter.getProjectDetails(railwayProject.id);
        if (!details) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Could not fetch details for project "${name}"`,
                }),
              },
            ],
          };
        }

        // Extract environments, services, plugins
        const environments = details.environments.edges.map((e) => ({
          name: e.node.name,
          railwayId: e.node.id,
        }));

        // Extract services with deployment settings
        const services = details.services.edges.map((e) => {
          const instances = e.node.serviceInstances?.edges ?? [];
          const instancesByEnv: Record<string, {
            domains: string[];
            customDomains: string[];
            startCommand?: string;
            healthcheckPath?: string;
            numReplicas?: number;
            sleepApplication?: boolean;
          }> = {};

          for (const inst of instances) {
            const envId = inst.node.environmentId;
            instancesByEnv[envId] = {
              domains: inst.node.domains?.serviceDomains?.map((d) => d.domain) ?? [],
              customDomains: inst.node.domains?.customDomains?.map((d) => d.domain) ?? [],
              startCommand: inst.node.startCommand,
              healthcheckPath: inst.node.healthcheckPath,
              numReplicas: inst.node.numReplicas,
              sleepApplication: inst.node.sleepApplication,
            };
          }

          return {
            name: e.node.name,
            railwayId: e.node.id,
            repo: e.node.repoTriggers.edges[0]?.node.repository ?? null,
            branch: e.node.repoTriggers.edges[0]?.node.branch ?? null,
            hasGitHubDeploy: e.node.repoTriggers.edges.length > 0,
            instancesByEnv,
          };
        });

        const components = details.plugins.edges.map((e) => ({
          type: mapPluginToComponentType(e.node.name),
          railwayId: e.node.id,
        }));

        // Fetch environment variable names (raw data for Claude to interpret)
        let envVarNames: string[] = [];

        // Fetch vars from first environment's first service as a sample
        if (environments.length > 0 && services.length > 0) {
          const sampleVars = await adapter.getServiceVariables(
            details.id,
            services[0].railwayId,
            environments[0].railwayId
          );
          envVarNames = Object.keys(sampleVars);
        }

        // No mappings provided - return data for Claude to interpret
        if (!environmentMappings) {
          // Auto-detect exact matches
          const autoDetected: Record<string, string> = {};
          const needsMapping: string[] = [];

          for (const env of environments) {
            const normalized = env.name.toLowerCase();
            if (normalized === 'production') {
              autoDetected[env.name] = 'production';
            } else if (normalized === 'staging') {
              autoDetected[env.name] = 'staging';
            } else if (normalized === 'development') {
              autoDetected[env.name] = 'development';
            } else {
              needsMapping.push(env.name);
            }
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  imported: false,
                  project: {
                    name: details.name,
                    railwayId: details.id,
                  },
                  environments,
                  services,
                  components,
                  envVarNames,
                  autoDetected,
                  needsMapping,
                  message:
                    needsMapping.length > 0
                      ? 'Found project. Some environments need classification. Call project_import with environmentMappings to complete import.'
                      : 'Found project. Call project_import with environmentMappings to complete import (can use auto-detected mappings).',
                }),
              },
            ],
          };
        }

        // Mappings provided - perform the import
        return await performImport(details, environmentMappings, services, components);
      } finally {
        await adapter.disconnect();
      }
    }
  );
}

function mapPluginToComponentType(pluginName: string): ComponentType {
  const normalized = pluginName.toLowerCase();
  if (normalized.includes('postgres')) return 'postgres';
  if (normalized.includes('redis')) return 'redis';
  if (normalized.includes('mysql')) return 'mysql';
  if (normalized.includes('mongo')) return 'mongodb';
  return pluginName;
}

async function performImport(
  details: RailwayProjectDetails,
  environmentMappings: Record<string, string>,
  services: Array<{
    name: string;
    railwayId: string;
    repo: string | null;
    branch: string | null;
    hasGitHubDeploy: boolean;
    instancesByEnv: Record<string, {
      domains: string[];
      customDomains: string[];
      startCommand?: string;
      healthcheckPath?: string;
      numReplicas?: number;
      sleepApplication?: boolean;
    }>;
  }>,
  components: Array<{ type: ComponentType; railwayId: string }>
) {
  // Check if project already exists
  const existingProject = projectRepo.findByName(details.name);
  if (existingProject) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: `Project "${details.name}" already exists in Infraprint`,
          }),
        },
      ],
    };
  }

  // Create the project
  const project = projectRepo.create({
    name: details.name,
    defaultPlatform: 'railway',
  });

  // Create environments with Railway bindings
  const createdEnvironments: Array<{ name: string; id: string; railwayId: string }> = [];

  for (const [railwayEnvName, infraType] of Object.entries(environmentMappings)) {
    const railwayEnv = details.environments.edges.find((e) => e.node.name === railwayEnvName);
    if (!railwayEnv) continue;

    const env = envRepo.create({
      projectId: project.id,
      name: infraType,
      platformBindings: {
        railwayProjectId: details.id,
        railwayEnvironmentId: railwayEnv.node.id,
        services: {},
      },
    });

    createdEnvironments.push({
      name: infraType,
      id: env.id,
      railwayId: railwayEnv.node.id,
    });
  }

  // Create services
  const createdServices: Array<{ name: string; id: string; railwayId: string }> = [];

  for (const svc of services) {
    const service = serviceRepo.create({
      projectId: project.id,
      name: svc.name,
      buildConfig: svc.repo
        ? {
            builder: 'nixpacks',
          }
        : {},
      envVarSpec: {},
    });

    createdServices.push({
      name: svc.name,
      id: service.id,
      railwayId: svc.railwayId,
    });

    // Update environment bindings with service info
    for (const env of createdEnvironments) {
      const existingEnv = envRepo.findById(env.id);
      if (existingEnv) {
        const bindings = existingEnv.platformBindings as {
          railwayProjectId?: string;
          railwayEnvironmentId?: string;
          services?: Record<string, { serviceId: string }>;
        };
        bindings.services = bindings.services || {};
        bindings.services[svc.name] = { serviceId: svc.railwayId };
        envRepo.update(env.id, { platformBindings: bindings });
      }
    }
  }

  // Create components for each environment
  const createdComponents: Array<{ type: string; environmentId: string; railwayId: string }> = [];

  for (const comp of components) {
    for (const env of createdEnvironments) {
      const component = componentRepo.create({
        environmentId: env.id,
        type: comp.type,
        externalId: comp.railwayId,
        bindings: {},
      });

      createdComponents.push({
        type: comp.type,
        environmentId: env.id,
        railwayId: comp.railwayId,
      });
    }
  }

  // Audit log
  auditRepo.create({
    action: 'project.imported',
    resourceType: 'project',
    resourceId: project.id,
    details: {
      name: project.name,
      source: 'railway',
      railwayProjectId: details.id,
      environmentCount: createdEnvironments.length,
      serviceCount: createdServices.length,
      componentCount: createdComponents.length,
    },
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          imported: true,
          message: `Imported "${details.name}" from Railway`,
          project: {
            id: project.id,
            name: project.name,
          },
          environments: createdEnvironments,
          services: createdServices,
          components: createdComponents,
        }),
      },
    ],
  };
}
