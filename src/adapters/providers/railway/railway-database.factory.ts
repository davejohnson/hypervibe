import type { Project } from '../../../domain/entities/project.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import type { IProviderAdapter, TemporaryDatabaseAccess } from '../../../domain/ports/provider.port.js';
import type { IDatabaseAdapter, ProvisionResult, ProvisionableType } from '../../../domain/ports/database.port.js';
import type { ObservedState } from '../../../domain/ports/observe.port.js';
import type { EnvironmentRepository } from '../../db/repositories/environment.repository.js';

interface RailwayHostingOps {
  ensureProject: (projectName: string, environment: Environment) => Promise<{
    success: boolean;
    data?: Record<string, unknown>;
    message: string;
    error?: string;
  }>;
  ensureComponent: (type: ComponentType, environment: Environment) => Promise<{
    component: Component;
    receipt: { success: boolean; message: string; error?: string; data?: Record<string, unknown> };
  }>;
  listPlugins: (projectId: string) => Promise<Array<{ id: string; name: string; type: string }>>;
  observe?: (environment: Environment) => Promise<ObservedState>;
  deleteProject?: (projectId: string) => Promise<{ success: boolean; error?: string }>;
  deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }>;
  deleteVolume?: (volumeId: string) => Promise<{ success: boolean; error?: string }>;
  acquireTemporaryDatabaseAccess?: (
    environment: Environment,
    component: Component,
    applicationPort: number
  ) => Promise<TemporaryDatabaseAccess>;
  releaseTemporaryDatabaseAccess?: (
    environment: Environment,
    component: Component,
    access: TemporaryDatabaseAccess
  ) => Promise<void>;
}

/**
 * Railway has no standalone database product: databases are services inside a
 * Railway hosting project. This factory wraps a connected Railway hosting
 * adapter in the IDatabaseAdapter port, including auth-recovery retry and
 * cleanup of projects it created itself.
 */
export function createRailwayDatabaseAdapter(params: {
  hostingAdapter: IProviderAdapter;
  envRepo: EnvironmentRepository;
  project?: Project;
}): IDatabaseAdapter {
  const { hostingAdapter, envRepo, project } = params;
  const railway = hostingAdapter as unknown as RailwayHostingOps;

  const makePluginVarRefs = (pluginName: string, type: ProvisionableType): Record<string, string> => {
    const ref = (varName: string) => '${{' + pluginName + '.' + varName + '}}';
    if (type === 'postgres') {
      return {
        DATABASE_URL: ref('DATABASE_URL'),
        DIRECT_URL: ref('DATABASE_PRIVATE_URL'),
      };
    }
    // Railway plugin provisioning currently supports postgres in DB flows.
    return {};
  };

  const observeRailwayDatabase = async (
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ) => {
    if (typeof railway.observe !== 'function') {
      throw new Error('Railway hosting adapter does not expose database observation.');
    }
    const observed = await railway.observe(environment);
    if (observed.completeness?.databases !== 'complete') {
      throw new Error(
        `Railway database observation is unknown: ${observed.warnings.join('; ') || 'provider returned incomplete state'}`
      );
    }
    const postgres = observed.databases.filter((database) => database.engine === 'postgres');
    if (component?.externalId) {
      return postgres.find((database) => database.externalId === component.externalId) ?? null;
    }
    const expectedName = options?.resourceName?.trim().toLowerCase();
    const named = expectedName
      ? postgres.filter((database) => database.name?.trim().toLowerCase() === expectedName)
      : postgres;
    const candidates = named.length > 0 ? named : postgres;
    if (candidates.length > 1) {
      throw new Error(
        `Multiple Railway PostgreSQL databases are visible: ${candidates.map((database) => database.externalId).join(', ')}`
      );
    }
    return candidates[0] ?? null;
  };

  return {
    name: 'railway',
    capabilities: {
      supportedDatabases: ['postgres'],
      supportsPooling: false,
      supportsReadReplicas: false,
      supportsPointInTimeRecovery: false,
      serverlessOptimized: false,
      supportsTemporaryDatabaseAccess: true,
    },
    async connect() {
      // Already connected via factory; no-op for compatibility.
    },
    async verify() {
      if (typeof hostingAdapter.verify === 'function') {
        return hostingAdapter.verify();
      }
      return { success: true };
    },
    async provision(type, environment, options): Promise<ProvisionResult> {
      if (type !== 'postgres') {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: `Railway database adapter supports only postgres (requested: ${type})`,
          },
        };
      }

      // Project creation is a separate reviewed plan action. A database action
      // may only provision inside the exact Railway project already bound to
      // this environment.
      const projectName = project?.name ?? `project-${environment.projectId}`;
      const projectId = (environment.platformBindings as Record<string, unknown>).projectId as string | undefined;
      if (!projectId) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: 'Railway project binding is missing',
            error: 'Apply the reviewed project action first, then re-run hv_plan. Database provisioning will not create or rebind a hosting project implicitly.',
            data: {
              phase: 'requireProjectBinding',
              provider: 'railway',
              requestedProjectName: projectName,
            },
          },
        };
      }

      const refreshedEnvironment = envRepo.findById(environment.id) ?? environment;
      let existingDatabase;
      try {
        existingDatabase = await observeRailwayDatabase(refreshedEnvironment, null, options);
      } catch (error) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: 'Failed to observe Railway databases before provisioning',
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (existingDatabase) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: `Railway PostgreSQL database ${existingDatabase.externalId} already exists`,
            error: 'Hypervibe will not silently adopt or replace it; use hv_import for that exact provider identity.',
          },
        };
      }
      const componentResult = await railway.ensureComponent(type, refreshedEnvironment);

      if (!componentResult.receipt.success) {
        componentResult.receipt.data = {
          ...(componentResult.receipt.data ?? {}),
          phase: 'ensureComponent',
          provider: 'railway',
          providerProjectId: projectId,
          requestedProjectName: projectName,
          ensureProjectCreated: false,
          authRecoveryRetried: false,
        };
        return {
          component: componentResult.component,
          receipt: componentResult.receipt,
        };
      }

      const componentBindings = componentResult.component.bindings as Record<string, unknown>;
      const resourceKind = componentBindings?.resourceKind;
      let pluginName: string = componentBindings?.pluginName as string || type;
      if (resourceKind !== 'service' && projectId && typeof railway.listPlugins === 'function') {
        const plugins = await railway.listPlugins(projectId);
        const matched =
          plugins.find((p) => p.id === componentResult.component.externalId) ||
          [...plugins].reverse().find((p) => p.type === type);
        if (matched?.name) {
          pluginName = matched.name;
        }
      }

      const envVars = makePluginVarRefs(pluginName, type);
      const connectionUrl = envVars.DATABASE_URL;

      return {
        component: {
          ...componentResult.component,
          bindings: {
            ...(componentResult.component.bindings ?? {}),
            provider: 'railway',
            projectId: projectId ?? undefined,
            connectionUrl,
            pluginName,
            resourceKind,
          },
        },
        receipt: {
          ...componentResult.receipt,
          data: {
            ...(componentResult.receipt.data ?? {}),
            phase: 'completed',
            provider: 'railway',
            providerProjectId: projectId,
            requestedProjectName: projectName,
            ensureProjectCreated: false,
            authRecoveryRetried: false,
          },
        },
        connectionUrl,
        envVars,
      };
    },
    async getConnectionUrl(component) {
      const bindings = component.bindings as Record<string, unknown>;
      const value = bindings.connectionUrl;
      return typeof value === 'string' ? value : null;
    },
    async observeDatabase(environment, component, options) {
      return observeRailwayDatabase(environment, component, options);
    },
    async acquireTemporaryDatabaseAccess(environment, component, applicationPort) {
      if (typeof railway.acquireTemporaryDatabaseAccess !== 'function') {
        throw new Error('Railway does not expose temporary database access.');
      }
      return railway.acquireTemporaryDatabaseAccess(environment, component, applicationPort);
    },
    async releaseTemporaryDatabaseAccess(environment, component, access) {
      if (typeof railway.releaseTemporaryDatabaseAccess !== 'function') {
        throw new Error('Railway does not expose temporary database access cleanup.');
      }
      await railway.releaseTemporaryDatabaseAccess(environment, component, access);
    },
    async destroy(component) {
      const bindings = component.bindings as Record<string, unknown>;
      const resourceKind = bindings.resourceKind;
      const volumeId = typeof bindings.volumeId === 'string' ? bindings.volumeId : undefined;
      const cleanupErrors: string[] = [];
      if (component.externalId && typeof railway.deleteService === 'function') {
        const deletedService = await railway.deleteService(component.externalId);
        if (!deletedService.success) {
          return {
            success: false,
            message: `Failed to delete Railway database service ${component.externalId}; persistent volume was preserved`,
            error: `service ${component.externalId}: ${deletedService.error ?? 'unknown error'}`,
          };
        }
        if (volumeId && typeof railway.deleteVolume === 'function') {
          const deletedVolume = await railway.deleteVolume(volumeId);
          if (!deletedVolume.success) {
            cleanupErrors.push(`volume ${volumeId}: ${deletedVolume.error ?? 'unknown error'}`);
          }
        }
        if (cleanupErrors.length === 0) {
          return {
            success: true,
            message: deletedService.alreadyAbsent
              ? `Railway database service is already absent: ${component.externalId}${volumeId ? `; deleted volume ${volumeId}` : ''}`
              : `Deleted Railway service ${component.externalId}${volumeId ? ` and volume ${volumeId}` : ''}`,
          };
        }
        return {
          success: false,
          message: `Failed to delete Railway database resources for ${component.externalId}`,
          error: cleanupErrors.join('; '),
        };
      }
      if (volumeId && typeof railway.deleteVolume === 'function') {
        const deletedVolume = await railway.deleteVolume(volumeId);
        if (deletedVolume.success) {
          return {
            success: true,
            message: `Deleted Railway volume ${volumeId}`,
          };
        }
        return {
          success: false,
          message: `Failed to delete Railway volume ${volumeId}`,
          error: deletedVolume.error,
        };
      }
      return {
        success: false,
        message: `Destroy is not implemented for Railway component ${component.externalId ?? component.id}${resourceKind ? ` (kind: ${String(resourceKind)})` : ''}`,
      };
    },
  };
}
