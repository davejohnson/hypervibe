import { z } from 'zod';
import type { ProviderCiDeployMetadata } from '../ports/ci-deploy.port.js';
import type { Project } from '../entities/project.entity.js';

export type ProviderCategory = 'deployment' | 'dns' | 'email' | 'payment' | 'tunnel' | 'local' | 'security' | 'database' | 'cache' | 'storage' | 'appstore' | 'ai';
export type ProviderLifecycleCapability = 'hosting' | 'database' | 'cache' | 'storage';

export interface ProviderMetadata {
  name: string;
  displayName: string;
  category: ProviderCategory;
  credentialsSchema: z.ZodTypeAny;
  setupHelpUrl?: string;
  credentials?: {
    defaultScalarKey?: string;
    /**
     * Environment-variable names which may resolve the same credential value.
     * Exact requested names win; aliases are only fallbacks.
     */
    environmentVariableAliases?: string[][];
  };
  orchestration?: ProviderOrchestrationMetadata;
  lifecycle?: {
    /** Engines this provider can reconcile through its database adapter. */
    databaseEngines?: string[];
    /** Engines this provider can reconcile through its cache adapter. */
    cacheEngines?: string[];
  };
}

export interface ProviderOrchestrationMetadata {
  project?: {
    /**
     * Provider projects contain multiple deploy environments. When a new
     * Hypervibe environment is added, reuse the existing project binding
     * instead of creating another provider project.
     */
    shareAcrossEnvironments?: boolean;
  };
  environment?: {
    /**
     * The provider models deploy environments as durable resources inside a
     * shared project. Planning must ensure and bind this resource explicitly
     * before any service, datastore, storage, or domain mutation can run.
     */
    separateResource?: boolean;
  };
  diff?: {
    /** Source-less services are expected unless branch deploys are configured. */
    requiresBranchDeployForCode?: boolean;
    /** Some providers cannot observe web vs worker, only cron vs non-cron. */
    workloadKindObservation?: 'exact' | 'cron-only';
    /**
     * Some providers report generated/reference env vars as resolved values.
     * Return true when Hypervibe should verify only that the key exists live.
     */
    presenceOnlyManagedEnvVar?: (params: { key: string; value: string }) => boolean;
  };
  connections?: {
    missingConnectionPolicy?: 'hard' | 'action-scoped-if-independent-actions';
  };
  logs?: {
    runtime?: boolean;
    deployments?: boolean;
    build?: boolean;
  };
  ci?: ProviderCiDeployMetadata;
  nativeBranchDeploy?: {
    needsGitHubAppAccess?: boolean;
    githubAppInstallUrl?: string;
    /**
     * Reconciliation policy when the desired trigger is CI but a live
     * provider-native repository source is still connected.
     */
    ciModeSourcePolicy?: 'disconnect' | 'block';
  };
}

export interface RegisteredProvider {
  metadata: ProviderMetadata;
  factory: (credentials: unknown) => unknown;
  /** Optional hook to install CLI tools or other dependencies when a connection is created. */
  ensureDependencies?: () => Promise<{ installed: string[]; errors: string[] }>;
  /** Provider-owned adapters derived from the connected primary adapter. */
  derivedAdapters?: {
    database?: (adapter: unknown, context: { project?: Project }) => Promise<unknown> | unknown;
    cache?: (adapter: unknown, context: { project?: Project }) => Promise<unknown> | unknown;
    storage?: (adapter: unknown, context: { project?: Project }) => Promise<unknown> | unknown;
  };
}

/**
 * Central registry for all provider adapters.
 * Providers self-register at module load time.
 */
export class ProviderRegistry {
  private providers = new Map<string, RegisteredProvider>();

  /**
   * Register a provider adapter
   */
  register(provider: RegisteredProvider): void {
    if (this.providers.has(provider.metadata.name)) {
      throw new Error(`Provider "${provider.metadata.name}" is already registered`);
    }
    this.providers.set(provider.metadata.name, provider);
  }

  /**
   * Get a provider by name
   */
  get(name: string): RegisteredProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all providers in a category
   */
  getByCategory(category: ProviderCategory): RegisteredProvider[] {
    return [...this.providers.values()].filter((p) => p.metadata.category === category);
  }

  /**
   * Get all registered provider names
   */
  names(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Get all registered providers
   */
  all(): RegisteredProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Check if a provider is registered
   */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Test whether a provider exposes a lifecycle adapter without teaching
   * generic orchestration about provider names. A deployment/database primary
   * adapter satisfies its matching capability; multi-product providers may
   * expose database or storage through derived adapters.
   */
  supports(name: string, capability: ProviderLifecycleCapability): boolean {
    const provider = this.providers.get(name);
    if (!provider) return false;
    if (capability === 'hosting') {
      return provider.metadata.category === 'deployment';
    }
    if (capability === 'database') {
      const exposesAdapter = provider.metadata.category === 'database'
        || typeof provider.derivedAdapters?.database === 'function';
      return exposesAdapter
        && (provider.metadata.lifecycle?.databaseEngines?.length ?? 0) > 0;
    }
    if (capability === 'cache') {
      const exposesAdapter = provider.metadata.category === 'cache'
        || typeof provider.derivedAdapters?.cache === 'function';
      return exposesAdapter
        && (provider.metadata.lifecycle?.cacheEngines?.length ?? 0) > 0;
    }
    return provider.metadata.category === 'storage'
      || typeof provider.derivedAdapters?.storage === 'function';
  }

  namesFor(capability: ProviderLifecycleCapability): string[] {
    return this.names().filter((name) => this.supports(name, capability));
  }

  supportsEngine(name: string, capability: 'database' | 'cache', engine: string): boolean {
    const provider = this.providers.get(name);
    if (!provider || !this.supports(name, capability)) return false;
    const engines = capability === 'database'
      ? provider.metadata.lifecycle?.databaseEngines
      : provider.metadata.lifecycle?.cacheEngines;
    return Array.isArray(engines) && engines.includes(engine);
  }

  /**
   * Validate credentials against a provider's schema
   */
  validateCredentials(
    name: string,
    creds: unknown
  ): { success: boolean; error?: string; data?: unknown } {
    const provider = this.providers.get(name);
    if (!provider) {
      return { success: false, error: `Unknown provider: ${name}` };
    }
    const result = provider.metadata.credentialsSchema.safeParse(creds);
    if (!result.success) {
      return { success: false, error: result.error.message };
    }
    return { success: true, data: result.data };
  }

  /**
   * Create an adapter instance for a provider
   */
  createAdapter<T = unknown>(name: string, creds: unknown): T {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Unknown provider: ${name}`);
    }
    return provider.factory(creds) as T;
  }

  /**
   * Get provider metadata
   */
  getMetadata(name: string): ProviderMetadata | undefined {
    return this.providers.get(name)?.metadata;
  }
}

// Export singleton instance
export const providerRegistry = new ProviderRegistry();
