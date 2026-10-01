import { Readable } from 'node:stream';
import { z } from 'zod';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { StorageObjectClient, StorageObjectRecord } from '../ports/storage.port.js';
import { managedBackupTargetHash, managedBackupTargetSchema, type ManagedBackupTarget } from './managed-backup-target.service.js';
import { observeObjectRecoverySetInventory, objectRecoveryManifestKey, objectRecoverySetPrefix, storedObjectRevisionMatches, storedObjectRevisionSchema } from './object-recovery-set.service.js';
import { POSTGRES_BACKUP_FORMAT_VERSION } from './postgres-backup.service.js';
import { readRecoveryJson, RECOVERY_LIMITS, recoverySetManifestSchema, recoverySetRoot, type RecoverySetManifest } from './recovery-set.service.js';

const MAX_EXECUTIONS = 256;
const MAX_EXECUTION_OBJECTS = 8;
const uuid = z.string().uuid();
const timestamp = z.string().datetime();
export const recoveryExecutionSchema = z.object({ version: z.literal(1), setId: uuid,
  contractHash: z.string().regex(/^[a-f0-9]{64}$/), completedAt: timestamp,
  jobId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/), cleanupVerified: z.literal(true) }).strict();
type Execution = z.infer<typeof recoveryExecutionSchema>;
export type RecoverySetReason = 'backup-missing' | 'backup-unverified' | 'observation-unavailable'
  | 'backup-stale' | 'restore-unverified';
export interface ManagedRecoveryObservation {
  manifest?: RecoverySetManifest;
  status: 'healthy' | 'unhealthy' | 'unknown';
  reasonCodes: RecoverySetReason[];
  /** No hourly byte audit is implied by a successful inventory observation. */
  evidence: 'inventory-and-prior-restore';
}
interface CompleteExecution { manifest: RecoverySetManifest; execution: Execution; owned: StorageObjectRecord[] }
type Context = { target: ManagedBackupTarget; archive: StorageObjectClient; now?: Date };
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
const prefixFor = (target: ManagedBackupTarget, setId: string) => `${recoverySetRoot(target.project, target.environment)}${uuid.parse(setId)}/`;

function checkedInventory(values: StorageObjectRecord[], limit: number) {
  if (values.length > limit || new Set(values.map(value => value.key)).size !== values.length
    || values.some(value => !Number.isSafeInteger(value.size) || value.size < 0)) throw new Error('Invalid or unbounded recovery inventory.');
  return values;
}
function exactInventory(values: StorageObjectRecord[], expected: Map<string, number | undefined>) {
  if (values.length !== expected.size || values.some(value => !expected.has(value.key)
    || (expected.get(value.key) !== undefined && value.size !== expected.get(value.key)))) throw new Error('Completed recovery inventory differs.');
}
function checkTime(value: string, lower: number, upper: number) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time < lower || time > upper) throw new Error('Recovery evidence has inconsistent times.');
}

async function inspectSet(input: Context & { setId: string; requireExecution: boolean }): Promise<CompleteExecution | undefined> {
  const target = managedBackupTargetSchema.parse(input.target), now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) throw new Error('Invalid recovery observation time.');
  const prefix = prefixFor(target, input.setId), completeKey = `${prefix}complete.json`, executionKey = `${prefix}execution.complete.json`;
  const rootObjects = checkedInventory(await input.archive.list({ prefix, maxObjects: MAX_EXECUTION_OBJECTS }), MAX_EXECUTION_OBJECTS);
  const rootKeys = new Set(rootObjects.map(object => object.key));
  if (rootKeys.has(executionKey) && !rootKeys.has(completeKey)) throw new Error('Execution completion has lost its inner manifest.');
  if (!rootKeys.has(completeKey) || (input.requireExecution && !rootKeys.has(executionKey))) return undefined;
  // Historical contracts remain retained, but cannot certify or authorize deletion for today's target.
  // Read their narrow version-independent envelope before interpreting today's
  // stronger evidence format. Never fabricate missing historical revisions.
  const rawManifest = await readRecoveryJson(input.archive, completeKey);
  const envelope = z.object({ contractHash: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().parse(rawManifest);
  if (envelope.contractHash !== managedBackupTargetHash(target)) return undefined;
  const manifest = recoverySetManifestSchema.parse(rawManifest);
  if (manifest.setId !== input.setId || manifest.project !== target.project || manifest.environment !== target.environment
    || (!manifest.database && !manifest.objects.length)
    || manifest.compatibility !== (manifest.database && manifest.objects.length ? 'references-verified' : 'not-applicable')
    || !same(manifest.destination, target.destination.identity)
    || Boolean(manifest.database) !== Boolean(target.database)
    || (manifest.database && !same(manifest.database.source, target.database!.source))
    || !same(manifest.objects.map(object => ({ name: object.name, identity: object.source })).sort((a, b) => a.name.localeCompare(b.name)),
      [...target.objects].sort((a, b) => a.name.localeCompare(b.name)))) throw new Error('Recovery identities differ from the current target.');
  const started = Date.parse(manifest.startedAt), completed = Date.parse(manifest.completedAt);
  checkTime(manifest.startedAt, 0, now); checkTime(manifest.dataTime, started, completed); checkTime(manifest.completedAt, started, now);
  const execution = rootKeys.has(executionKey)
    ? recoveryExecutionSchema.parse(await readRecoveryJson(input.archive, executionKey))
    : { version: 1 as const, setId: input.setId, contractHash: manifest.contractHash, completedAt: manifest.completedAt,
      jobId: 'unrecorded', cleanupVerified: true as const };
  if (execution.setId !== input.setId || execution.contractHash !== manifest.contractHash) throw new Error('Execution marker differs from the recovery set.');
  checkTime(execution.completedAt, completed, now);
  const expected = new Map<string, number | undefined>([[`${prefix}started.json`, undefined], [completeKey, undefined]]);
  if (rootKeys.has(executionKey)) expected.set(executionKey, undefined);
  const start = z.object({ version: z.literal(1), runId: uuid, startedAt: timestamp, project: z.string(), environment: z.string(),
    contractHash: z.string(), destination: managedBackupTargetSchema.shape.destination.shape.identity }).strict()
    .parse(await readRecoveryJson(input.archive, `${prefix}started.json`));
  if (start.runId !== input.setId || start.startedAt !== manifest.startedAt || start.project !== target.project
    || start.environment !== target.environment || start.contractHash !== manifest.contractHash || !same(start.destination, manifest.destination)) throw new Error('Recovery reservation differs.');
  if (manifest.database) {
    const database = manifest.database, sqlPrefix = `${prefix}sql/${input.setId}/`;
    if (database.archiveKey !== `${sqlPrefix}database.dump` || database.manifestKey !== `${sqlPrefix}database.complete.json`) throw new Error('SQL recovery paths are not owned by this execution.');
    expected.set(database.archiveKey, database.bytes); expected.set(database.manifestKey, undefined);
    const sql = z.object({ formatVersion: z.literal(POSTGRES_BACKUP_FORMAT_VERSION), mechanism: z.literal('postgres-logical-archive'),
      source: recoverySetManifestSchema.shape.database.unwrap().shape.source,
      destination: managedBackupTargetSchema.shape.destination.shape.identity, runId: uuid,
      archiveKey: z.string(), archiveRevision: storedObjectRevisionSchema, manifestKey: z.string(), sha256: z.string(), bytes: z.number(), dataTime: timestamp,
      completedAt: timestamp, restoreVerified: z.literal(true), cleanupVerified: z.literal(true) }).passthrough()
      .parse(await readRecoveryJson(input.archive, database.manifestKey));
    if (sql.runId !== input.setId || !same(sql.source, database.source) || !same(sql.destination, target.destination.identity)
      || sql.archiveKey !== database.archiveKey || sql.manifestKey !== database.manifestKey || sql.sha256 !== database.sha256
      || !same(sql.archiveRevision, database.archiveRevision)
      || !storedObjectRevisionMatches(database.archiveRevision, rootObjects.find(object => object.key === database.archiveKey)?.revision)
      || sql.bytes !== database.bytes || sql.dataTime !== manifest.dataTime || sql.completedAt !== database.restoreVerifiedAt) throw new Error('SQL recovery evidence differs.');
    checkTime(database.restoreVerifiedAt, started, completed);
  }
  exactInventory(rootObjects, expected);
  const owned = [...rootObjects];
  for (const object of manifest.objects) {
    const observed = await observeObjectRecoverySetInventory({ destination: input.archive, sourceIdentity: object.source,
      destinationIdentity: target.destination.identity, setId: input.setId, limits: RECOVERY_LIMITS });
    const objectManifest = observed.manifest;
    if (object.manifestKey !== objectRecoveryManifestKey(object.source, input.setId)
      || object.manifestSha256 !== observed.manifestSha256 || object.objectCount !== objectManifest.entries.length
      || object.totalBytes !== objectManifest.entries.reduce((sum, entry) => sum + BigInt(entry.size), 0n).toString()) throw new Error('Object recovery evidence differs.');
    checkTime(objectManifest.createdAt, started, completed); checkTime(objectManifest.completedAt, started, completed);
    checkTime(object.restoreVerifiedAt, Date.parse(objectManifest.completedAt), completed);
    const objects = checkedInventory(await input.archive.list({ prefix: objectRecoverySetPrefix(object.source, input.setId),
      maxObjects: RECOVERY_LIMITS.maxObjects + 1 }), RECOVERY_LIMITS.maxObjects + 1);
    exactInventory(objects, new Map([[object.manifestKey, undefined], ...objectManifest.entries.map(entry => [entry.backupKey, entry.size] as [string, number])]));
    // The final inventory becomes conditional-delete authority. A fresh LIST
    // must not replace the verified revision with newer same-sized bytes.
    const revisions = new Map(objectManifest.entries.map(entry => [entry.backupKey, entry.backupRevision]));
    if (objects.some(item => item.key !== object.manifestKey && !storedObjectRevisionMatches(revisions.get(item.key), item.revision))) {
      throw new Error('Recovery inventory changed before retaining deletion authority.');
    }
    owned.push(...objects);
  }
  if (new Set(owned.map(object => object.key)).size !== owned.length) throw new Error('Recovery sources have overlapping archive ownership.');
  return { manifest, execution, owned };
}

async function completedInventory(input: Context): Promise<{ sets: CompleteExecution[]; invalid: boolean }> {
  const root = recoverySetRoot(input.target.project, input.target.environment);
  const records = checkedInventory(await input.archive.list({ prefix: root, maxObjects: MAX_EXECUTIONS * MAX_EXECUTION_OBJECTS }), MAX_EXECUTIONS * MAX_EXECUTION_OBJECTS);
  const ids = new Set<string>();
  for (const record of records) {
    const suffix = record.key.slice(root.length), parts = suffix.split('/');
    if (parts.length === 2 && parts[1] === 'execution.complete.json') ids.add(uuid.parse(parts[0]));
  }
  if (ids.size > MAX_EXECUTIONS) throw new Error('Recovery inventory exceeds its observation limit.');
  const sets: CompleteExecution[] = []; let invalid = false;
  for (const setId of ids) {
    try { const set = await inspectSet({ ...input, setId, requireExecution: true }); if (set) sets.push(set); }
    catch { invalid = true; }
  }
  return { sets, invalid };
}

/** Controller attestation only: invoke AFTER the exact provider job is terminal and temporary resources are absent. */
export async function recordRecoveryExecution(input: Context & { setId: string; jobId: string; completedAt?: string }) {
  const now = input.now ?? new Date();
  const observed = await inspectSet({ ...input, now, requireExecution: false });
  if (!observed) throw new Error('No complete recovery set matches the current execution contract.');
  const marker = recoveryExecutionSchema.parse({ version: 1, setId: input.setId, contractHash: managedBackupTargetHash(input.target),
    jobId: input.jobId, completedAt: input.completedAt ?? now.toISOString(), cleanupVerified: true });
  checkTime(marker.completedAt, Date.parse(observed.manifest.completedAt), now.getTime());
  const key = `${prefixFor(input.target, input.setId)}execution.complete.json`;
  if (observed.owned.some(object => object.key === key)) {
    if (observed.execution.jobId !== marker.jobId) throw new Error('Execution cleanup belongs to a different provider job.');
    return { applied: 0, skipped: 1 };
  }
  const bytes = Buffer.from(JSON.stringify(marker));
  await input.archive.put(key, { body: Readable.from([bytes]), size: bytes.length, contentType: 'application/json' }, { ifAbsent: true });
  if (!same(recoveryExecutionSchema.parse(await readRecoveryJson(input.archive, key)), marker)) throw new Error('Execution cleanup marker read-back failed.');
  return { applied: 1, skipped: 0 };
}

export async function observeManagedRecoverySet(input: Context): Promise<ManagedRecoveryObservation> {
  const evidence = 'inventory-and-prior-restore' as const;
  try {
    const now = input.now ?? new Date(), { sets, invalid } = await completedInventory({ ...input, now });
    if (invalid) return { status: 'unknown', reasonCodes: ['backup-unverified'], evidence };
    const latest = sets.sort((a, b) => b.manifest.dataTime.localeCompare(a.manifest.dataTime)
      || b.execution.completedAt.localeCompare(a.execution.completedAt))[0];
    if (!latest) return { status: 'unhealthy', reasonCodes: ['backup-missing'], evidence };
    const manifest = latest.manifest, reasonCodes: RecoverySetReason[] = [];
    if (Date.parse(manifest.dataTime) + 24 * 3_600_000 <= now.getTime()) reasonCodes.push('backup-stale');
    const restores = [...manifest.objects.map(object => object.restoreVerifiedAt), ...(manifest.database ? [manifest.database.restoreVerifiedAt] : [])];
    if (restores.some(time => Date.parse(time) + 7 * 86_400_000 <= now.getTime())) reasonCodes.push('restore-unverified');
    return { manifest, status: reasonCodes.length ? 'unhealthy' : 'healthy', reasonCodes, evidence };
  } catch { return { status: 'unknown', reasonCodes: ['observation-unavailable'], evidence }; }
}

/** Exact-key retention only. Incomplete/foreign-contract sets never count toward seven or get deleted. */
export async function applyManagedRecoveryRetention(input: Context) {
  if (!input.archive.remove) throw new Error('The archive has no conditional exact-object deletion capability.');
  const { sets, invalid } = await completedInventory(input);
  if (invalid) throw new Error('Retention is blocked by unverified completed evidence.');
  const ordered = sets.sort((a, b) => b.manifest.dataTime.localeCompare(a.manifest.dataTime)
    || b.execution.completedAt.localeCompare(a.execution.completedAt) || b.manifest.setId.localeCompare(a.manifest.setId));
  const restoreTime = (set: CompleteExecution) => Math.min(...set.manifest.objects.map(object => Date.parse(object.restoreVerifiedAt)),
    ...(set.manifest.database ? [Date.parse(set.manifest.database.restoreVerifiedAt)] : []));
  const latestRestore = [...sets].sort((a, b) => restoreTime(b) - restoreTime(a))[0]?.manifest.setId;
  const deletions = ordered.slice(7).filter(set => set.manifest.setId !== latestRestore);
  // Validate every deletion's conditional revision before the first mutation.
  for (const set of deletions) for (const object of set.owned) {
    if (!object.revision || !Object.entries(object.revision).some(([key, value]) => ['etag', 'generation', 'versionId'].includes(key) && value)) throw new Error('Retention requires native object revisions.');
  }
  let applied = 0, deletedSets = 0;
  try {
    for (const set of deletions) {
      const marker = `${prefixFor(input.target, set.manifest.setId)}execution.complete.json`;
      const keys = [...set.owned].sort((a, b) => Number(b.key === marker) - Number(a.key === marker));
      // Withdraw health first. Any later failure leaves an incomplete retained set, never false health.
      for (const object of keys) { await input.archive.remove(object.key, object.revision); applied++; }
      const prefixes = [prefixFor(input.target, set.manifest.setId),
        ...set.manifest.objects.map(object => objectRecoverySetPrefix(object.source, set.manifest.setId))];
      for (const prefix of prefixes) {
        if ((await input.archive.list({ prefix, maxObjects: RECOVERY_LIMITS.maxObjects + MAX_EXECUTION_OBJECTS })).length) {
          throw new Error('Retention deletion is acknowledged but absence is unverified.');
        }
      }
      deletedSets++;
    }
    return { success: true, applied, skipped: ordered.length - deletedSets, deletedSets, mutationAttempted: applied > 0 };
  } catch { return { success: false, applied: null, skipped: 0, deletedSets, mutationAttempted: true }; }
}
