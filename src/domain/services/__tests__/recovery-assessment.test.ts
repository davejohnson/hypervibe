import { describe, expect, it } from 'vitest';
import { assessRecovery, RECOVERY_CHECKS, type RecoveryCheck, type RecoveryEvidenceState } from '../recovery-assessment.js';

// Owner requirement: one shared recovery contract. Reconstructed evidence
// projections, not live restore certification. Independent provider constraints:
// https://supabase.com/docs/guides/platform/clone-project (copied jobs execute)
// https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_RestoreFromSnapshot.html
// (new instance availability does not establish application readiness).
const verified = Object.fromEntries(RECOVERY_CHECKS.map(check => [check, 'verified'])) as Record<RecoveryCheck, RecoveryEvidenceState>;

describe('shared recovery evidence assessment', () => {
  it('cannot turn an available snapshot into a verified restore or application rollback', () => {
    const result = assessRecovery({ recoveryPoint: 'verified' });
    expect(result.ready).toBe(false);
    expect(result.checks.databaseValidation).toBe('unknown');
    expect(result.checks.applicationArtifact).toBe('unknown');
    expect(result.checks.migrationCompatibility).toBe('unknown');
  });

  it('keeps copied jobs and outbound effects separate from new-resource isolation', () => {
    const result = assessRecovery({ ...verified, restoreSideEffectIsolation: 'unknown' });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([{ check: 'restoreSideEffectIsolation', state: 'unknown' }]);
  });

  it.each(RECOVERY_CHECKS)('requires independent evidence for %s', (check) => {
    for (const state of ['unknown', 'failed', 'unsupported'] as const) {
      const result = assessRecovery({ ...verified, [check]: state });
      expect(result.ready).toBe(false);
      expect(result.blockers).toEqual([{ check, state }]);
    }
  });

  it('reports a complete assessment only when every required boundary is verified', () => {
    expect(assessRecovery(verified)).toMatchObject({ version: 1, ready: true, blockers: [] });
    expect(assessRecovery().ready).toBe(false);
  });

  it('rejects invented states and unexpected provider details instead of returning them', () => {
    expect(() => assessRecovery({ recoveryPoint: 'probably' } as never)).toThrow();
    expect(() => assessRecovery({ rawProviderError: 'private' } as never)).toThrow();
  });
});
