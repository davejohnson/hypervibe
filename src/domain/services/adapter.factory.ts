import { providerRegistry } from '../registry/provider.registry.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Project } from '../entities/project.entity.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';
import type { IDatabaseAdapter } from '../ports/database.port.js';

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
    const platform = project.defaultPlatform || 'railway';
    return this.getAdapter<IHostingAdapter>(platform, 'deployment');
  }

  /**
   * Get a database adapter by provider name.
   * Used when a component specifies a specific database provider.
   */
  async getDatabaseAdapter(providerName: string): Promise<AdapterResult<IDatabaseAdapter>> {
    return this.getAdapter<IDatabaseAdapter>(providerName, 'database');
  }

  /**
   * Get any provider adapter by name.
   * Generic method that works with any registered provider.
   */
  async getProviderAdapter(providerName: string): Promise<AdapterResult<IProviderAdapter>> {
    return this.getAdapter<IProviderAdapter>(providerName);
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
    return dbProviders
      .filter((p) => this.hasVerifiedConnection(p.metadata.name))
      .map((p) => p.metadata.name);
  }

  /**
   * Internal method to resolve and instantiate any adapter.
   */
  private async getAdapter<T>(
    providerName: string,
    expectedCategory?: string
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
    const connection = this.connectionRepo.findByProvider(providerName);
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
}

// Export singleton instance for convenience
export const adapterFactory = new AdapterFactory();
