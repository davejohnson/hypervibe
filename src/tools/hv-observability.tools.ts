import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import { detectProviderName } from '../domain/services/provider-logs.service.js';
import {
  fetchProviderLogs,
  fetchProviderDeployments,
  fetchProviderBuildLogs,
  supportsLogsDeploymentsProvider,
  supportsLogsBuildProvider,
  logsDeploymentsUnsupportedMessage,
  logsBuildUnsupportedMessage,
} from '../domain/services/provider-logs.service.js';
import { fetchStripeWebhookStatuses } from '../domain/services/stripe-ops.service.js';
import { stripeEnvironmentName } from '../domain/services/stripe-env.service.js';
import {
  resolveHealthEnvironment,
  resolveHealthService,
  normalizeBaseUrl,
  joinUrl,
  resolveServiceBaseUrl,
  runHttpCheck,
  collectProjectDeploymentHealth,
} from '../domain/services/health.service.js';
import type { CommandContext } from '../application/context.js';
import { projectField, envField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler, HvError } from '../application/results.js';
import { SpecStore } from '../domain/spec/spec.store.js';

function resolveEnvOrThrow(ctx: CommandContext, projectRef: string | undefined, envName: string | undefined) {
  const project = ctx.resolveProjectOrThrow({ project: projectRef });
  const environment = ctx.resolveEnvironmentOrThrow(project, envName);
  const bindings = environment.platformBindings as { provider?: string; services?: Record<string, { serviceId: string }> };
  const provider = detectProviderName(project.defaultPlatform, bindings.provider);
  return { project, environment, bindings, provider };
}

export function registerHvObservabilityTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
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
      mode: z.enum(['sandbox', 'live']).optional().describe('source=stripe-webhooks only: optional assertion against the selected environment-scoped connection mode'),
    },
    wrapCommandHandler(async ({ project: projectRef, env, service, source, limit, errorsOnly, deploymentId, mode }) => {
      if (source === 'stripe-webhooks') {
        if (!projectRef || !env) {
          throw new HvError('VALIDATION', 'Stripe webhook inspection requires explicit project and env selectors.', {
            hint: 'Pass the Hypervibe project and environment whose payments.stripe connection should be inspected.',
          });
        }
        const invalid = [
          service !== undefined ? 'service' : undefined,
          limit !== undefined ? 'limit' : undefined,
          errorsOnly !== undefined ? 'errorsOnly' : undefined,
          deploymentId !== undefined ? 'deploymentId' : undefined,
        ].filter((field): field is string => Boolean(field));
        if (invalid.length > 0) {
          throw new HvError('VALIDATION', 'Stripe webhook inspection received selectors for another log source.', {
            details: { invalid },
            hint: 'Use only project, env, source="stripe-webhooks", and optional mode.',
          });
        }
        const { project, environment } = resolveEnvOrThrow(ctx, projectRef, env);
        const environmentSpec = new SpecStore().get(project)?.spec.environments[environment.name];
        const stripeEnvironment = environmentSpec?.payments?.stripe
          ? stripeEnvironmentName(environment.name, environmentSpec.payments.stripe)
          : environment.name;
        const result = await fetchStripeWebhookStatuses(stripeEnvironment, mode);
        if (!result.success) {
          throw new HvError(result.code, result.error, {
            next: result.code === 'MISSING_CONNECTION' ? ['hv_connections'] : undefined,
          });
        }
        return commandSuccess({
          source,
          project: project.name,
          environment: environment.name,
          stripeEnvironment,
          mode: result.mode,
          webhooks: result.webhooks,
        });
      }

      const invalid = source === 'service'
        ? [deploymentId !== undefined ? 'deploymentId' : undefined, mode !== undefined ? 'mode' : undefined]
        : source === 'build'
          ? [limit !== undefined ? 'limit' : undefined, errorsOnly !== undefined ? 'errorsOnly' : undefined, mode !== undefined ? 'mode' : undefined]
          : [errorsOnly !== undefined ? 'errorsOnly' : undefined, deploymentId !== undefined ? 'deploymentId' : undefined, mode !== undefined ? 'mode' : undefined];
      const invalidFields = invalid.filter((field): field is string => Boolean(field));
      if (invalidFields.length > 0) {
        throw new HvError('VALIDATION', `${source} logs received selectors for another log source.`, {
          details: { invalid: invalidFields },
          hint: 'Remove the listed selectors or choose the matching source.',
        });
      }

      const { project, environment, bindings, provider } = resolveEnvOrThrow(ctx, projectRef, env);
      const boundServices = Object.keys(bindings.services ?? {});
      const serviceName = service ?? boundServices[0];

      if (source === 'deployments') {
        if (!supportsLogsDeploymentsProvider(provider)) {
          throw new HvError('UNSUPPORTED', logsDeploymentsUnsupportedMessage(provider));
        }
        const deployments = await fetchProviderDeployments(provider, project, environment, service, limit ?? 10);
        return commandSuccess({ source, provider, environment: environment.name, deployments });
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
        return commandSuccess({ source, provider, service: serviceName, ...result });
      }

      const { logs, deploymentStatus } = await fetchProviderLogs(
        provider,
        project,
        environment,
        serviceName,
        limit ?? 100,
        { errorsOnly }
      );
      return commandSuccess({
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

  commands.register(
    'hv_health',
    'HTTP health-check a deployed service or an explicit URL. Project-backed checks also surface latest deployment failures across every bound environment when provider connections are available; unknown provider observations never count as healthy.',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service name (defaults to web or the first web service)'),
      url: z.string().url().optional().describe('Explicit URL to check instead of resolving from bindings'),
      path: z.string().optional().describe('Path to check (defaults to the service healthCheckPath or /)'),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
    },
    wrapCommandHandler(async ({ project: projectRef, env, service, url, path, timeoutMs = 20000 }) => {
      let baseUrl: string;
      let healthPath = path;
      let resolvedService: string | undefined;
      let resolvedProject: ReturnType<CommandContext['resolveProjectOrThrow']> | undefined;

      if (url) {
        baseUrl = normalizeBaseUrl(url);
      } else {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        resolvedProject = project;
        const environment = env
          ? ctx.resolveEnvironmentOrThrow(project, env)
          : resolveHealthEnvironment(project.id);
        if (!environment) {
          throw new HvError('NOT_FOUND', 'No environment found to check.', { hint: 'Pass env explicitly.' });
        }
        const storedService = resolveHealthService(project.id, service);
        const environmentSpec = new SpecStore().get(project)?.spec.environments[environment.name];
        const desiredServiceName = service
          ?? Object.entries(environmentSpec?.services ?? {}).find(([, value]) => value.workloadKind === 'web')?.[0]
          ?? Object.keys(environmentSpec?.services ?? {})[0];
        const resolvedName = storedService?.name ?? desiredServiceName;
        if (!resolvedName) {
          throw new HvError('NOT_FOUND', service ? `Service not found: ${service}` : 'No services found.');
        }
        const desiredService = environmentSpec?.services[resolvedName];
        if (!storedService && !desiredService) {
          throw new HvError('NOT_FOUND', `Service not found: ${resolvedName}`);
        }
        resolvedService = resolvedName;
        const declaredDomain = desiredService?.workloadKind === 'web'
          ? environmentSpec?.domain
          : undefined;
        const resolved = resolveServiceBaseUrl(environment, resolvedName, declaredDomain);
        if (!resolved) {
          throw new HvError('NOT_FOUND', `Service "${resolvedName}" has no URL binding in ${environment.name}.`, {
            hint: 'Deploy it first with hv_apply or hv_deploy.',
          });
        }
        baseUrl = resolved;
        healthPath = healthPath
          ?? storedService?.buildConfig.healthCheckPath
          ?? desiredService?.healthCheckPath
          ?? '/';
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

      const specEnvironmentNames = resolvedProject
        ? Object.keys(new SpecStore().get(resolvedProject)?.spec.environments ?? {})
        : [];
      const deploymentHealth = resolvedProject
        ? await collectProjectDeploymentHealth({
          project: resolvedProject,
          environments: ctx.repos.environments
            .findByProjectId(resolvedProject.id)
            .filter((environment) => specEnvironmentNames.includes(environment.name)),
        })
        : undefined;
      const deploymentFailure = deploymentHealth?.failures[0];
      const unknownEnvironments = deploymentHealth?.environments
        .filter((environment) => environment.state === 'unknown')
        .map((environment) => environment.environment) ?? [];

      return commandSuccess(
        {
          service: resolvedService,
          baseUrl,
          check,
          ...(deploymentHealth ? { deploymentHealth } : {}),
        },
        {
          hint: !check.ok
            ? 'Check hv_logs source="service" errorsOnly=true for the failing service.'
            : deploymentFailure
              ? `Latest deployment failure: ${deploymentFailure.environment}/${deploymentFailure.service} on ${deploymentFailure.provider} (${deploymentFailure.status}). Inspect that environment with hv_logs source="deployments" and source="build" where supported.`
              : undefined,
          warnings: unknownEnvironments.length > 0
            ? [`Deployment status is unknown for: ${unknownEnvironments.join(', ')}.`]
            : undefined,
        }
      );
    })
  );
}
