import { providerRegistry } from '../registry/provider.registry.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Project } from '../entities/project.entity.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';
import type { IDatabaseAdapter } from '../ports/database.port.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { createRailwayDatabaseAdapter } from '../../adapters/providers/railway/railway-database.factory.js';
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
        error: `No connection found for ${providerName}. Use hv_connect first. Recommended: use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, or credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if intentional.`,
      };
    }

    if (connection.status !== 'verified') {
      return {
        success: false,
        error: `Connection for ${providerName} is not verified (status: ${connection.status}). Use hv_connect provider="${providerName}" action="verify" first.`,
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

    return {
      success: true,
      adapter: createRailwayDatabaseAdapter({
        hostingAdapter: hostingResult.adapter,
        envRepo: this.envRepo,
        project,
      }),
    };
  }
}

// Export singleton instance for convenience
export const adapterFactory = new AdapterFactory();
