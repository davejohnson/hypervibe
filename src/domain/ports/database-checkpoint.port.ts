import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { RecoverySourceIdentity } from './recovery-source.port.js';

export type DatabaseCheckpointIdentity = RecoverySourceIdentity;

export interface DatabaseCheckpointBackup {
  id: string;
  externalId?: string;
  name?: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedMB?: number | null;
  referencedMB?: number | null;
  volumeInstanceSizeMB?: number | null;
}

export interface DatabaseCheckpointSource extends DatabaseCheckpointIdentity {
  backups: DatabaseCheckpointBackup[];
}

export type DatabaseCheckpointObservation =
  | { state: 'pending' | 'failed' | 'unknown' }
  | { state: 'complete'; source: DatabaseCheckpointIdentity; backup: DatabaseCheckpointBackup };

export interface DatabaseCheckpointObservationFailure {
  stage: 'source_inventory' | 'workflow_status' | 'operation_status';
  category: 'authorization' | 'schema' | 'rate_limit' | 'provider' | 'invalid_response' | 'unknown';
  httpStatus?: number;
}

/** Locally classified read failure; never retain raw provider text or request data. */
export class DatabaseCheckpointObservationError extends Error implements DatabaseCheckpointObservationFailure {
  readonly httpStatus?: number;

  constructor(readonly stage: DatabaseCheckpointObservationFailure['stage'],
    readonly category: DatabaseCheckpointObservationFailure['category'], httpStatus?: number) {
    super(`Database checkpoint observation is unknown (${stage}: ${category}).`);
    this.name = 'DatabaseCheckpointObservationError';
    if (Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599) this.httpStatus = httpStatus;
  }
}

export interface DatabaseCheckpointBinding {
  source: DatabaseCheckpointIdentity;
  label: string;
  beforeBackupIds: string[];
  beforeBackupExternalIds: string[];
  requestStartedAt: string;
  acknowledged?: boolean;
  operationId?: string;
  state: 'attempting' | 'running' | 'complete' | 'unknown' | 'error';
  backup?: DatabaseCheckpointBackup;
  verifiedAt?: string;
}

/** Snapshot-only capability; failure or incomplete reads must throw, never imply absence. */
export interface IDatabaseCheckpointAdapter {
  observeCheckpointSource(environment: Environment, component: Component): Promise<DatabaseCheckpointSource>;
  /** Prove native completion and exact correlation; inventory presence alone is insufficient. */
  observeCheckpointRequest(environment: Environment, component: Component, binding: DatabaseCheckpointBinding): Promise<DatabaseCheckpointObservation>;
  createCheckpoint(source: DatabaseCheckpointIdentity, label: string): Promise<{ acknowledged: boolean; operationId?: string }>;
}

export function supportsDatabaseCheckpoint(adapter: unknown): adapter is IDatabaseCheckpointAdapter {
  const candidate = adapter as Partial<IDatabaseCheckpointAdapter> | null;
  return Boolean(candidate
    && typeof candidate.observeCheckpointSource === 'function'
    && typeof candidate.observeCheckpointRequest === 'function'
    && typeof candidate.createCheckpoint === 'function');
}
