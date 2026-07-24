import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlanService } from '../domain/plan/plan.service.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { requiresProductionConfirm } from '../domain/services/policy.service.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { executeRollback, ROLLBACK_NOTE } from '../domain/services/rollback.service.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ToolContext } from './context.js';
import {
  connectionProviders,
  connectionRecoveryDetails,
  connectionRecoveryHint,
  executePlanApply,
} from './apply-plan.js';
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

function ciBranchDeployGuidance(project: Project, envName: string): { branch: string; workflow: string; providerName: string } | null {
  const specResult = new SpecStore().get(project);
  const envSpec = specResult?.spec.environments[envName];
  if (
    !envSpec
    || envSpec.deploy?.strategy !== 'branch'
    || (envSpec.deploy.trigger ?? 'ci') !== 'ci'
    || !providerRegistry.getMetadata(envSpec.hosting.provider)?.orchestration?.ci
  ) {
    return null;
  }

  const branch = envSpec.deploy.branch ?? defaultBranchForEnvironment(envName);
  const workflowKind = envName.toLowerCase().includes('prod') ? 'production' : 'staging';
  return {
    branch,
    workflow: `deploy-${envSpec.hosting.provider}-${workflowKind}.yml`,
    providerName: providerRegistry.getMetadata(envSpec.hosting.provider)?.displayName ?? envSpec.hosting.provider,
  };
}

export function registerHvDeployTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_deploy',
    'Deploy services to an environment (staging, production, etc.). Plan-gated: builds a plan from the spec and applies it immediately; the planId and applyRunId are returned for the audit trail. Delegated secret slots accept values only through secretRefs={KEY:"env:NAME"|"dotenv:/absolute/path/.env#KEY"|"file:/absolute/path"|"<manager>://..."}; values are resolved locally and encrypted into the plan. Ordinary envVars and env files cannot override delegated keys. By default, .env.<env> then repo .env are considered as deploy input in envFile.mode="runtime". Requires a spec (hv_spec_set). Protected environments require confirm=true.',
    {
      project: projectField,
      env: envField,
      services: z.array(z.string()).optional().describe('Specific services to deploy (default: all)'),
      envVars: z.record(z.string()).optional().describe('Additional one-off environment variables; values are encrypted in the stored plan and win over .env and spec envVars.'),
      envFile: z.string().optional().describe('Local .env file to consider as deploy input. Defaults to .env.<env>, creating it from repo .env when missing and syncing newly added base keys when present. Selection follows spec envFile policy; values are encrypted in the stored plan and never returned.'),
      includeEnvFile: z.boolean().optional().describe('Set false to skip the default repo .env deploy input.'),
      secretRefs: z.record(z.string()).optional().describe('Chat-safe local/secret-manager references for delegated secret slots, keyed by declared env var name. Never pass raw secret values.'),
      confirm: confirmField,
    },
    wrapHandler(async ({ project: projectRef, env, services, envVars, envFile, includeEnvFile, secretRefs, confirm }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });

      // Deploys are plan-gated: the spec is the source of truth for what runs.
      const specResult = new SpecStore().get(project);
      if (!specResult) {
        return toolError('NOT_FOUND', `Project "${project.name}" has no spec.`, {
          hint: 'Define one with hv_spec_set, or inspect existing provider infrastructure with hv_inspect and adopt it with hv_import, then hv_deploy.',
          next: ['hv_spec_set', 'hv_inspect', 'hv_import'],
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

      const ciDeploy = ciBranchDeployGuidance(project, envName);
      if (ciDeploy) {
        return toolError(
          'VALIDATION',
          `Environment "${envName}" uses ${ciDeploy.providerName} GitHub Actions branch deploys. hv_deploy does not build or push the image for this mode.`,
          {
            hint: `Run hv_plan/hv_apply to sync the workflow, then push to ${ciDeploy.branch} or run hv_ci_trigger workflow="${ciDeploy.workflow}" ref="${ciDeploy.branch}". Check progress with hv_ci_status, then hv_health.`,
            next: ['hv_plan', 'hv_apply', 'hv_ci_trigger', 'hv_ci_status'],
          }
        );
      }

      const planService = new PlanService();
      const planned = await planService.plan(project, envName, {
        ...(services?.length ? { serviceFilter: services } : {}),
        ...(envVars && Object.keys(envVars).length > 0 ? { envVarOverrides: envVars } : {}),
        ...(envFile ? { envFile } : {}),
        ...(includeEnvFile !== undefined ? { includeEnvFile } : {}),
        ...(secretRefs && Object.keys(secretRefs).length > 0 ? { secretRefs } : {}),
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
      if (outcome.kind === 'input_required') {
        return toolError('VALIDATION', 'Deployment needs delegated secret inputs before it can apply.', {
          details: { environment: outcome.envName, inputRequired: outcome.requirements },
          hint: 'Use safe local secretRefs for values available on this Mac. Otherwise prepare a value-free handoff naming each delegated key, environment, and principal for the project owner. Do not paste raw secrets into chat.',
          next: ['hv_deploy'],
          agentInstruction: {
            action: 'ask_user',
            message: 'Stop before deploy. Use safe local secret references when available, or prepare a value-free owner handoff for the delegated-secret slots.',
          },
        });
      }
      if (outcome.kind === 'blocked') {
        return toolError('MISSING_CONNECTION', `Missing verified connections: ${connectionProviders(outcome.applyBlocked).join(', ')}.`, {
          details: {
            blocked: outcome.applyBlocked,
            ...connectionRecoveryDetails(outcome.applyBlocked),
          },
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
    'Rollback by redeploying services from the most recent successful deploy run (or a specific run via toRunId). Recorded as a plan/apply run pair (planId + applyRunId returned) with per-service receipts; redeploys current code, not a pinned image. Protected environments require confirm=true.',
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
        return toolError(code, result.error, code === 'MISSING_CONNECTION'
          ? { details: connectionRecoveryDetails([{ provider: project.defaultPlatform }]) }
          : undefined);
      }

      const { ok: _ok, success, ...payload } = result;
      if (!success) {
        return toolError('PROVIDER_ERROR', 'Rollback deployment had errors', { details: payload });
      }
      return toolSuccess({ ...payload, note: ROLLBACK_NOTE }, { next: ['hv_health'] });
    })
  );
}
