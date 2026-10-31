import type { Environment } from '../entities/environment.entity.js';
import type { ProviderRuntimeIdentity, Receipt } from './provider.port.js';
import type { StorageContext } from './storage.port.js';

/** Exact bucket and consuming workload. All fields are non-secret evidence. */
export interface StorageRuntimeAccessTarget {
  environment: Environment;
  serviceName: string;
  storageName: string;
  externalId: string;
  context: StorageContext;
  identity: ProviderRuntimeIdentity;
}

/** A provider-owned grant identity; existence alone never establishes ownership. */
export interface StorageRuntimeAccessBinding {
  id: string;
  attemptId: string;
  evidence: Record<string, string>;
}

export type StorageRuntimeAccessObservation =
  | { state: 'absent' }
  | { state: 'present'; binding: StorageRuntimeAccessBinding }
  | { state: 'unknown'; reason: string };

/** Each write is its own reviewed action, separate from environment wiring. */
export interface IStorageRuntimeAccess {
  readonly hostingProviders: readonly string[];
  observe(target: StorageRuntimeAccessTarget, binding?: StorageRuntimeAccessBinding): Promise<StorageRuntimeAccessObservation>;
  grant(target: StorageRuntimeAccessTarget, attemptId: string, binding?: StorageRuntimeAccessBinding): Promise<{
    receipt: Receipt;
    binding?: StorageRuntimeAccessBinding;
  }>;
  revoke(target: StorageRuntimeAccessTarget, binding: StorageRuntimeAccessBinding): Promise<Receipt>;
}
