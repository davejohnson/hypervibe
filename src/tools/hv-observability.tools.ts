import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StateManager, type TrackedError } from '../agent/state.js';
import { detectProviderName } from './logs.tools.js';
import {
  fetchProviderLogs,
  fetchProviderDeployments,
  fetchProviderBuildLogs,
  fetchStripeWebhookStatuses,
  collectRecentErrors,
  collectErrorsSummary,
  supportsLogsDeploymentsProvider,
  supportsLogsBuildProvider,
  logsDeploymentsUnsupportedMessage,
  logsBuildUnsupportedMessage,
} from './logs.tools.js';
import {
  resolveHealthEnvironment,
  resolveHealthService,
  normalizeBaseUrl,
  joinUrl,
  resolveServiceBaseUrl,
  runHttpCheck,
} from './health.tools.js';
import type { ToolContext } from './context.js';
import { projectField, envField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';

const stateManager = new StateManager();

function resolveEnvOrThrow(ctx: ToolContext, projectRef: string | undefined, envName: string | undefined) {
  const project = ctx.resolveProjectOrThrow({ project: projectRef });
  const environment = ctx.resolveEnvironmentOrThrow(project, envName);
  const bindings = environment.platformBindings as { provider?: string; services?: Record<string, { serviceId: string }> };
  const provider = detectProviderName(project.defaultPlatform, bindings.provider);
  return { project, environment, bindings, provider };
}

export function registerHvObservabilityTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_logs',
    'Fetch logs and delivery status: runtime service logs, build logs, recent deployments, or Stripe webhook endpoint status.',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service name. Defaults to the first bound service for source=service/build.'),
      source: z.enum(['service', 'build', 'deployments', 'stripe-webhooks']).describe('What to fetch'),
      limit: z.number().int().min(1).max(500).optional().describe('Max entries (default 100 for service logs, 10 for deployments)'),
      errorsOnly: z.boolean().optional().describe('source=service only: return only error-like lines'),
      deploymentId: z.string().optional().describe('source=build only: specific deployment (defaults to latest)'),
      mode: z.enum(['sandbox', 'live']).optional().describe('source=stripe-webhooks only (default sandbox)'),
    },
    wrapHandler(async ({ project: projectRef, env, service, source, limit, errorsOnly, deploymentId, mode }) => {
      if (source === 'stripe-webhooks') {
        const webhooks = await fetchStripeWebhookStatuses(mode ?? 'sandbox');
        return toolSuccess({ source, mode: mode ?? 'sandbox', webhooks });
      }

      const { project, environment, bindings, provider } = resolveEnvOrThrow(ctx, projectRef, env);
      const boundServices = Object.keys(bindings.services ?? {});
      const serviceName = service ?? boundServices[0];

      if (source === 'deployments') {
        if (!supportsLogsDeploymentsProvider(provider)) {
          throw new HvError('UNSUPPORTED', logsDeploymentsUnsupportedMessage(provider));
        }
        const deployments = await fetchProviderDeployments(provider, project, environment, service, limit ?? 10);
        return toolSuccess({ source, provider, environment: environment.name, deployments });
      }

      if (!serviceName) {
        throw new HvError('NOT_FOUND', 'No services bound in this environment.', {
          hint: 'Deploy first with hv_apply, or pass service explicitly.',
        });
      }

      if (source === 'build') {
        if (!supportsLogsBuildProvider(provider)) {
          throw new HvError('UNSUPPORTED', logsBuildUnsupportedMessage(provider));
        }
        const result = await fetchProviderBuildLogs(provider, project, environment, serviceName, deploymentId);
        return toolSuccess({ source, provider, service: serviceName, ...result });
      }

      const { logs, deploymentStatus } = await fetchProviderLogs(
        provider,
        project,
        environment,
        serviceName,
        limit ?? 100,
        { errorsOnly }
      );
      return toolSuccess({
        source,
        provider,
        environment: environment.name,
        service: serviceName,
        deploymentStatus,
        count: logs.length,
        logs,
      });
    })
  );

  server.tool(
    'hv_errors',
    'Surface production errors: list recent error log lines, summarize error health per service, or manage autofix-tracked error fingerprints.',
    {
      project: projectField,
      env: envField,
      action: z.enum(['list', 'summary', 'tracked', 'ignore']).optional()
        .describe('list = recent error log lines; summary = per-service error/deploy health; tracked = autofix-agent tracked errors; ignore = stop auto-fixing a tracked fingerprint. Default list.'),
      limit: z.number().int().min(1).max(200).optional().describe('Max errors for list/tracked (default 20)'),
      fingerprint: z.string().optional().describe('action=ignore: tracked error fingerprint'),
      status: z.enum(['all', 'new', 'pr_created', 'ignored']).optional().describe('action=tracked: filter by status'),
    },
    wrapHandler(async ({ project: projectRef, env, action = 'list', limit = 20, fingerprint, status }) => {
      if (action === 'tracked' || action === 'ignore') {
        if (action === 'ignore') {
          if (!fingerprint) {
            throw new HvError('VALIDATION', 'fingerprint is required for action=ignore.');
          }
          const error = stateManager.getError(fingerprint);
          if (!error) {
            return toolError('NOT_FOUND', `Tracked error not found: ${fingerprint}`);
          }
          stateManager.updateErrorStatus(fingerprint, 'ignored');
          stateManager.save();
          return toolSuccess({ fingerprint, ...stateManager.getError(fingerprint) });
        }

        let entries: Array<[string, TrackedError]> = Object.entries(stateManager.getAllErrors());
        if (status && status !== 'all') {
          entries = entries.filter(([, e]) => e.status === status);
        }
        entries.sort((a, b) => new Date(b[1].lastSeen).getTime() - new Date(a[1].lastSeen).getTime());
        return toolSuccess({
          totalCount: entries.length,
          errors: entries.slice(0, limit).map(([fp, e]) => ({ fingerprint: fp, ...e })),
        });
      }

      const { project, environment, provider } = resolveEnvOrThrow(ctx, projectRef, env);
      if (action === 'summary') {
        const summary = await collectErrorsSummary(provider, project, environment);
        return toolSuccess({ environment: environment.name, provider, ...summary });
      }

      const { errors, totalFound } = await collectRecentErrors(provider, project, environment, limit);
      return toolSuccess({
        environment: environment.name,
        provider,
        totalFound,
        errors,
      });
    })
  );

  server.tool(
    'hv_health',
    'HTTP health-check a deployed service (uses the stored healthCheckPath by default) or an explicit URL.',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service name (defaults to web or the first web service)'),
      url: z.string().url().optional().describe('Explicit URL to check instead of resolving from bindings'),
      path: z.string().optional().describe('Path to check (defaults to the service healthCheckPath or /)'),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
    },
    wrapHandler(async ({ project: projectRef, env, service, url, path, timeoutMs = 20000 }) => {
      let baseUrl: string;
      let healthPath = path;
      let resolvedService: string | undefined;

      if (url) {
        baseUrl = normalizeBaseUrl(url);
      } else {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        const environment = env
          ? ctx.resolveEnvironmentOrThrow(project, env)
          : resolveHealthEnvironment(project.id);
        if (!environment) {
          throw new HvError('NOT_FOUND', 'No environment found to check.', { hint: 'Pass env explicitly.' });
        }
        const svc = resolveHealthService(project.id, service);
        if (!svc) {
          throw new HvError('NOT_FOUND', service ? `Service not found: ${service}` : 'No services found.');
        }
        resolvedService = svc.name;
        const resolved = resolveServiceBaseUrl(environment, svc.name);
        if (!resolved) {
          throw new HvError('NOT_FOUND', `Service "${svc.name}" has no URL binding in ${environment.name}.`, {
            hint: 'Deploy it first with hv_apply or hv_deploy.',
          });
        }
        baseUrl = resolved;
        healthPath = healthPath ?? svc.buildConfig.healthCheckPath ?? '/';
      }

      const check = await runHttpCheck({
        name: 'health',
        url: joinUrl(baseUrl, healthPath ?? '/'),
        method: 'GET',
        timeoutMs,
        followRedirects: false,
        expectedStatusMin: 200,
        expectedStatusMax: 399,
        bodyPreviewBytes: 2048,
      });

      return toolSuccess(
        { service: resolvedService, baseUrl, check },
        { hint: check.ok ? undefined : 'Check hv_logs source="service" errorsOnly=true for the failing service.' }
      );
    })
  );
}
