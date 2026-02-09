import { z } from 'zod';
import type {
  SecretManagerProvider,
  ISecretManagerAdapter,
  SecretManagerCapabilities,
} from '../ports/secretmanager.port.js';

export interface SecretManagerMetadata {
  name: SecretManagerProvider;
  displayName: string;
  credentialsSchema: z.ZodTypeAny;
  setupHelpUrl?: string;
}

export interface RegisteredSecretManager {
  metadata: SecretManagerMetadata;
  factory: (credentials: unknown) => ISecretManagerAdapter;
  /** Default capabilities (adapter may override after connect) */
  defaultCapabilities: SecretManagerCapabilities;
}

/**
 * Central registry for secret manager adapters.
 * Providers self-register at module load time.
 */
class SecretManagerRegistry {
  private providers = new Map<SecretManagerProvider, RegisteredSecretManager>();

  /**
   * Register a secret manager adapter
   */
  register(provider: RegisteredSecretManager): void {
    this.providers.set(provider.metadata.name, provider);
  }

  /**
   * Get a secret manager by name
   */
  get(name: SecretManagerProvider | string): RegisteredSecretManager | undefined {
    return this.providers.get(name as SecretManagerProvider);
  }

  /**
   * Get all registered provider names
   */
  names(): SecretManagerProvider[] {
    return [...this.providers.keys()];
  }

  /**
   * Get all registered providers
   */
  all(): RegisteredSecretManager[] {
    return [...this.providers.values()];
  }

  /**
   * Check if a provider is registered
   */
  has(name: string): boolean {
    return this.providers.has(name as SecretManagerProvider);
  }

  /**
   * Validate credentials against a provider's schema
   */
  validateCredentials(
    name: string,
    creds: unknown
  ): { success: boolean; error?: string; data?: unknown } {
    const provider = this.providers.get(name as SecretManagerProvider);
    if (!provider) {
      return { success: false, error: `Unknown secret manager: ${name}` };
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
  createAdapter(name: string, creds: unknown): ISecretManagerAdapter {
    const provider = this.providers.get(name as SecretManagerProvider);
    if (!provider) {
      throw new Error(`Unknown secret manager: ${name}`);
    }
    return provider.factory(creds);
  }

  /**
   * Get provider metadata
   */
  getMetadata(name: string): SecretManagerMetadata | undefined {
    return this.providers.get(name as SecretManagerProvider)?.metadata;
  }

  /**
   * Get default capabilities for a provider
   */
  getCapabilities(name: string): SecretManagerCapabilities | undefined {
    return this.providers.get(name as SecretManagerProvider)?.defaultCapabilities;
  }
}

// Export singleton instance
export const secretManagerRegistry = new SecretManagerRegistry();
