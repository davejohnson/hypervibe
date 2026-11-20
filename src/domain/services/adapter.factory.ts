import { providerRegistry } from '../registry/provider.registry.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { UNCONFIGURED_HOSTING_PROVIDER, type Project } from '../entities/project.entity.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';
import { supportsDatabaseLifecycle, supportsDatabaseOperations, type IDatabaseAdapter, type IDatabaseOperations } from '../ports/database.port.js';
import { supportsCacheLifecycle, type ICacheAdapter } from '../ports/cache.port.js';
import { supportsStorageLifecycle, supportsStorageOperations, type IStorageAdapter, type IStorageOperations } from '../ports/storage.port.js';
import type { Environment } from '../entities/environment.entity.js';
import { SpecStore } from '../spec/spec.store.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { GCP_PROJECT_ID_PATTERN, gcpCredentialsMatchProject, gcpConnectionScope, gcpEnvironmentBindingConflict } from './gcp-environment-target.js';
import { getProjectScopeHints } from './project-scope.js';
import { formatConnectionGuidance } from './connection-guidance.js';

/**
 * Result of resolving an adapter
 */
export interface AdapterResult<T> {
  success: boolean;
  adapter?: T;
  error?: string;
  /** Actual verified connection selected, distinct from the requested capability provider. */
  connectionProvider?: string;
}

interface AdapterEnvironment {
  environment?: Pick<Environment, 'name' | 'platformBindings'> | null;
  hosting?: EnvironmentSpec['hosting'];
  requestedScope?: string;
  requestedRegion?: string;
}

export function usesGcpEnvironmentConnection(provider: string): boolean {
  const sources = providerRegistry.connectionProviders(provider);
  return sources.includes('cloudrun') || sources.includes('cloudsql');
}

function gcpTargetForAdapter(provider: string, project?: Project, selection?: AdapterEnvironment) {
  if (!selection || !usesGcpEnvironmentConnection(provider)) return;
  const { environment, requestedScope } = selection;
  const repository = parseGitHubRepoFromRemote(project?.gitRemoteUrl);
  const hasProjectScope = requestedScope?.includes('#gcp:');
  const scopedProjectId = hasProjectScope ? requestedScope!.split('#gcp:').at(-1) : undefined;
  if (hasProjectScope && (!repository || !scopedProjectId || !GCP_PROJECT_ID_PATTERN.test(scopedProjectId)
    || requestedScope !== gcpConnectionScope(repository, scopedProjectId))) {
    throw new Error('Select the Hypervibe project whose repository matches the requested Google Cloud connection scope.');
  }
  const hosting = selection.hosting ?? (project && environment
    ? new SpecStore().getForInspection(project)?.spec.environments[environment.name]?.hosting : undefined);
  const declaredId = hosting?.provider === 'cloudrun' ? hosting.gcpProjectId : undefined;
  if (declaredId && !repository) throw new Error('An exact GitHub repository is required to select the environment’s Google Cloud connection.');
  if (requestedScope && declaredId && requestedScope !== gcpConnectionScope(repository!, declaredId)) {
    throw new Error('The requested scope differs from the environment’s Google Cloud connection.');
  }
  if (environment && scopedProjectId && !declaredId) throw new Error('This environment uses its repository-default Google Cloud connection.');
  const binding = environment?.platformBindings;
  const boundId = binding?.provider === 'cloudrun' && typeof binding.projectId === 'string' ? binding.projectId : undefined;
  const projectId = declaredId ?? scopedProjectId ?? boundId;
  if (!projectId) return;
  if (!GCP_PROJECT_ID_PATTERN.test(projectId)) throw new Error('The environment has an invalid Google Cloud project binding.');
  const region = hosting?.provider === 'cloudrun' ? hosting.region ?? 'us-central1'
    : typeof binding?.environmentId === 'string' ? binding.environmentId : undefined;
  if (environment && region) {
    const conflict = gcpEnvironmentBindingConflict(binding, projectId, region);
    if (conflict) throw new Error(conflict);
    if (selection.requestedRegion && selection.requestedRegion !== region) throw new Error('The requested region differs from the environment’s Google Cloud region.');
  }
  const scope = declaredId || scopedProjectId ? gcpConnectionScope(repository!, projectId) : undefined;
  return { projectId, scope, region };
}

/**
 * Factory for creating and resolving adapters based on project configuration.
 * Centralizes the logic for looking up connections and instantiating adapters.
 */
export class AdapterFactory {
  private connectionRepo = new ConnectionRepository();

  // Constructing the command registry is side-effect free (CLI help/version
  // and MCP capability discovery both do it). Do not create the encryption
  // key until a command actually resolves provider credentials.
  private get secretStore(): ReturnType<typeof getSecretStore> {
    return getSecretStore();
  }

  /**
   * Get a hosting adapter for a project based on its defaultPlatform.
   * Looks up the verified connection and instantiates the adapter.
   */
  async getHostingAdapter(project: Project): Promise<AdapterResult<IHostingAdapter>> {
    const platform = project.defaultPlatform?.trim();
    if (!platform || platform === UNCONFIGURED_HOSTING_PROVIDER) {
      return {
        success: false,
        error: `Project ${project.name} has no reviewed hosting provider. Initialize desired state with hv_spec first.`,
      };
    }
    return this.getHostingAdapterByName(platform, project);
  }

  /** Resolve the exact hosting provider named by a reviewed environment/action. */
  async getHostingAdapterByName(
    providerName: string,
    project?: Project
  ): Promise<AdapterResult<IHostingAdapter>> {
    const maturityBlock = this.lifecycleMutationBlock<IHostingAdapter>(providerName, 'hosting');
    if (maturityBlock) return maturityBlock;
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
    project?: Project,
    selection?: AdapterEnvironment
  ): Promise<AdapterResult<IDatabaseAdapter>> {
    const maturityBlock = this.lifecycleMutationBlock<IDatabaseAdapter>(providerName, 'database');
    if (maturityBlock) return maturityBlock;
    const provider = providerRegistry.get(providerName);
    const result = provider?.derivedAdapters?.database
      ? await this.getDerivedAdapter<IDatabaseAdapter>(providerName, 'database', project, selection)
      : await this.getAdapter<IDatabaseAdapter>(
          providerName,
          'database',
          project ? getProjectScopeHints(project) : undefined, project, selection
        );
    return this.requireLifecyclePort(result, supportsDatabaseLifecycle, providerName, 'database');
  }

  async getCacheAdapter(
    providerName: string,
    project?: Project
  ): Promise<AdapterResult<ICacheAdapter>> {
    const maturityBlock = this.lifecycleMutationBlock<ICacheAdapter>(providerName, 'cache');
    if (maturityBlock) return maturityBlock;
    const provider = providerRegistry.get(providerName);
    const result = provider?.derivedAdapters?.cache
      ? await this.getDerivedAdapter<ICacheAdapter>(providerName, 'cache', project)
      : await this.getAdapter<ICacheAdapter>(
          providerName,
          'cache',
          project ? getProjectScopeHints(project) : undefined
        );
    return this.requireLifecyclePort(result, supportsCacheLifecycle, providerName, 'cache');
  }

  /** Access an existing database without selecting a resource lifecycle writer. */
  async getDatabaseOperations(providerName: string, project?: Project, selection?: AdapterEnvironment): Promise<AdapterResult<IDatabaseOperations>> {
    const provider = providerRegistry.get(providerName);
    const result = provider?.derivedAdapters?.database
      ? await this.getDerivedAdapter<IDatabaseOperations>(providerName, 'database', project, selection)
      : await this.getAdapter<IDatabaseOperations>(providerName, 'database', project ? getProjectScopeHints(project) : undefined, project, selection);
    if (!result.success || !result.adapter) return result;
    return supportsDatabaseOperations(result.adapter) ? result
      : { success: false, error: `${providerName} does not implement database operations.` };
  }

  /** Transfer or inspect objects in an already-bound bucket without provisioning authority. */
  async getStorageOperations(providerName: string, project?: Project, selection?: AdapterEnvironment): Promise<AdapterResult<IStorageOperations>> {
    const provider = providerRegistry.get(providerName);
    const result = provider?.derivedAdapters?.storage
      ? await this.getDerivedAdapter<IStorageOperations>(providerName, 'storage', project, selection)
      : await this.getAdapter<IStorageOperations>(providerName, 'storage', project ? getProjectScopeHints(project) : undefined, project, selection);
    if (!result.success || !result.adapter) return result;
    return supportsStorageOperations(result.adapter) ? result
      : { success: false, error: `${providerName} does not implement storage operations.` };
  }

  async getStorageAdapter(providerName: string, project?: Project): Promise<AdapterResult<IStorageAdapter>> {
    const maturityBlock = this.lifecycleMutationBlock<IStorageAdapter>(providerName, 'storage');
    if (maturityBlock) return maturityBlock;
    const provider = providerRegistry.get(providerName);
    const result = provider?.derivedAdapters?.storage
      ? await this.getDerivedAdapter<IStorageAdapter>(providerName, 'storage', project)
      : await this.getAdapter<IStorageAdapter>(providerName, 'storage', project ? getProjectScopeHints(project) : undefined);
    return this.requireLifecyclePort(result, supportsStorageLifecycle, providerName, 'storage');
  }

  /**
   * Get any provider adapter by name.
   * Generic method that works with any registered provider.
   */
  async getProviderAdapter(
    providerName: string,
    project?: Project,
    scopeHints?: string[],
    selection?: AdapterEnvironment
  ): Promise<AdapterResult<IProviderAdapter>> {
    return this.getAdapter<IProviderAdapter>(
      providerName,
      undefined,
      scopeHints ?? (project ? getProjectScopeHints(project) : undefined), project, selection
    );
  }

  /**
   * Check if a platform has a verified connection.
   */
  hasVerifiedConnection(providerName: string): boolean {
    return providerRegistry.connectionProviders(providerName).some((connectionProvider) =>
      this.connectionRepo.findAllByProvider(connectionProvider).some((connection) => connection.status === 'verified')
    );
  }

  /**
   * Get list of available hosting platforms (those with connections).
   */
  getAvailableHostingPlatforms(): string[] {
    return providerRegistry.namesForMutation('hosting')
      .filter((providerName) => this.hasVerifiedConnection(providerName));
  }

  /**
   * Get list of available database providers (those with connections).
   */
  getAvailableDatabaseProviders(): string[] {
    return providerRegistry.namesForMutation('database')
      .filter((providerName) => this.hasVerifiedConnection(providerName));
  }

  getAvailableCacheProviders(): string[] {
    return providerRegistry.namesForMutation('cache')
      .filter((providerName) => this.hasVerifiedConnection(providerName));
  }

  private lifecycleMutationBlock<T>(
    providerName: string,
    capability: 'hosting' | 'database' | 'cache' | 'storage'
  ): AdapterResult<T> | undefined {
    if (!providerRegistry.supports(providerName, capability)) {
      return {
        success: false,
        error: `Provider ${providerName} does not declare ${capability} lifecycle support. Infrastructure mutation was blocked.`,
      };
    }
    if (providerRegistry.supportsMutation(providerName, capability)) return undefined;
    const maturity = providerRegistry.lifecycleMaturity(providerName, capability);
    return {
      success: false,
      error: `${providerName} ${capability} lifecycle is ${maturity?.status ?? 'unclassified'} and cannot mutate infrastructure. ${maturity?.reason ?? 'Complete its live-readiness prerequisites before using it in desired state.'} Read-only hv_inspect and hv_connections remain available.`,
    };
  }

  private requireLifecyclePort<T>(
    result: AdapterResult<T>,
    supports: (value: unknown) => value is T,
    providerName: string,
    capability: 'database' | 'cache' | 'storage'
  ): AdapterResult<T> {
    if (!result.success || !result.adapter) return result;
    if (supports(result.adapter)) return result;
    return {
      success: false,
      error: `Provider ${providerName} advertises ${capability} lifecycle support but its adapter does not implement the complete runtime port. Infrastructure mutation was blocked.`,
    };
  }

  /**
   * Internal method to resolve and instantiate any adapter.
   */
  private async getAdapter<T>(
    providerName: string,
    expectedCategory?: string,
    scopeHints?: string[],
    project?: Project,
    selection?: AdapterEnvironment
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

    let target: ReturnType<typeof gcpTargetForAdapter>;
    try {
      target = gcpTargetForAdapter(providerName, project, selection);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Could not resolve the environment’s Google Cloud project.' };
    }
    const connectionCandidates = providerRegistry.connectionProviders(providerName)
      .map((connectionProvider) => target?.scope
        ? this.connectionRepo.findByProviderAndScope(connectionProvider, target.scope)
        : this.connectionRepo.findBestMatchFromHints(connectionProvider, scopeHints))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    const connection = connectionCandidates.find((candidate) => candidate.status === 'verified')
      ?? connectionCandidates[0];
    if (!connection) {
      return {
        success: false,
        error: `No connection found for ${providerName}${target ? ` in Google Cloud project ${target.projectId}` : ''}. ${formatConnectionGuidance(providerName)}`,
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
      const credentials = this.secretStore.decryptObject<Record<string, unknown>>(connection.credentialsEncrypted);
      if (target && !gcpCredentialsMatchProject(credentials, target.projectId, { allowLegacyKey: !target.scope })) {
        return { success: false, error: `The selected ${providerName} connection does not identify Google Cloud project ${target.projectId}.` };
      }
      const adapter = await providerRegistry.createAdapter<T>(providerName, credentials);
      if (target?.region && providerName === 'cloudrun') {
        await (adapter as IHostingAdapter).configureTarget?.({ region: target.region });
      }

      return { success: true, adapter, connectionProvider: connection.provider };
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
    project?: Project,
    selection?: AdapterEnvironment
  ): Promise<AdapterResult<T>> {
    const provider = providerRegistry.get(providerName);
    const derive = provider?.derivedAdapters?.[capability];
    if (!provider || !derive) {
      return { success: false, error: `${providerName} does not expose a ${capability} adapter capability` };
    }
    const base = await this.getAdapter<IProviderAdapter>(
      providerName,
      provider.metadata.category,
      project ? getProjectScopeHints(project) : undefined, project, selection
    );
    if (!base.success || !base.adapter) {
      return { success: false, error: base.error || `No ${providerName} adapter available` };
    }
    try {
      return { success: true, adapter: await derive(base.adapter, { project }) as T, connectionProvider: base.connectionProvider };
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
