import type { Environment } from '../entities/environment.entity.js';
import type { Receipt, VerifyResult } from './provider.port.js';
import type { ObservedStorage } from './observe.port.js';

export interface StorageCapabilities {
  kind: 'object';
  regions: string[];
  privateOnly: boolean;
  supportsUsageObservation: boolean;
}

export interface StorageContext {
  projectId: string;
  environmentId: string;
}

export interface StorageCredentials {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  urlStyle: string;
}

export interface StorageEnsureResult {
  receipt: Receipt;
  externalId?: string;
  context?: StorageContext;
}

export interface IStorageAdapter {
  readonly name: string;
  readonly capabilities: StorageCapabilities;
  connect(credentials: unknown): Promise<void>;
  verify(): Promise<VerifyResult>;
  disconnect?(): Promise<void>;
  ensureContext(projectName: string, environment: Environment, context?: Partial<StorageContext>): Promise<StorageEnsureResult>;
  observe(environment: Environment, context: StorageContext): Promise<ObservedStorage[]>;
  ensureBucket(environment: Environment, context: StorageContext, name: string, region: string): Promise<StorageEnsureResult>;
  getCredentials(environment: Environment, context: StorageContext, externalId: string): Promise<StorageCredentials>;
  destroyBucket(environment: Environment, context: StorageContext, externalId: string): Promise<Receipt>;
}
