import { z } from 'zod';
import { recoverySourceIdentityMatches, recoverySourceIdentitySchema } from './recovery-source.js';

export const backupPolicyAttemptSchema = z.object({
  source: recoverySourceIdentitySchema,
  policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  preservationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type BackupPolicyAttempt = z.infer<typeof backupPolicyAttemptSchema>;
const attemptsSchema = z.record(z.string().regex(/^backup-policy:(database|volume|storage):[^:\s]+:[^:\s]+$/), backupPolicyAttemptSchema);

/** Unresolved writes survive import and restart. Invalid state cannot authorize a retry. */
export function backupPolicyAttempts(raw: unknown): Record<string, BackupPolicyAttempt> {
  if (raw === undefined) return {};
  const parsed = attemptsSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Malformed daily backup policy attempt state; refusing to discard recovery evidence.');
  return parsed.data;
}

export function mergeBackupPolicyAttempts(local: unknown, incoming: unknown): Record<string, BackupPolicyAttempt> {
  const previous = backupPolicyAttempts(local);
  const next = backupPolicyAttempts(incoming);
  for (const [id, attempt] of Object.entries(next)) {
    const retained = previous[id];
    if (retained && (!recoverySourceIdentityMatches(retained.source, attempt.source)
      || retained.policyFingerprint !== attempt.policyFingerprint
      || retained.preservationFingerprint !== attempt.preservationFingerprint)) {
      throw new Error('Conflicting daily backup policy attempts; resolve the retained write before importing another attempt.');
    }
  }
  // A stale import cannot erase a local reservation. A stale reservation imported
  // after local completion can only require fresh observation, never a second write.
  return { ...next, ...previous };
}
