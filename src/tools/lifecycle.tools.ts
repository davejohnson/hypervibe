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
import { connectionSetupDetails, formatConnectionGuidance } from '../domain/services/connection-guidance.js';
import { parseQueueBindings } from '../domain/services/queue-plan.service.js';
import type { ToolContext } from './context.js';
import { projectField, envField, confirmField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler } from './respond.js';

export function registerLifecycleTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_inspect',
    'Read-only provider inspection for forensics/adoption planning. Currently Railway only. Omit name/railwayProjectId to list projects; pass name or railwayProjectId to inspect environments, services, components, storage buckets, and env var names. Never writes Hypervibe local state or provider resources.',
    {
      provider: z.enum(['railway']).optional().describe('Provider to inspect (default: railway)'),
      name: z.string().optional().describe('Existing provider project name to inspect. Omit name and railwayProjectId to list projects.'),
      railwayProjectId: z.string().optional().describe('Exact Railway project id to inspect. Use this when multiple Railway projects have the same display name.'),
    },
    wrapHandler(async ({ name, railwayProjectId }) => {
      const adapter = await connectRailwayForImport();
      if (!adapter) {
        return toolError('MISSING_CONNECTION', 'No Railway connection configured.', {
          details: { connectionSetup: connectionSetupDetails('railway') },
          hint: formatConnectionGuidance('railway'),
          next: ['hv_connect'],
        });
      }

      try {
        if (!name && !railwayProjectId) {
          const projects = await listRailwayImportCandidates(adapter);
          return toolSuccess(
            { projects },
            {
              hint: projects.length > 0
                ? 'Call hv_inspect name="<railway-project>" to inspect one. If multiple projects share a name, pass railwayProjectId from this list.'
                : 'No Railway projects found on this account.',
            }
          );
        }

        let selectedProjectId = railwayProjectId;
        let selectedProjectName = name;
        if (!selectedProjectId) {
          const matches = await adapter.findProjectsByName(name!);
          if (matches.length === 0) {
            return toolError('NOT_FOUND', `Railway project "${name}" not found.`, {
              hint: 'Use hv_inspect to inspect existing provider infrastructure. For new infrastructure use hv_spec_set, hv_plan, and hv_apply.',
            });
          }
          if (matches.length > 1) {
            return toolError('VALIDATION', `Multiple Railway projects named "${name}" are visible.`, {
              details: {
                projects: matches.map((project) => ({ name: project.name, railwayId: project.id })),
              },
              hint: 'Re-run hv_inspect with railwayProjectId set to the exact Railway project id. Hypervibe will not guess between duplicate provider projects.',
              next: ['hv_inspect'],
            });
          }
          selectedProjectId = matches[0].id;
          selectedProjectName = matches[0].name;
        }

        const inspection = await inspectRailwayProject(adapter, selectedProjectId);
        if (!inspection) {
          return toolError('PROVIDER_ERROR', `Could not fetch details for Railway project "${selectedProjectName ?? selectedProjectId}".`, {
            hint: 'Use hv_inspect to inspect existing provider infrastructure. For new infrastructure use hv_spec_set, hv_plan, and hv_apply.',
          });
        }

        const { details, environments, services, components, storage, envVarNames, autoDetected, needsMapping } = inspection;
        return toolSuccess(
          {
            inspected: true,
            imported: false,
            project: { name: details.name, railwayId: details.id },
            environments,
            services,
            components,
            storage,
            envVarNames,
            autoDetected,
            needsMapping,
          },
          {
            hint: needsMapping.length > 0
              ? `Classify these environments (${needsMapping.join(', ')}) before adoption. To adopt, call hv_import with environmentMappings and confirm=true.`
              : 'Inspection only. To adopt this provider project into Hypervibe, call hv_import with environmentMappings and confirm=true.',
            next: ['hv_import'],
          }
        );
      } finally {
        await adapter.disconnect();
      }
    })
  );

  server.tool(
    'hv_import',
    'Adopt already-deployed provider infrastructure into Hypervibe local/repo state (currently Railway). Adoption writes explicit Hypervibe project/environment/service/component/storage bindings. For read-only provider data, use hv_inspect. Not for creating new infrastructure (use hv_spec_set + hv_apply).',
    {
      provider: z.enum(['railway']).optional().describe('Source provider to import from (default: railway)'),
      name: z.string().optional().describe('Existing provider project name to adopt. Use hv_inspect first if you only need to read provider state.'),
      railwayProjectId: z.string().optional().describe('Exact Railway project id to adopt. Use this when multiple Railway projects have the same display name.'),
      force: z.boolean().optional().describe('Set true to override the safety check when a Hypervibe project with the same name already exists.'),
      environmentMappings: z
        .record(z.string(), z.string())
        .optional()
        .describe('Map provider environment names to Hypervibe environments (e.g., {"prod-us-east": "production", "blue": "staging"})'),
      storageMappings: z.record(z.string(), z.string()).optional().describe('Explicitly adopt Railway buckets by id, mapping bucket id to desired storage name (e.g. {"bucket-id":"uploads"}).'),
      confirm: confirmField,
    },
    wrapHandler(async ({ name, railwayProjectId, force = false, environmentMappings, storageMappings, confirm }) => {
      if (!name && !railwayProjectId) {
        return toolError('VALIDATION', 'hv_import is adoption-only and requires name or railwayProjectId.', {
          hint: 'Use hv_inspect provider="railway" to list/read provider projects. Use hv_import only when adopting a selected provider project into Hypervibe.',
          next: ['hv_inspect'],
        });
      }

      if (!environmentMappings) {
        return toolError('VALIDATION', 'hv_import requires environmentMappings because it writes Hypervibe adoption bindings.', {
          hint: 'Use hv_inspect first to read environments/services/components, then call hv_import with environmentMappings and confirm=true when you want to adopt.',
          next: ['hv_inspect'],
        });
      }

      const adapter = await connectRailwayForImport();
      if (!adapter) {
        return toolError('MISSING_CONNECTION', 'No Railway connection configured.', {
          details: { connectionSetup: connectionSetupDetails('railway') },
          hint: formatConnectionGuidance('railway'),
          next: ['hv_connect'],
        });
      }

      try {
        let selectedProjectId = railwayProjectId;
        let selectedProjectName = name;
        if (!selectedProjectId) {
          const matches = await adapter.findProjectsByName(name!);
          if (matches.length === 0) {
            return toolError('NOT_FOUND', `Railway project "${name}" not found.`, {
              hint: 'Use hv_inspect to inspect existing provider infrastructure. For new infrastructure use hv_spec_set, hv_plan, and hv_apply.',
            });
          }
          if (matches.length > 1) {
            return toolError('VALIDATION', `Multiple Railway projects named "${name}" are visible.`, {
              details: {
                projects: matches.map((project) => ({ name: project.name, railwayId: project.id })),
              },
              hint: 'Re-run hv_import with railwayProjectId set to the exact Railway project id. Hypervibe will not guess between duplicate provider projects.',
              next: ['hv_inspect', 'hv_import'],
            });
          }
          selectedProjectId = matches[0].id;
          selectedProjectName = matches[0].name;
        }

        const inspection = await inspectRailwayProject(adapter, selectedProjectId);
        if (!inspection) {
          return toolError('PROVIDER_ERROR', `Could not fetch details for Railway project "${selectedProjectName ?? selectedProjectId}".`, {
            hint: 'Use hv_inspect to inspect existing provider infrastructure. For new infrastructure use hv_spec_set, hv_plan, and hv_apply.',
          });
        }

        const { details, environments, services, components } = inspection;

        // Guardrail: import is adoption-only. Block when a Hypervibe project
        // with the same name already exists unless force=true.
        const existing = ctx.repos.projects.findByName(details.name);
        if (existing && !force && environmentMappings) {
          return toolError('VALIDATION', `Hypervibe project "${details.name}" already exists. hv_import is adoption-only.`, {
            hint: 'Use hv_plan/hv_apply for setup or retries. Re-run hv_import with force=true only to intentionally re-adopt this live Railway project and update local bindings.',
          });
        }

        if (!confirm) {
          return toolError('CONFIRM_REQUIRED', `This will adopt Railway project "${details.name}" into Hypervibe local state. Provider resources are not changed.`, {
            details: {
              project: { name: details.name, railwayId: details.id },
              environmentMappings,
              environments,
              services: services.map((service) => ({ name: service.name, railwayId: service.railwayId })),
              components,
              storage: inspection.storage,
              storageMappings: storageMappings ?? {},
            },
            hint: 'Re-run hv_import with the same name/railwayProjectId, environmentMappings, and confirm=true to write local Hypervibe adoption bindings.',
            next: ['hv_import'],
          });
        }

        const result = await importRailwayProject(details, environmentMappings, services, components, { force, storageMappings });
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

        const queueBindings = Object.entries(parseQueueBindings(environment))
          .filter(([, binding]) => binding.backend === 'pubsub')
          .map(([queueName]) => queueName);

        ctx.repos.environments.delete(environment.id);
        ctx.repos.audit.create({
          action: 'environment.deleted',
          resourceType: 'environment',
          resourceId: environment.id,
          details: { project: project.name, name: environment.name },
        });

        return toolSuccess(
          { deleted: { scope: 'environment', project: project.name, environment: environment.name } },
          {
            hint: providerNote,
            ...(queueBindings.length > 0
              ? { warnings: [`Pub/Sub topics for queue(s) ${queueBindings.join(', ')} were not deleted; remove queues from the spec and apply first if you want them gone.`] }
              : {}),
          }
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
