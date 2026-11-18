import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { parseStorageBindings, type StorageBinding } from '../domain/services/storage-plan.service.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import type { StorageContext } from '../domain/ports/storage.port.js';
import { engineBucketName, type MigrationCopyEvidence } from './infrastructure-engine.js';
import { s3SourceRemote, type StorageTransferResult } from './migration-transfer-gcp.js';

interface SelectedBucket {
  name: string;
  binding: StorageBinding;
  targetBucket: string;
  identity: string;
}

function hasScope(scope: unknown): scope is StorageContext {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
  const fields = Object.entries(scope);
  return fields.length > 0 && fields.every(([key, value]) => key.trim() && typeof value === 'string' && value.trim());
}

export function selectMigrationBuckets(source: EnvironmentSpec, target: EnvironmentSpec, environment: Environment, projectId: string, targetName: string) {
  const bindings = parseStorageBindings(environment);
  const buckets: SelectedBucket[] = [];
  for (const [name, requested] of Object.entries(source.storage ?? {})) {
    if (requested.purpose === 'backup') continue;
    const binding = bindings[name];
    if (typeof binding?.externalId !== 'string' || !binding.externalId.trim() || binding.provider !== requested.provider
      || binding.purpose === 'backup' || !hasScope(binding.instanceScope)) {
      return { blocked: `The source bucket ${name} has no matching deployed storage binding. Check its provider and environment before migrating.` } as const;
    }
    const targetStorage = target.storage?.[name];
    if (targetStorage?.provider !== 'gcs' || targetStorage.purpose === 'backup') {
      return { blocked: `The target needs a matching Google Cloud Storage data bucket for ${name}.` } as const;
    }
    const targetBucket = engineBucketName(projectId, targetName, name);
    const identity = canonicalJsonSha256({ provider: binding.provider, id: binding.externalId, scope: binding.instanceScope, targetBucket });
    buckets.push({ name, binding, targetBucket, identity });
  }
  return { buckets } as const;
}

export function missingDeployedBucket(buckets: SelectedBucket[], deployed?: string[]) {
  const missing = buckets.find(({ name }) => !Array.isArray(deployed) || !deployed.includes(name));
  return missing && `Hypervibe has no record of deploying the target data bucket ${missing.name}. Check the target infrastructure plan and storage binding before retrying.`;
}

export function bucketSummaries(storage: NonNullable<MigrationCopyEvidence['storage']>) {
  return storage.map(({ name, files, bytes, match }) => ({ name, files, bytes, match }));
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function hasVerifiedBuckets(evidence: MigrationCopyEvidence, buckets: SelectedBucket[]) {
  const receipts = evidence.storage ?? [];
  return Array.isArray(receipts) && receipts.length === buckets.length && buckets.every(({ name, identity }) => receipts.some(
    receipt => receipt?.name === name && receipt.match === true && count(receipt.files) && count(receipt.bytes) && receipt.downloadVerifiedFor === identity,
  ));
}

/** Resolve every selected bucket before any job can replace the target database or files. */
export async function prepareMigrationBuckets(project: Project, environment: Environment, buckets: SelectedBucket[]) {
  const prepared = [];
  for (const { name, binding, targetBucket, identity } of buckets) {
    const adapter = await adapterFactory.getStorageAdapter(binding.provider, project);
    if (!adapter.success || !adapter.adapter?.getCredentials || !binding.instanceScope) {
      return { blocked: `Hypervibe could not get access to the source data bucket ${name} on ${binding.provider}.` } as const;
    }
    try {
      const credentials = await adapter.adapter.getCredentials(environment, binding.instanceScope, binding.externalId);
      if (!credentials.bucket?.trim() || credentials.bucket.includes('/') || !credentials.accessKeyId || !credentials.secretAccessKey) {
        return { blocked: `The provider returned incomplete access details for the source bucket ${name}.` } as const;
      }
      const remote = s3SourceRemote(credentials);
      prepared.push({ name, identity, env: { ...remote.env, SOURCE_BUCKET: credentials.bucket, TARGET_BUCKET: targetBucket }, sourceSecrets: remote.secrets });
    } catch {
      return { blocked: `Hypervibe could not read the access details for the source data bucket ${name}.` } as const;
    }
  }
  return { prepared } as const;
}

export function compareMigrationBucket(name: string, result: StorageTransferResult) {
  if (result.ok !== true) return { blocked: result.error ?? `Comparing files in ${name} failed.` } as const;
  const { source, target, differences } = result;
  if (result.comparison !== 'download' || !count(differences) || !count(source?.count) || !count(source.bytes)
    || !count(target?.count) || !count(target.bytes)) {
    return { blocked: `The file check for ${name} returned incomplete evidence.` } as const;
  }
  const match = differences === 0 && source.count === target.count && source.bytes === target.bytes;
  return { name, files: source.count, bytes: source.bytes, differences, match } as const;
}
