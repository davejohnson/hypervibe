import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DeployOrchestrator } from '../domain/services/deploy.orchestrator.js';
import { buildDeploySourceEnvVars } from '../domain/services/deploy-source.js';
import { buildDatabaseEnvVarsFromComponent } from '../domain/services/database-env.js';
import { requiresProductionConfirm } from '../domain/services/policy.service.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { executeRollback, ROLLBACK_NOTE } from '../domain/services/rollback.service.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ToolContext } from './context.js';
import { projectField, envField, confirmField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';

function assertConfirmed(project: Project, environment: Environment, confirm: boolean | undefined, action: string): void {
  if (requiresProductionConfirm(project, environment.name) && !confirm) {
    throw new HvError(
      'CONFIRM_REQUIRED',
      `Environment "${environment.name}" is protected by project policy.`,
      { hint: `Re-run ${action} with confirm=true to proceed.` }
    );
  }
}

export function registerHvDeployTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_deploy',
    'Deploy services to an environment (staging, production, etc.). Protected environments require confirm=true.',
    {
      project: projectField,
      env: envField,
      services: z.array(z.string()).optional().describe('Specific services to deploy (default: all)'),
      envVars: z.record(z.string()).optional().describe('Additional environment variables'),
      confirm: confirmField,
    },
    wrapHandler(async ({ project: projectRef, env, services, envVars, confirm }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });

      // Resolve environment, auto-creating it if missing (same as legacy deploy).
      const envName = env?.trim() || 'staging';
      const environment = ctx.repos.environments.findByProjectAndName(project.id, envName)
        ?? ctx.repos.environments.create({ projectId: project.id, name: envName });

      assertConfirmed(project, environment, confirm, 'hv_deploy');

      const adapterResult = await ctx.adapterFactory.getHostingAdapter(project);
      if (!adapterResult.success || !adapterResult.adapter) {
        const platform = project.defaultPlatform || 'cloudrun';
        return toolError(
          'MISSING_CONNECTION',
          adapterResult.error || `No verified ${platform} connection.`,
          { hint: 'Connect the hosting provider first with hv_connect. Recommended: export scalar tokens and use credentialsRef="env:NAME" credentialsKey="apiToken", or put JSON credentials in a local file and use credentialsRef="file:/absolute/path". Raw credentials={...} is still accepted if intentional.' }
        );
      }
      const adapter = adapterResult.adapter;

      let servicesToDeploy = ctx.repos.services.findByProjectId(project.id);
      if (services && services.length > 0) {
        servicesToDeploy = servicesToDeploy.filter((s) => services.includes(s.name));
      }
      if (servicesToDeploy.length === 0) {
        return toolError('NOT_FOUND', 'No services found to deploy.', {
          hint: 'Create services first (hv_spec_set) or check service names.',
        });
      }

      const orchestrator = new DeployOrchestrator();
      // Inject the managed database's env vars (e.g. DATABASE_URL) on every
      // deploy, same as hv_apply does: some providers (Cloud Run) scope env
      // vars to the revision, so a redeploy that omits them would lose them.
      const dbComponent = ctx.repos.components.findByEnvironmentAndType(environment.id, 'postgres');
      const databaseEnvVars = dbComponent
        ? buildDatabaseEnvVarsFromComponent(dbComponent).envVars
        : {};
      const deployEnvVars = {
        ...buildDeploySourceEnvVars(project, adapter.name),
        ...databaseEnvVars,
        ...(envVars ?? {}),
      };
      const result = await orchestrator.execute({
        project,
        environment,
        services: servicesToDeploy,
        envVars: Object.keys(deployEnvVars).length > 0 ? deployEnvVars : undefined,
        verifyHttpHealth: true,
        adapter,
      });

      const data = {
        runId: result.run.id,
        status: result.run.status,
        environment: environment.name,
        urls: result.urls,
        serviceUrls: result.serviceUrls,
        primaryUrl: result.primaryUrl,
        errors: result.errors.length > 0 ? result.errors : undefined,
        createdResources: result.createdResources,
        rollback: result.rollback,
        intent: syncProjectIntent(project.id),
      };

      if (!result.success) {
        return toolError('PROVIDER_ERROR', 'Deployment had errors', {
          details: data,
          hint: 'Inspect errors, then retry hv_deploy or roll back with hv_rollback.',
        });
      }

      return toolSuccess(
        { ...data, message: `Deployment completed for ${servicesToDeploy.length} service(s)` },
        { next: ['hv_health'] }
      );
    })
  );

  server.tool(
    'hv_rollback',
    'Rollback by redeploying services from the most recent successful deploy run (or a specific run via toRunId). Protected environments require confirm=true.',
    {
      project: projectField,
      env: envField,
      toRunId: z.string().uuid().optional().describe('Specific successful deploy run ID to roll back to'),
      services: z.array(z.string()).optional().describe('Specific services to rollback (default: all in target run)'),
      confirm: confirmField,
    },
    wrapHandler(async ({ project: projectRef, env, toRunId, services, confirm }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const environment = ctx.resolveEnvironmentOrThrow(project, env);

      assertConfirmed(project, environment, confirm, 'hv_rollback');

      const result = await executeRollback({ project, environment, toRunId, services });
      if (!result.ok) {
        const code = result.reason === 'no_adapter' ? 'MISSING_CONNECTION'
          : result.reason === 'invalid_run' ? 'VALIDATION'
            : 'NOT_FOUND';
        return toolError(code, result.error);
      }

      const { ok: _ok, success, ...payload } = result;
      if (!success) {
        return toolError('PROVIDER_ERROR', 'Rollback deployment had errors', { details: payload });
      }
      return toolSuccess({ ...payload, note: ROLLBACK_NOTE }, { next: ['hv_health'] });
    })
  );
}
