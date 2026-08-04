import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Receipt } from './provider.port.js';

export type DatabaseAvailability = 'zonal' | 'regional';

export interface DatabaseBackupPolicy {
  retainedBackups: number;
  pitrRetentionDays: number;
}

export interface DatabaseReplicaConfig {
  region?: string;
  tier?: string;
}

export interface DatabaseReplicaBinding extends DatabaseReplicaConfig {
  externalId: string;
  connectionName?: string;
  connectionUrl?: string;
  createdAt?: string;
}

export interface DatabaseReplicaProvisionResult {
  receipt: Receipt;
  replica?: DatabaseReplicaBinding;
}

/** Optional provider capability kept separate from the primary database port. */
export interface IDatabaseResilienceAdapter {
  configureAvailability(
    environment: Environment,
    component: Component,
    availability: DatabaseAvailability
  ): Promise<Receipt>;

  configureBackupPolicy(
    environment: Environment,
    component: Component,
    policy: DatabaseBackupPolicy
  ): Promise<Receipt>;

  provisionReadReplica(
    environment: Environment,
    component: Component,
    name: string,
    config: DatabaseReplicaConfig
  ): Promise<DatabaseReplicaProvisionResult>;

  destroyReadReplica(
    environment: Environment,
    component: Component,
    name: string,
    replica: DatabaseReplicaBinding
  ): Promise<Receipt>;
}

export function supportsDatabaseResilience(
  adapter: unknown
): adapter is IDatabaseResilienceAdapter {
  const candidate = adapter as Partial<IDatabaseResilienceAdapter> | null;
  return Boolean(
    candidate
    && typeof candidate.configureAvailability === 'function'
    && typeof candidate.configureBackupPolicy === 'function'
    && typeof candidate.provisionReadReplica === 'function'
    && typeof candidate.destroyReadReplica === 'function'
  );
}
