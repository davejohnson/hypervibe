import type { Project } from '../../../domain/entities/project.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import type { IProviderAdapter } from '../../../domain/ports/provider.port.js';
import type { IDatabaseAdapter, ProvisionResult, ProvisionableType } from '../../../domain/ports/database.port.js';
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
  deleteProject?: (projectId: string) => Promise<{ success: boolean; error?: string }>;
  deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string }>;
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
    if (type === 'redis') {
      return {
        REDIS_URL: ref('REDIS_URL'),
      };
    }
    // Railway plugin provisioning currently supports postgres/redis in DB flows.
    return {};
  };

  const isAuthError = (message?: string): boolean =>
    typeof message === 'string' && /not authorized|forbidden|permission denied/i.test(message);

  return {
    name: 'railway',
    capabilities: {
      supportedDatabases: ['postgres'],
      supportedCaches: ['redis'],
      supportsPooling: false,
      supportsReadReplicas: false,
      supportsPointInTimeRecovery: false,
      serverlessOptimized: false,
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
    async provision(type, environment, _options): Promise<ProvisionResult> {
      if (type !== 'postgres' && type !== 'redis') {
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
            message: `Railway database adapter supports only postgres/redis (requested: ${type})`,
          },
        };
      }

      // Railway DB provisioning should target the same Railway project as the app hosting project.
      // Do not derive names from databaseName or environment.
      const projectName = project?.name ?? `project-${environment.projectId}`;
      const ensureProject = await railway.ensureProject(projectName, environment);
      if (!ensureProject.success) {
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
            message: ensureProject.message,
            error: ensureProject.error,
            data: {
              phase: 'ensureProject',
              provider: 'railway',
              requestedProjectName: projectName,
            },
          },
        };
      }

      const projectId =
        (ensureProject.data?.projectId as string | undefined) ||
        ((environment.platformBindings as Record<string, unknown>).projectId as string | undefined);
      const createdByProvision = Boolean(ensureProject.data?.created);
      let retriedAfterAuthRecover = false;

      if (projectId) {
        envRepo.updatePlatformBindings(environment.id, {
          provider: 'railway',
          projectId,
        });
      }

      const refreshedEnvironment = envRepo.findById(environment.id) ?? environment;
      let componentResult = await railway.ensureComponent(type, refreshedEnvironment);
      if (!componentResult.receipt.success && projectId && !createdByProvision && isAuthError(componentResult.receipt.error)) {
        retriedAfterAuthRecover = true;
        // Recover from stale/non-writable Railway bindings by clearing project/service linkage and retrying once.
        envRepo.updatePlatformBindings(environment.id, {
          projectId: undefined,
          environmentId: undefined,
          services: undefined,
        });

        const reboundEnv = envRepo.findById(environment.id) ?? refreshedEnvironment;
        const retryEnsureProject = await railway.ensureProject(projectName, reboundEnv);
        const retryProjectId =
          (retryEnsureProject.data?.projectId as string | undefined) ||
          ((reboundEnv.platformBindings as Record<string, unknown>).projectId as string | undefined);

        if (retryEnsureProject.success && retryProjectId) {
          envRepo.updatePlatformBindings(environment.id, {
            provider: 'railway',
            projectId: retryProjectId,
          });
          const retryEnv = envRepo.findById(environment.id) ?? reboundEnv;
          componentResult = await railway.ensureComponent(type, retryEnv);

          if (!componentResult.receipt.success && retryEnsureProject.data?.created === true && typeof railway.deleteProject === 'function') {
            const retryCleanup = await railway.deleteProject(retryProjectId);
            if (!retryCleanup.success) {
              componentResult.receipt.error = `${componentResult.receipt.error ?? componentResult.receipt.message} Cleanup failed for Railway project ${retryProjectId}: ${retryCleanup.error ?? 'unknown error'}`;
            }
          }
        }
      }

      if (!componentResult.receipt.success) {
        componentResult.receipt.data = {
          ...(componentResult.receipt.data ?? {}),
          phase: 'ensureComponent',
          provider: 'railway',
          providerProjectId: projectId,
          requestedProjectName: projectName,
          ensureProjectCreated: createdByProvision,
          authRecoveryRetried: retriedAfterAuthRecover,
        };
        if (projectId && createdByProvision && typeof railway.deleteProject === 'function') {
          const cleanup = await railway.deleteProject(projectId);
          if (cleanup.success) {
            envRepo.updatePlatformBindings(environment.id, {
              provider: undefined,
              projectId: undefined,
            });
          } else {
            componentResult.receipt.error = `${componentResult.receipt.error ?? componentResult.receipt.message} Cleanup failed for Railway project ${projectId}: ${cleanup.error ?? 'unknown error'}`;
          }
        }
        return {
          component: componentResult.component,
          receipt: componentResult.receipt,
        };
      }

      let pluginName: string =
        (componentResult.component.bindings as Record<string, unknown>)?.pluginName as string || type;
      if (projectId && typeof railway.listPlugins === 'function') {
        const plugins = await railway.listPlugins(projectId);
        const matched =
          plugins.find((p) => p.id === componentResult.component.externalId) ||
          [...plugins].reverse().find((p) => p.type === type);
        if (matched?.name) {
          pluginName = matched.name;
        }
      }

      const envVars = makePluginVarRefs(pluginName, type);
      const connectionUrl = envVars.DATABASE_URL ?? envVars.REDIS_URL;

      return {
        component: {
          ...componentResult.component,
          bindings: {
            ...(componentResult.component.bindings ?? {}),
            provider: 'railway',
            projectId: projectId ?? undefined,
            connectionUrl,
            pluginName,
            resourceKind: (componentResult.component.bindings as Record<string, unknown>)?.resourceKind,
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
            ensureProjectCreated: createdByProvision,
            authRecoveryRetried: retriedAfterAuthRecover,
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
    async destroy(component) {
      const bindings = component.bindings as Record<string, unknown>;
      const resourceKind = bindings.resourceKind;
      if (component.externalId && typeof railway.deleteService === 'function') {
        const deletedService = await railway.deleteService(component.externalId);
        if (deletedService.success) {
          return {
            success: true,
            message: `Deleted Railway service ${component.externalId}`,
          };
        }
        return {
          success: false,
          message: `Failed to delete Railway service ${component.externalId}`,
          error: deletedService.error,
        };
      }
      return {
        success: false,
        message: `Destroy is not implemented for Railway component ${component.externalId ?? component.id}${resourceKind ? ` (kind: ${String(resourceKind)})` : ''}`,
      };
    },
  };
}
