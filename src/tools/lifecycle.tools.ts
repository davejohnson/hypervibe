import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  connectRailwayForImport,
  listRailwayImportCandidates,
  inspectRailwayProject,
  importRailwayProject,
} from '../domain/services/import.service.js';
import {
  serviceBindingFor,
  removeServiceBinding,
  removeServiceFromDesiredState,
} from '../domain/services/spec.service.js';
import type { ToolContext } from './context.js';
import { projectField, envField, confirmField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler } from './respond.js';

export function registerLifecycleTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_import',
    'Adopt already-deployed provider infrastructure into Hypervibe (currently Railway). Three modes: no name → list importable provider projects; name without environmentMappings → return raw environments/services/components for you to interpret; name + environmentMappings → perform the import. Not for creating new infrastructure (use hv_spec_set + hv_apply).',
    {
      provider: z.enum(['railway']).optional().describe('Source provider to import from (default: railway)'),
      name: z.string().optional().describe('Existing provider project name to adopt. Omit to list projects available to import.'),
      force: z.boolean().optional().describe('Set true to override the safety check when a Hypervibe project with the same name already exists.'),
      environmentMappings: z
        .record(z.string(), z.string())
        .optional()
        .describe('Map provider environment names to Hypervibe environments (e.g., {"prod-us-east": "production", "blue": "staging"})'),
    },
    wrapHandler(async ({ name, force = false, environmentMappings }) => {
      const adapter = await connectRailwayForImport();
      if (!adapter) {
        return toolError('MISSING_CONNECTION', 'No Railway connection configured.', {
          hint: 'Connect Railway with hv_connect provider="railway" first. Recommended: use credentialsRef="env:HYPERVIBE_RAILWAY_TOKEN" for an exported token or credentialsRef="dotenv:/absolute/path/.env#HYPERVIBE_RAILWAY_TOKEN" for an existing .env file; raw credentials={...} is still accepted if intentional.',
          next: ['hv_connect'],
        });
      }

      try {
        // Mode 1: no name — list importable Railway projects.
        if (!name) {
          const projects = await listRailwayImportCandidates(adapter);
          return toolSuccess(
            { projects },
            {
              hint: projects.length > 0
                ? 'Call hv_import name="<railway-project>" to inspect one for adoption.'
                : 'No Railway projects found on this account.',
            }
          );
        }

        const railwayProject = await adapter.findProjectByName(name);
        if (!railwayProject) {
          return toolError('NOT_FOUND', `Railway project "${name}" not found.`, {
            hint: 'hv_import adopts existing infrastructure. For new infrastructure use hv_spec_set, hv_plan, and hv_apply.',
          });
        }

        // Guardrail: import is adoption-only. Block when a Hypervibe project
        // with the same name already exists unless force=true.
        const existing = ctx.repos.projects.findByName(name);
        if (existing && !force) {
          return toolError('VALIDATION', `Hypervibe project "${name}" already exists. hv_import is adoption-only.`, {
            hint: 'Use hv_plan/hv_apply for setup or retries. Re-run hv_import with force=true only to intentionally re-adopt this live Railway project.',
          });
        }

        const inspection = await inspectRailwayProject(adapter, railwayProject.id);
        if (!inspection) {
          return toolError('PROVIDER_ERROR', `Could not fetch details for Railway project "${name}".`);
        }

        const { details, environments, services, components, envVarNames, autoDetected, needsMapping } = inspection;

        // Mode 2: no mappings — return raw data for the agent to interpret.
        if (!environmentMappings) {
          return toolSuccess(
            {
              imported: false,
              project: { name: details.name, railwayId: details.id },
              environments,
              services,
              components,
              envVarNames,
              autoDetected,
              needsMapping,
            },
            {
              hint: needsMapping.length > 0
                ? `Classify these environments (${needsMapping.join(', ')}) and call hv_import again with environmentMappings to complete adoption.`
                : 'Call hv_import again with environmentMappings to complete adoption (the auto-detected mappings are usually correct).',
              next: ['hv_import'],
            }
          );
        }

        // Mode 3: mappings provided — perform the import.
        const result = await importRailwayProject(details, environmentMappings, services, components);
        if (result.status === 'already_exists') {
          return toolError('VALIDATION', `Project "${details.name}" already exists in Hypervibe.`);
        }

        return toolSuccess(
          {
            imported: true,
            project: result.project,
            environments: result.environments,
            services: result.services,
            components: result.components,
            intent: result.intent,
          },
          {
            hint: `Imported "${details.name}" from Railway. Define a spec with hv_spec_set to manage it declaratively.`,
            next: ['hv_status'],
          }
        );
      } finally {
        await adapter.disconnect();
      }
    })
  );

  server.tool(
    'hv_destroy',
    'Delete LOCAL Hypervibe records only: a project (cascade), an environment, or a service (including its platform binding). Never touches provider resources — to destroy live infrastructure, remove it from the spec with hv_spec_set, then run hv_plan and hv_apply. Data-bearing destroys are confirm-gated with confirmDestroy. Without confirm=true this returns CONFIRM_REQUIRED listing exactly what local records would be deleted.',
    {
      project: projectField,
      env: envField,
      scope: z.enum(['project', 'environment', 'service']).describe('What to delete: the whole project record, one environment record, or one service record'),
      name: z.string().optional().describe('Service name (required when scope="service")'),
      confirm: confirmField,
    },
    wrapHandler(async ({ project: projectRef, env, scope, name, confirm }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const providerNote = 'Provider resources were not touched — destroy live infrastructure via hv_spec_set + hv_plan + hv_apply. Data-bearing destroys require confirmDestroy.';

      if (scope === 'project') {
        const environments = ctx.repos.environments.findByProjectId(project.id);
        const services = ctx.repos.services.findByProjectId(project.id);
        const summary = {
          project: { id: project.id, name: project.name },
          environments: environments.map((e) => e.name),
          services: services.map((s) => s.name),
        };

        if (!confirm) {
          return toolError('CONFIRM_REQUIRED', `This would delete the local project "${project.name}" with ${environments.length} environment(s) and ${services.length} service(s). No provider resources are affected.`, {
            details: summary,
            hint: 'Re-run hv_destroy with confirm=true to delete these local records.',
          });
        }

        ctx.repos.projects.delete(project.id);
        ctx.repos.audit.create({
          action: 'project.deleted',
          resourceType: 'project',
          resourceId: project.id,
          details: { name: project.name },
        });

        return toolSuccess({ deleted: { scope: 'project', ...summary } }, { hint: providerNote });
      }

      if (scope === 'environment') {
        const environment = ctx.resolveEnvironmentOrThrow(project, env);

        if (!confirm) {
          return toolError('CONFIRM_REQUIRED', `This would delete the local environment "${environment.name}" of project "${project.name}" (including its platform bindings). No provider resources are affected.`, {
            details: { environment: { id: environment.id, name: environment.name } },
            hint: 'Re-run hv_destroy with confirm=true to delete this local record.',
          });
        }

        ctx.repos.environments.delete(environment.id);
        ctx.repos.audit.create({
          action: 'environment.deleted',
          resourceType: 'environment',
          resourceId: environment.id,
          details: { project: project.name, name: environment.name },
        });

        return toolSuccess(
          { deleted: { scope: 'environment', project: project.name, environment: environment.name } },
          { hint: providerNote }
        );
      }

      // scope === 'service'
      if (!name?.trim()) {
        return toolError('VALIDATION', 'name is required when scope="service".', {
          hint: 'Pass the service name to delete, e.g. name="web".',
        });
      }

      const service = ctx.repos.services.findByProjectAndName(project.id, name.trim());
      if (!service) {
        const available = ctx.repos.services.findByProjectId(project.id).map((s) => s.name);
        return toolError('NOT_FOUND', `Service "${name}" not found in project "${project.name}".`, {
          details: { available },
        });
      }

      const boundEnvironments = ctx.repos.environments
        .findByProjectId(project.id)
        .filter((environment) => serviceBindingFor(environment, service.name));

      if (!confirm) {
        return toolError('CONFIRM_REQUIRED', `This would delete the local service "${service.name}" from project "${project.name}" and remove its binding from ${boundEnvironments.length} environment(s). No provider resources are affected.`, {
          details: {
            service: { id: service.id, name: service.name },
            bindingsRemovedFrom: boundEnvironments.map((e) => e.name),
          },
          hint: 'Re-run hv_destroy with confirm=true to delete these local records.',
        });
      }

      for (const environment of boundEnvironments) {
        removeServiceBinding(environment.id, environment, service.name);
      }
      ctx.repos.services.delete(service.id);

      // Mirror legacy service_delete: drop the service from any legacy
      // desired-state policy so old apply flows don't recreate it.
      const desiredState = project.policies?.desiredState && typeof project.policies.desiredState === 'object' && !Array.isArray(project.policies.desiredState)
        ? project.policies.desiredState as Record<string, unknown>
        : undefined;
      const nextDesiredState = removeServiceFromDesiredState(desiredState, service.name);
      if (nextDesiredState) {
        ctx.repos.projects.update(project.id, {
          policies: { ...(project.policies ?? {}), desiredState: nextDesiredState },
        });
      }

      ctx.repos.audit.create({
        action: 'service.deleted',
        resourceType: 'service',
        resourceId: service.id,
        details: { project: project.name, name: service.name },
      });

      return toolSuccess(
        {
          deleted: {
            scope: 'service',
            project: project.name,
            service: service.name,
            bindingsRemovedFrom: boundEnvironments.map((e) => e.name),
          },
        },
        { hint: `${providerNote} If the spec still declares "${service.name}", remove it with hv_spec_set too.` }
      );
    })
  );
}
