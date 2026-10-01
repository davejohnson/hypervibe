import { describe, expect, it } from 'vitest';
import { assessBackupReadiness } from '../backup-readiness.js';
import type { BackupPolicyObservation } from '../backup-policy.service.js';
import type { BackupHealthObservation } from '../backup-health.service.js';

const now = Date.parse('2026-09-30T12:00:00Z');
function fixture() {
  const resource = { kind: 'database' as const, provider: 'cloudsql', name: 'postgres',
    retained: false, bindingState: 'bound' as const, componentId: 'component-a' };
  const source = { provider: 'cloudsql', primaryExternalId: 'production',
    providerScope: { projectId: 'project-a', region: 'us-central1' }, resourceIdentity: { instanceId: 'production' } };
  const coverage: BackupPolicyObservation = { policy: { mode: 'daily', source: 'default', resources: [resource] },
    resources: [{ resource, state: 'scheduled', observation: { state: 'known', daily: true, source,
      policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot' } }] };
  const health: BackupHealthObservation = { observedAt: '2026-09-30T12:00:00Z', resources: [{ resource,
    source: structuredClone(source), state: 'verified', recoveryPointId: 'point-a', dataTime: '2026-09-30T10:00:00Z',
    completedAt: '2026-09-30T10:05:00Z', freshUntil: '2026-10-01T10:00:00Z',
    restore: { state: 'verified', verifiedAt: '2026-09-30T11:00:00Z', freshUntil: '2026-10-07T11:00:00Z' } }] };
  return { coverage, health };
}

describe('shared backup release readiness', () => {
  it('requires independently observed scheduling, a completed point and an isolated restore', () => {
    const f = fixture();
    expect(assessBackupReadiness(f.coverage, f.health, now)).toMatchObject({ ready: true,
      policyReady: true, recoveryPointReady: true, restoreReady: true, gaps: [] });
  });
  it.each(['missing', 'stale', 'unknown', 'unsupported'] as const)('blocks %s completed-point evidence despite daily scheduling', state => {
    const f = fixture(); f.health.resources[0].state = state;
    expect(assessBackupReadiness(f.coverage, f.health, now)).toMatchObject({ ready: false, recoveryPointReady: false });
  });
  it.each(['missing', 'stale', 'unknown', 'unsupported'] as const)('keeps %s restore evidence separate from a fresh completed point', state => {
    const f = fixture(); f.health.resources[0].restore = { state };
    expect(assessBackupReadiness(f.coverage, f.health, now)).toMatchObject({ ready: false, recoveryPointReady: true, restoreReady: false });
  });
  it('rejects evidence for another native project with the same resource name', () => {
    const f = fixture(); f.health.resources[0].source!.providerScope.projectId = 'another-project';
    expect(assessBackupReadiness(f.coverage, f.health, now)).toMatchObject({ ready: false, recoveryPointReady: false, restoreReady: false });
  });
  it('rechecks point and restore expiry at the release boundary', () => {
    const f = fixture(); f.health.resources[0].freshUntil = '2026-09-30T12:00:00Z';
    f.health.resources[0].restore!.freshUntil = '2026-09-30T12:00:00Z';
    expect(assessBackupReadiness(f.coverage, f.health, now)).toMatchObject({ ready: false, recoveryPointReady: false, restoreReady: false });
  });
  it('rejects old or future observation timestamps', () => {
    for (const observedAt of ['2026-09-30T11:54:00Z', '2026-09-30T12:00:01Z', 'invalid']) {
      const f = fixture(); f.health.observedAt = observedAt;
      expect(assessBackupReadiness(f.coverage, f.health, now).ready).toBe(false);
    }
  });
  it('does not lose a retained target when evidence omits or duplicates a resource', () => {
    const f = fixture(); f.coverage.policy.resources.push({ ...f.coverage.policy.resources[0], name: 'previous', retained: true });
    f.health.resources.push(f.health.resources[0]);
    expect(assessBackupReadiness(f.coverage, f.health, now).ready).toBe(false);
  });
  it('requires known daily policy even when an independently observed point is usable', () => {
    const f = fixture(); f.coverage.resources[0].state = 'unknown';
    expect(assessBackupReadiness(f.coverage, f.health, now)).toMatchObject({ ready: false, policyReady: false });
  });
  it('honors only an explicit reasoned exclusion without manufacturing backup observations', () => {
    const f = fixture(); f.coverage.policy = { ...f.coverage.policy, mode: 'disabled', source: 'explicit', reason: 'Disposable preview.' };
    expect(assessBackupReadiness(f.coverage, { observedAt: new Date(now).toISOString(), resources: [] }, now).ready).toBe(true);
    expect(f.health.resources[0].state).toBe('verified');
  });
});
