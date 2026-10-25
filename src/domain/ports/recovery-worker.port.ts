import type { RecoverySourceIdentity } from './recovery-source.port.js';
import type { StorageObjectClient } from './storage.port.js';
import type { RecoveryRuntimeStorageIdentity } from './recovery-runtime.port.js';

/** Provider-native worker inputs are non-secret except the selected SQL URL. */
export interface RecoveryWorkerRequest {
  configuration: Record<string, string>;
  database?: { source: RecoverySourceIdentity };
  sourceUrl?: string;
  destination: RecoveryRuntimeStorageIdentity;
  archiveBucket: string;
  objects: Array<{ name: string; identity: RecoveryRuntimeStorageIdentity; bucket: string }>;
}

export interface RecoveryWorkerSession {
  sourceUrl?: string;
  openStorage(identity: RecoveryRuntimeStorageIdentity): Promise<StorageObjectClient>;
  close(): Promise<void>;
}

export interface IRecoveryWorker {
  validate(request: RecoveryWorkerRequest): void;
  open(request: RecoveryWorkerRequest): Promise<RecoveryWorkerSession>;
}
