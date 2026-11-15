import type { IDailyBackupPolicy } from '../domain/ports/daily-backup.port.js';
import type { RecoverySourceIdentity } from '../domain/ports/recovery-source.port.js';

/** Synthetic normalized provider evidence for tests whose existing resource is
 * already protected. Callers choose the exact source independently. The real
 * policy, health and readiness evaluators still run; this is not provider/live
 * compatibility evidence and never authorizes a backup mutation. */
export function dailyBackupEvidence<TTarget = unknown>(source: RecoverySourceIdentity): IDailyBackupPolicy<TTarget> {
  const selectedSource = structuredClone(source);
  return {
    async observe() {
      return { state: 'known', source: structuredClone(selectedSource), daily: true,
        policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot',
        retention: { unit: 'backups', value: 7 } };
    },
    async observeRecovery() {
      const now = Date.now();
      return { state: 'complete', source: structuredClone(selectedSource), recoveryPointId: 'synthetic-recovery-point',
        dataTime: new Date(now - 60_000).toISOString(), completedAt: new Date(now - 30_000).toISOString(),
        expiresAt: new Date(now + 6 * 86_400_000).toISOString(),
        restore: { state: 'verified', source: structuredClone(selectedSource), recoveryPointId: 'synthetic-recovery-point',
          verifiedAt: new Date(now - 15_000).toISOString(), isolationVerified: true, cleanupVerified: true } };
    },
    async configureDaily() { throw new Error('Unexpected backup mutation in an already-protected resource fixture.'); },
  };
}
