import { z } from 'zod';

/** Evidence dimensions, not provider capability flags or permission to restore. */
export const RECOVERY_CHECKS = [
  'recoveryPoint',
  'restoreTargetIsolation',
  'restoreSideEffectIsolation',
  'databaseValidation',
  'applicationArtifact',
  'applicationAvailability',
  'applicationHealth',
  'migrationCompatibility',
  'cleanup',
] as const;
export type RecoveryCheck = typeof RECOVERY_CHECKS[number];
export type RecoveryEvidenceState = 'verified' | 'unknown' | 'failed' | 'unsupported';
const evidenceState = z.enum(['verified', 'unknown', 'failed', 'unsupported']);
const observationsSchema = z.object(Object.fromEntries(
  RECOVERY_CHECKS.map(check => [check, evidenceState.optional()]),
)).strict();

/**
 * Shared presentation of evidence already established by the caller's real
 * boundary. Missing reads, provider support and matching configuration cannot
 * establish a check. Never consume this report as mutation authorization.
 */
export function assessRecovery(observations: Partial<Record<RecoveryCheck, RecoveryEvidenceState>> = {}) {
  const parsed = observationsSchema.parse(observations);
  const checks = Object.fromEntries(RECOVERY_CHECKS.map(check => [check, parsed[check] ?? 'unknown'])) as Record<RecoveryCheck, RecoveryEvidenceState>;
  const blockers = RECOVERY_CHECKS.filter(check => checks[check] !== 'verified')
    .map(check => ({ check, state: checks[check] }));
  return { version: 1 as const, ready: blockers.length === 0, checks, blockers };
}
