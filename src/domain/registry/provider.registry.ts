import { z } from 'zod';

export type ProviderCategory = 'deployment' | 'dns' | 'email' | 'payment' | 'tunnel' | 'local' | 'security' | 'database' | 'appstore';

export interface ProviderMetadata {
  name: string;
  displayName: string;
  category: ProviderCategory;
  credentialsSchema: z.ZodTypeAny;
  setupHelpUrl?: string;
}

export interface RegisteredProvider {
  metadata: ProviderMetadata;
  factory: (credentials: unknown) => unknown;
}

/**
 * Central registry for all provider adapters.
 * Providers self-register at module load time.
 */
class ProviderRegistry {
  private providers = new Map<string, RegisteredProvider>();

  /**
   * Register a provider adapter
   */
  register(provider: RegisteredProvider): void {
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
