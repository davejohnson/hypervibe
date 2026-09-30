import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';

export interface DatabaseCheckpointIdentity {
  providerScope: Record<string, string>;
  primaryExternalId: string;
  volumeId: string;
  volumeInstanceId: string;
}

export interface DatabaseCheckpointBackup {
  id: string;
  externalId: string;
  name: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedMB: number | null;
  referencedMB: number | null;
  volumeInstanceSizeMB: number | null;
}

export interface DatabaseCheckpointSource extends DatabaseCheckpointIdentity {
  backups: DatabaseCheckpointBackup[];
}

export interface DatabaseCheckpointWorkflow {
  state: 'running' | 'complete' | 'error' | 'not-found';
}

export interface DatabaseCheckpointObservationFailure {
  stage: 'source_inventory' | 'workflow_status';
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
  workflowId?: string;
  state: 'attempting' | 'running' | 'complete' | 'unknown' | 'error';
  backup?: DatabaseCheckpointBackup;
  verifiedAt?: string;
}

/** Snapshot-only capability; failure or incomplete reads must throw, never imply absence. */
export interface IDatabaseCheckpointAdapter {
  observeCheckpointSource(environment: Environment, component: Component): Promise<DatabaseCheckpointSource>;
  observeCheckpointWorkflow(workflowId: string): Promise<DatabaseCheckpointWorkflow>;
  createCheckpoint(source: DatabaseCheckpointIdentity, label: string): Promise<{ workflowId: string | null }>;
}

export function supportsDatabaseCheckpoint(adapter: unknown): adapter is IDatabaseCheckpointAdapter {
  const candidate = adapter as Partial<IDatabaseCheckpointAdapter> | null;
  return Boolean(candidate
    && typeof candidate.observeCheckpointSource === 'function'
    && typeof candidate.observeCheckpointWorkflow === 'function'
    && typeof candidate.createCheckpoint === 'function');
}
