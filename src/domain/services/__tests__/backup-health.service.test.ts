import { describe, expect, it, vi } from 'vitest';
import { observeBackupHealth, evaluateRecoveryHealth } from '../backup-health.service.js';

const source = { provider: 'railway', primaryExternalId: 'db', providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: { volumeId: 'v' } };
const resource = { kind: 'database' as const, name: 'postgres', provider: 'railway', retained: false, bindingState: 'bound' as const, componentId: 'c' };
const now = new Date('2026-09-30T12:00:00Z');
const proof = { state: 'complete', source, recoveryPointId: 'point-1', completedAt: '2026-09-30T03:05:00Z', dataTime: '2026-09-30T03:00:00Z',
  restore: { state: 'verified', verifiedAt: '2026-09-30T04:00:00Z', recoveryPointId: 'point-1', source, isolationVerified: true, cleanupVerified: true } };

describe('completed backup health', () => {
  it('does not treat a schedule or a recent receipt as a recovery point', () => {
    expect(evaluateRecoveryHealth(resource, source, { daily: true, observedAt: now.toISOString() }, now).state).toBe('unknown');
  });
  it('ages the captured data, not the time an old copy finished', () => {
    expect(evaluateRecoveryHealth(resource, source, { ...proof, dataTime: '2026-09-28T03:00:00Z' }, now).state).toBe('stale');
  });
  it('requires exact source and isolated restore evidence', () => {
    expect(evaluateRecoveryHealth(resource, source, { ...proof, source: { ...source, primaryExternalId: 'other' } }, now).state).toBe('unknown');
    expect(evaluateRecoveryHealth(resource, source, { ...proof, restore: { ...proof.restore, isolationVerified: false } }, now).restore?.state).toBe('unknown');
  });
  it('separates a fresh available point from an expired weekly restore check', () => {
    const result = evaluateRecoveryHealth(resource, source, { ...proof, restore: { ...proof.restore, verifiedAt: '2026-09-20T04:00:00Z' } }, now);
    expect(result.state).toBe('verified');
    expect(result.restore?.state).toBe('stale');
  });
  it('rejects future proof and invalid dates', () => {
    for (const completedAt of ['nonsense', '2027-01-01T00:00:00Z']) expect(evaluateRecoveryHealth(resource, source, { ...proof, completedAt }, now).state).toBe('unknown');
  });
  it('accepts a completed source-scoped point and bounded restore proof', () => {
    expect(evaluateRecoveryHealth(resource, source, proof, now)).toMatchObject({ state: 'verified', source, recoveryPointId: 'point-1', freshUntil: '2026-10-01T03:00:00.000Z', restore: { state: 'verified', freshUntil: '2026-10-07T04:00:00.000Z' } });
  });
  it('does not read or mutate providers for an explicitly excluded environment', async () => {
    const getDatabaseAdapter = vi.fn();
    const result = await observeBackupHealth({ spec: { hosting: { provider: 'railway' }, services: {}, database: { provider: 'railway', engine: 'postgres' }, backups: { mode: 'disabled', reason: 'No customer data' } } as any,
      environment: null, components: [], adapterFactory: { getDatabaseAdapter } as any });
    expect(result.resources).toEqual([]);
    expect(getDatabaseAdapter).not.toHaveBeenCalled();
  });
});
