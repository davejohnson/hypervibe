import type { Environment } from '../entities/environment.entity.js';
import type { Component } from '../entities/component.entity.js';
import type { ObservedCache } from './observe.port.js';
import type { Receipt, VerifyResult } from './provider.port.js';

export type CacheEngine = 'redis';

export interface CacheCapabilities {
  supportedCaches: CacheEngine[];
  supportsTls: boolean;
  supportsHighAvailability: boolean;
  supportsPersistence: boolean;
  serverlessOptimized: boolean;
}

export interface CacheProvisionResult {
  component: Component;
  receipt: Receipt;
  connectionUrl?: string;
  envVars?: Record<string, string>;
}

/**
 * Cache lifecycle is deliberately separate from databases: Redis has its own
 * runtime contract and bounded verification, and SQL migration commands do
 * not apply to it.
 */
export interface ICacheAdapter {
  readonly name: string;
  readonly capabilities: CacheCapabilities;

  connect(credentials: unknown): Promise<void>;
  verify(): Promise<VerifyResult>;
  disconnect?(): Promise<void>;

  provision(
    engine: CacheEngine,
    environment: Environment,
    options?: {
      size?: string;
      region?: string;
      resourceName?: string;
    }
  ): Promise<CacheProvisionResult>;

  getConnectionUrl(component: Component): Promise<string | null>;
  destroy(component: Component): Promise<Receipt>;
  getStatus?(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }>;
  observeCache(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedCache | null>;
}
