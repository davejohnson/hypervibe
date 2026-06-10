import { providerRegistry } from '../registry/provider.registry.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Project } from '../entities/project.entity.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';
import type { IDatabaseAdapter, ProvisionResult, ProvisionableType } from '../ports/database.port.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getProjectScopeHints } from './project-scope.js';

/**
 * Result of resolving an adapter
 */
export interface AdapterResult<T> {
  success: boolean;
  adapter?: T;
  error?: string;
}

/**
 * Factory for creating and resolving adapters based on project configuration.
 * Centralizes the logic for looking up connections and instantiating adapters.
 */
export class AdapterFactory {
  private connectionRepo = new ConnectionRepository();
  private secretStore = getSecretStore();
  private envRepo = new EnvironmentRepository();

  /**
   * Get a hosting adapter for a project based on its defaultPlatform.
   * Looks up the verified connection and instantiates the adapter.
   */
  async getHostingAdapter(project: Project): Promise<AdapterResult<IHostingAdapter>> {
    const platform = project.defaultPlatform || 'cloudrun';
    return this.getAdapter<IHostingAdapter>(platform, 'deployment', getProjectScopeHints(project));
  }

  /**
   * Get a database adapter by provider name.
   * Used when a component specifies a specific database provider.
   */
  async getDatabaseAdapter(
    providerName: string,
    project?: Project
  ): Promise<AdapterResult<IDatabaseAdapter>> {
    if (providerName === 'railway') {
      return this.getRailwayDatabaseAdapter(project);
    }
    return this.getAdapter<IDatabaseAdapter>(
      providerName,
      'database',
      project ? getProjectScopeHints(project) : undefined
    );
  }

  /**
   * Get any provider adapter by name.
   * Generic method that works with any registered provider.
   */
  async getProviderAdapter(
    providerName: string,
    project?: Project
  ): Promise<AdapterResult<IProviderAdapter>> {
    return this.getAdapter<IProviderAdapter>(
      providerName,
      undefined,
      project ? getProjectScopeHints(project) : undefined
    );
  }

  /**
   * Check if a platform has a verified connection.
   */
  hasVerifiedConnection(providerName: string): boolean {
    const connection = this.connectionRepo.findByProvider(providerName);
    return connection?.status === 'verified';
  }

  /**
   * Get list of available hosting platforms (those with connections).
   */
  getAvailableHostingPlatforms(): string[] {
    const hostingProviders = providerRegistry.getByCategory('deployment');
    return hostingProviders
      .filter((p) => this.hasVerifiedConnection(p.metadata.name))
      .map((p) => p.metadata.name);
  }

  /**
   * Get list of available database providers (those with connections).
   */
  getAvailableDatabaseProviders(): string[] {
    const dbProviders = providerRegistry.getByCategory('database');
    const available = dbProviders
      .filter((p) => this.hasVerifiedConnection(p.metadata.name))
      .map((p) => p.metadata.name);
    if (this.hasVerifiedConnection('railway') && !available.includes('railway')) {
      available.push('railway');
    }
    return available;
  }

  /**
   * Internal method to resolve and instantiate any adapter.
   */
  private async getAdapter<T>(
    providerName: string,
    expectedCategory?: string,
    scopeHints?: string[]
  ): Promise<AdapterResult<T>> {
    // Check if provider is registered
    const provider = providerRegistry.get(providerName);
    if (!provider) {
      return {
        success: false,
        error: `Unknown provider: ${providerName}. Available providers: ${providerRegistry.names().join(', ')}`,
      };
    }

    // Validate category if specified
    if (expectedCategory && provider.metadata.category !== expectedCategory) {
      return {
        success: false,
        error: `Provider ${providerName} is not a ${expectedCategory} provider (it's a ${provider.metadata.category} provider)`,
      };
    }

    // Look up connection
    const connection = this.connectionRepo.findBestMatchFromHints(providerName, scopeHints);
    if (!connection) {
      return {
        success: false,
        error: `No connection found for ${providerName}. Use connection_create first.`,
      };
    }

    if (connection.status !== 'verified') {
      return {
        success: false,
        error: `Connection for ${providerName} is not verified (status: ${connection.status}). Use connection_verify first.`,
      };
    }

    // Decrypt credentials and create adapter
    try {
      const credentials = this.secretStore.decryptObject(connection.credentialsEncrypted);
      const adapter = providerRegistry.createAdapter<T>(providerName, credentials);

      // Connect if the adapter has an async connect method
      const adapterWithConnect = adapter as unknown as { connect?: (c: unknown) => Promise<void> };
      if (adapter && typeof adapterWithConnect.connect === 'function') {
        await adapterWithConnect.connect(credentials);
      }

      return { success: true, adapter };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create ${providerName} adapter: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async getRailwayDatabaseAdapter(project?: Project): Promise<AdapterResult<IDatabaseAdapter>> {
    const hostingResult = await this.getAdapter<IProviderAdapter>(
      'railway',
      'deployment',
      project ? getProjectScopeHints(project) : undefined
    );
    if (!hostingResult.success || !hostingResult.adapter) {
      return { success: false, error: hostingResult.error || 'No Railway adapter available' };
    }

    const railway = hostingResult.adapter as unknown as {
      ensureProject: (projectName: string, environment: import('../entities/environment.entity.js').Environment) => Promise<{
        success: boolean;
        data?: Record<string, unknown>;
        message: string;
        error?: string;
      }>;
      ensureComponent: (
        type: import('../entities/component.entity.js').ComponentType,
        environment: import('../entities/environment.entity.js').Environment
      ) => Promise<{
        component: import('../entities/component.entity.js').Component;
        receipt: { success: boolean; message: string; error?: string; data?: Record<string, unknown> };
      }>;
      listPlugins: (projectId: string) => Promise<Array<{ id: string; name: string; type: string }>>;
      deleteProject?: (projectId: string) => Promise<{ success: boolean; error?: string }>;
      deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string }>;
    };

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

    const envRepo = this.envRepo;
    const adapter: IDatabaseAdapter = {
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
        if (typeof hostingResult.adapter?.verify === 'function') {
          return hostingResult.adapter.verify();
        }
        return { success: true };
      },
      async provision(type, environment, options): Promise<ProvisionResult> {
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
          ((environment.platformBindings as Record<string, unknown>).projectId as string | undefined) ||
          ((environment.platformBindings as Record<string, unknown>).railwayProjectId as string | undefined);
        const createdByProvision = Boolean(ensureProject.data?.created);
        let retriedAfterAuthRecover = false;

        if (projectId) {
          envRepo.updatePlatformBindings(environment.id, {
            provider: 'railway',
            projectId,
            railwayProjectId: projectId,
          });
        }

        const refreshedEnvironment = envRepo.findById(environment.id) ?? environment;
        let componentResult = await railway.ensureComponent(type, refreshedEnvironment);
        if (!componentResult.receipt.success && projectId && !createdByProvision && isAuthError(componentResult.receipt.error)) {
          retriedAfterAuthRecover = true;
          // Recover from stale/non-writable Railway bindings by clearing project/service linkage and retrying once.
          envRepo.updatePlatformBindings(environment.id, {
            projectId: undefined,
            railwayProjectId: undefined,
            environmentId: undefined,
            railwayEnvironmentId: undefined,
            services: undefined,
          });

          const reboundEnv = envRepo.findById(environment.id) ?? refreshedEnvironment;
          const retryEnsureProject = await railway.ensureProject(projectName, reboundEnv);
          const retryProjectId =
            (retryEnsureProject.data?.projectId as string | undefined) ||
            ((reboundEnv.platformBindings as Record<string, unknown>).projectId as string | undefined) ||
            ((reboundEnv.platformBindings as Record<string, unknown>).railwayProjectId as string | undefined);

          if (retryEnsureProject.success && retryProjectId) {
            envRepo.updatePlatformBindings(environment.id, {
              provider: 'railway',
              projectId: retryProjectId,
              railwayProjectId: retryProjectId,
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
            railwayProjectId: projectId,
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
                railwayProjectId: undefined,
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
              railwayProjectId: projectId,
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

    return { success: true, adapter };
  }
}

// Export singleton instance for convenience
export const adapterFactory = new AdapterFactory();
