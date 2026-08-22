import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { serviceWorkloadKind } from '../entities/service.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { Service } from '../entities/service.entity.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import { adapterFactory } from './adapter.factory.js';

const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

type HealthCheckResult = {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  statusText?: string;
  latencyMs: number;
  redirected?: boolean;
  finalUrl?: string;
  headers?: Record<string, string>;
  setCookie?: {
    count: number;
    headers: string[];
  };
  json?: unknown;
  bodyPreview?: string;
  bodyTruncated?: boolean;
  error?: string;
};

export type DeploymentHealthState = 'healthy' | 'failed' | 'unknown';

export type ProjectDeploymentHealth = {
  state: DeploymentHealthState;
  environments: Array<{
    environment: string;
    provider: string;
    state: DeploymentHealthState;
    services: Array<{
      service: string;
      state: DeploymentHealthState;
      status: string;
      url?: string;
      reason?: string;
    }>;
    reason?: string;
  }>;
  failures: Array<{
    environment: string;
    provider: string;
    service: string;
    status: string;
  }>;
};

const FAILED_DEPLOYMENT_STATUSES = new Set([
  'canceled',
  'cancelled',
  'crash',
  'crashed',
  'error',
  'failed',
  'failure',
  'update_failed',
]);

const HEALTHY_DEPLOYMENT_STATUSES = new Set([
  'active',
  'deployed',
  'live',
  'ready',
  'running',
  'success',
  'succeeded',
]);

export function classifyDeploymentStatus(status: string): DeploymentHealthState {
  const normalized = status.trim().toLowerCase();
  if (FAILED_DEPLOYMENT_STATUSES.has(normalized)) return 'failed';
  if (HEALTHY_DEPLOYMENT_STATUSES.has(normalized)) return 'healthy';
  return 'unknown';
}

/**
 * Observe the latest bound deployment for every service/environment without
 * turning unsupported reads or provider failures into healthy state.
 */
export async function collectProjectDeploymentHealth(params: {
  project: Project;
  environments: Environment[];
  desiredServiceNamesByEnvironment: Record<string, readonly string[]>;
}): Promise<ProjectDeploymentHealth> {
  const environmentResults: ProjectDeploymentHealth['environments'] = [];

  for (const environment of [...params.environments].sort((a, b) => a.name.localeCompare(b.name))) {
    const bindings = parseHostingBindings(environment);
    const provider = bindings.provider ?? params.project.defaultPlatform ?? 'cloudrun';
    const desiredServiceNames = [...new Set(
      params.desiredServiceNamesByEnvironment[environment.name] ?? []
    )].sort((a, b) => a.localeCompare(b));
    if (desiredServiceNames.length === 0) {
      environmentResults.push({
        environment: environment.name,
        provider,
        state: 'unknown',
        services: [],
        reason: 'No current desired services are available for deployment observation.',
      });
      continue;
    }

    const resolved = await adapterFactory.getHostingAdapterByName(provider, params.project);
    if (!resolved.success || !resolved.adapter || typeof resolved.adapter.getDeployStatus !== 'function') {
      const reason = resolved.success
        ? `${provider} does not support deployment-status observation.`
        : `No verified ${provider} hosting connection is available for deployment-status observation.${resolved.error ? ` ${resolved.error}` : ''}`;
      environmentResults.push({
        environment: environment.name,
        provider,
        state: 'unknown',
        services: desiredServiceNames.map((service) => ({
          service,
          state: 'unknown',
          status: 'unknown',
          reason,
        })),
        reason,
      });
      continue;
    }

    const services = [] as ProjectDeploymentHealth['environments'][number]['services'];
    for (const service of desiredServiceNames) {
      const serviceId = bindings.services?.[service]?.serviceId;
      if (!serviceId) {
        services.push({
          service,
          state: 'unknown',
          status: 'unknown',
          reason: `No provider binding is recorded for desired service "${service}".`,
        });
        continue;
      }
      try {
        const observed = await resolved.adapter.getDeployStatus(environment, serviceId);
        const state = classifyDeploymentStatus(observed.status);
        services.push({
          service,
          state,
          status: observed.status,
          ...(observed.url ? { url: observed.url } : {}),
          ...(observed.reason
            ? { reason: observed.reason }
            : state === 'unknown'
              ? { reason: `${provider} returned deployment status "${observed.status}".` }
              : {}),
        });
      } catch (error) {
        services.push({
          service,
          state: 'unknown',
          status: 'unknown',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const state = services.some((service) => service.state === 'failed')
      ? 'failed'
      : services.every((service) => service.state === 'healthy')
        ? 'healthy'
        : 'unknown';
    const unknownReason = state === 'unknown'
      ? services
        .filter((service) => service.state === 'unknown')
        .map((service) => `${service.service}: ${service.reason ?? `status ${service.status}`}`)
        .join('; ')
      : undefined;
    environmentResults.push({
      environment: environment.name,
      provider,
      state,
      services,
      ...(unknownReason ? { reason: unknownReason } : {}),
    });
  }

  const failures = environmentResults.flatMap((environment) =>
    environment.services
      .filter((service) => service.state === 'failed')
      .map((service) => ({
        environment: environment.environment,
        provider: environment.provider,
        service: service.service,
        status: service.status,
      }))
  );

  return {
    state: failures.length > 0
      ? 'failed'
      : environmentResults.length > 0
        && environmentResults.every((environment) => environment.state === 'healthy')
        ? 'healthy'
        : 'unknown',
    environments: environmentResults,
    failures,
  };
}

export function resolveHealthEnvironment(projectId: string, environmentName?: string): Environment | null {
  if (environmentName) {
    return envRepo.findByProjectAndName(projectId, environmentName);
  }

  for (const candidate of ['production', 'prod', 'staging']) {
    const environment = envRepo.findByProjectAndName(projectId, candidate);
    if (environment) return environment;
  }

  const environments = envRepo.findByProjectId(projectId);
  return environments.find((environment) => environment.name !== 'local') ?? environments[0] ?? null;
}

export function resolveHealthService(projectId: string, serviceName?: string): Service | null {
  if (serviceName) {
    return serviceRepo.findByProjectAndName(projectId, serviceName);
  }

  return serviceRepo.findByProjectAndName(projectId, 'web')
    ?? serviceRepo.findByProjectId(projectId).find((service) => serviceWorkloadKind(service) === 'web')
    ?? serviceRepo.findByProjectId(projectId)[0]
    ?? null;
}

function withHttps(urlOrHost: string): string {
  const trimmed = urlOrHost.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function normalizeBaseUrl(urlOrHost: string): string {
  const parsed = new URL(withHttps(urlOrHost));
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

export function joinUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}`;
}

export function resolveServiceBaseUrl(
  environment: Environment,
  serviceName: string,
  declaredDomain?: string
): string | null {
  const bindings = parseHostingBindings(environment);
  const serviceBinding = bindings.services?.[serviceName];
  const candidate = serviceBinding?.url ?? serviceBinding?.customDomains?.[0];
  if (candidate) {
    return normalizeBaseUrl(candidate);
  }

  const domainBindings = environment.platformBindings.domains;
  for (const [domain, domainBinding] of Object.entries(
    domainBindings && typeof domainBindings === 'object' && !Array.isArray(domainBindings)
      ? domainBindings
      : {}
  )) {
    if (!domainBinding || typeof domainBinding !== 'object' || Array.isArray(domainBinding)) continue;
    if (domainBinding?.service === serviceName) {
      return normalizeBaseUrl(domain);
    }
  }

  if (declaredDomain) {
    return normalizeBaseUrl(declaredDomain);
  }

  return null;
}

function maskSetCookieHeader(header: string): string {
  const [nameValue, ...attributes] = header.split(';');
  const cookieName = nameValue.split('=')[0]?.trim() || 'cookie';
  return [`${cookieName}=***`, ...attributes.map((part) => part.trim()).filter(Boolean)].join('; ');
}

function getSetCookieHeaders(headers: Headers): string[] {
  const extendedHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extendedHeaders.getSetCookie === 'function') {
    return extendedHeaders.getSetCookie();
  }

  const header = headers.get('set-cookie');
  return header ? [header] : [];
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = key.toLowerCase() === 'set-cookie' ? maskSetCookieHeader(value) : value;
  });
  return result;
}

function parseJsonPreview(text: string, contentType: string | null): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!contentType?.toLowerCase().includes('json') && !/^[{[]/.test(trimmed)) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export async function runHttpCheck(params: {
  name: string;
  url: string;
  method: 'GET' | 'HEAD';
  timeoutMs: number;
  followRedirects: boolean;
  expectedStatusMin: number;
  expectedStatusMax: number;
  bodyPreviewBytes: number;
}): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const fetchResponse = await fetch(params.url, {
      method: params.method,
      redirect: params.followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const setCookieHeaders = getSetCookieHeaders(fetchResponse.headers);
    const body = params.method === 'HEAD' ? '' : await fetchResponse.text();
    const bodyPreview = body.slice(0, params.bodyPreviewBytes);
    const json = parseJsonPreview(body, fetchResponse.headers.get('content-type'));
    const ok = fetchResponse.status >= params.expectedStatusMin && fetchResponse.status <= params.expectedStatusMax;

    return {
      name: params.name,
      url: params.url,
      ok,
      status: fetchResponse.status,
      statusText: fetchResponse.statusText,
      latencyMs,
      redirected: fetchResponse.redirected,
      finalUrl: fetchResponse.url,
      headers: headersToObject(fetchResponse.headers),
      setCookie: {
        count: setCookieHeaders.length,
        headers: setCookieHeaders.map(maskSetCookieHeader),
      },
      ...(json !== undefined ? { json } : {}),
      ...(bodyPreview ? { bodyPreview } : {}),
      ...(body.length > params.bodyPreviewBytes ? { bodyTruncated: true } : {}),
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error && error.name === 'AbortError'
      ? `Timed out after ${params.timeoutMs}ms`
      : error instanceof Error ? error.message : String(error);
    return {
      name: params.name,
      url: params.url,
      ok: false,
      latencyMs,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}
