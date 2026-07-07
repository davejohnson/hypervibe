import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { StripeAdapter } from '../../adapters/providers/stripe/stripe.adapter.js';
import type { StripeCredentials, StripeMode } from '../../adapters/providers/stripe/stripe.adapter.js';
import { adapterFactory } from './adapter.factory.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import type { Project } from '../entities/project.entity.js';
import { NotSupportedError } from '../errors/not-supported.error.js';
import { providerRegistry } from '../registry/provider.registry.js';

const connectionRepo = new ConnectionRepository();

type UnifiedLog = {
  timestamp: string;
  severity: string;
  message: string;
};

type EnvironmentLike = {
  platformBindings: unknown;
  name: string;
};

export function detectProviderName(projectDefaultPlatform: string | undefined, bindingsProvider: string | undefined): string {
  return (bindingsProvider || projectDefaultPlatform || 'cloudrun').toLowerCase();
}

export function isErrorLike(log: UnifiedLog): boolean {
  const message = log.message.toLowerCase();
  const severity = (log.severity || '').toLowerCase();
  return (
    severity === 'error' ||
    severity === 'warn' ||
    message.includes('error') ||
    message.includes('exception') ||
    message.includes('failed') ||
    message.includes('crash') ||
    message.includes('fatal')
  );
}

export function supportsLogsDeploymentsProvider(provider: string): boolean {
  return Boolean(providerRegistry.getMetadata(provider.toLowerCase())?.orchestration?.logs?.deployments);
}

export function supportsLogsBuildProvider(provider: string): boolean {
  return Boolean(providerRegistry.getMetadata(provider.toLowerCase())?.orchestration?.logs?.build);
}

export function logsDeploymentsUnsupportedMessage(provider: string): string {
  const supported = providerRegistry.all()
    .filter((entry) => entry.metadata.orchestration?.logs?.deployments)
    .map((entry) => entry.metadata.name)
    .sort();
  return `logs_deployments currently supports ${supported.join(', ') || '(none)'} only (provider: ${provider}).`;
}

export function logsBuildUnsupportedMessage(provider: string): string {
  const supported = providerRegistry.all()
    .filter((entry) => entry.metadata.orchestration?.logs?.build)
    .map((entry) => entry.metadata.name)
    .sort();
  return `logs_build currently supports ${supported.join(', ') || '(none)'} only (provider: ${provider}).`;
}

export async function fetchProviderLogs(
  provider: string,
  project: Project,
  environment: EnvironmentLike,
  serviceName: string,
  lines: number,
  options: { errorsOnly?: boolean } = {}
): Promise<{ deploymentStatus?: string; deploymentId?: string; logs: UnifiedLog[] }> {
  const bindings = environment.platformBindings as {
    projectId?: string;
    environmentId?: string;
    services?: Record<string, { serviceId: string }>;
  };

  const result = await adapterFactory.getProviderAdapter(provider, project);
  if (!result.success || !result.adapter) {
    throw new Error(result.error || `Failed to create ${provider} adapter`);
  }
  const adapter = result.adapter as unknown as {
    getDeployments?: (
      projectId: string,
      environmentId: string,
      serviceId: string | undefined,
      limit: number
    ) => Promise<Array<{ id: string; status: string; createdAt?: string; staticUrl?: string }>>;
    getDeploymentLogs?: (
      deploymentId: string,
      limit: number
    ) => Promise<Array<{ timestamp: string; severity?: string; message: string }>>;
    getLogs?: (
      environment: { platformBindings: unknown; name: string },
      serviceName: string,
      options?: { limit?: number; errorsOnly?: boolean }
    ) => Promise<Array<{ timestamp: Date; severity: string; message: string; raw: string }>>;
    getDeployStatus?: (
      environment: { platformBindings: unknown; name: string },
      deploymentId: string
    ) => Promise<{ status: string; url?: string }>;
  };

  if (typeof adapter.getDeployments === 'function' && typeof adapter.getDeploymentLogs === 'function') {
    if (!bindings.projectId || !bindings.environmentId || !bindings.services?.[serviceName]) {
      throw new Error(`Environment/service not fully bound to ${provider}`);
    }
    const deployments = await adapter.getDeployments(
      bindings.projectId,
      bindings.environmentId,
      bindings.services[serviceName].serviceId,
      1
    );
    if (deployments.length === 0) {
      return { logs: [] };
    }

    const latestDeployment = deployments[0];
    const logs = await adapter.getDeploymentLogs(latestDeployment.id, lines);
    return {
      deploymentStatus: latestDeployment.status,
      deploymentId: latestDeployment.id,
      logs: logs.map((l) => ({
        timestamp: l.timestamp,
        severity: l.severity || 'info',
        message: l.message,
      })),
    };
  }

  if (typeof adapter.getLogs === 'function') {
    const deploymentId = bindings.services?.[serviceName]?.serviceId;
    const logs = await adapter.getLogs(environment, serviceName, { limit: lines, errorsOnly: options.errorsOnly });
    const status = deploymentId && typeof adapter.getDeployStatus === 'function'
      ? await adapter.getDeployStatus(environment, deploymentId)
      : undefined;
    return {
      deploymentStatus: status?.status ?? 'unknown',
      deploymentId,
      logs: logs.map((log) => ({
        timestamp: log.timestamp.toISOString(),
        severity: log.severity || 'info',
        message: log.message,
      })),
    };
  }

  throw new NotSupportedError(provider, 'log reads');
}

export type ProviderDeployment = {
  id: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  service?: string;
  type?: string;
  logUri?: string;
};

/**
 * List recent deployments for an environment (optionally narrowed to one
 * service) across the supported hosting providers. Throws on resolution and
 * provider failures with the same messages the legacy tools returned.
 */
export async function fetchProviderDeployments(
  provider: string,
  project: Project,
  environment: EnvironmentLike,
  serviceName: string | undefined,
  limit: number
): Promise<ProviderDeployment[]> {
  const bindings = environment.platformBindings as {
    projectId?: string;
    environmentId?: string;
    services?: Record<string, { serviceId: string }>;
  };

  const result = await adapterFactory.getProviderAdapter(provider, project);
  if (!result.success || !result.adapter) {
    throw new Error(result.error || `Failed to create ${provider} adapter`);
  }
  const adapter = result.adapter as unknown as {
    listDeployments?: (
      environment: { platformBindings: unknown; name: string },
      serviceName?: string,
      limit?: number
    ) => Promise<ProviderDeployment[]>;
    getDeployments?: (
      projectId: string,
      environmentId: string,
      serviceId: string | undefined,
      limit: number
    ) => Promise<Array<{ id: string; status: string; createdAt?: string; staticUrl?: string }>>;
  };

  if (typeof adapter.listDeployments === 'function') {
    return adapter.listDeployments(environment, serviceName, limit);
  }

  if (typeof adapter.getDeployments === 'function') {
    if (!bindings.projectId || !bindings.environmentId) {
      throw new Error(`Environment not deployed to ${provider}`);
    }
    const serviceId = serviceName && bindings.services?.[serviceName]
      ? bindings.services[serviceName].serviceId
      : undefined;
    const deployments = await adapter.getDeployments(
      bindings.projectId,
      bindings.environmentId,
      serviceId,
      limit
    );
    return deployments.map((deployment) => ({
      id: deployment.id,
      status: deployment.status,
      createdAt: deployment.createdAt,
      url: deployment.staticUrl,
    }));
  }

  throw new NotSupportedError(provider, 'deployment listing', logsDeploymentsUnsupportedMessage(provider));
}

/**
 * Get build logs for a deployment (latest by default) across the supported
 * hosting providers. Throws on resolution and provider failures.
 */
export async function fetchProviderBuildLogs(
  provider: string,
  project: Project,
  environment: EnvironmentLike,
  serviceName: string,
  deploymentId?: string
): Promise<{ deploymentId: string; buildLogs: string }> {
  const bindings = environment.platformBindings as {
    projectId?: string;
    environmentId?: string;
    services?: Record<string, { serviceId: string }>;
  };

  const result = await adapterFactory.getProviderAdapter(provider, project);
  if (!result.success || !result.adapter) {
    throw new Error(result.error || `Failed to create ${provider} adapter`);
  }
  const adapter = result.adapter as unknown as {
    getBuildLogs?: (deploymentId: string) => Promise<string>;
    getDeployments?: (
      projectId: string,
      environmentId: string,
      serviceId: string | undefined,
      limit: number
    ) => Promise<Array<{ id: string; status: string }>>;
  };
  if (typeof adapter.getBuildLogs !== 'function' || typeof adapter.getDeployments !== 'function') {
    throw new NotSupportedError(provider, 'build log reads', logsBuildUnsupportedMessage(provider));
  }
  if (!bindings.projectId || !bindings.environmentId) {
    throw new Error(`Environment not deployed to ${provider}`);
  }

  let targetDeploymentId = deploymentId;
  if (!targetDeploymentId) {
    const deployments = await adapter.getDeployments(
      bindings.projectId,
      bindings.environmentId,
      bindings.services?.[serviceName]?.serviceId,
      1
    );
    if (deployments.length === 0) {
      throw new Error('No deployments found for service');
    }
    targetDeploymentId = deployments[0].id;
  }

  const buildLogs = await adapter.getBuildLogs(targetDeploymentId);
  return { deploymentId: targetDeploymentId, buildLogs: buildLogs || 'No build logs available' };
}

/**
 * Collect recent error-like log lines across every bound service in an
 * environment, newest first.
 */
export async function collectRecentErrors(
  provider: string,
  project: Project,
  environment: EnvironmentLike,
  limit: number
): Promise<{
  errors: Array<{ service: string; timestamp: string; message: string; severity?: string }>;
  totalFound: number;
}> {
  const bindings = environment.platformBindings as {
    services?: Record<string, { serviceId: string }>;
  };

  const allErrors: Array<{ service: string; timestamp: string; message: string; severity?: string }> = [];
  for (const serviceName of Object.keys(bindings.services ?? {})) {
    const { logs } = await fetchProviderLogs(provider, project, environment, serviceName, 500);
    for (const error of logs.filter(isErrorLike)) {
      allErrors.push({
        service: serviceName,
        timestamp: error.timestamp,
        message: error.message,
        severity: error.severity,
      });
    }
  }

  allErrors.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return { errors: allErrors.slice(0, limit), totalFound: allErrors.length };
}

export type ServiceErrorsSummary = {
  summary: {
    totalServices: number;
    totalErrors: number;
    failedDeployments: number;
    healthyServices: number;
  };
  services: Array<{
    service: string;
    deploymentStatus: string;
    errorCount: number;
    recentErrors: Array<{ timestamp: string; message: string }>;
  }>;
};

/** Summarize recent errors per bound service in an environment. */
export async function collectErrorsSummary(
  provider: string,
  project: Project,
  environment: EnvironmentLike
): Promise<ServiceErrorsSummary> {
  const bindings = environment.platformBindings as {
    services?: Record<string, { serviceId: string }>;
  };

  const serviceErrors: ServiceErrorsSummary['services'] = [];
  for (const serviceName of Object.keys(bindings.services ?? {})) {
    const { deploymentStatus, logs } = await fetchProviderLogs(provider, project, environment, serviceName, 200);
    const errors = logs.filter(isErrorLike);

    serviceErrors.push({
      service: serviceName,
      deploymentStatus: deploymentStatus ?? 'unknown',
      errorCount: errors.length,
      recentErrors: errors.slice(0, 5).map((e) => ({
        timestamp: e.timestamp,
        message: e.message.substring(0, 200),
      })),
    });
  }

  const totalErrors = serviceErrors.reduce((sum, s) => sum + s.errorCount, 0);
  const failedDeployments = serviceErrors.filter((s) =>
    s.deploymentStatus === 'FAILED' || s.deploymentStatus === 'CRASHED'
  );

  return {
    summary: {
      totalServices: serviceErrors.length,
      totalErrors,
      failedDeployments: failedDeployments.length,
      healthyServices: serviceErrors.filter((s) => s.errorCount === 0 && s.deploymentStatus === 'SUCCESS').length,
    },
    services: serviceErrors,
  };
}

/** Check the status of Stripe webhook endpoints. Throws if Stripe is not connected. */
export async function fetchStripeWebhookStatuses(
  mode: 'sandbox' | 'live',
  webhookId?: string
): Promise<Array<{ id: string; url: string; status: string; enabledEvents: number; description?: string | null }>> {
  const connection = connectionRepo.findByProvider('stripe');
  if (!connection) {
    throw new Error(`No Stripe connection found. ${formatConnectionGuidance('stripe')}`);
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<StripeCredentials>(connection.credentialsEncrypted);
  const adapter = new StripeAdapter();
  adapter.connect(credentials);

  const webhooks = await adapter.listWebhookEndpoints(mode as StripeMode);
  return webhooks
    .filter((w) => !webhookId || w.id === webhookId)
    .map((w) => ({
      id: w.id,
      url: w.url,
      status: w.status,
      enabledEvents: w.enabled_events.length,
      description: w.description,
    }));
}
