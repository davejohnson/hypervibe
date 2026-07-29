import type { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import type { Project } from '../../../domain/entities/project.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import type { IProviderAdapter } from '../../../domain/ports/provider.port.js';
import type {
  CacheEngine,
  CacheProvisionResult,
  ICacheAdapter,
} from '../../../domain/ports/cache.port.js';

interface RailwayCacheOps {
  ensureComponent(type: ComponentType, environment: Environment): Promise<{
    component: Component;
    receipt: {
      success: boolean;
      message: string;
      error?: string;
      data?: Record<string, unknown>;
    };
  }>;
  deleteService?(serviceId: string): Promise<{ success: boolean; error?: string }>;
  deleteVolume?(volumeId: string): Promise<{ success: boolean; error?: string }>;
}

function failedComponent(environment: Environment, engine: CacheEngine): Component {
  return {
    id: '',
    environmentId: environment.id,
    type: engine,
    bindings: {},
    externalId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Railway Redis is a service-backed datastore inside the already-reviewed
 * Railway project. The cache action cannot create or adopt a project.
 */
export function createRailwayCacheAdapter(params: {
  hostingAdapter: IProviderAdapter;
  envRepo: EnvironmentRepository;
  project?: Project;
}): ICacheAdapter {
  const { hostingAdapter, envRepo, project } = params;
  const railway = hostingAdapter as unknown as RailwayCacheOps;

  return {
    name: 'railway',
    capabilities: {
      supportedCaches: ['redis'],
      supportsTls: false,
      supportsHighAvailability: false,
      supportsPersistence: true,
      serverlessOptimized: false,
    },
    async connect() {
      // The primary Railway adapter is already connected by AdapterFactory.
    },
    async verify() {
      return typeof hostingAdapter.verify === 'function'
        ? hostingAdapter.verify()
        : { success: true };
    },
    async provision(engine, environment): Promise<CacheProvisionResult> {
      if (engine !== 'redis') {
        return {
          component: failedComponent(environment, engine),
          receipt: {
            success: false,
            message: `Railway cache adapter supports only redis (requested: ${engine})`,
          },
        };
      }
      const projectId = (environment.platformBindings as Record<string, unknown>).projectId;
      if (typeof projectId !== 'string' || projectId.length === 0) {
        return {
          component: failedComponent(environment, engine),
          receipt: {
            success: false,
            message: 'Railway project binding is missing',
            error: 'Apply the reviewed project action first, then re-run hv_plan. Cache provisioning will not create or rebind a hosting project implicitly.',
            data: {
              phase: 'requireProjectBinding',
              provider: 'railway',
              requestedProjectName: project?.name ?? `project-${environment.projectId}`,
            },
          },
        };
      }

      const refreshedEnvironment = envRepo.findById(environment.id) ?? environment;
      const result = await railway.ensureComponent('redis', refreshedEnvironment);
      if (!result.receipt.success) {
        return result;
      }
      const rawBindings = result.component.bindings as Record<string, unknown>;
      const pluginName = typeof rawBindings.pluginName === 'string'
        ? rawBindings.pluginName
        : 'redis-db';
      const connectionUrl = '${{' + pluginName + '.REDIS_URL}}';
      return {
        component: {
          ...result.component,
          bindings: {
            ...rawBindings,
            provider: 'railway',
            projectId,
            connectionUrl,
            pluginName,
          },
        },
        receipt: {
          ...result.receipt,
          data: {
            ...(result.receipt.data ?? {}),
            phase: 'completed',
            provider: 'railway',
            providerProjectId: projectId,
          },
        },
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
      };
    },
    async getConnectionUrl(component) {
      const value = (component.bindings as Record<string, unknown>).connectionUrl;
      return typeof value === 'string' ? value : null;
    },
    async observeCache(environment, component, options) {
      if (typeof hostingAdapter.observe !== 'function') {
        throw new Error('Railway cache observation is unavailable');
      }
      const observed = await hostingAdapter.observe(environment);
      const caches = observed.caches ?? [];
      if (component?.externalId) {
        return caches.find((cache) => cache.externalId === component.externalId) ?? null;
      }
      const resourceName = options?.resourceName?.toLowerCase();
      const matches = resourceName
        ? caches.filter((cache) => cache.name?.toLowerCase() === resourceName)
        : caches;
      if (matches.length > 1) {
        throw new Error(`Multiple Railway Redis caches match ${options?.resourceName ?? 'the requested environment'}`);
      }
      return matches[0] ?? null;
    },
    async destroy(component) {
      const bindings = component.bindings as Record<string, unknown>;
      const volumeId = typeof bindings.volumeId === 'string' ? bindings.volumeId : undefined;
      if (!component.externalId || typeof railway.deleteService !== 'function') {
        return {
          success: false,
          message: `Destroy is not implemented for Railway Redis component ${component.externalId ?? component.id}`,
        };
      }
      const deletedService = await railway.deleteService(component.externalId);
      if (!deletedService.success) {
        return {
          success: false,
          message: `Failed to delete Railway Redis service ${component.externalId}; persistent volume was preserved`,
          error: deletedService.error,
        };
      }
      if (volumeId) {
        if (typeof railway.deleteVolume !== 'function') {
          return {
            success: false,
            message: `Deleted Railway Redis service ${component.externalId}, but volume ${volumeId} cleanup is unavailable`,
          };
        }
        const deletedVolume = await railway.deleteVolume(volumeId);
        if (!deletedVolume.success) {
          return {
            success: false,
            message: `Deleted Railway Redis service ${component.externalId}, but failed to delete its volume`,
            error: deletedVolume.error,
          };
        }
      }
      return {
        success: true,
        message: `Deleted Railway Redis service ${component.externalId}${volumeId ? ` and volume ${volumeId}` : ''}`,
      };
    },
  };
}
