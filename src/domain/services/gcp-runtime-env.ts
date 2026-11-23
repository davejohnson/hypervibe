import { CACHE_ENV_KEYS } from './cache-env.js';
import { BUILD_TOKEN_KEYS } from './runtime-env-policy.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';

export const CLOUD_RUN_RESERVED_ENV = new Set(['PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION']);
export const S3_COMPATIBLE_SECRET_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;

const GCP_STORAGE_KEYS = ['OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_STORAGE_BUCKET'] as const;
const S3_STORAGE_KEYS = ['AWS_ENDPOINT_URL', 'AWS_DEFAULT_REGION', 'AWS_S3_BUCKET_NAME', 'AWS_S3_URL_STYLE',
  'AWS_REQUEST_CHECKSUM_CALCULATION', 'AWS_RESPONSE_CHECKSUM_VALIDATION'] as const;
export type GcpStorageEnv = Record<typeof GCP_STORAGE_KEYS[number], string>;
export type GcpS3StorageEnv = Record<typeof S3_STORAGE_KEYS[number], string>;

export function queueEnvVarSuffix(queueName: string): string {
  return queueName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function pubsubQueueEnvNames(queueName: string) {
  const suffix = queueEnvVarSuffix(queueName);
  return { topic: `QUEUE_TOPIC_${suffix}`, subscription: `QUEUE_SUBSCRIPTION_${suffix}` };
}

/** Check the declared wiring before any resource or secret needs to exist. */
export function gcpDatabaseAliasProblems(environment: EnvironmentSpec): string[] {
  const problems: string[] = [];
  if (environment.hosting.provider !== 'cloudrun' || environment.database?.provider !== 'cloudsql') return problems;
  const shared = new Set<string>([...BUILD_TOKEN_KEYS, ...CLOUD_RUN_RESERVED_ENV, 'CLOUD_SQL_CONNECTION_NAME', 'PGHOST']);
  if (environment.cache?.provider === 'memorystore') {
    for (const key of CACHE_ENV_KEYS) shared.add(key);
  }
  for (const queue of Object.keys(environment.queues ?? {})) {
    shared.add('QUEUE_BACKEND');
    shared.add('QUEUE_NAMES');
    const { topic, subscription } = pubsubQueueEnvNames(queue);
    shared.add(topic);
    shared.add(subscription);
  }
  for (const [service, { databaseEnvAliases }] of Object.entries(environment.services)) {
    if (!databaseEnvAliases) continue;
    const reserved = new Set(shared);
    for (const storage of Object.values(environment.storage ?? {})) {
      if (storage.provider !== 'gcs' || !storage.injectInto.includes(service)) continue;
      for (const key of GCP_STORAGE_KEYS) reserved.add(key);
      if (storage.access === 's3') {
        for (const key of [...S3_STORAGE_KEYS, ...S3_COMPATIBLE_SECRET_KEYS]) reserved.add(key);
      }
    }
    for (const alias of Object.keys(databaseEnvAliases)) {
      if (reserved.has(alias)) {
        problems.push(`Cloud Run reserves "${alias}" for another setting on service "${service}". Choose another database URL alias.`);
      }
    }
  }
  return problems;
}
