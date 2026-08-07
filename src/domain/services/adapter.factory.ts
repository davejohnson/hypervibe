import { providerRegistry } from '../registry/provider.registry.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Project } from '../entities/project.entity.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';
import type { IDatabaseAdapter } from '../ports/database.port.js';
import type { ICacheAdapter } from '../ports/cache.port.js';
import type { IStorageAdapter } from '../ports/storage.port.js';
import type { ILoadBalancerAdapter } from '../ports/load-balancer.port.js';
import { getProjectScopeHints } from './project-scope.js';
import { formatConnectionGuidance } from './connection-guidance.js';

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

  /**
   * Get a hosting adapter for a project based on its defaultPlatform.
   * Looks up the verified connection and instantiates the adapter.
   */
  async getHostingAdapter(project: Project): Promise<AdapterResult<IHostingAdapter>> {
    const platform = project.defaultPlatform || 'cloudrun';
    return this.getHostingAdapterByName(platform, project);
  }

  /** Resolve the exact hosting provider named by a reviewed environment/action. */
  async getHostingAdapterByName(
    providerName: string,
    project?: Project
  ): Promise<AdapterResult<IHostingAdapter>> {
    return this.getAdapter<IHostingAdapter>(
      providerName,
      'deployment',
      project ? getProjectScopeHints(project) : undefined
    );
  }

  /**
   * Get a database adapter by provider name.
   * Used when a component specifies a specific database provider.
   */
  async getDatabaseAdapter(
    providerName: string,
    project?: Project
  ): Promise<AdapterResult<IDatabaseAdapter>> {
    const provider = providerRegistry.get(providerName);
    if (provider?.derivedAdapters?.database) {
      return this.getDerivedAdapter<IDatabaseAdapter>(providerName, 'database', project);
    }
    return this.getAdapter<IDatabaseAdapter>(
      providerName,
      'database',
      project ? getProjectScopeHints(project) : undefined
    );
  }

  async getCacheAdapter(
    providerName: string,
    project?: Project
  ): Promise<AdapterResult<ICacheAdapter>> {
    const provider = providerRegistry.get(providerName);
    if (provider?.derivedAdapters?.cache) {
      return this.getDerivedAdapter<ICacheAdapter>(providerName, 'cache', project);
    }
    return this.getAdapter<ICacheAdapter>(
      providerName,
      'cache',
      project ? getProjectScopeHints(project) : undefined
    );
  }

  async getStorageAdapter(providerName: string, project?: Project): Promise<AdapterResult<IStorageAdapter>> {
    const provider = providerRegistry.get(providerName);
    if (provider?.derivedAdapters?.storage) {
      return this.getDerivedAdapter<IStorageAdapter>(providerName, 'storage', project);
    }
    return this.getAdapter<IStorageAdapter>(providerName, 'storage', project ? getProjectScopeHints(project) : undefined);
  }

  async getLoadBalancerAdapter(
    providerName: string,
    project?: Project,
    scopeHints?: string[]
  ): Promise<AdapterResult<ILoadBalancerAdapter>> {
    return this.getAdapter<ILoadBalancerAdapter>(
      providerName,
      undefined,
      scopeHints ?? (project ? getProjectScopeHints(project) : undefined)
    );
  }

  /**
   * Get any provider adapter by name.
   * Generic method that works with any registered provider.
   */
  async getProviderAdapter(
    providerName: string,
    project?: Project,
    scopeHints?: string[]
  ): Promise<AdapterResult<IProviderAdapter>> {
    return this.getAdapter<IProviderAdapter>(
      providerName,
      undefined,
      scopeHints ?? (project ? getProjectScopeHints(project) : undefined)
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
    return providerRegistry.namesFor('database')
      .filter((providerName) => this.hasVerifiedConnection(providerName));
  }

  getAvailableCacheProviders(): string[] {
    return providerRegistry.namesFor('cache')
      .filter((providerName) => this.hasVerifiedConnection(providerName));
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
        error: `No connection found for ${providerName}. ${formatConnectionGuidance(providerName)}`,
      };
    }

    if (connection.status !== 'verified') {
      return {
        success: false,
        error: `Connection for ${providerName} is not verified (status: ${connection.status}). Re-run hv_connections provider="${providerName}" action="verify" after confirming token type and permissions. ${formatConnectionGuidance(providerName)}`,
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

  private async getDerivedAdapter<T>(
    providerName: string,
    capability: 'database' | 'cache' | 'storage',
    project?: Project
  ): Promise<AdapterResult<T>> {
    const provider = providerRegistry.get(providerName);
    const derive = provider?.derivedAdapters?.[capability];
    if (!provider || !derive) {
      return { success: false, error: `${providerName} does not expose a ${capability} adapter capability` };
    }
    const base = await this.getAdapter<IProviderAdapter>(
      providerName,
      provider.metadata.category,
      project ? getProjectScopeHints(project) : undefined
    );
    if (!base.success || !base.adapter) {
      return { success: false, error: base.error || `No ${providerName} adapter available` };
    }
    try {
      return { success: true, adapter: await derive(base.adapter, { project }) as T };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create ${providerName} ${capability} adapter: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

// Export singleton instance for convenience
export const adapterFactory = new AdapterFactory();
