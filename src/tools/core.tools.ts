import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { projectSpecSchema, type ProjectSpec } from '../domain/spec/spec.schema.js';
import { specToBootstrapParams } from '../domain/spec/spec-bootstrap.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { diffEnvironment } from '../domain/plan/diff.engine.js';
import {
  ConvergeExecutor,
  fingerprintObservedState,
  type ActionResult,
} from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { executeBootstrap } from '../domain/services/bootstrap.service.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { StateManager } from '../agent/state.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ToolContext } from './context.js';
import { projectField, envField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';

function deploymentProviders(): string[] {
  return providerRegistry.getByCategory('deployment').map((p) => p.metadata.name);
}

function validateHostingProviders(spec: ProjectSpec): void {
  const available = deploymentProviders();
  for (const [envName, env] of Object.entries(spec.environments)) {
    if (!available.includes(env.hosting.provider)) {
      throw new HvError('VALIDATION', `Unknown hosting provider "${env.hosting.provider}" in environment "${envName}".`, {
        hint: `Available hosting providers: ${available.join(', ')}.`,
      });
    }
  }
}

function summarizeActions(actions: PlanAction[]) {
  const counts: Record<string, number> = {};
  for (const action of actions) {
    counts[action.type] = (counts[action.type] ?? 0) + 1;
  }
  return counts;
}

export function registerCoreTools(server: McpServer, ctx: ToolContext): void {
  const specStore = new SpecStore();
  const planService = new PlanService();

  server.tool(
    'hv_spec_set',
    'Create or update the desired-state spec for a project (the single source of truth that hv_plan diffs against live infrastructure). Merges by default; pass replace=true to overwrite. In a merge, set a key to null to delete it (e.g. remove a service).',
    {
      project: projectField,
      spec: z.record(z.unknown()).describe('Full ProjectSpec (replace) or partial patch (merge). Shape: { environments: { <env>: { hosting: { provider }, services: { <name>: { workloadKind?, startCommand?, releaseCommand?, healthCheckPath?, cronSchedule?, public? } }, database?: { provider: supabase|rds|cloudsql|railway }, domain?, email?: { enabled }, envVars?, deploy?: { strategy: branch|manual, branch? }, migrations? } } }'),
      replace: z.boolean().optional().describe('Replace the entire spec instead of merging'),
    },
    wrapHandler(async ({ project: projectRef, spec, replace }) => {
      let project = ctx.resolveProject({ project: projectRef });
      if (!project) {
        const name = (typeof spec.project === 'string' && spec.project.trim())
          || projectRef?.trim();
        if (!name) {
          throw new HvError('NOT_FOUND', 'No project found and no name provided.', {
            hint: 'Pass project (or spec.project) to create a new project.',
          });
        }
        project = ctx.repos.projects.create({ name });
      }

      let result;
      try {
        result = replace
          ? specStore.replace(project, {
            version: 1,
            project: project.name,
            ...spec,
          })
          : specStore.merge(project, spec);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new HvError('VALIDATION', 'Spec failed validation.', {
            details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            hint: 'Fix the listed fields and retry hv_spec_set.',
          });
        }
        throw error;
      }
      validateHostingProviders(result.spec);

      return toolSuccess(
        {
          project: { id: project.id, name: project.name },
          revision: result.revision,
          spec: result.spec,
        },
        { next: ['hv_plan'] }
      );
    })
  );

  server.tool(
    'hv_spec_get',
    'Read the current desired-state spec and revision for a project.',
    { project: projectField },
    wrapHandler(async ({ project: projectRef }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const result = specStore.get(project);
      if (!result) {
        return toolError('NOT_FOUND', `Project "${project.name}" has no spec yet.`, {
          hint: 'Define one with hv_spec_set.',
        });
      }
      return toolSuccess({
        project: { id: project.id, name: project.name },
        revision: result.revision,
        spec: result.spec,
        environments: Object.fromEntries(
          Object.entries(result.spec.environments).map(([name, env]) => [name, {
            hosting: env.hosting.provider,
            services: Object.keys(env.services),
            database: env.database?.provider ?? null,
            domain: env.domain ?? null,
          }])
        ),
      });
    })
  );

  server.tool(
    'hv_plan',
    'Diff the spec against live infrastructure (observed where the provider supports it) and return an executable plan. The returned planId is required by hv_apply.',
    { project: projectField, env: envField },
    wrapHandler(async ({ project: projectRef, env }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const result = await planService.plan(project, env?.trim() || 'staging');
      if ('error' in result) {
        return toolError('VALIDATION', result.error, { next: ['hv_spec_set'] });
      }

      const confirmIds = result.actions.filter((a) => a.requiresConfirm).map((a) => a.id);
      const pending = result.actions.filter((a) => a.type !== 'noop');
      const hint = result.blocked.length > 0
        ? `Blocked: connect ${result.blocked.map((b) => b.provider).join(', ')} with hv_connect before applying.`
        : pending.length === 0
          ? 'Everything is in sync — nothing to apply.'
          : `Apply with hv_apply planId="${result.planRunId}"${confirmIds.length ? ` and confirmDestroy=${JSON.stringify(confirmIds)} to also run the confirm-gated destroys` : ''}.`;

      return toolSuccess(
        {
          planId: result.planRunId,
          environment: result.environmentName,
          specRevision: result.specRevision,
          verified: result.verified,
          summary: summarizeActions(result.actions),
          actions: result.actions,
          unmanaged: result.unmanaged,
          blocked: result.blocked,
        },
        {
          hint,
          warnings: result.warnings,
          next: result.blocked.length === 0 && pending.length > 0 ? ['hv_apply'] : undefined,
        }
      );
    })
  );

  server.tool(
    'hv_status',
    'Show desired vs observed state for an environment: drift, unmanaged resources, and blocked connections. Read-only; does not persist a plan.',
    { project: projectField, env: envField },
    wrapHandler(async ({ project: projectRef, env }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = specStore.get(project);
      if (!specResult) {
        return toolError('NOT_FOUND', `Project "${project.name}" has no spec.`, { hint: 'Define one with hv_spec_set.' });
      }
      const envName = env?.trim() || 'staging';
      const envSpec = specResult.spec.environments[envName];
      if (!envSpec) {
        return toolError('NOT_FOUND', `Spec has no environment "${envName}".`, {
          details: { available: Object.keys(specResult.spec.environments) },
        });
      }

      const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const { observed, warnings } = await planService.observeEnvironment(project, environment, envSpec);
      const local = planService.buildLocalSnapshot(project, environment);
      const diff = diffEnvironment({ spec: envSpec, envName, observed, local });
      const drift = diff.actions.filter((a) => a.type !== 'noop');

      return toolSuccess(
        {
          environment: envName,
          specRevision: specResult.revision,
          verified: observed !== null,
          inSync: drift.length === 0,
          summary: summarizeActions(diff.actions),
          drift,
          unmanaged: diff.unmanaged,
          blocked: planService.preflight(envSpec),
        },
        {
          warnings: [...warnings, ...diff.warnings],
          hint: drift.length > 0 ? 'Run hv_plan to get an executable plan for this drift.' : undefined,
        }
      );
    })
  );

  server.tool(
    'hv_apply',
    'Apply a plan produced by hv_plan. Rejects stale plans (spec changed, infrastructure changed, plan expired, or already applied). Confirm-gated destroys (data-bearing resources) run only when their action ids are passed in confirmDestroy.',
    {
      project: projectField,
      planId: z.string().describe('Plan id returned by hv_plan'),
      confirmDestroy: z.array(z.string()).optional().describe('Action ids of confirm-gated destroys to execute (e.g. ["database:railway:destroy"])'),
    },
    wrapHandler(async ({ project: projectRef, planId, confirmDestroy }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = specStore.get(project);
      if (!specResult) {
        return toolError('NOT_FOUND', `Project "${project.name}" has no spec.`, { hint: 'hv_spec_set, then hv_plan.' });
      }

      const executor = new ConvergeExecutor();
      const loaded = executor.loadPlan(planId);
      if ('error' in loaded) {
        return toolError('NOT_FOUND', loaded.error, { next: ['hv_plan'] });
      }
      const envName = loaded.document.environmentName;
      const envSpec = specResult.spec.environments[envName];
      if (!envSpec) {
        return toolError('VALIDATION', `Spec no longer has environment "${envName}".`, { next: ['hv_plan'] });
      }

      const blocked = planService.preflight(envSpec);
      if (blocked.length > 0) {
        return toolError('MISSING_CONNECTION', `Missing verified connections: ${blocked.map((b) => b.provider).join(', ')}.`, {
          details: blocked,
          hint: 'Connect them with hv_connect, then re-run hv_plan and hv_apply.',
        });
      }

      // Re-observe for the TOCTOU fingerprint check.
      const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const { observed } = await planService.observeEnvironment(project, environment, envSpec);
      const freshFingerprint = observed ? fingerprintObservedState(observed) : null;

      // The bootstrap path derives the hosting adapter from project.defaultPlatform.
      let applyProject: Project = project;
      if (project.defaultPlatform !== envSpec.hosting.provider) {
        applyProject = ctx.repos.projects.update(project.id, { defaultPlatform: envSpec.hosting.provider }) ?? project;
      }

      // Converge: bootstrap handles create/update/replace as one idempotent
      // pass; confirm-gated database destroys run individually afterward.
      let bootstrap: { success: boolean; summary: Record<string, unknown> } | null = null;
      const ensureBootstrap = async () => {
        if (!bootstrap) {
          bootstrap = await executeBootstrap(specToBootstrapParams(applyProject.name, envName, envSpec));
        }
        return bootstrap;
      };

      const handler = async (action: PlanAction): Promise<ActionResult> => {
        if (action.resource.kind === 'database' && action.type === 'destroy') {
          return destroyDatabase(ctx, applyProject, envName, action);
        }
        const result = await ensureBootstrap();
        if (result.success) {
          return { success: true, message: `Converged (${action.id})` };
        }
        return {
          success: false,
          message: `Apply failed while converging ${action.id}`,
          error: String(result.summary.error ?? 'bootstrap failed'),
          data: result.summary,
        };
      };

      const result = await executor.execute({
        planRunId: planId,
        confirmDestroy,
        currentSpecRevision: specResult.revision,
        freshObservedFingerprint: freshFingerprint,
        handler,
      });

      if (result.success) {
        syncAutofixWatches(ctx, applyProject, envName, envSpec);
      }

      const skipped = result.receipts.filter((r) => r.status === 'skipped_requires_confirm');
      if (!result.success && !result.applyRunId) {
        // Rejected before execution (stale plan, superseded spec, etc.)
        return toolError('VALIDATION', result.error ?? 'Apply rejected', { next: ['hv_plan'] });
      }

      return toolSuccess(
        {
          applied: result.success,
          applyRunId: result.applyRunId,
          environment: envName,
          receipts: result.receipts,
          ...(bootstrap ? { bootstrapSummary: (bootstrap as { summary: Record<string, unknown> }).summary } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        {
          hint: skipped.length > 0
            ? `Skipped confirm-gated destroys: ${skipped.map((r) => r.actionId).join(', ')}. Re-run hv_plan, then hv_apply with confirmDestroy to execute them.`
            : result.success
              ? 'Apply complete. Check hv_status to verify convergence.'
              : 'Apply failed; compensations ran where registered. Inspect receipts and re-run hv_plan.',
          next: ['hv_status'],
        }
      );
    })
  );
}

/** Sync spec.autofix to the autofix agent's watch list after a successful apply. */
function syncAutofixWatches(
  ctx: ToolContext,
  project: Project,
  envName: string,
  envSpec: import('../domain/spec/spec.schema.js').EnvironmentSpec
): void {
  if (!envSpec.autofix) return;
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) return;

  try {
    const stateManager = new StateManager();
    const serviceNames = envSpec.autofix.services ?? Object.keys(envSpec.services);
    for (const serviceName of serviceNames) {
      if (envSpec.autofix.enabled) {
        stateManager.addWatch({ projectId: project.id, environmentId: environment.id, serviceName, enabled: true });
      } else {
        stateManager.removeWatch(project.id, environment.id, serviceName);
      }
    }
    stateManager.save();
  } catch (error) {
    // Watch sync must never fail an apply.
    console.warn(`[hypervibe] autofix watch sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function destroyDatabase(
  ctx: ToolContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const component = ctx.repos.components.findByEnvironmentAndType(environment.id, action.resource.name);
  if (!component) {
    return { success: true, message: `No local ${action.resource.name} component to destroy — nothing to do` };
  }

  const adapterResult = await adapterFactory.getDatabaseAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Database adapter unavailable', error: adapterResult.error };
  }

  const destroyed = await adapterResult.adapter.destroy(component);
  if (!destroyed.success) {
    return { success: false, message: destroyed.message, error: destroyed.error };
  }
  ctx.repos.components.delete(component.id);
  return { success: true, message: `Destroyed ${action.resource.provider} ${action.resource.name} and removed local component` };
}
