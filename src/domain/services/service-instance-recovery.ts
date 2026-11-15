import { z } from 'zod';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { hostingServiceCreateRecoverySchema } from '../ports/hosting.port.js';
import { serviceInstanceRecoveryApprovalSchema, serviceInstanceTargetSchema, type ServiceInstanceIntent } from '../ports/service-instance.port.js';

const identity = z.string().min(1).max(512).regex(/^[A-Za-z0-9_.:/-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const base = z.object({ marker: hostingServiceCreateRecoverySchema, target: serviceInstanceTargetSchema, serviceName: identity });
const recordSchema = z.discriminatedUnion('disposition', [
  base.extend({ disposition: z.literal('unresolved-not-retried') }).strict(),
  base.extend({ disposition: z.literal('operator-confirmed-unresolved-rearchive'),
    approval: serviceInstanceRecoveryApprovalSchema }).strict(),
]);
const archiveSchema = z.object({ id: identity, digest, recordEncrypted: z.string().min(1).max(65536) }).strict();

/** Private receipts preserve uncertainty; matching bytes never establish origin. */
export function serviceInstanceHistory(value: unknown) {
  try {
    const entries = z.array(archiveSchema).max(1000).parse(value ?? []);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error();
    const history = entries.map(entry => {
      const record = recordSchema.parse(getSecretStore().decryptObject(entry.recordEncrypted));
      if (record.marker.resourceName !== record.serviceName || record.marker.state !== 'unresolved'
        || record.marker.serviceId || record.marker.providerScope.projectId !== record.target.projectId
        || record.marker.providerScope.environmentId !== record.target.environmentId
        || Object.keys(record.marker.providerScope).length !== 2
        || canonicalJsonSha256(record.marker) !== entry.digest) throw new Error();
      return { ...entry, record };
    });
    for (const entry of history) {
      if (entry.record.disposition !== 'operator-confirmed-unresolved-rearchive') continue;
      const approval = entry.record.approval;
      const original = history.find(candidate => candidate.id === approval.archiveId);
      if (!original || original.record.disposition !== 'unresolved-not-retried'
        || original.digest !== entry.digest || approval.activeMarkerSha256 !== entry.digest
        || original.record.serviceName !== entry.record.serviceName
        || canonicalJsonSha256(original.record.target) !== canonicalJsonSha256(entry.record.target)) throw new Error();
    }
    return history;
  } catch { throw new Error('Private instance attempt history could not be verified.'); }
}

export function serviceInstanceIntentFingerprint(intent: ServiceInstanceIntent): string {
  const { completed: _completed, recoveryApproval: _approval, ...base } = intent;
  return canonicalJsonSha256(base);
}

export function serviceInstanceRecoveryReview(history: ReturnType<typeof serviceInstanceHistory>, intent: ServiceInstanceIntent, name: string, markerDigest: string) {
  const originals = history.filter(entry => entry.record.disposition === 'unresolved-not-retried'
    && entry.digest === markerDigest && entry.record.serviceName === name
    && entry.record.marker.provider === intent.provider
    && canonicalJsonSha256(entry.record.target) === canonicalJsonSha256(intent.target));
  if (intent.priorCreateRecoverySha256 !== markerDigest || originals.length !== 1) throw new Error('recovery_review_unverified');
  return { archiveId: originals[0].id, activeMarkerSha256: markerDigest };
}
