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
import { getProjectIntent, syncProjectIntent } from '../domain/services/intent.service.js';
import { resolveProject, detectGitRemoteUrl } from './resolve-project.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

export function mergeProjectPolicies(
  currentPolicies: Record<string, unknown> | undefined,
  updates: {
    protectedEnvironments?: string[];
    requireApprovalForDestructive?: boolean;
    requireApprovalForProtectedEnvironments?: boolean;
    desiredState?: Record<string, unknown>;
  }
): Record<string, unknown> {
  const nextPolicies = { ...(currentPolicies ?? {}) } as Record<string, unknown>;
  if (updates.protectedEnvironments !== undefined) {
    nextPolicies.protectedEnvironments = updates.protectedEnvironments;
  }
  if (updates.requireApprovalForDestructive !== undefined) {
    nextPolicies.requireApprovalForDestructive = updates.requireApprovalForDestructive;
  }
  if (updates.requireApprovalForProtectedEnvironments !== undefined) {
    nextPolicies.requireApprovalForProtectedEnvironments = updates.requireApprovalForProtectedEnvironments;
  }
  if (updates.desiredState !== undefined) {
    nextPolicies.desiredState = updates.desiredState;
  }
  return nextPolicies;
}

export function registerProjectTools(server: McpServer): void {
  server.tool(
    'project_create',
    'Create a new Hypervibe project record for new infrastructure provisioning (use infra_apply to create resources on providers).',
    {
      name: z.string().min(1).max(100).describe('Project name'),
      defaultPlatform: z.string().optional().describe('Greenfield deployment platform hint (default: cloudrun)'),
      gitRemoteUrl: z.string().optional().describe('Git remote URL to scope this project to (auto-detected from cwd if not provided)'),
    },
    async ({ name, defaultPlatform, gitRemoteUrl }) => {
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

      // Auto-detect git remote if not provided
      const resolvedGitRemoteUrl = gitRemoteUrl ?? detectGitRemoteUrl() ?? undefined;

      // Validate input
      const input = createProjectSchema.parse({ name, defaultPlatform, gitRemoteUrl: resolvedGitRemoteUrl });

      // Create project
      const project = projectRepo.create(input);

      // Audit log
      auditRepo.create({
        action: 'project.created',
        resourceType: 'project',
        resourceId: project.id,
        details: { name: project.name },
      });
      const intent = syncProjectIntent(project.id);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Project "${name}" created successfully`,
              project,
              intent,
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
      const project = resolveProject({ projectId, projectName });

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
              intent: getProjectIntent(project.id),
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'project_intent_get',
    'Get intent overview (hosting + integrations) derived from current project data.',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      refresh: z.boolean().optional().describe('Regenerate intent before returning (default: true)'),
    },
    async ({ projectId, projectName, refresh = true }) => {
      const project = resolveProject({ projectId, projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Project not found' }),
          }],
        };
      }

      const intent = getProjectIntent(project.id, refresh);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: { id: project.id, name: project.name },
            intent,
          }),
        }],
      };
    }
  );

  server.tool(
    'project_policy_get',
    'Get project policy settings',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
    },
    async ({ projectId, projectName }) => {
      const project = resolveProject({ projectId, projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Project not found' }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: { id: project.id, name: project.name },
            policies: project.policies ?? {},
          }),
        }],
      };
    }
  );

  server.tool(
    'project_policy_set',
    'Set project policy controls (protected environments, approval requirements, desired state).',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      protectedEnvironments: z.array(z.string()).optional().describe('Environments requiring confirm flags (e.g., production)'),
      requireApprovalForDestructive: z.boolean().optional().describe('Require explicit confirm for destructive actions'),
      requireApprovalForProtectedEnvironments: z.boolean().optional().describe('Require approval IDs for deploy/rollback/apply in protected environments (default: true)'),
      desiredState: z.record(z.unknown()).optional().describe('Optional desired-state object for infra_apply'),
    },
    async ({ projectId, projectName, protectedEnvironments, requireApprovalForDestructive, requireApprovalForProtectedEnvironments, desiredState }) => {
      const project = resolveProject({ projectId, projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Project not found' }),
          }],
        };
      }

      const nextPolicies = mergeProjectPolicies(project.policies ?? {}, {
        protectedEnvironments,
        requireApprovalForDestructive,
        requireApprovalForProtectedEnvironments,
        desiredState,
      });

      const updated = projectRepo.update(project.id, { policies: nextPolicies });
      const intent = syncProjectIntent(project.id);
      auditRepo.create({
        action: 'project.policies_updated',
        resourceType: 'project',
        resourceId: project.id,
        details: {
          protectedEnvironments,
          requireApprovalForDestructive,
          requireApprovalForProtectedEnvironments,
          desiredStateSet: desiredState !== undefined,
        },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: { id: updated?.id ?? project.id, name: updated?.name ?? project.name },
            policies: updated?.policies ?? nextPolicies,
            intent,
          }),
        }],
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
      const project = resolveProject({ projectId, projectName });

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
    'Adopt an already-deployed Railway project into Hypervibe state (discovery/import). Not for creating new infrastructure or retrying failed applies.',
    {
      name: z.string().optional().describe('Existing Railway project name to adopt. If omitted, lists Railway projects available to import.'),
      force: z.boolean().optional().describe('Set true to override safety checks when a Hypervibe project with the same name already exists.'),
      environmentMappings: z
        .record(z.string(), z.string())
        .optional()
        .describe('Map Railway environment names to Hypervibe types (e.g., {"prod-us-east": "production", "blue": "staging"})'),
    },
    async ({ name, force = false, environmentMappings }) => {
      // Get Railway connection
      const connection = connectionRepo.findByProvider('railway');
      if (!connection) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                  error: 'No Railway connection configured. Use connection_create provider="railway" first.',
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
                  message: `Found ${projects.length} Railway projects. Use project_import name="<existing-railway-project>" to adopt one into Hypervibe.`,
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
                  error: `Railway project "${name}" not found. For new infrastructure, use project_create then infra_apply (not project_import).`,
                }),
              },
            ],
          };
        }

        // Guardrail: import is for adoption-only. If a Hypervibe project already exists,
        // default to blocking import to avoid replacing/re-mapping active deploy state.
        const existingHypervibe = projectRepo.findByName(name);
        if (existingHypervibe && !force) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Hypervibe project "${name}" already exists. project_import is adoption-only and should not be used for retries/remediation.`,
                  next: 'Use infra_apply for setup/retry, or rerun project_import with force=true only if you intentionally want to re-adopt this live Railway project.',
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
                      ? 'Found existing Railway project. Some environments need classification. Call project_import with environmentMappings to complete adoption.'
                      : 'Found existing Railway project. Call project_import with environmentMappings to complete adoption (you can use auto-detected mappings).',
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
            error: `Project "${details.name}" already exists in Hypervibe`,
          }),
        },
      ],
    };
  }

  // Extract git remote URL from service repo triggers
  const repoUrl = services.find((s) => s.repo)?.repo ?? undefined;
  const gitRemoteUrl = repoUrl
    ? `https://github.com/${repoUrl}`
    : detectGitRemoteUrl() ?? undefined;

  // Create the project
  const project = projectRepo.create({
    name: details.name,
    defaultPlatform: 'railway',
    gitRemoteUrl,
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
        provider: 'railway',
        projectId: details.id,
        environmentId: railwayEnv.node.id,
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
    const firstInstance = Object.values(svc.instancesByEnv)[0];
    const service = serviceRepo.create({
      projectId: project.id,
      name: svc.name,
      buildConfig: {
        ...(svc.repo ? { builder: 'nixpacks' as const } : {}),
        ...(firstInstance?.startCommand ? { startCommand: firstInstance.startCommand } : {}),
        ...(firstInstance?.healthcheckPath ? { healthCheckPath: firstInstance.healthcheckPath } : {}),
      },
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
          provider?: string;
          projectId?: string;
          environmentId?: string;
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
      providerProjectId: details.id,
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
          intent: syncProjectIntent(project.id),
        }),
      },
    ],
  };
}
