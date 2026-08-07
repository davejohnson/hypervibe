import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import type { CommandContext } from '../application/context.js';
import { projectField, envField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler, HvError } from '../application/results.js';

/**
 * Redact secret-bearing fields when returning stored run plans to chat.
 * Current plans store env var key names only, but runs persisted before
 * that change carry plaintext values in steps[].params.vars — mask them.
 */
function redactRunPlan(plan: unknown): unknown {
  if (!plan || typeof plan !== 'object') return plan;
  const record = plan as Record<string, unknown>;
  const redacted: Record<string, unknown> = { ...record };
  const overrides = record.overrides as Record<string, unknown> | undefined;
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    const redactedOverrides = { ...overrides };
    delete redactedOverrides.envVarsEncrypted;
    redacted.overrides = redactedOverrides;
  }
  if (Array.isArray(record.steps)) {
    redacted.steps = record.steps.map((step) => {
      if (!step || typeof step !== 'object') return step;
      const stepRecord = step as Record<string, unknown>;
      const params = stepRecord.params as Record<string, unknown> | undefined;
      if (!params || typeof params.vars !== 'object' || params.vars === null) return step;
      return {
        ...stepRecord,
        params: {
          ...params,
          vars: Object.fromEntries(Object.keys(params.vars as Record<string, unknown>).map((key) => [key, '***'])),
        },
      };
    });
  }
  return redacted;
}

export function registerHvDevxTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_runs',
    'Inspect run history. action="list" (default) shows recent deployment/apply runs (with the latest run\'s status surfaced); action="get" returns full details (plan, receipts) for one run; action="audit" lists recent audit events.',
    {
      action: z.enum(['list', 'get', 'audit']).optional().describe('Operation (default: list)'),
      runId: z.string().optional().describe('Run id (required for action="get")'),
      project: projectField,
      env: envField.describe('Filter runs by environment name (action="list")'),
      limit: z.number().int().min(1).optional().describe('Max items to return (default: 20 runs, 50 audit events)'),
      resourceType: z.string().optional().describe('Audit filter: resource type (project, environment, run, ...)'),
      resourceId: z.string().optional().describe('Audit filter: resource id (used with resourceType)'),
      auditAction: z.string().optional().describe('Audit filter: action name (e.g. deploy.started)'),
    },
    wrapCommandHandler(async ({ action = 'list', runId, project: projectRef, env, limit, resourceType, resourceId, auditAction }) => {
      if (action === 'audit') {
        const max = limit ?? 50;
        const events = resourceType && resourceId
          ? ctx.repos.audit.findByResource(resourceType, resourceId, max)
          : auditAction
            ? ctx.repos.audit.findByAction(auditAction, max)
            : ctx.repos.audit.findRecent(max);
        return commandSuccess({
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
        });
      }

      const describeRun = (run: NonNullable<ReturnType<typeof ctx.repos.runs.findById>>) => ({
        id: run.id,
        type: run.type,
        status: run.status,
        project: ctx.repos.projects.findById(run.projectId)?.name,
        environment: ctx.repos.environments.findById(run.environmentId)?.name,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        error: run.error,
      });

      if (action === 'get') {
        if (!runId) {
          throw new HvError('VALIDATION', 'runId is required for action="get".');
        }
        const run = ctx.repos.runs.findById(runId);
        if (!run) {
          return commandError('NOT_FOUND', `Run not found: ${runId}`, { hint: 'List runs with hv_runs action="list".' });
        }
        return commandSuccess({
          run: { ...describeRun(run), plan: redactRunPlan(run.plan), receipts: run.receipts, createdAt: run.createdAt },
        });
      }

      // action === 'list'
      const max = limit ?? 20;
      let runs;
      if (projectRef) {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        if (env) {
          const environment = ctx.resolveEnvironmentOrThrow(project, env);
          runs = ctx.repos.runs.findByEnvironmentId(environment.id, max);
        } else {
          runs = ctx.repos.runs.findByProjectId(project.id, max);
        }
      } else {
        runs = ctx.repos.runs.findRecent(max);
      }

      const enriched = runs.map(describeRun);
      const latest = enriched[0] ?? null;
      return commandSuccess(
        { count: enriched.length, latest, runs: enriched },
        latest ? { hint: `Latest run is ${latest.status} (${latest.type}). Use hv_runs action="get" runId="${latest.id}" for plan and receipts.` } : undefined
      );
    })
  );
}
