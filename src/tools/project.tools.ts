import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { createProjectSchema } from '../schemas/project.schema.js';
import { getProjectIntent, syncProjectIntent } from '../domain/services/intent.service.js';
import {
  connectRailwayForImport,
  listRailwayImportCandidates,
  inspectRailwayProject,
  importRailwayProject,
} from '../domain/services/import.service.js';
import { resolveProject, detectGitRemoteUrl } from './resolve-project.js';

const projectRepo = new ProjectRepository();
const auditRepo = new AuditRepository();

export function mergeProjectPolicies(
  currentPolicies: Record<string, unknown> | undefined,
  updates: {
    protectedEnvironments?: string[];
    desiredState?: Record<string, unknown>;
  }
): Record<string, unknown> {
  const nextPolicies = { ...(currentPolicies ?? {}) } as Record<string, unknown>;
  if (updates.protectedEnvironments !== undefined) {
    nextPolicies.protectedEnvironments = updates.protectedEnvironments;
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
    'Set project policy controls (protected environments, desired state).',
    {
      projectId: z.string().uuid().optional().describe('Project ID'),
      projectName: z.string().optional().describe('Project name'),
      protectedEnvironments: z.array(z.string()).optional().describe('Environments requiring confirm flags (e.g., production)'),
      desiredState: z.record(z.unknown()).optional().describe('Optional desired-state object for infra_apply'),
    },
    async ({ projectId, projectName, protectedEnvironments, desiredState }) => {
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
      // Get Railway connection + connect
      const adapter = await connectRailwayForImport();
      if (!adapter) {
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

      try {
        // No name provided - list all projects
        if (!name) {
          const projectSummaries = await listRailwayImportCandidates(adapter);

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  message: `Found ${projectSummaries.length} Railway projects. Use project_import name="<existing-railway-project>" to adopt one into Hypervibe.`,
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

        // Get full project details + raw data for the agent to interpret
        const inspection = await inspectRailwayProject(adapter, railwayProject.id);
        if (!inspection) {
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

        const { details, environments, services, components, envVarNames, autoDetected, needsMapping } = inspection;

        // No mappings provided - return data for Claude to interpret
        if (!environmentMappings) {
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
        const result = await importRailwayProject(details, environmentMappings, services, components);
        if (result.status === 'already_exists') {
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

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                imported: true,
                message: `Imported "${details.name}" from Railway`,
                project: result.project,
                environments: result.environments,
                services: result.services,
                components: result.components,
                intent: result.intent,
              }),
            },
          ],
        };
      } finally {
        await adapter.disconnect();
      }
    }
  );
}
