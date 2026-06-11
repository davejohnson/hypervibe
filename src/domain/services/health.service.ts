import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { serviceWorkloadKind } from '../entities/service.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';

const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

type ServiceBinding = {
  url?: string;
  customDomains?: string[];
};

type PlatformBindings = {
  provider?: string;
  services?: Record<string, ServiceBinding>;
  domains?: Record<string, { service?: string }>;
};

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

export function resolveServiceBaseUrl(environment: Environment, serviceName: string): string | null {
  const bindings = environment.platformBindings as PlatformBindings;
  const serviceBinding = bindings.services?.[serviceName];
  const candidate = serviceBinding?.url ?? serviceBinding?.customDomains?.[0];
  if (candidate) {
    return normalizeBaseUrl(candidate);
  }

  for (const [domain, domainBinding] of Object.entries(bindings.domains ?? {})) {
    if (domainBinding?.service === serviceName) {
      return normalizeBaseUrl(domain);
    }
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
