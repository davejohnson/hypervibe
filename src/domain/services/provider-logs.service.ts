import { adapterFactory } from './adapter.factory.js';
import { UNCONFIGURED_HOSTING_PROVIDER, type Project } from '../entities/project.entity.js';
import { NotSupportedError } from '../errors/not-supported.error.js';
import { providerRegistry } from '../registry/provider.registry.js';

type UnifiedLog = {
  timestamp: string;
  severity: string;
  message: string;
};

type EnvironmentLike = {
  platformBindings: unknown;
  name: string;
};

/** Adapter resolution failed before a provider log API could be called. */
export class ProviderLogsConnectionError extends Error {}

export interface ProviderLogsReadErrorDetails {
  message: string;
  cause?: string;
  causeCode?: string;
  httpStatus?: number;
}

function providerLogsReadErrorDetails(error: unknown): ProviderLogsReadErrorDetails {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const record = error && typeof error === 'object'
    ? error as { cause?: unknown; code?: unknown; response?: { status?: unknown } }
    : {};
  const cause = record.cause;
  const causeRecord = cause && typeof cause === 'object'
    ? cause as { message?: unknown; code?: unknown }
    : {};
  const causeMessage = cause instanceof Error
    ? cause.message.slice(0, 1000)
    : typeof causeRecord.message === 'string'
      ? causeRecord.message.slice(0, 1000)
      : undefined;
  const causeCode = typeof causeRecord.code === 'string'
    ? causeRecord.code
    : typeof record.code === 'string'
      ? record.code
      : undefined;
  const httpStatus = typeof record.response?.status === 'number'
    ? record.response.status
    : undefined;
  return {
    message,
    ...(causeMessage && causeMessage !== message ? { cause: causeMessage } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(httpStatus ? { httpStatus } : {}),
  };
}

export class ProviderLogsReadError extends Error {
  readonly details: ProviderLogsReadErrorDetails;

  constructor(
    readonly provider: string,
    readonly operation: string,
    error: unknown
  ) {
    const details = providerLogsReadErrorDetails(error);
    const cause = [
      details.message,
      details.cause,
      details.causeCode ? `code ${details.causeCode}` : undefined,
      details.httpStatus ? `HTTP ${details.httpStatus}` : undefined,
    ].filter(Boolean).join('; ');
    super(`${provider} ${operation} failed: ${cause}`);
    this.name = 'ProviderLogsReadError';
    this.details = details;
  }
}

async function readProviderOperation<T>(
  provider: string,
  operation: string,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new ProviderLogsReadError(provider, operation, error);
  }
}

function boundedProviderLogs(
  logs: UnifiedLog[],
  requestedLimit: number,
  errorsOnly: boolean
): UnifiedLog[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(requestedLimit)));
  const selected = errorsOnly ? logs.filter(isErrorLike) : logs;
  if (selected.length <= limit) return selected;
  return [...selected]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-limit);
}

export function detectProviderName(projectDefaultPlatform: string | undefined, bindingsProvider: string | undefined): string {
  return (bindingsProvider || projectDefaultPlatform || UNCONFIGURED_HOSTING_PROVIDER).toLowerCase();
}

export function isErrorLike(log: UnifiedLog): boolean {
  const message = log.message.trim();
  const normalizedMessage = message.toLowerCase();
  const severity = (log.severity || '').toLowerCase();
  if (['error', 'warn', 'warning', 'fatal', 'critical', 'alert', 'emergency'].includes(severity)) {
    return true;
  }

  // File/module names are not runtime exceptions merely because their path
  // contains "error" or "exception".
  if (
    /^(?:loading|loaded|registering|registered|importing|imported)\b/i.test(message)
    && /\b(?:errors?|exceptions?)\.[a-z0-9]+(?:\b|$)/i.test(message)
  ) {
    return false;
  }

  // Successful summaries such as "0 errors" should not be promoted to
  // failures. Strip the zero-count phrase so a separate real failure signal
  // on the same line can still win.
  const withoutZeroCounts = normalizedMessage.replace(/\b0\s+(?:errors?|failures?)\b/g, '');
  return (
    /\b(?:error|exception|failed|failure|crash(?:ed)?|fatal)\b/.test(withoutZeroCounts)
    || /\b(?:econnrefused|connection refused|unhandled rejection|uncaught exception)\b/.test(withoutZeroCounts)
    || /[A-Za-z][A-Za-z0-9]*Error(?=[:\s]|$)/.test(message)
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
    throw new ProviderLogsConnectionError(result.error || `Failed to create ${provider} adapter`);
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
    const deployments = await readProviderOperation(
      provider,
      'latest deployment lookup',
      () => adapter.getDeployments!(
        bindings.projectId!,
        bindings.environmentId!,
        bindings.services![serviceName]!.serviceId,
        1
      )
    );
    if (deployments.length === 0) {
      return { logs: [] };
    }

    const latestDeployment = deployments[0];
    const scanLimit = options.errorsOnly ? 500 : lines;
    const providerLogs = await readProviderOperation(
      provider,
      'service log read',
      () => adapter.getDeploymentLogs!(latestDeployment.id, scanLimit)
    );
    const logs = boundedProviderLogs(providerLogs.map((log) => ({
      timestamp: log.timestamp,
      severity: log.severity || 'info',
      message: log.message,
    })), lines, options.errorsOnly === true);
    return {
      deploymentStatus: latestDeployment.status,
      deploymentId: latestDeployment.id,
      logs,
    };
  }

  if (typeof adapter.getLogs === 'function') {
    const deploymentId = bindings.services?.[serviceName]?.serviceId;
    const scanLimit = options.errorsOnly ? 500 : lines;
    const providerLogs = await readProviderOperation(
      provider,
      'service log read',
      () => adapter.getLogs!(environment, serviceName, { limit: scanLimit, errorsOnly: options.errorsOnly })
    );
    const status = deploymentId && typeof adapter.getDeployStatus === 'function'
      ? await readProviderOperation(
        provider,
        'deployment status lookup',
        () => adapter.getDeployStatus!(environment, deploymentId)
      )
      : undefined;
    const logs = boundedProviderLogs(providerLogs.map((log) => ({
      timestamp: log.timestamp.toISOString(),
      severity: log.severity || 'info',
      message: log.message,
    })), lines, options.errorsOnly === true);
    return {
      deploymentStatus: status?.status ?? 'unknown',
      deploymentId,
      logs,
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
    throw new ProviderLogsConnectionError(result.error || `Failed to create ${provider} adapter`);
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
    return readProviderOperation(
      provider,
      'deployment listing',
      () => adapter.listDeployments!(environment, serviceName, limit)
    );
  }

  if (typeof adapter.getDeployments === 'function') {
    if (!bindings.projectId || !bindings.environmentId) {
      throw new Error(`Environment not deployed to ${provider}`);
    }
    const serviceId = serviceName && bindings.services?.[serviceName]
      ? bindings.services[serviceName].serviceId
      : undefined;
    const deployments = await readProviderOperation(
      provider,
      'deployment listing',
      () => adapter.getDeployments!(
        bindings.projectId!,
        bindings.environmentId!,
        serviceId,
        limit
      )
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
    throw new ProviderLogsConnectionError(result.error || `Failed to create ${provider} adapter`);
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
    const deployments = await readProviderOperation(
      provider,
      'latest deployment lookup',
      () => adapter.getDeployments!(
        bindings.projectId!,
        bindings.environmentId!,
        bindings.services?.[serviceName]?.serviceId,
        1
      )
    );
    if (deployments.length === 0) {
      throw new Error('No deployments found for service');
    }
    targetDeploymentId = deployments[0].id;
  }

  const buildLogs = await readProviderOperation(
    provider,
    'build log read',
    () => adapter.getBuildLogs!(targetDeploymentId)
  );
  return { deploymentId: targetDeploymentId, buildLogs: buildLogs || 'No build logs available' };
}
