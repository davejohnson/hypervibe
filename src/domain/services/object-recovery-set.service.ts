import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { StorageObjectClient, StorageObjectPayload, StorageObjectRecord, StorageObjectRevision } from '../ports/storage.port.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { recoveryIdentityStringSchema } from './recovery-source.js';

export const objectRecoveryIdentitySchema = z.object({
  provider: recoveryIdentityStringSchema,
  externalId: recoveryIdentityStringSchema,
  instanceScope: z.record(recoveryIdentityStringSchema).refine(value => Object.keys(value).length > 0
    && Object.keys(value).every(key => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) && !/secret|password|token|credential|key/i.test(key))),
}).strict();
export type ObjectRecoveryIdentity = z.infer<typeof objectRecoveryIdentitySchema>;
export interface ObjectRecoveryLimits { maxObjects: number; maxObjectBytes: number; maxTotalBytes: number; maxManifestBytes?: number }
const revisionSchema = z.object({ etag: z.string().min(1).optional(), versionId: z.string().min(1).optional(),
  generation: z.string().min(1).optional(), metageneration: z.string().min(1).optional(), lastModified: z.string().min(1).optional() }).strict()
  .refine(value => Boolean(value.etag || value.versionId || value.generation), 'A native object revision is required.');
// Persist only validators independently exposed by both GET and ordinary LIST.
// S3/Azure versionId is GET-only here; their ETag is an opaque validator, never
// our content checksum. GCS metadata changes require metageneration as well.
export const storedObjectRevisionSchema = z.union([
  z.object({ generation: z.string().min(1), metageneration: z.string().min(1) }).strict(),
  z.object({ etag: z.string().min(1), lastModified: z.string().min(1).optional() }).strict(),
]);
export type StoredObjectRevision = z.infer<typeof storedObjectRevisionSchema>;
export function normalizeStoredObjectRevision(raw: unknown): StoredObjectRevision {
  const revision = revisionSchema.parse(raw);
  if ((revision.generation || revision.metageneration) && (revision.etag || revision.versionId || revision.lastModified)) {
    throw new Error('Stored object revision mixes provider validator formats.');
  }
  return storedObjectRevisionSchema.parse(revision.generation || revision.metageneration
    ? { generation: revision.generation, metageneration: revision.metageneration }
    : { etag: revision.etag, ...(revision.lastModified ? { lastModified: revision.lastModified } : {}) });
}
export function storedObjectRevisionMatches(expected: unknown, actual: unknown): boolean {
  try {
    const selected = storedObjectRevisionSchema.parse(expected);
    const current = normalizeStoredObjectRevision(actual);
    return sameRevision(selected, current);
  } catch { return false; }
}
const executionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
const keySchema = z.string().min(1).max(4096);
const httpSchema = z.object({ contentType: z.string().optional(), contentEncoding: z.string().optional(),
  cacheControl: z.string().optional(), contentDisposition: z.string().optional() }).strict();
const entrySchema = z.object({ key: keySchema, backupKey: keySchema, size: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), revision: revisionSchema, backupRevision: storedObjectRevisionSchema, http: httpSchema,
  metadata: z.record(z.string()) }).strict();
export const OBJECT_RECOVERY_FORMAT_VERSION = 2 as const;
export const objectRecoveryManifestSchema = z.object({ version: z.literal(OBJECT_RECOVERY_FORMAT_VERSION), setId: executionIdSchema,
  sourceIdentity: objectRecoveryIdentitySchema, destinationIdentity: objectRecoveryIdentitySchema,
  createdAt: z.string().datetime(), completedAt: z.string().datetime(),
  consistency: z.literal('revision-checked-object-copy'), sourceInventorySha256: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(entrySchema) }).strict();
export type ObjectRecoveryManifest = z.infer<typeof objectRecoveryManifestSchema>;
export interface ObjectRecoveryReceipt {
  setId: string; objectCount: number; totalBytes: string; manifestSha256: string;
  completedAt: string; contentVerified: true; applied: number; skipped: number;
}
export interface VerifiedObjectRecoverySet { manifest: ObjectRecoveryManifest; receipt: ObjectRecoveryReceipt }

function bounds(limits: ObjectRecoveryLimits): Required<ObjectRecoveryLimits> {
  const values = { ...limits, maxManifestBytes: limits.maxManifestBytes ?? 8 * 1024 * 1024 };
  if (Object.values(values).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid object recovery limits.');
  return values;
}
function distinct(left: ObjectRecoveryIdentity, right: ObjectRecoveryIdentity) {
  if (canonicalJsonSha256(left) === canonicalJsonSha256(right)) throw new Error('Recovery requires a distinct bucket or container.');
}
export function objectRecoverySetPrefix(sourceIdentity: ObjectRecoveryIdentity, setId: string): string {
  return `hypervibe-recovery/v1/${canonicalJsonSha256(objectRecoveryIdentitySchema.parse(sourceIdentity))}/${executionIdSchema.parse(setId)}/`;
}
export function objectRecoveryManifestKey(sourceIdentity: ObjectRecoveryIdentity, setId: string): string {
  return `${objectRecoverySetPrefix(sourceIdentity, setId)}manifest.json`;
}
const objectKey = (prefix: string, key: string) => `${prefix}objects/${createHash('sha256').update(key).digest('hex')}`;
function readable(body: StorageObjectPayload['body']): Readable {
  if (body instanceof Readable) return body;
  return Readable.fromWeb((body instanceof Blob ? body.stream() : body) as ReadableStream<Uint8Array>);
}
function metadata(payload: StorageObjectPayload) {
  const http = httpSchema.parse(Object.fromEntries(['contentType', 'contentEncoding', 'cacheControl', 'contentDisposition']
    .flatMap(key => payload[key as keyof StorageObjectPayload] === undefined ? [] : [[key, payload[key as keyof StorageObjectPayload]]])));
  const custom = z.record(z.string()).parse(payload.metadata ?? {});
  if (Buffer.byteLength(JSON.stringify({ http, custom })) > 32 * 1024) throw new Error('Object metadata exceeds the recovery limit.');
  return { http, metadata: custom };
}
function sameRevision(expected: StorageObjectRevision, actual?: StorageObjectRevision): boolean {
  return Boolean(actual && Object.entries(expected).every(([key, value]) => actual[key as keyof StorageObjectRevision] === value));
}
function inventory(raw: StorageObjectRecord[], limits: Required<ObjectRecoveryLimits>) {
  if (raw.length > limits.maxObjects) throw new Error('Object inventory exceeds its count limit.');
  const records = raw.map(item => ({ key: keySchema.parse(item.key), size: z.number().int().nonnegative().safe().parse(item.size),
    revision: revisionSchema.parse(item.revision) })).sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(records.map(item => item.key)).size !== records.length) throw new Error('Duplicate object key in recovery inventory.');
  let total = 0;
  for (const object of records) {
    total += object.size;
    if (object.size > limits.maxObjectBytes || total > limits.maxTotalBytes || !Number.isSafeInteger(total)) throw new Error('Object recovery byte limit exceeded.');
  }
  return records;
}
async function digestPayload(payload: StorageObjectPayload, expectedSize: number): Promise<string> {
  const hash = createHash('sha256'); let bytes = 0; const body = readable(payload.body);
  try {
    if (payload.size !== expectedSize) throw new Error('Object recovery size changed.');
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > expectedSize) throw new Error('Object stream exceeded its declared size.');
      hash.update(buffer);
    }
    if (bytes !== expectedSize) throw new Error('Object stream ended before its declared size.');
    return hash.digest('hex');
  } finally { body.destroy(); }
}
async function copy(source: StorageObjectClient, destination: StorageObjectClient, sourceKey: string, destinationKey: string,
  expectedSize: number, revision: StorageObjectRevision | undefined) {
  const payload = await source.get(sourceKey, revision);
  const body = readable(payload.body);
  if (payload.size !== expectedSize || (revision && !sameRevision(revision, payload.revision))) {
    body.destroy(); throw new Error('The source object changed after inventory.');
  }
  let properties: ReturnType<typeof metadata>;
  try { properties = metadata(payload); } catch (error) { body.destroy(); throw error; }
  const hash = createHash('sha256'); let bytes = 0;
  const stream = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > expectedSize) { callback(new Error('Object stream exceeded its declared size.')); return; }
    hash.update(chunk); callback(null, chunk);
  }, flush(callback) { callback(bytes === expectedSize ? undefined : new Error('Object stream ended before its declared size.')); } });
  try {
    await Promise.all([pipeline(body, stream), destination.put(destinationKey, { body: stream, size: expectedSize,
      ...properties.http, metadata: properties.metadata }, { ifAbsent: true })]);
  } finally { body.destroy(); stream.destroy(); }
  const sha256 = hash.digest('hex');
  const readback = await destination.get(destinationKey);
  const actualHash = await digestPayload(readback, expectedSize);
  if (canonicalJsonSha256(metadata(readback)) !== canonicalJsonSha256(properties)
    || actualHash !== sha256) throw new Error('Stored object bytes or metadata failed independent read-back verification.');
  return { sha256, backupRevision: normalizeStoredObjectRevision(readback.revision), ...properties };
}
function checkedManifest(raw: unknown, limits: Required<ObjectRecoveryLimits>): ObjectRecoveryManifest {
  const manifest = objectRecoveryManifestSchema.parse(raw);
  distinct(manifest.sourceIdentity, manifest.destinationIdentity);
  const prefix = objectRecoverySetPrefix(manifest.sourceIdentity, manifest.setId);
  inventory(manifest.entries, limits);
  if (manifest.entries.some(entry => entry.backupKey !== objectKey(prefix, entry.key))) throw new Error('Recovery manifest contains an unowned destination key.');
  if (canonicalJsonSha256(manifest.entries.map(({ key, size, revision }) => ({ key, size, revision })).sort((a, b) => a.key.localeCompare(b.key))) !== manifest.sourceInventorySha256) {
    throw new Error('Recovery manifest source inventory is inconsistent.');
  }
  return manifest;
}
function receipt(manifest: ObjectRecoveryManifest, manifestSha256: string, applied: number, skipped: number): ObjectRecoveryReceipt {
  return { setId: manifest.setId, objectCount: manifest.entries.length,
    totalBytes: manifest.entries.reduce((bytes, entry) => bytes + BigInt(entry.size), 0n).toString(), manifestSha256,
    completedAt: manifest.completedAt, contentVerified: true, applied, skipped };
}
async function manifestBytes(client: StorageObjectClient, key: string, maxBytes: number): Promise<Buffer> {
  const object = await client.get(key); const body = readable(object.body); const chunks: Buffer[] = []; let bytes = 0;
  try {
    if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > maxBytes) throw new Error('Recovery manifest exceeds its size limit.');
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > maxBytes) throw new Error('Recovery manifest exceeds its size limit.');
      chunks.push(buffer);
    }
    if (bytes !== object.size) throw new Error('Recovery manifest stream size differs from metadata.');
    return Buffer.concat(chunks);
  } finally { body.destroy(); }
}

/** Lightweight observation: validates the committed inventory and presence, not current object bytes. */
export async function observeObjectRecoverySetInventory(params: { destination: StorageObjectClient; sourceIdentity: ObjectRecoveryIdentity;
  destinationIdentity: ObjectRecoveryIdentity; setId: string; limits: ObjectRecoveryLimits }): Promise<{ manifest: ObjectRecoveryManifest; manifestSha256: string }> {
  const limits = bounds(params.limits); const key = objectRecoveryManifestKey(params.sourceIdentity, params.setId);
  const bytes = await manifestBytes(params.destination, key, limits.maxManifestBytes);
  const manifest = checkedManifest(JSON.parse(bytes.toString('utf8')), limits);
  if (manifest.setId !== params.setId || canonicalJsonSha256(manifest.sourceIdentity) !== canonicalJsonSha256(params.sourceIdentity)
    || canonicalJsonSha256(manifest.destinationIdentity) !== canonicalJsonSha256(params.destinationIdentity)) throw new Error('Recovery manifest identifies a different source or destination.');
  const expected = new Set([key, ...manifest.entries.map(entry => entry.backupKey)]);
  const actual = await params.destination.list({ prefix: objectRecoverySetPrefix(params.sourceIdentity, params.setId), maxObjects: limits.maxObjects + 1 });
  if (actual.length !== expected.size || new Set(actual.map(object => object.key)).size !== expected.size
    || actual.some(object => !expected.has(object.key))) throw new Error('Completed recovery set has missing, duplicate or extra objects.');
  if (actual.some(object => object.key !== key && manifest.entries.find(entry => entry.backupKey === object.key)?.size !== object.size)) {
    throw new Error('Completed recovery set object size differs from its manifest.');
  }
  if (actual.some(object => object.key !== key && !storedObjectRevisionMatches(
    manifest.entries.find(entry => entry.backupKey === object.key)?.backupRevision, object.revision))) {
    throw new Error('Completed recovery set object revision changed after verification.');
  }
  return { manifest, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function verifyObjectRecoverySet(params: { destination: StorageObjectClient; sourceIdentity: ObjectRecoveryIdentity;
  destinationIdentity: ObjectRecoveryIdentity; setId: string; limits: ObjectRecoveryLimits }): Promise<VerifiedObjectRecoverySet> {
  const observed = await observeObjectRecoverySetInventory(params);
  for (const entry of observed.manifest.entries) {
    const payload = await params.destination.get(entry.backupKey, entry.backupRevision);
    if (!storedObjectRevisionMatches(entry.backupRevision, payload.revision)) {
      readable(payload.body).destroy(); throw new Error('Recovery set object revision changed before verification.');
    }
    const actualHash = await digestPayload(payload, entry.size);
    if (canonicalJsonSha256(metadata(payload)) !== canonicalJsonSha256({ http: entry.http, metadata: entry.metadata })
      || actualHash !== entry.sha256) throw new Error('Recovery set content or metadata failed verification.');
  }
  return { manifest: observed.manifest, receipt: receipt(observed.manifest, observed.manifestSha256, 0, observed.manifest.entries.length) };
}

export async function createObjectRecoverySet(params: { source: StorageObjectClient; destination: StorageObjectClient;
  sourceIdentity: ObjectRecoveryIdentity; destinationIdentity: ObjectRecoveryIdentity; setId: string; createdAt: string;
  limits: ObjectRecoveryLimits }): Promise<VerifiedObjectRecoverySet> {
  const limits = bounds(params.limits); const sourceIdentity = objectRecoveryIdentitySchema.parse(params.sourceIdentity);
  const destinationIdentity = objectRecoveryIdentitySchema.parse(params.destinationIdentity); distinct(sourceIdentity, destinationIdentity);
  const createdAt = z.string().datetime().parse(params.createdAt);
  const prefix = objectRecoverySetPrefix(sourceIdentity, params.setId); const key = objectRecoveryManifestKey(sourceIdentity, params.setId);
  const existing = await params.destination.list({ prefix, maxObjects: limits.maxObjects + 1 });
  if (existing.some(object => object.key === key)) return verifyObjectRecoverySet(params);
  if (existing.length) throw new Error('A partial recovery set already occupies this execution id; never overwrite it.');
  const before = inventory(await params.source.list({ maxObjects: limits.maxObjects }), limits); const entries: ObjectRecoveryManifest['entries'] = [];
  for (const object of before) {
    const backupKey = objectKey(prefix, object.key);
    entries.push({ ...object, backupKey, ...await copy(params.source, params.destination, object.key, backupKey, object.size, object.revision) });
  }
  if (canonicalJsonSha256(inventory(await params.source.list({ maxObjects: limits.maxObjects }), limits)) !== canonicalJsonSha256(before)) throw new Error('Source inventory changed during recovery-set creation.');
  const copied = await params.destination.list({ prefix, maxObjects: limits.maxObjects });
  if (copied.length !== entries.length || new Set(copied.map(object => object.key)).size !== entries.length
    || copied.some(object => !entries.some(entry => entry.backupKey === object.key && entry.size === object.size))) throw new Error('Recovery destination inventory differs from the copied set.');
  if (copied.some(object => !storedObjectRevisionMatches(entries.find(entry => entry.backupKey === object.key)?.backupRevision, object.revision))) {
    throw new Error('Recovery destination revision changed after read-back verification.');
  }
  const manifest = checkedManifest({ version: OBJECT_RECOVERY_FORMAT_VERSION, setId: params.setId, sourceIdentity, destinationIdentity, createdAt,
    completedAt: new Date().toISOString(), consistency: 'revision-checked-object-copy', sourceInventorySha256: canonicalJsonSha256(before), entries }, limits);
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.length > limits.maxManifestBytes) throw new Error('Recovery manifest exceeds its size limit.');
  await params.destination.put(key, { body: Readable.from([bytes]), size: bytes.length, contentType: 'application/json' }, { ifAbsent: true });
  const observed = await manifestBytes(params.destination, key, limits.maxManifestBytes);
  if (!observed.equals(bytes)) throw new Error('Recovery completion manifest failed read-back verification.');
  return { manifest, receipt: receipt(manifest, createHash('sha256').update(bytes).digest('hex'), entries.length, 0) };
}

export async function restoreObjectRecoverySet(params: { backup: StorageObjectClient; target: StorageObjectClient;
  manifest: ObjectRecoveryManifest; targetIdentity: ObjectRecoveryIdentity; restoreId: string; limits: ObjectRecoveryLimits }) {
  const limits = bounds(params.limits); const manifest = checkedManifest(params.manifest, limits);
  const targetIdentity = objectRecoveryIdentitySchema.parse(params.targetIdentity);
  distinct(targetIdentity, manifest.sourceIdentity); distinct(targetIdentity, manifest.destinationIdentity);
  const verified = await verifyObjectRecoverySet({ destination: params.backup, sourceIdentity: manifest.sourceIdentity,
    destinationIdentity: manifest.destinationIdentity, setId: manifest.setId, limits });
  if (canonicalJsonSha256(verified.manifest) !== canonicalJsonSha256(manifest)) throw new Error('The selected recovery manifest changed before restore.');
  const prefix = `hypervibe-restore/v1/${canonicalJsonSha256(manifest.sourceIdentity)}/${executionIdSchema.parse(params.restoreId)}/`;
  if ((await params.target.list({ prefix, maxObjects: limits.maxObjects })).length) throw new Error('Restore verification requires a fresh isolated target prefix.');
  for (const entry of manifest.entries) {
    const copied = await copy(params.backup, params.target, entry.backupKey, objectKey(prefix, entry.key), entry.size, entry.backupRevision);
    if (copied.sha256 !== entry.sha256 || canonicalJsonSha256({ http: copied.http, metadata: copied.metadata })
      !== canonicalJsonSha256({ http: entry.http, metadata: entry.metadata })) throw new Error('Restored object differs from its committed recovery manifest.');
  }
  const actual = await params.target.list({ prefix, maxObjects: limits.maxObjects });
  if (actual.length !== manifest.entries.length || new Set(actual.map(object => object.key)).size !== manifest.entries.length
    || actual.some(object => !manifest.entries.some(entry => object.key === objectKey(prefix, entry.key) && object.size === entry.size))) throw new Error('Restore inventory differs from its committed recovery set.');
  return { ...verified.receipt, applied: manifest.entries.length, skipped: 0, restoreId: params.restoreId,
    restoreVerified: true as const, restoredAt: new Date().toISOString(), targetIdentity,
    restoredKeys: manifest.entries.map(entry => objectKey(prefix, entry.key)) };
}

/** Planning only: never propagates source deletions and never performs a bulk prefix delete. */
export function planObjectRecoveryRetention(params: { completed: VerifiedObjectRecoverySet[]; retainCompleted: number; latestVerifiedRestoreSetId?: string }) {
  if (!Number.isSafeInteger(params.retainCompleted) || params.retainCompleted < 7) throw new Error('Retain at least seven completed recovery sets.');
  const sets = [...params.completed].sort((a, b) => b.manifest.completedAt.localeCompare(a.manifest.completedAt)
    || b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  if (new Set(sets.map(set => set.manifest.setId)).size !== sets.length) throw new Error('Duplicate retention set identity.');
  const sources = new Set(sets.map(set => canonicalJsonSha256({ source: set.manifest.sourceIdentity, destination: set.manifest.destinationIdentity })));
  if (sources.size > 1) throw new Error('Retention cannot span different source or destination identities.');
  if (params.latestVerifiedRestoreSetId && !sets.some(set => set.manifest.setId === params.latestVerifiedRestoreSetId)) throw new Error('The latest verified restore is not in the observed retention inventory.');
  for (const set of sets) {
    const manifest = checkedManifest(set.manifest, bounds({ maxObjects: Number.MAX_SAFE_INTEGER, maxObjectBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER }));
    if (set.receipt.contentVerified !== true || set.receipt.setId !== manifest.setId || set.receipt.manifestSha256 !== createHash('sha256').update(JSON.stringify(manifest)).digest('hex')) throw new Error('Retention requires verified manifest evidence.');
  }
  return sets.slice(params.retainCompleted).filter(set => set.manifest.setId !== params.latestVerifiedRestoreSetId).map(set => {
    const manifest = set.manifest;
    return { setId: manifest.setId, destinationIdentity: manifest.destinationIdentity,
      manifestSha256: set.receipt.manifestSha256, keys: [...manifest.entries.map(entry => entry.backupKey), objectRecoveryManifestKey(manifest.sourceIdentity, manifest.setId)] };
  });
}
