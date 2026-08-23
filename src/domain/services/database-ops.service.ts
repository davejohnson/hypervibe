import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import type { Project } from '../entities/project.entity.js';
import { adapterFactory } from './adapter.factory.js';

const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();

export function isPostgresDatabaseUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.startsWith('postgres://') || lower.startsWith('postgresql://');
}

/** A concrete Postgres URL usable from OUTSIDE the hosting provider's network (CI runners, local pg_dump). */
export function isExternallyUsableDatabaseUrl(url: string | null | undefined): url is string {
  return Boolean(isPostgresDatabaseUrl(url) && !url.includes('${{') && !url.includes('.railway.internal'));
}

/**
 * Build a postgres URL that goes through a Railway TCP proxy, using the
 * datastore service's own variables for credentials. Returns null when the
 * variables are missing the required credentials.
 */
export function buildRailwayProxyDatabaseUrl(
  vars: Record<string, string>,
  proxy: { domain: string; proxyPort: number }
): string | null {
  const user = vars.PGUSER;
  const password = vars.POSTGRES_PASSWORD;
  if (!user || !password) {
    return null;
  }
  const database = vars.PGDATABASE || vars.POSTGRES_DB;
  if (!database) return null;
  const domain = proxy.domain.replace(/\.+$/, '');
  return `postgresql://${user}:${encodeURIComponent(password)}@${domain}:${proxy.proxyPort}/${database}`;
}

/**
 * Resolve a database URL reachable from outside the hosting network.
 * Railway components store a `${{plugin.DATABASE_URL}}` template (only
 * meaningful inside Railway), so fetch the datastore service's real
 * variables and prefer DATABASE_PUBLIC_URL (TCP proxy), falling back to a
 * read-only lookup of an existing TCP proxy on the datastore service.
 * Runs during hv_plan, so it must NEVER create a proxy.
 */
export async function resolveExternalDatabaseUrl(
  project: Project,
  env: { id: string; name: string; platformBindings: Record<string, unknown> },
  serviceName?: string
): Promise<string | null> {
  const direct = await resolveEnvironmentDatabaseUrl(project, env, serviceName);
  if (isExternallyUsableDatabaseUrl(direct)) {
    return direct;
  }

  const component = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
  const componentBindings = component?.bindings as Record<string, unknown> | undefined;
  if (!component || componentBindings?.provider !== 'railway') {
    return null;
  }
  const railwayProjectId = typeof componentBindings.projectId === 'string' ? componentBindings.projectId : undefined;
  const datastoreServiceId = component.externalId
    ?? (typeof componentBindings.serviceId === 'string' ? componentBindings.serviceId : undefined);
  const envBindings = env.platformBindings as { environmentId?: string };
  const railwayEnvironmentId = typeof envBindings?.environmentId === 'string' ? envBindings.environmentId : undefined;
  if (!railwayProjectId || !datastoreServiceId || !railwayEnvironmentId) {
    return null;
  }

  const adapterResult = await adapterFactory.getProviderAdapter('railway', project);
  const adapter = adapterResult.success
    ? adapterResult.adapter as unknown as {
      getServiceVariables?: (projectId: string, serviceId: string, environmentId: string) => Promise<Record<string, string>>;
      getTcpProxy?: (environmentId: string, serviceId: string, applicationPort: number) => Promise<{ domain: string; proxyPort: number } | null>;
    }
    : null;
  if (!adapter || typeof adapter.getServiceVariables !== 'function') {
    return null;
  }
  try {
    const vars = await adapter.getServiceVariables(railwayProjectId, datastoreServiceId, railwayEnvironmentId);
    if (isExternallyUsableDatabaseUrl(vars.DATABASE_PUBLIC_URL)) return vars.DATABASE_PUBLIC_URL;
    if (isExternallyUsableDatabaseUrl(vars.DATABASE_URL)) return vars.DATABASE_URL;

    // No externally usable URL variable — check for an existing TCP proxy
    // (read-only: this runs during hv_plan and must not create one).
    if (typeof adapter.getTcpProxy === 'function') {
      const proxy = await adapter.getTcpProxy(railwayEnvironmentId, datastoreServiceId, 5432);
      if (proxy) {
        return buildRailwayProxyDatabaseUrl(vars, proxy);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveEnvironmentDatabaseUrl(
  project: Project,
  env: { id: string; name: string; platformBindings: Record<string, unknown> },
  serviceName?: string
): Promise<string | null> {
  const component = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
  const componentBindings = component?.bindings as Record<string, unknown> | undefined;
  const componentProvider = typeof componentBindings?.provider === 'string' ? componentBindings.provider : undefined;
  if (component && componentProvider && componentProvider !== 'railway') {
    const adapterResult = await adapterFactory.getDatabaseAdapter(componentProvider, project);
    if (adapterResult.success && adapterResult.adapter) {
      const adapterUrl = await adapterResult.adapter.getConnectionUrl(component);
      if (adapterUrl) {
        return adapterUrl;
      }
    }
  }

  const componentUrl =
    typeof componentBindings?.connectionUrl === 'string' && componentBindings.connectionUrl.length > 0
      ? componentBindings.connectionUrl
      : typeof componentBindings?.connectionString === 'string' && componentBindings.connectionString.length > 0
        ? componentBindings.connectionString
        : undefined;
  if (componentUrl) {
    return componentUrl;
  }

  const bindings = env.platformBindings as {
    provider?: string;
    projectId?: string;
    environmentId?: string;
    services?: Record<string, { serviceId: string }>;
  };
  const projectId = bindings.projectId;
  const environmentId = bindings.environmentId;

  if (bindings.provider !== 'railway' || !projectId || !environmentId) {
    return null;
  }

  const services = serviceRepo.findByProjectId(project.id);
  const targetService = serviceName ? services.find((s) => s.name === serviceName) : services[0];
  const serviceId = targetService ? bindings.services?.[targetService.name]?.serviceId : undefined;
  if (!serviceId) {
    return null;
  }

  const adapterResult = await adapterFactory.getProviderAdapter(bindings.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return null;
  }

  const adapter = adapterResult.adapter as unknown as {
    getDatabaseUrl?: (projectId: string, environmentId: string, serviceId: string) => Promise<string | null>;
  };
  if (typeof adapter.getDatabaseUrl !== 'function') {
    return null;
  }

  return adapter.getDatabaseUrl(projectId, environmentId, serviceId);
}

export function maskDatabaseUrl(url: string): string {
  // Mask both username and password: postgres://user:pass@host → postgres://***:***@host
  return url
    .replace(/\/\/([^:@/]+):([^@]*)@/, '//***:***@')
    .replace(/\/\/([^:@/]+)@/, '//***@');
}
