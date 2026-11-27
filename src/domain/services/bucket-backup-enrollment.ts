import { z } from 'zod';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { StorageObjectClient } from '../ports/storage.port.js';
import { readRecoveryObject } from './object-recovery-set.service.js';
import type { DailyBucketBackupClients } from './daily-bucket-backup.service.js';

export const enrollmentKey = (id: string) => 'hypervibe-runtime/enrollment-' + id;

const revisionSchema = z.object({ etag: z.string().min(1), lastModified: z.iso.datetime(), versionId: z.string().min(1).optional() }).strict();
export const enrollmentWitnessSchema = z.object({ source: revisionSchema, archive: revisionSchema }).strict();
export type EnrollmentWitness = z.infer<typeof enrollmentWitnessSchema>;

export function decodeEnrollmentWitness(encoded: unknown): EnrollmentWitness {
  const checked = z.string().min(1).max(4096).base64url().parse(encoded);
  return enrollmentWitnessSchema.parse(JSON.parse(Buffer.from(checked, 'base64url').toString('utf8')));
}

export async function checkBucketEnrollment(client: StorageObjectClient, id: string, expected?: EnrollmentWitness['source']) {
  z.guid().parse(id);
  // Read the current object. An explicit historic version could hide replacement of the live marker.
  const marker = await readRecoveryObject(client, enrollmentKey(id), 64);
  const revision = revisionSchema.parse(marker.revision);
  if (marker.bytes.toString('utf8') !== id || expected && (revision.etag !== expected.etag ||
    revision.lastModified !== expected.lastModified || revision.versionId !== expected.versionId)) {
    throw new Error('The reviewed file backup enrollment marker is missing or has changed.');
  }
  return revision;
}

/** Markers are written only once by the reviewed setup. The task has no
 * source write permission and never creates a marker to repair a missing one. */
export async function enrolledBucketClients(clients: DailyBucketBackupClients, id: string, witness: EnrollmentWitness): Promise<DailyBucketBackupClients> {
  const expected = enrollmentWitnessSchema.parse(witness);
  const verifyIdentity = async () => {
    await clients.verifyIdentity?.();
    await Promise.all([checkBucketEnrollment(clients.source, id, expected.source), checkBucketEnrollment(clients.archive, id, expected.archive)]);
  };
  try {
    await verifyIdentity();
    const marker = enrollmentKey(id);
    const source: StorageObjectClient = {
      ...clients.source,
      async list(options) {
        await checkBucketEnrollment(clients.source, id, expected.source);
        const records = await clients.source.list(options?.maxObjects === undefined ? options : { ...options, maxObjects: options.maxObjects + 1 });
        const files = records.filter(record => record.key !== marker);
        if (options?.maxObjects !== undefined && files.length > options.maxObjects) throw new Error('The backup source exceeds its object count limit.');
        return files;
      },
      get: (...args) => clients.source.get(...args), put: (...args) => clients.source.put(...args), destroy: () => clients.source.destroy(),
    };
    const identity = (which: 'sourceIdentity' | 'destinationIdentity') => ({ ...clients[which], instanceScope: { ...clients[which].instanceScope,
      enrollmentId: id, enrollmentRevisionSha256: canonicalJsonSha256(which === 'sourceIdentity' ? expected.source : expected.archive) } });
    return { source, archive: clients.archive, verifyIdentity, sourceIdentity: identity('sourceIdentity'), destinationIdentity: identity('destinationIdentity') };
  } catch (error) {
    clients.source.destroy(); clients.archive.destroy(); throw error;
  }
}
