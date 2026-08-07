import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import {
  serviceBindingFor,
  removeServiceBinding,
  removeServiceFromDesiredState,
} from '../domain/services/spec.service.js';
import { parseQueueBindings } from '../domain/services/queue-plan.service.js';
import type { CommandContext } from '../application/context.js';
import { projectField, envField, confirmField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler } from '../application/results.js';
import { inspectProvider } from '../application/inspect-provider.js';
import { importProvider } from '../application/import-provider.js';

export function registerLifecycleTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_inspect',
    'Read-only provider forensics across every registered provider. A completely parameterless call lists providers, connection state, and supported resource reads. Every bounded inspection requires provider; live environment inspection requires provider, project, and env. Never writes Hypervibe local state or provider resources.',
    {
      provider: z.string().trim().min(1).optional().describe('Registered provider name. Required whenever any other selector is supplied; omit only for parameterless provider discovery.'),
      project: z.string().optional().describe('Hypervibe project name or id. Required with env; omit for provider-account inspection or parameterless discovery.'),
      env: z.string().optional().describe('Exact environment name. Live environment inspection requires provider, project, and env; this command does not default to staging.'),
      scope: z.string().trim().min(1).optional().describe('Provider connection/account/repository/domain scope, such as owner/repo or example.com.'),
      resource: z.string().trim().min(1).optional().describe('Provider-owned resource class returned by the provider listing, such as project, ref, pages, zone, or dns.'),
      id: z.string().trim().min(1).optional().describe('Exact durable provider resource id.'),
      name: z.string().trim().min(1).optional().describe('Exact provider resource name when an id is not known.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum list results (default 25, hard maximum 100).'),
    },
    wrapCommandHandler(async (input) => commandSuccess(await inspectProvider(ctx, input)))
  );

  commands.register(
    'hv_import',
    'Adopt already-deployed provider infrastructure into Hypervibe local/repo state through a provider-declared adoption capability. Adoption writes explicit Hypervibe project/environment/resource bindings. For read-only provider data, use hv_inspect. Not for creating new infrastructure (use hv_spec + hv_apply).',
    {
      provider: z.string().trim().min(1).describe('Registered source provider. Providers without a tested adoption driver return UNSUPPORTED.'),
      name: z.string().optional().describe('Existing provider project name to adopt. Use hv_inspect first if you only need to read provider state.'),
      id: z.string().optional().describe('Exact durable provider project id. Use this when multiple provider projects have the same display name.'),
      force: z.boolean().optional().describe('Set true to override the safety check when a Hypervibe project with the same name already exists.'),
      environmentMappings: z
        .record(z.string(), z.string().trim().min(1))
        .refine((mappings) => Object.keys(mappings).length > 0, 'environmentMappings must contain at least one mapping')
        .optional()
        .describe('Map provider environment names to Hypervibe environments (e.g., {"prod-us-east": "production", "blue": "staging"})'),
      storageMappings: z.record(
        z.string(),
        z.string().regex(/^[a-z][a-z0-9-]{0,60}$/, 'storage names: lowercase alphanumeric and dashes, starting with a letter')
      ).optional().describe('Map provider storage ids to desired storage names (e.g. {"bucket-id":"uploads"}).'),
      databaseMappings: z.record(z.string(), z.enum(['postgres'])).optional().describe('Map provider service ids to PostgreSQL components. Datastore candidates are shown by hv_inspect.'),
      cacheMappings: z.record(z.string(), z.enum(['redis'])).optional().describe('Map provider service ids to Redis components. Datastore candidates are shown by hv_inspect.'),
      confirm: confirmField,
    },
    wrapCommandHandler(async (input) => importProvider(ctx, input))
  );

  commands.register(
    'hv_destroy',
    'Delete LOCAL Hypervibe records only: a project (cascade), an environment, or a service (including its platform binding). Never touches provider resources — to destroy live infrastructure, remove it from the spec with hv_spec, then run hv_plan and hv_apply with the exact confirmActions ids. Without confirm=true this returns CONFIRM_REQUIRED listing exactly what local records would be deleted.',
    {
      project: projectField,
      env: envField,
      scope: z.enum(['project', 'environment', 'service']).describe('What to delete: the whole project record, one environment record, or one service record'),
      name: z.string().optional().describe('Service name (required when scope="service")'),
      confirm: confirmField,
    },
    wrapCommandHandler(async ({ project: projectRef, env, scope, name, confirm }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const providerNote = 'Provider resources were not touched — destroy live infrastructure via hv_spec + hv_plan + hv_apply with exact confirmActions ids.';

      if (scope === 'project') {
        const environments = ctx.repos.environments.findByProjectId(project.id);
        const services = ctx.repos.services.findByProjectId(project.id);
        const summary = {
          project: { id: project.id, name: project.name },
          environments: environments.map((e) => e.name),
          services: services.map((s) => s.name),
        };

        if (!confirm) {
          return commandError('CONFIRM_REQUIRED', `This would delete the local project "${project.name}" with ${environments.length} environment(s) and ${services.length} service(s). No provider resources are affected.`, {
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

        return commandSuccess({ deleted: { scope: 'project', ...summary } }, { hint: providerNote });
      }

      if (scope === 'environment') {
        const environment = ctx.resolveEnvironmentOrThrow(project, env);

        if (!confirm) {
          return commandError('CONFIRM_REQUIRED', `This would delete the local environment "${environment.name}" of project "${project.name}" (including its platform bindings). No provider resources are affected.`, {
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

        return commandSuccess(
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
        return commandError('VALIDATION', 'name is required when scope="service".', {
          hint: 'Pass the service name to delete, e.g. name="web".',
        });
      }

      const service = ctx.repos.services.findByProjectAndName(project.id, name.trim());
      if (!service) {
        const available = ctx.repos.services.findByProjectId(project.id).map((s) => s.name);
        return commandError('NOT_FOUND', `Service "${name}" not found in project "${project.name}".`, {
          details: { available },
        });
      }

      const boundEnvironments = ctx.repos.environments
        .findByProjectId(project.id)
        .filter((environment) => serviceBindingFor(environment, service.name));

      if (!confirm) {
        return commandError('CONFIRM_REQUIRED', `This would delete the local service "${service.name}" from project "${project.name}" and remove its binding from ${boundEnvironments.length} environment(s). No provider resources are affected.`, {
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

      return commandSuccess(
        {
          deleted: {
            scope: 'service',
            project: project.name,
            service: service.name,
            bindingsRemovedFrom: boundEnvironments.map((e) => e.name),
          },
        },
        { hint: `${providerNote} If the spec still declares "${service.name}", remove it with hv_spec too.` }
      );
    })
  );
}
