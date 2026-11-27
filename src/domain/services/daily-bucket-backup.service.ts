import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { StorageObjectClient, StorageObjectRecord } from '../ports/storage.port.js';
import {
  createObjectRecoverySet, normalizeStoredObjectRevision, objectRecoveryIdentitySchema,
  objectRecoveryManifestKey, objectRecoverySetPrefix, observeObjectRecoverySetInventory,
  readObjectRecoveryManifest, readRecoveryObjectBytes, RECOVERY_LIMITS, storedObjectRevisionMatches,
  storedObjectRevisionSchema, verifyObjectRecoverySet, type ObjectRecoveryIdentity, type StoredObjectRevision,
} from './object-recovery-set.service.js';

const keep = 7;
const dayMs = 86_400_000;
const maxMarkers = 3660;
const markerBytes = 16 * 1024;
const dateSchema = z.iso.date();
const reservationSchema = z.object({
  version: z.literal(1), date: dateSchema, createdAt: z.iso.datetime(), attemptId: z.uuid().optional(),
  sourceIdentity: objectRecoveryIdentitySchema, destinationIdentity: objectRecoveryIdentitySchema,
}).strict();
type Reservation = z.infer<typeof reservationSchema>;
const markerSchema = reservationSchema.extend({
  reservationRevision: storedObjectRevisionSchema, manifestRevision: storedObjectRevisionSchema,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const retirementSchema = z.object({ point: markerSchema, pointRevision: storedObjectRevisionSchema }).strict();
type Retirement = z.infer<typeof retirementSchema>;
type Archive = {
  archive: StorageObjectClient; sourceIdentity: ObjectRecoveryIdentity; destinationIdentity: ObjectRecoveryIdentity; now?: Date;
  verifyIdentity?: () => Promise<void>;
};
export type DailyBucketBackupClients = Omit<Archive, 'now'> & { source: StorageObjectClient };
export interface DailyBucketBackupPoint {
  date: string; createdAt: string; completedAt: string; objectCount: number;
  totalBytes: string; manifestSha256: string; manifestKey: string;
}
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);

function root(input: Archive) {
  const source = objectRecoveryIdentitySchema.parse(input.sourceIdentity);
  const destination = objectRecoveryIdentitySchema.parse(input.destinationIdentity);
  if (source.provider !== destination.provider || same(source, destination)) throw new Error('Daily backups require separate storage on the same cloud.');
  return 'hypervibe-bucket-backups/v1/' + canonicalJsonSha256({ source, destination }) + '/';
}
function keys(input: Archive, date: string, attemptId?: string) {
  const prefix = root(input), setId = 'daily-' + dateSchema.parse(date) + (attemptId ? '-' + z.uuid().parse(attemptId) : '');
  return {
    setId, reservation: prefix + 'runs/' + date + '.json', point: prefix + 'points/' + date + '.json',
    retirement: prefix + 'retiring/' + date + '.json', manifest: objectRecoveryManifestKey(input.sourceIdentity, setId),
  };
}
function copyInput(input: Archive, setId: string, expectedManifestRevision?: StoredObjectRevision) {
  return { destination: input.archive, sourceIdentity: input.sourceIdentity, destinationIdentity: input.destinationIdentity,
    setId, limits: RECOVERY_LIMITS, expectedManifestRevision };
}
async function exactRecord(client: StorageObjectClient, key: string) {
  const records = await client.list({ prefix: key, maxObjects: 1 });
  if (records.length > 1 || records.some(record => record.key !== key)) throw new Error('Backup evidence object identity is ambiguous.');
  return records[0];
}
async function readMarker(client: StorageObjectClient, key: string, revision: StoredObjectRevision) {
  return JSON.parse((await readRecoveryObjectBytes(client, key, markerBytes, revision)).toString('utf8')) as unknown;
}
async function writeMarker(client: StorageObjectClient, key: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > markerBytes) throw new Error('Backup evidence exceeds its size limit.');
  await client.put(key, { body: Readable.from([bytes]), size: bytes.length, contentType: 'application/json' }, { ifAbsent: true });
  const record = await exactRecord(client, key);
  const revision = normalizeStoredObjectRevision(record?.revision);
  if (!same(await readMarker(client, key, revision), value)) throw new Error('Backup evidence read-back failed.');
  return revision;
}
function reservation(input: Archive, raw: unknown, date: string) {
  const value = reservationSchema.parse(raw);
  if (value.date !== date || value.createdAt.slice(0, 10) !== date || Date.parse(value.createdAt) > (input.now ?? new Date()).getTime()
    || !same(value.sourceIdentity, input.sourceIdentity) || !same(value.destinationIdentity, input.destinationIdentity)) {
    throw new Error('The backup reservation differs from the selected bucket pair or date.');
  }
  return value;
}
async function inventory(input: Archive, directory: 'points' | 'retiring' | 'runs') {
  const prefix = root(input) + directory + '/';
  const records = await input.archive.list({ prefix, maxObjects: maxMarkers });
  if (records.length > maxMarkers) throw new Error('Backup evidence inventory exceeds its size limit.');
  const result = new Map<string, StoredObjectRevision>();
  for (const record of records) {
    const date = dateSchema.parse(record.key.slice(prefix.length, -5));
    if (record.key !== prefix + date + '.json' || result.has(date)) throw new Error('Backup evidence has unexpected or duplicate keys.');
    result.set(date, normalizeStoredObjectRevision(record.revision));
  }
  return result;
}
async function inspectPoint(input: Archive, date: string, pointRevision: StoredObjectRevision) {
  const point = markerSchema.parse(await readMarker(input.archive, keys(input, date).point, pointRevision));
  const path = keys(input, date, point.attemptId);
  const { manifestSha256, manifestRevision, reservationRevision, ...recorded } = point;
  const reserved = reservation(input, await readMarker(input.archive, path.reservation, reservationRevision), date);
  if (!same(reserved, recorded)) throw new Error('The completed backup differs from its original reservation.');
  const observed = await observeObjectRecoverySetInventory(copyInput(input, path.setId, manifestRevision));
  const { manifest } = observed;
  if (observed.manifestSha256 !== manifestSha256 || manifest.createdAt !== reserved.createdAt
    || Date.parse(manifest.completedAt) < Date.parse(reserved.createdAt) || Date.parse(manifest.completedAt) > (input.now ?? new Date()).getTime()) {
    throw new Error('The retained manifest differs from its completed backup.');
  }
  const summary: DailyBucketBackupPoint = {
    date, createdAt: manifest.createdAt, completedAt: manifest.completedAt, objectCount: manifest.entries.length,
    totalBytes: manifest.entries.reduce((sum, entry) => sum + BigInt(entry.size), 0n).toString(), manifestSha256, manifestKey: path.manifest,
  };
  return { summary, retirement: { point, pointRevision } };
}
async function inspectHistory(input: Archive) {
  const points = await inventory(input, 'points');
  const retiring = new Map<string, { operation: Retirement; revision: StoredObjectRevision }>();
  for (const [date, revision] of await inventory(input, 'retiring')) {
    const operation = retirementSchema.parse(await readMarker(input.archive, keys(input, date).retirement, revision));
    const { manifestSha256: _hash, manifestRevision: _manifest, reservationRevision: _run, ...reserved } = operation.point;
    reservation(input, reserved, date);
    if (points.has(date) && !same(points.get(date), operation.pointRevision)) throw new Error('The retiring backup index changed.');
    retiring.set(date, { operation, revision });
  }
  const completed = [];
  for (const date of [...points.keys()].sort().reverse()) {
    if (!retiring.has(date)) completed.push(await inspectPoint(input, date, points.get(date)!));
  }
  for (const date of retiring.keys()) {
    if (completed.filter(set => set.summary.date > date).length < keep) throw new Error('Retirement requires seven newer complete backup dates.');
  }
  return { completed, retiring };
}

/** Only completed dates with the exact independently verified archive object revisions are returned. */
export async function observeDailyBucketBackups(input: Archive): Promise<{ points: DailyBucketBackupPoint[] }> {
  await input.verifyIdentity?.();
  const { completed } = await inspectHistory(input);
  await input.verifyIdentity?.();
  return { points: completed.map(set => set.summary) };
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const witnessSchema = z.object({ attemptId: z.uuid(), reservationRevision: storedObjectRevisionSchema,
  keyHash: sha256, size: z.number().int().nonnegative().safe(), revision: storedObjectRevisionSchema }).strict();
const witnessPrefix = (input: Archive, attemptId: string) => root(input) + 'receipts/' + z.uuid().parse(attemptId) + '/verified/';

async function writePoint(input: Archive, reserved: Reservation, reservationRevision: StoredObjectRevision, manifestSha256: string) {
  const path = keys(input, reserved.date, reserved.attemptId);
  const manifest = await exactRecord(input.archive, path.manifest);
  if (!same(await readMarker(input.archive, path.reservation, reservationRevision), reserved)) throw new Error('The daily backup reservation changed.');
  const marker = markerSchema.parse({ ...reserved, reservationRevision, manifestSha256, manifestRevision: normalizeStoredObjectRevision(manifest?.revision) });
  try { await writeMarker(input.archive, path.point, marker); }
  catch (error) {
    const published = await exactRecord(input.archive, path.point);
    if (!published || !same(await readMarker(input.archive, path.point, normalizeStoredObjectRevision(published.revision)), marker)) throw error;
  }
}

async function finishCommittedCopy(input: Archive, reserved: Reservation, revision: StoredObjectRevision) {
  const path = keys(input, reserved.date, reserved.attemptId);
  const recovered = await verifyObjectRecoverySet(copyInput(input, path.setId));
  if (recovered.manifest.createdAt !== reserved.createdAt) throw new Error('The retained copy belongs to another reservation.');
  await writePoint(input, reserved, revision, recovered.receipt.manifestSha256);
}

async function publish(input: Archive & { source: StorageObjectClient }, date: string, started: string) {
  const day = keys(input, date);
  if (await exactRecord(input.archive, day.retirement)) throw new Error('The selected backup date is being retired.');
  if (await exactRecord(input.archive, day.point)) return;
  const previous = await exactRecord(input.archive, day.reservation);
  if (previous) {
    const revision = normalizeStoredObjectRevision(previous.revision);
    const reserved = reservation(input, await readMarker(input.archive, day.reservation, revision), date);
    // A lost acknowledgement can authorize checking an existing manifest, never a second source copy.
    if (!await exactRecord(input.archive, keys(input, date, reserved.attemptId).manifest)) throw new Error('The daily backup started but has no completed manifest.');
    await finishCommittedCopy(input, reserved, revision);
    return;
  }
  const attemptId = randomUUID();
  const reserved = reservationSchema.parse({ version: 1, date, createdAt: started, attemptId,
    sourceIdentity: input.sourceIdentity, destinationIdentity: input.destinationIdentity });
  const reservationRevision = await writeMarker(input.archive, day.reservation, reserved);
  const path = keys(input, date, attemptId);
  const objectPrefix = objectRecoverySetPrefix(input.sourceIdentity, path.setId) + 'objects/';
  const deadline = Date.parse(started) + dayMs;
  const client = input.archive;
  const destination: StorageObjectClient = {
    list: options => client.list(options), get: (key, expected) => client.get(key, expected), destroy() {},
    put(key, payload, condition) {
      if ((input.now?.getTime() ?? Date.now()) >= deadline) throw new Error('The daily backup execution expired.');
      return client.put(key, payload, condition);
    },
  };
  const created = await createObjectRecoverySet({ ...copyInput(input, path.setId), destination, source: input.source, createdAt: started, now: input.now,
    async objectVerified(entry) {
      const keyHash = entry.backupKey.slice(objectPrefix.length);
      const proof = witnessSchema.parse({ attemptId, reservationRevision, keyHash, size: entry.size, revision: entry.backupRevision });
      await writeMarker(client, witnessPrefix(input, attemptId) + keyHash, proof);
    },
  });
  if (created.manifest.createdAt !== started) throw new Error('The retained copy belongs to another reservation.');
  await writePoint(input, reserved, reservationRevision, created.receipt.manifestSha256);
}

interface PartialReport { dates: number; objects: number; bytes: bigint }
/** Only bounded aggregate numbers may cross the scheduled job's error output. */
export class DailyBucketPartialLimitError extends Error {
  constructor(report: PartialReport) {
    super('New bucket copies are paused because unverified partial backups reached the retention limit ('
      + report.dates + ' dates, ' + report.objects + ' objects, ' + report.bytes.toString() + ' bytes).');
  }
}

async function clearWitnesses(input: Archive, reserved: Reservation, reservationRevision: StoredObjectRevision,
  partialObjects?: Map<string, StorageObjectRecord>) {
  if (!reserved.attemptId) return;
  const objectPrefix = objectRecoverySetPrefix(input.sourceIdentity, keys(input, reserved.date, reserved.attemptId).setId) + 'objects/';
  const prefix = witnessPrefix(input, reserved.attemptId);
  const receipts = await input.archive.list({ prefix, maxObjects: RECOVERY_LIMITS.maxObjects });
  if (receipts.length > RECOVERY_LIMITS.maxObjects || new Set(receipts.map(row => row.key)).size !== receipts.length) throw new Error('Partial copy evidence is incomplete.');
  for (const receipt of receipts) {
    const revision = normalizeStoredObjectRevision(receipt.revision);
    const proof = witnessSchema.parse(await readMarker(input.archive, receipt.key, revision));
    if (receipt.key !== prefix + proof.keyHash || proof.attemptId !== reserved.attemptId || !same(proof.reservationRevision, reservationRevision)) {
      throw new Error('Partial copy evidence belongs to another reservation.');
    }
    const key = objectPrefix + proof.keyHash, object = partialObjects?.get(key);
    if (object) {
      // A lost upload acknowledgement leaves no receipt. Only the recorded native revision authorizes removal.
      if (object.size !== proof.size || !same(normalizeStoredObjectRevision(object.revision), proof.revision)) continue;
      await input.archive.remove!(key, proof.revision);
      if (await exactRecord(input.archive, key)) throw new Error('Partial copy removal is unconfirmed.');
      partialObjects!.delete(key);
    }
    await input.archive.remove!(receipt.key, revision);
  }
}

async function assertNoWitnesses(input: Archive, attemptId: string) {
  if ((await input.archive.list({ prefix: witnessPrefix(input, attemptId), maxObjects: 1 })).length) throw new Error('Partial copy evidence cleanup is unconfirmed.');
}

async function reconcileAbandoned(input: Archive, reserved: Reservation, revision: StoredObjectRevision, age: number) {
  const path = keys(input, reserved.date, reserved.attemptId);
  const fence = { version: 1, state: 'abandoned', attemptId: reserved.attemptId, reservationRevision: revision };
  const fenceSize = Buffer.byteLength(JSON.stringify(fence));
  let terminal = await exactRecord(input.archive, path.manifest);
  if (!terminal && reserved.attemptId) {
    // Compete at the actual create-only manifest key. A late complete manifest
    // wins intact or the old execution loses its ability to commit this point.
    try { await writeMarker(input.archive, path.manifest, fence); }
    catch (error) { if (!await exactRecord(input.archive, path.manifest)) throw error; }
    terminal = await exactRecord(input.archive, path.manifest);
  }
  const terminalRevision = terminal && normalizeStoredObjectRevision(terminal.revision);
  if (terminal && (!reserved.attemptId || terminal.size !== fenceSize || !same(await readMarker(input.archive, path.manifest, terminalRevision!), fence))) {
    await finishCommittedCopy(input, reserved, revision);
    return [];
  }
  const prefix = objectRecoverySetPrefix(input.sourceIdentity, path.setId);
  const listObjects = async () => (await input.archive.list({ prefix, maxObjects: RECOVERY_LIMITS.maxObjects + 1 })).filter(object => object.key !== path.manifest);
  const before = await listObjects();
  if (before.length > RECOVERY_LIMITS.maxObjects || new Set(before.map(row => row.key)).size !== before.length) throw new Error('The partial backup inventory is incomplete.');
  await clearWitnesses(input, reserved, revision, new Map(before.map(row => [row.key, row])));
  const remaining = await listObjects();
  // Keep an expired writer fenced for another full execution window while any
  // request it already sent can settle. Re-check the namespace on later runs.
  if (!remaining.length && age >= 2 * dayMs && reserved.attemptId && terminalRevision) {
    await assertNoWitnesses(input, reserved.attemptId);
    await input.archive.remove!(path.manifest, terminalRevision);
    if (await exactRecord(input.archive, path.manifest)) throw new Error('Partial copy fence removal is unconfirmed.');
    await input.archive.remove!(path.reservation, revision);
  }
  return remaining;
}

async function reconcilePreviousAttempts(input: DailyBucketBackupClients & { now?: Date }, today: string) {
  const points = await inventory(input, 'points'), retiring = await inventory(input, 'retiring');
  const unknown: PartialReport = { dates: 0, objects: 0, bytes: 0n };
  let checkedBindings = false;
  for (const [date, revision] of await inventory(input, 'runs')) {
    if (date >= today || points.has(date) || retiring.has(date)) continue;
    const reserved = reservation(input, await readMarker(input.archive, keys(input, date).reservation, revision), date);
    const age = (input.now?.getTime() ?? Date.now()) - Date.parse(reserved.createdAt);
    if (age < dayMs) continue;
    if (!checkedBindings) { await input.verifyIdentity?.(); checkedBindings = true; }
    const remaining = await reconcileAbandoned(input, reserved, revision, age);
    if (remaining.length) unknown.dates++;
    unknown.objects += remaining.length;
    for (const object of remaining) {
      if (!Number.isSafeInteger(object.size) || object.size < 0) throw new Error('Unverified partial backup size is unknown.');
      unknown.bytes += BigInt(object.size);
    }
  }
  if (unknown.objects >= RECOVERY_LIMITS.maxObjects || unknown.bytes >= BigInt(RECOVERY_LIMITS.maxTotalBytes)) {
    throw new DailyBucketPartialLimitError(unknown);
  }
  return unknown;
}

async function finishRetirement(input: Archive, date: string, operation: Retirement, journalRevision: StoredObjectRevision) {
  const { point, pointRevision } = operation;
  const path = keys(input, date, point.attemptId);
  const { manifestRevision, manifestSha256, reservationRevision, ...reserved } = point;
  reservation(input, reserved, date);
  const pointRecord = await exactRecord(input.archive, path.point);
  if (pointRecord && (!storedObjectRevisionMatches(pointRevision, pointRecord.revision)
    || !same(await readMarker(input.archive, path.point, pointRevision), point))) throw new Error('The retiring backup index changed.');
  const runRecord = await exactRecord(input.archive, path.reservation);
  if (runRecord && (!storedObjectRevisionMatches(reservationRevision, runRecord.revision)
    || !same(await readMarker(input.archive, path.reservation, reservationRevision), reserved))) throw new Error('The retiring backup reservation changed.');

  const prefix = objectRecoverySetPrefix(input.sourceIdentity, path.setId);
  const objects = await input.archive.list({ prefix, maxObjects: RECOVERY_LIMITS.maxObjects + 1 });
  const data = objects.filter(object => object.key !== path.manifest);
  if (objects.length > RECOVERY_LIMITS.maxObjects + 1 || new Set(objects.map(object => object.key)).size !== objects.length) {
    throw new Error('Retiring backup inventory is incomplete or duplicated.');
  }
  const manifestRecord = objects.find(object => object.key === path.manifest);
  if (manifestRecord) {
    if (!runRecord || !storedObjectRevisionMatches(manifestRevision, manifestRecord.revision)) throw new Error('The retiring backup manifest changed.');
    const read = await readObjectRecoveryManifest(copyInput(input, path.setId, manifestRevision));
    if (read.manifestSha256 !== manifestSha256 || read.manifest.createdAt !== reserved.createdAt) throw new Error('The retiring backup manifest changed.');
    const entries = new Map(read.manifest.entries.map(entry => [entry.backupKey, entry]));
    if (data.some(object => {
      const entry = entries.get(object.key);
      return !entry || entry.size !== object.size || !storedObjectRevisionMatches(entry.backupRevision, object.revision);
    })) throw new Error('Retiring backup objects differ from the verified manifest.');
  } else if (data.length || pointRecord) {
    throw new Error('Cannot identify a retiring backup without its manifest.');
  }

  const remove = async (record: StorageObjectRecord) => input.archive.remove!(record.key, normalizeStoredObjectRevision(record.revision));
  if (pointRecord) await remove(pointRecord);
  for (const object of data) await remove(object);
  if (manifestRecord) await remove(manifestRecord);
  if ((await input.archive.list({ prefix, maxObjects: 1 })).length || await exactRecord(input.archive, path.point)) throw new Error('Backup retirement is unconfirmed.');
  await clearWitnesses(input, reserved, reservationRevision);
  if (reserved.attemptId) await assertNoWitnesses(input, reserved.attemptId);
  if (runRecord) await remove(runRecord);
  if (await exactRecord(input.archive, path.reservation)) throw new Error('Backup reservation retirement is unconfirmed.');
  await input.archive.remove!(path.retirement, journalRevision);
  if (await exactRecord(input.archive, path.retirement)) throw new Error('Backup retirement completion is unconfirmed.');
}

export async function runDailyBucketBackup(input: DailyBucketBackupClients & { now?: Date }) {
  if (!input.archive.remove) throw new Error('The archive requires native conditional deletion.');
  await input.verifyIdentity?.();
  const started = (input.now ?? new Date()).toISOString(), date = started.slice(0, 10);
  const partials = await reconcilePreviousAttempts(input, date);
  await publish(input, date, started);
  const { completed, retiring } = await inspectHistory(input);
  const today = completed.find(set => set.summary.date === date);
  if (!today) throw new Error('The daily backup could not be verified.');
  if (completed.length > keep || retiring.size) await input.verifyIdentity?.();
  for (const set of completed.slice(keep)) {
    const expired = set.summary.date;
    const revision = await writeMarker(input.archive, keys(input, expired).retirement, set.retirement);
    retiring.set(expired, { operation: set.retirement, revision });
  }
  for (const [expired, { operation, revision }] of retiring) {
    await finishRetirement(input, expired, operation, revision);
  }
  return { point: today.summary, retainedPoints: Math.min(completed.length, keep),
    ...(partials.dates ? { unverifiedPartials: { dates: partials.dates, objects: partials.objects, bytes: partials.bytes.toString() } } : {}) };
}
