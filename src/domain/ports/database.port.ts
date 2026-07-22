import type { Environment } from '../entities/environment.entity.js';
import type { Component, ComponentType } from '../entities/component.entity.js';
import type { Receipt, TemporaryDatabaseAccess, VerifyResult } from './provider.port.js';

/**
 * Supported database types that can be provisioned
 */
export type DatabaseType = 'postgres';

/**
 * All provisionable component types
 */
export type ProvisionableType = DatabaseType;

/**
 * Capabilities that a database provider supports.
 */
export interface DatabaseCapabilities {
  /** Database types the provider supports */
  supportedDatabases: DatabaseType[];

  /** Whether the provider supports connection pooling (important for serverless) */
  supportsPooling: boolean;

  /** Whether read replicas can be provisioned */
  supportsReadReplicas: boolean;

  /** Whether point-in-time recovery is available */
  supportsPointInTimeRecovery: boolean;

  /** Whether the provider is optimized for serverless workloads */
  serverlessOptimized: boolean;

  /** Whether bounded operations can acquire and release provider-owned access. */
  supportsTemporaryDatabaseAccess?: boolean;

  /** Prefer provider-owned access even when a stored public-looking URL exists. */
  prefersTemporaryDatabaseAccess?: boolean;
}

/**
 * Result of provisioning a database or cache
 */
export interface ProvisionResult {
  /** The provisioned component with bindings populated */
  component: Component;

  /** Standard receipt with success/failure info */
  receipt: Receipt;

  /** Connection URL ready for injection into hosting environment */
  connectionUrl?: string;

  /** Additional environment variables to set (e.g., individual host/port/user/pass) */
  envVars?: Record<string, string>;
}

/**
 * Standard binding keys used for database components
 */
export interface DatabaseBindings {
  /** Provider name (e.g., 'supabase', 'cloudsql', 'railway', 'rds') */
  provider: string;

  /** External database/instance ID */
  instanceId: string;

  /** Connection URL */
  connectionUrl: string;

  /** Pooled connection URL (if available) */
  pooledUrl?: string;

  /** Individual connection parameters */
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
}

/**
 * Interface for database provider adapters.
 * Database adapters provision and manage databases independently of hosting.
 * The connection URLs they produce are injected into hosting platforms.
 */
export interface IDatabaseAdapter {
  readonly name: string;

  /** Provider capabilities */
  readonly capabilities: DatabaseCapabilities;

  /**
   * Connect to the database provider with credentials
   */
  connect(credentials: unknown): Promise<void>;

  /**
   * Verify the connection and credentials are valid
   */
  verify(): Promise<VerifyResult>;

  /**
   * Disconnect and clean up
   */
  disconnect?(): Promise<void>;

  /**
   * Provision a new database or cache instance.
   * Returns the component with connection details ready for use.
   */
  provision(
    type: ProvisionableType,
    environment: Environment,
    options?: {
      /** Instance size/tier */
      size?: string;
      /** Region for the instance */
      region?: string;
      /** Database name to create */
      databaseName?: string;
    }
  ): Promise<ProvisionResult>;

  /**
   * Get the connection URL for an existing component.
   * Useful when the URL needs to be refreshed or retrieved.
   */
  getConnectionUrl(component: Component): Promise<string | null>;

  /**
   * Destroy a provisioned database/cache instance.
   * Use with caution - this deletes data permanently.
   */
  destroy(component: Component): Promise<Receipt>;

  /**
   * Check the status of a database instance.
   */
  getStatus?(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }>;

  /**
   * Acquire an externally usable endpoint for one bounded operation.
   * Implementations must mark reused access temporary=false so callers never
   * remove user-managed access.
   */
  acquireTemporaryDatabaseAccess?(
    environment: Environment,
    component: Component,
    applicationPort: number
  ): Promise<TemporaryDatabaseAccess>;

  /** Release only access returned with temporary=true by this adapter. */
  releaseTemporaryDatabaseAccess?(
    environment: Environment,
    component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void>;
}
