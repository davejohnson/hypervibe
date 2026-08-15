import type { Readable } from 'node:stream';
import type { Environment } from '../entities/environment.entity.js';
import type { Receipt, VerifyResult } from './provider.port.js';
import type { ObservedStorage } from './observe.port.js';

export interface StorageCapabilities {
  kind: 'object';
  regions: string[];
  privateOnly: boolean;
  supportsUsageObservation: boolean;
  /** Provider can expose a streaming object data plane for migration. */
  supportsObjectTransfer?: boolean;
}

export interface StorageObjectRecord {
  key: string;
  size: number;
}

export interface StorageObjectPayload {
  body: Readable | ReadableStream | Blob;
  size: number;
  contentType?: string;
  contentEncoding?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
}

export interface StorageObjectClient {
  list(): Promise<StorageObjectRecord[]>;
  get(key: string): Promise<StorageObjectPayload>;
  put(key: string, payload: StorageObjectPayload): Promise<void>;
  destroy(): void;
}

/**
 * Opaque, non-secret provider coordinates required to address one storage
 * instance. Adapters own the field names (for example Railway project and
 * environment ids, or a cloud account/project plus region).
 */
export type StorageContext = Record<string, string>;

export interface StorageCredentials {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
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
  /** Stable environment-variable names written when a service is wired. */
  runtimeEnvKeys(name: string): string[];
  connect(credentials: unknown): Promise<void>;
  verify(): Promise<VerifyResult>;
  disconnect?(): Promise<void>;
  /**
   * Verify or resolve storage context from already-converged provider
   * scaffolding. It must never create a project or deploy environment.
   */
  ensureContext(
    projectName: string,
    environment: Environment,
    context?: Partial<StorageContext>,
    desiredRegion?: string
  ): Promise<StorageEnsureResult>;
  /**
   * Resolve provider scope for first-use observation using identity/read APIs
   * only. This method must never create, register, tag, or mutate resources.
   */
  resolveObservationContext?(
    projectName: string,
    environment: Environment,
    desiredRegion: string
  ): Promise<StorageEnsureResult>;
  observe(environment: Environment, context: StorageContext): Promise<ObservedStorage[]>;
  ensureBucket(environment: Environment, context: StorageContext, name: string, region: string): Promise<StorageEnsureResult>;
  /** Resolve provider-native runtime configuration. Secret values never enter receipts or bindings. */
  getRuntimeEnv(environment: Environment, context: StorageContext, externalId: string, name: string): Promise<Record<string, string>>;
  /** S3-compatible data-plane credentials when this provider exposes them. */
  getCredentials?(environment: Environment, context: StorageContext, externalId: string): Promise<StorageCredentials>;
  /**
   * Optional provider-native object stream. Azure/GCP adapters can translate
   * their native APIs here; S3-compatible adapters may rely on credentials.
   */
  openObjectTransfer?(environment: Environment, context: StorageContext, externalId: string): Promise<StorageObjectClient>;
  destroyBucket(environment: Environment, context: StorageContext, externalId: string): Promise<Receipt>;
}
