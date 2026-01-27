import { z } from 'zod';

/**
 * Infrastructure primitives - the building blocks of deployment
 */
export type InfraPrimitive =
  | 'compute'    // Web servers, workers
  | 'database'   // PostgreSQL, MySQL, MongoDB
  | 'cache'      // Redis, Memcached
  | 'queue'      // Message queues
  | 'cron'       // Scheduled jobs
  | 'dns'        // DNS management
  | 'storage';   // File/object storage

/**
 * Standard environment variables each primitive type provides
 */
export const PRIMITIVE_ENV_VARS: Record<InfraPrimitive, string[]> = {
  compute: ['PORT', 'HOST'],
  database: ['DATABASE_URL'],
  cache: ['REDIS_URL', 'CACHE_URL'],
  queue: ['QUEUE_URL', 'AMQP_URL'],
  cron: [], // Usually just config, no connection string
  dns: [],  // Managed externally
  storage: ['STORAGE_URL', 'S3_BUCKET', 'S3_ENDPOINT'],
};

/**
 * Infrastructure provider plugin definition
 */
export interface InfraProvider {
  name: string;
  displayName: string;

  // Which primitives this provider offers
  primitives: InfraPrimitive[];

  // Credentials needed to use this provider
  credentialsSchema: z.ZodTypeAny;

  // Setup help
  setupUrl?: string;
  documentationUrl?: string;

  // How this provider exposes each primitive's env vars
  // e.g., Railway Postgres provides DATABASE_URL via ${{Postgres.DATABASE_URL}}
  envVarMapping?: Partial<Record<InfraPrimitive, Record<string, string>>>;

  // Factory to create the adapter
  factory: (credentials: unknown) => unknown;
}

/**
 * Registry for infrastructure providers
 */
class InfrastructureRegistry {
  private providers = new Map<string, InfraProvider>();

  register(provider: InfraProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): InfraProvider | undefined {
    return this.providers.get(name);
  }

  all(): InfraProvider[] {
    return [...this.providers.values()];
  }

  names(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Get all providers that offer a specific primitive
   */
  getByPrimitive(primitive: InfraPrimitive): InfraProvider[] {
    return [...this.providers.values()].filter((p) =>
      p.primitives.includes(primitive)
    );
  }

  /**
   * Get providers grouped by primitive
   */
  byPrimitive(): Record<InfraPrimitive, InfraProvider[]> {
    const result: Record<InfraPrimitive, InfraProvider[]> = {
      compute: [],
      database: [],
      cache: [],
      queue: [],
      cron: [],
      dns: [],
      storage: [],
    };

    for (const provider of this.providers.values()) {
      for (const primitive of provider.primitives) {
        result[primitive].push(provider);
      }
    }

    return result;
  }

  /**
   * Validate credentials for a provider
   */
  validateCredentials(
    name: string,
    creds: unknown
  ): { success: boolean; error?: string; data?: unknown } {
    const provider = this.providers.get(name);
    if (!provider) {
      return { success: false, error: `Unknown provider: ${name}` };
    }
    const result = provider.credentialsSchema.safeParse(creds);
    if (!result.success) {
      return { success: false, error: result.error.message };
    }
    return { success: true, data: result.data };
  }

  /**
   * Create an adapter instance
   */
  createAdapter<T = unknown>(name: string, creds: unknown): T {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Unknown provider: ${name}`);
    }
    return provider.factory(creds) as T;
  }
}

export const infrastructureRegistry = new InfrastructureRegistry();

// ============================================
// Built-in Infrastructure Providers
// ============================================

// Note: The actual adapters register themselves via their own files
// This file just defines the registry structure

// Example of how a provider would register (done in adapter files):
/*
infrastructureRegistry.register({
  name: 'railway',
  displayName: 'Railway',
  primitives: ['compute', 'database', 'cache'],
  credentialsSchema: RailwayCredentialsSchema,
  setupUrl: 'https://railway.app/account/tokens',
  envVarMapping: {
    database: {
      DATABASE_URL: '${{Postgres.DATABASE_URL}}',
    },
    cache: {
      REDIS_URL: '${{Redis.REDIS_URL}}',
    },
  },
  factory: (creds) => new RailwayAdapter(creds),
});
*/
