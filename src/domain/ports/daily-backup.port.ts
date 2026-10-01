import type { Environment } from '../entities/environment.entity.js';
import type { Component } from '../entities/component.entity.js';
import type { Receipt } from './provider.port.js';
import type { RecoverySourceIdentity } from './recovery-source.port.js';
import type { ServiceVolumeTarget } from './service-volume.port.js';
import type { StorageContext } from './storage.port.js';

/** Schedule configuration is not evidence of a completed backup or tested restore. */
export type DailyBackupObservation = {
  state: 'known';
  source: RecoverySourceIdentity;
  daily: boolean;
  policyFingerprint: string;
  /** Native protection that must survive adding daily scheduling. */
  preservationFingerprint: string;
  mechanism: 'snapshot' | 'continuous' | 'retained-copy';
  retention?: { unit: 'days' | 'backups'; value: number };
} | { state: 'unknown'; reason: string };

export interface DailyBackupReview {
  source: RecoverySourceIdentity;
  policyFingerprint: string;
}

/** Add daily protection, preserving stronger schedules, retention and PITR.
 * Never creates a backup, restores data, changes the source image, or disables
 * protection. Native adapters own prerequisites and exact source resolution.
 */
export interface IDailyBackupPolicy<TTarget> {
  observe(target: TTarget): Promise<DailyBackupObservation>;
  /** Read terminal point/restore evidence. Missing support must never imply a healthy backup. */
  observeRecovery?(target: TTarget): Promise<import('../services/backup-health.service.js').BackupRecoveryObservation>;
  configureDaily(target: TTarget, reviewed: DailyBackupReview): Promise<Receipt>;
}

export interface DatabaseBackupTarget { environment: Environment; component: Component }
export interface VolumeBackupTarget { target: ServiceVolumeTarget; externalId: string }
export interface StorageBackupTarget { environment: Environment; context: StorageContext; externalId: string }
