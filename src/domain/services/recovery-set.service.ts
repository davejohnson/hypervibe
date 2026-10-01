import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { StorageObjectClient } from '../ports/storage.port.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { createLocalRecoveryStore } from './local-recovery-store.js';
import { backupAndVerifyPostgres, type PostgresBackupInput, type PostgresBackupResult } from './postgres-backup.service.js';
import { createObjectRecoverySet, objectRecoveryIdentitySchema, objectRecoveryManifestKey, restoreObjectRecoverySet,
  type ObjectRecoveryIdentity, type ObjectRecoveryLimits } from './object-recovery-set.service.js';
import { recoverySourceIdentityMatches, recoverySourceIdentitySchema } from './recovery-source.js';

export const RECOVERY_LIMITS: ObjectRecoveryLimits = { maxObjects: 100_000, maxObjectBytes: 5 * 1024 ** 3, maxTotalBytes: 100 * 1024 ** 3, maxManifestBytes: 32 * 1024 ** 2 };
const timestamp = z.string().datetime();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/);
export const recoverySetManifestSchema = z.object({ version: z.literal(1), setId: z.string().uuid(),
  project: name, environment: name, contractHash: sha256,
  destination: objectRecoveryIdentitySchema, startedAt: timestamp, dataTime: timestamp, completedAt: timestamp,
  database: z.object({ source: recoverySourceIdentitySchema, archiveKey: z.string().min(1), manifestKey: z.string().min(1),
    sha256, bytes: z.number().int().nonnegative().safe(), restoreVerifiedAt: timestamp }).strict().optional(),
  objects: z.array(z.object({ name, source: objectRecoveryIdentitySchema, manifestKey: z.string().min(1), manifestSha256: sha256,
    objectCount: z.number().int().nonnegative(), totalBytes: z.string().regex(/^\d+$/), restoreVerifiedAt: timestamp }).strict()),
  compatibility: z.enum(['references-verified', 'not-applicable']),
  consistency: z.literal('database-snapshot-and-revision-checked-files'),
  restoreVerified: z.literal(true), cleanupVerified: z.literal(true),
}).strict();
export type RecoverySetManifest = z.infer<typeof recoverySetManifestSchema>;
export interface RecoverySetInput {
  runId: string; project: string; environment: string; contractHash: string;
  destination: ObjectRecoveryIdentity; archive: StorageObjectClient;
  database?: Pick<PostgresBackupInput, 'source' | 'sourceUrl' | 'verificationQuery'>;
  fileReferenceQueries?: PostgresBackupInput['fileReferenceQueries'];
  objects: Array<{ name: string; identity: ObjectRecoveryIdentity; client: StorageObjectClient }>;
}
export function recoverySetRoot(project: string, environment: string): string {
  return `hypervibe-recovery-sets/v1/${canonicalJsonSha256({ project: name.parse(project), environment: name.parse(environment) })}/`;
}

export async function readRecoveryJson(client: StorageObjectClient, key: string, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  const payload = await client.get(key);
  const body = payload.body instanceof Readable ? payload.body : Readable.fromWeb(
    (payload.body instanceof Blob ? payload.body.stream() : payload.body) as import('node:stream/web').ReadableStream);
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    if (!Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > maxBytes) throw new Error('Recovery evidence exceeds its limit.');
    for await (const chunk of body) { bytes += Buffer.byteLength(chunk); if (bytes > maxBytes) throw new Error('Recovery evidence exceeds its limit.'); chunks.push(Buffer.from(chunk)); }
    if (bytes !== payload.size) throw new Error('Recovery evidence is truncated.');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { body.destroy(); }
}
async function writeJson(client: StorageObjectClient, key: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  await client.put(key, { body: Readable.from([bytes]), size: bytes.length, contentType: 'application/json' }, { ifAbsent: true });
  if (canonicalJsonSha256(await readRecoveryJson(client, key)) !== canonicalJsonSha256(value)) throw new Error('Recovery evidence read-back failed.');
}

/** One reservation and one completion marker join independently restored SQL and file copies.
 * This proves referenced files exist, not a transaction across arbitrary mutable external systems.
 */
export async function createRecoverySet(input: RecoverySetInput, dependencies: {
  backupDatabase?: typeof backupAndVerifyPostgres; createRestoreStore?: typeof createLocalRecoveryStore;
} = {}) {
  z.string().uuid().parse(input.runId); sha256.parse(input.contractHash);
  const destination = objectRecoveryIdentitySchema.parse(input.destination);
  if (!input.database && !input.objects.length) throw new Error('Recovery set has no persistent sources.');
  const names = new Set(input.objects.map(item => name.parse(item.name)));
  if (names.size !== input.objects.length) throw new Error('Duplicate recovery source.');
  for (const object of input.objects) {
    objectRecoveryIdentitySchema.parse(object.identity);
    if (canonicalJsonSha256(object.identity) === canonicalJsonSha256(destination)) throw new Error('The archive must be separate from every source.');
  }
  const projections = input.fileReferenceQueries ?? [];
  if (input.database && input.objects.length && (projections.length !== names.size
    || new Set(projections.map(item => item.storageName)).size !== names.size
    || projections.some(item => !names.has(item.storageName)))) throw new Error('Database and files require an explicit reference projection for every bucket.');
  const prefix = `${recoverySetRoot(input.project, input.environment)}${input.runId}/`;
  // A partial or uncertain execution is not safe to repeat, even if no completion is visible.
  if ((await input.archive.list({ prefix })).length) throw new Error('This recovery execution already exists; it will not be repeated.');
  const startedAt = new Date().toISOString();
  await writeJson(input.archive, `${prefix}started.json`, { version: 1, runId: input.runId, startedAt,
    project: input.project, environment: input.environment, contractHash: input.contractHash, destination });
  let sql: PostgresBackupResult | undefined;
  if (input.database) {
    sql = await (dependencies.backupDatabase ?? backupAndVerifyPostgres)({ ...input.database, archive: input.archive,
      destination, runId: input.runId, archivePrefix: prefix.replace(/\/$/, '') + '/sql', fileReferenceQueries: projections });
    if (sql.evidence.runId !== input.runId || !recoverySourceIdentityMatches(sql.evidence.source, input.database.source)
      || canonicalJsonSha256(sql.evidence.destination) !== canonicalJsonSha256(destination)
      || sql.evidence.restoreVerified !== true || sql.evidence.cleanupVerified !== true) throw new Error('SQL recovery proof differs from the reviewed source.');
  }
  const objects: RecoverySetManifest['objects'] = [];
  for (const object of input.objects) {
    const copy = await createObjectRecoverySet({ source: object.client, destination: input.archive, sourceIdentity: object.identity,
      destinationIdentity: destination, setId: input.runId, createdAt: startedAt, limits: RECOVERY_LIMITS });
    if (sql) {
      const matching = sql.fileReferences.filter(reference => reference.storageName === object.name);
      const keys = new Set(copy.manifest.entries.map(entry => entry.key));
      if (matching.length !== 1 || matching[0].keys.some(key => !keys.has(key))) throw new Error('A file referenced by the restored database is missing from the retained set.');
    }
    const target = await (dependencies.createRestoreStore ?? createLocalRecoveryStore)();
    let restoredAt: string;
    try {
      const restore = await restoreObjectRecoverySet({ backup: input.archive, target: target.client,
        manifest: copy.manifest, targetIdentity: target.identity, restoreId: input.runId, limits: RECOVERY_LIMITS });
      restoredAt = restore.restoredAt;
    } finally { await target.cleanup(); }
    objects.push({ name: object.name, source: object.identity, manifestKey: objectRecoveryManifestKey(object.identity, input.runId),
      manifestSha256: copy.receipt.manifestSha256, objectCount: copy.receipt.objectCount, totalBytes: copy.receipt.totalBytes,
      restoreVerifiedAt: restoredAt });
  }
  const manifest = recoverySetManifestSchema.parse({ version: 1, setId: input.runId, project: input.project,
    environment: input.environment, contractHash: input.contractHash, destination, startedAt,
    dataTime: sql?.evidence.dataTime ?? startedAt, completedAt: new Date().toISOString(),
    ...(sql ? { database: { source: sql.evidence.source, archiveKey: sql.evidence.archiveKey, manifestKey: sql.evidence.manifestKey,
      sha256: sql.evidence.sha256, bytes: sql.evidence.bytes, restoreVerifiedAt: sql.evidence.completedAt } } : {}),
    objects, compatibility: sql && objects.length ? 'references-verified' : 'not-applicable',
    consistency: 'database-snapshot-and-revision-checked-files', restoreVerified: true, cleanupVerified: true });
  const manifestKey = `${prefix}complete.json`;
  await writeJson(input.archive, manifestKey, manifest);
  return { manifest, receipt: { setId: input.runId, manifestKey, manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    completedAt: manifest.completedAt, applied: 1, skipped: 0, databaseCount: sql ? 1 : 0,
    objectCount: objects.reduce((count, item) => count + item.objectCount, 0), restoreVerified: true, cleanupVerified: true } };
}
