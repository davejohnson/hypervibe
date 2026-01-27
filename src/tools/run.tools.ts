import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const runRepo = new RunRepository();
const auditRepo = new AuditRepository();

function resolveProject(projectId?: string, projectName?: string) {
  if (projectId) return projectRepo.findById(projectId);
  if (projectName) return projectRepo.findByName(projectName);
  return null;
}

export function registerRunTools(server: McpServer): void {
  server.tool(
    'run_list',
    'List recent deployment runs',
    {
      projectId: z.string().uuid().optional().describe('Filter by project ID'),
      projectName: z.string().optional().describe('Filter by project name'),
      environmentName: z.string().optional().describe('Filter by environment name'),
      limit: z.number().optional().describe('Maximum number of runs to return (default: 20)'),
    },
    async ({ projectId, projectName, environmentName, limit }) => {
      const maxLimit = limit ?? 20;
      let runs;

      if (projectId || projectName) {
        const project = resolveProject(projectId, projectName);
        if (!project) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: 'Project not found.',
                }),
              },
            ],
          };
        }

        if (environmentName) {
          const environment = envRepo.findByProjectAndName(project.id, environmentName);
          if (!environment) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: false,
                    error: `Environment "${environmentName}" not found in project.`,
                  }),
                },
              ],
            };
          }
          runs = runRepo.findByEnvironmentId(environment.id, maxLimit);
        } else {
          runs = runRepo.findByProjectId(project.id, maxLimit);
        }
      } else {
        runs = runRepo.findRecent(maxLimit);
      }

      // Enrich runs with project/environment names
      const enrichedRuns = runs.map((run) => {
        const project = projectRepo.findById(run.projectId);
        const environment = envRepo.findById(run.environmentId);
        return {
          id: run.id,
          type: run.type,
          status: run.status,
          project: project?.name,
          environment: environment?.name,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          error: run.error,
        };
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: enrichedRuns.length,
              runs: enrichedRuns,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'run_get',
    'Get detailed information about a specific run',
    {
      runId: z.string().uuid().describe('Run ID'),
    },
    async ({ runId }) => {
      const run = runRepo.findById(runId);

      if (!run) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Run not found: ${runId}`,
              }),
            },
          ],
        };
      }

      const project = projectRepo.findById(run.projectId);
      const environment = envRepo.findById(run.environmentId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              run: {
                id: run.id,
                type: run.type,
                status: run.status,
                project: { id: project?.id, name: project?.name },
                environment: { id: environment?.id, name: environment?.name },
                plan: run.plan,
                receipts: run.receipts,
                error: run.error,
                startedAt: run.startedAt,
                completedAt: run.completedAt,
                createdAt: run.createdAt,
              },
            }),
          },
        ],
      };
    }
  );

  server.tool(
    'audit_list',
    'List recent audit events',
    {
      resourceType: z.string().optional().describe('Filter by resource type (project, environment, run, etc.)'),
      resourceId: z.string().optional().describe('Filter by resource ID'),
      action: z.string().optional().describe('Filter by action (e.g., deploy.started)'),
      limit: z.number().optional().describe('Maximum number of events to return (default: 50)'),
    },
    async ({ resourceType, resourceId, action, limit }) => {
      const maxLimit = limit ?? 50;
      let events;

      if (resourceType && resourceId) {
        events = auditRepo.findByResource(resourceType, resourceId, maxLimit);
      } else if (action) {
        events = auditRepo.findByAction(action, maxLimit);
      } else {
        events = auditRepo.findRecent(maxLimit);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: events.length,
              events: events.map((e) => ({
                id: e.id,
                timestamp: e.timestamp,
                actor: e.actor,
                action: e.action,
                resourceType: e.resourceType,
                resourceId: e.resourceId,
                details: e.details,
              })),
            }),
          },
        ],
      };
    }
  );
}
