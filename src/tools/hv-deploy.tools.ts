import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlanService } from '../domain/plan/plan.service.js';
import { requiresProductionConfirm } from '../domain/services/policy.service.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { executeRollback, ROLLBACK_NOTE } from '../domain/services/rollback.service.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ToolContext } from './context.js';
import { connectionProviders, connectionRecoveryHint, executePlanApply } from './apply-plan.js';
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

function defaultBranchForEnvironment(envName: string): string {
  return envName.toLowerCase().includes('prod') ? 'main' : 'staging';
}

function railwayCiDeployGuidance(project: Project, envName: string): { branch: string; workflow: string } | null {
  const specResult = new SpecStore().get(project);
  const envSpec = specResult?.spec.environments[envName];
  if (
    envSpec?.hosting.provider !== 'railway'
    || envSpec.deploy?.strategy !== 'branch'
    || (envSpec.deploy.trigger ?? 'ci') !== 'ci'
  ) {
    return null;
  }

  const branch = envSpec.deploy.branch ?? defaultBranchForEnvironment(envName);
  return {
    branch,
    workflow: `deploy-railway-${defaultBranchForEnvironment(envName) === 'main' ? 'production' : 'staging'}.yml`,
  };
}

export function registerHvDeployTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_deploy',
    'Deploy services to an environment (staging, production, etc.). Plan-gated: builds a plan from the spec (optionally restricted to services=[...] with one-off envVars={...} overrides) and applies it immediately; the planId and applyRunId are returned for the audit trail. Requires a spec (hv_spec_set). Protected environments require confirm=true.',
    {
      project: projectField,
      env: envField,
      services: z.array(z.string()).optional().describe('Specific services to deploy (default: all)'),
      envVars: z.record(z.string()).optional().describe('Additional environment variables'),
      confirm: confirmField,
    },
    wrapHandler(async ({ project: projectRef, env, services, envVars, confirm }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });

      // Deploys are plan-gated: the spec is the source of truth for what runs.
      const specResult = new SpecStore().get(project);
      if (!specResult) {
        return toolError('NOT_FOUND', `Project "${project.name}" has no spec.`, {
          hint: 'Define one with hv_spec_set (or hv_import an existing project), then hv_deploy.',
          next: ['hv_spec_set', 'hv_import'],
        });
      }
      const envName = env?.trim() || 'staging';
      const envSpec = specResult.spec.environments[envName];
      if (!envSpec) {
        return toolError('VALIDATION', `Spec has no environment "${envName}".`, {
          details: { available: Object.keys(specResult.spec.environments) },
          next: ['hv_spec_set'],
        });
      }
      if (Object.keys(envSpec.services).length === 0) {
        return toolError('NOT_FOUND', 'No services found to deploy.', {
          hint: 'Create services first (hv_spec_set) or check service names.',
        });
      }

      // Resolve environment, auto-creating it if missing (same as legacy deploy).
      const environment = ctx.repos.environments.findByProjectAndName(project.id, envName)
        ?? ctx.repos.environments.create({ projectId: project.id, name: envName });

      assertConfirmed(project, environment, confirm, 'hv_deploy');

      const railwayCi = railwayCiDeployGuidance(project, envName);
      if (railwayCi) {
        return toolError(
          'VALIDATION',
          `Environment "${envName}" uses Railway GitHub Actions branch deploys. hv_deploy does not build or push the image for this mode.`,
          {
            hint: `Run hv_plan/hv_apply to sync the workflow, then push to ${railwayCi.branch} or run hv_ci_trigger workflow="${railwayCi.workflow}" ref="${railwayCi.branch}". Check progress with hv_ci_status, then hv_health.`,
            next: ['hv_plan', 'hv_apply', 'hv_ci_trigger', 'hv_ci_status'],
          }
        );
      }

      const planService = new PlanService();
      const planned = await planService.plan(project, envName, {
        ...(services?.length ? { serviceFilter: services } : {}),
        ...(envVars && Object.keys(envVars).length > 0 ? { envVarOverrides: envVars } : {}),
      });
      if ('error' in planned) {
        return toolError('VALIDATION', planned.error, { next: ['hv_spec_set'] });
      }

      const outcome = await executePlanApply(ctx, {
        project,
        spec: specResult.spec,
        specRevision: specResult.revision,
        planId: planned.planRunId,
        confirmActions: [],
        verifyHttpHealth: true,
        alwaysRunBootstrap: true,
      });
      if (outcome.kind === 'plan_not_found' || outcome.kind === 'env_missing') {
        return toolError('INTERNAL', 'Deploy plan could not be applied immediately after planning.', {
          details: outcome,
        });
      }
      if (outcome.kind === 'blocked') {
        return toolError('MISSING_CONNECTION', `Missing verified connections: ${connectionProviders(outcome.applyBlocked).join(', ')}.`, {
          details: outcome.applyBlocked,
          hint: connectionRecoveryHint(outcome.applyBlocked, { after: 'Then re-run hv_deploy.' }),
          next: ['hv_connect', 'hv_deploy'],
        });
      }

      const summary = outcome.bootstrapSummary ?? {};
      const data = {
        planId: planned.planRunId,
        applyRunId: outcome.result.applyRunId,
        runId: summary.deploymentRunId,
        status: outcome.result.success ? 'succeeded' : 'failed',
        environment: envName,
        urls: summary.urls ?? [],
        serviceUrls: summary.serviceUrls ?? {},
        primaryUrl: summary.primaryUrl,
        errors: outcome.result.success
          ? undefined
          : [String(summary.error ?? outcome.result.error ?? 'Deploy failed')],
        createdResources: summary.deploymentCreatedResources ?? [],
        rollback: summary.deploymentRollback,
        receipts: outcome.result.receipts,
        intent: syncProjectIntent(project.id),
      };

      if (!outcome.result.success) {
        return toolError('PROVIDER_ERROR', 'Deployment had errors', {
          details: data,
          hint: 'Inspect errors, then retry hv_deploy or roll back with hv_rollback.',
        });
      }

      const deployedCount = services?.length ?? Object.keys(envSpec.services).length;
      return toolSuccess(
        { ...data, message: `Deployment completed for ${deployedCount} service(s)` },
        { warnings: outcome.actionScopedWarnings, next: ['hv_health'] }
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
