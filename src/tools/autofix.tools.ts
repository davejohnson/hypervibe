import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StateManager, type Watch, type TrackedError } from '../agent/state.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { resolveProject } from './resolve-project.js';

const stateManager = new StateManager();
const envRepo = new EnvironmentRepository();
const projectRepo = new ProjectRepository();

export function registerAutoFixTools(server: McpServer): void {
  /**
   * Add a watch for a service in an environment.
   */
  server.tool(
    'autofix_watch_add',
    'Enable auto-fix watching for a service. The agent will monitor logs and create PRs for errors.',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment name (e.g., production, staging)'),
      serviceName: z.string().describe('Service name to watch'),
    },
    async ({ projectName, environmentName, serviceName }) => {
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

      // Verify service exists in bindings
      const bindings = environment.platformBindings as {
        services?: Record<string, { serviceId: string }>;
      };

      if (!bindings.services?.[serviceName]) {
        const availableServices = Object.keys(bindings.services || {});
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Service ${serviceName} not found in ${environmentName}`,
              availableServices,
            }),
          }],
        };
      }

      // Add the watch
      const watch: Watch = {
        projectId: project.id,
        environmentId: environment.id,
        serviceName,
        enabled: true,
      };

      stateManager.addWatch(watch);
      stateManager.save();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Now watching ${serviceName} in ${environmentName} for errors`,
            watch,
          }),
        }],
      };
    }
  );

  /**
   * Remove a watch.
   */
  server.tool(
    'autofix_watch_remove',
    'Stop watching a service for auto-fix',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment name'),
      serviceName: z.string().describe('Service name'),
    },
    async ({ projectName, environmentName, serviceName }) => {
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

      const removed = stateManager.removeWatch(project.id, environment.id, serviceName);
      stateManager.save();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            removed,
            message: removed
              ? `Stopped watching ${serviceName} in ${environmentName}`
              : 'Watch not found',
          }),
        }],
      };
    }
  );

  /**
   * List all watches.
   */
  server.tool(
    'autofix_watch_list',
    'List all auto-fix watches',
    {},
    async () => {
      const watches = stateManager.getWatches();

      // Enrich with project/environment names
      const enrichedWatches = watches.map((watch) => {
        const project = projectRepo.findById(watch.projectId);
        const env = envRepo.findById(watch.environmentId);
        return {
          ...watch,
          projectName: project?.name,
          environmentName: env?.name,
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            count: watches.length,
            enabledCount: watches.filter((w) => w.enabled).length,
            watches: enrichedWatches,
          }),
        }],
      };
    }
  );

  /**
   * Get auto-fix agent status.
   */
  server.tool(
    'autofix_status',
    'Check the status of the auto-fix agent',
    {},
    async () => {
      const watches = stateManager.getWatches();
      const errors = stateManager.getAllErrors();
      const lastPoll = stateManager.getLastPollAt();

      const errorsByStatus = {
        new: 0,
        analyzing: 0,
        fixing: 0,
        pr_created: 0,
        ignored: 0,
        resolved: 0,
      };

      for (const error of Object.values(errors)) {
        errorsByStatus[error.status]++;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            status: {
              totalWatches: watches.length,
              enabledWatches: watches.filter((w) => w.enabled).length,
              lastPollAt: lastPoll?.toISOString() ?? null,
              totalErrors: Object.keys(errors).length,
              errorsByStatus,
            },
          }),
        }],
      };
    }
  );

  /**
   * List detected errors.
   */
  server.tool(
    'autofix_errors_list',
    'List errors detected by the auto-fix agent',
    {
      status: z.enum(['all', 'new', 'pr_created', 'ignored']).optional().describe('Filter by status'),
      limit: z.number().optional().describe('Max errors to return (default 20)'),
    },
    async ({ status, limit = 20 }) => {
      const allErrors = stateManager.getAllErrors();

      let filtered: Array<[string, TrackedError]> = Object.entries(allErrors);

      if (status && status !== 'all') {
        filtered = filtered.filter(([_, err]) => err.status === status);
      }

      // Sort by lastSeen descending
      filtered.sort((a, b) =>
        new Date(b[1].lastSeen).getTime() - new Date(a[1].lastSeen).getTime()
      );

      const limited = filtered.slice(0, limit);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            totalCount: filtered.length,
            returnedCount: limited.length,
            errors: limited.map(([fingerprint, error]) => ({
              fingerprint,
              ...error,
            })),
          }),
        }],
      };
    }
  );

  /**
   * Ignore an error fingerprint.
   */
  server.tool(
    'autofix_error_ignore',
    'Ignore an error fingerprint (stop auto-fixing it)',
    {
      fingerprint: z.string().describe('Error fingerprint to ignore'),
    },
    async ({ fingerprint }) => {
      const error = stateManager.getError(fingerprint);
      if (!error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Error not found: ${fingerprint}` }),
          }],
        };
      }

      stateManager.updateErrorStatus(fingerprint, 'ignored');
      stateManager.save();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Error ${fingerprint} marked as ignored`,
            error: {
              fingerprint,
              ...stateManager.getError(fingerprint),
            },
          }),
        }],
      };
    }
  );
}
