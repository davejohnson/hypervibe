import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { serviceWorkloadKind } from '../domain/entities/service.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Service } from '../domain/entities/service.entity.js';
import { hostingProviderForEnvironment, providerDisplayName } from '../domain/services/hosting-env.service.js';
import { resolveProjectOrError } from './resolve-project.js';

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

function response(data: Record<string, unknown>) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data),
    }],
  };
}

function resolveEnvironment(projectId: string, environmentName?: string): Environment | null {
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

function resolveService(projectId: string, serviceName?: string): Service | null {
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

function normalizeBaseUrl(urlOrHost: string): string {
  const parsed = new URL(withHttps(urlOrHost));
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}`;
}

function resolveServiceBaseUrl(environment: Environment, serviceName: string): string | null {
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

async function runHttpCheck(params: {
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

export function registerHealthTools(server: McpServer): void {
  server.tool(
    'health_check',
    'Check a deployed service URL or explicit URL. Uses the stored service healthCheckPath by default and can also smoke-test the root route.',
    {
      projectId: z.string().uuid().optional().describe('Project ID. Optional when url is provided.'),
      projectName: z.string().optional().describe('Project name. Optional when url is provided.'),
      environmentName: z.string().optional().describe('Environment name (defaults to production/prod/staging).'),
      serviceName: z.string().optional().describe('Service name (defaults to web or first web service).'),
      url: z.string().url().optional().describe('Explicit base URL or full URL to check instead of resolving from project bindings.'),
      path: z.string().optional().describe('Path to check. Defaults to service buildConfig.healthCheckPath or /.'),
      includeRoot: z.boolean().optional().describe('Also check /. Defaults true when resolving a project service with a non-root health path.'),
      method: z.enum(['GET', 'HEAD']).optional().describe('HTTP method to use (default GET).'),
      followRedirects: z.boolean().optional().describe('Follow HTTP redirects before reporting status (default false).'),
      timeoutMs: z.number().int().min(1000).max(60000).optional().describe('Per-request timeout in milliseconds (default 20000).'),
      expectedStatusMin: z.number().int().min(100).max(599).optional().describe('Minimum acceptable HTTP status (default 200).'),
      expectedStatusMax: z.number().int().min(100).max(599).optional().describe('Maximum acceptable HTTP status (default 399).'),
      bodyPreviewBytes: z.number().int().min(0).max(10000).optional().describe('Maximum response body bytes to return per check (default 2048).'),
    },
    async ({
      projectId,
      projectName,
      environmentName,
      serviceName,
      url,
      path,
      includeRoot,
      method = 'GET',
      followRedirects = false,
      timeoutMs = 20000,
      expectedStatusMin = 200,
      expectedStatusMax = 399,
      bodyPreviewBytes = 2048,
    }) => {
      if (expectedStatusMin > expectedStatusMax) {
        return response({
          success: false,
          error: 'expectedStatusMin must be less than or equal to expectedStatusMax',
        });
      }

      let project: Project | null = null;
      let environment: Environment | null = null;
      let service: Service | null = null;
      let provider: string | undefined;
      let baseUrl: string;
      let healthPath = path;
      let explicitTargetUrl: string | undefined;

      if (url) {
        const explicitUrl = new URL(url);
        explicitTargetUrl = explicitUrl.toString();
        baseUrl = normalizeBaseUrl(`${explicitUrl.origin}${explicitUrl.pathname === '/' ? '' : explicitUrl.pathname}${path ? '' : explicitUrl.search}`);
        healthPath = path ?? (explicitUrl.pathname && explicitUrl.pathname !== '/' ? explicitUrl.pathname : '/');
      } else {
        const resolved = resolveProjectOrError({ projectId, projectName });
        if ('error' in resolved) return resolved.error;
        project = resolved.project;

        environment = resolveEnvironment(project.id, environmentName);
        if (!environment) {
          return response({ success: false, error: `No environment found for project ${project.name}` });
        }

        service = resolveService(project.id, serviceName);
        if (!service) {
          return response({ success: false, error: `No service found for project ${project.name}` });
        }

        provider = hostingProviderForEnvironment(project, environment);
        const resolvedBaseUrl = resolveServiceBaseUrl(environment, service.name);
        if (!resolvedBaseUrl) {
          return response({
            success: false,
            error: `No public URL is stored for service ${service.name} in ${environment.name}. Redeploy or provide url explicitly.`,
            project: project.name,
            environment: environment.name,
            service: service.name,
            provider,
          });
        }

        baseUrl = resolvedBaseUrl;
        healthPath = healthPath ?? service.buildConfig.healthCheckPath ?? '/';
      }

      const normalizedHealthPath = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
      const shouldIncludeRoot = includeRoot ?? (!url && normalizedHealthPath !== '/');
      const checksToRun = [
        {
          name: 'health',
          url: explicitTargetUrl && !path ? explicitTargetUrl : joinUrl(baseUrl, normalizedHealthPath),
        },
        ...(shouldIncludeRoot && normalizedHealthPath !== '/'
          ? [{ name: 'root', url: joinUrl(baseUrl, '/') }]
          : []),
      ];

      const checks = await Promise.all(checksToRun.map((check) => runHttpCheck({
        ...check,
        method,
        timeoutMs,
        followRedirects,
        expectedStatusMin,
        expectedStatusMax,
        bodyPreviewBytes,
      })));
      const success = checks.every((check) => check.ok);

      return response({
        success,
        project: project?.name,
        environment: environment?.name,
        service: service?.name,
        provider,
        providerName: provider ? providerDisplayName(provider) : undefined,
        baseUrl,
        path: normalizedHealthPath,
        checks,
        message: success
          ? `Health check passed for ${checks.length} URL${checks.length === 1 ? '' : 's'}`
          : `Health check failed for ${checks.filter((check) => !check.ok).length}/${checks.length} URL${checks.length === 1 ? '' : 's'}`,
      });
    }
  );
}
