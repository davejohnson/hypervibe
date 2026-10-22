import { describe, expect, it } from 'vitest';
import { assessSecurityPolicy } from '../security-policy.service.js';

describe('recurring security due assessment', () => {
  it('proposes a cadence without claiming absent completion or deployed automation', () => {
    const result = assessSecurityPolicy({ now: new Date('2026-10-21T12:00:00Z') });
    expect(result.policySource).toBe('suggested');
    expect(result.activities).toEqual([
      { activity: 'advisoryReview', status: 'missing-evidence', due: true },
      { activity: 'codeReview', status: 'missing-evidence', due: true },
      { activity: 'credentialRotation', status: 'missing-evidence', due: true },
    ]);
    expect(result.automationStatus).toBe('unverified');
  });

  it('treats the exact due instant as due and preserves independent review evidence', () => {
    const result = assessSecurityPolicy({
      now: new Date('2026-10-21T12:00:00Z'),
      policy: { advisoryReview: { intervalDays: 1 }, codeReview: { intervalDays: 7 }, credentialRotation: { intervalMonths: 1 } },
      completedAt: { advisoryReview: '2026-10-20T12:00:00Z', codeReview: '2026-10-20T12:00:00Z', credentialRotation: '2026-10-01T12:00:00Z' },
    });
    expect(result.policySource).toBe('declared');
    expect(result.activities).toEqual([
      { activity: 'advisoryReview', status: 'due', due: true, completedAt: '2026-10-20T12:00:00.000Z', nextDueAt: '2026-10-21T12:00:00.000Z' },
      { activity: 'codeReview', status: 'current', due: false, completedAt: '2026-10-20T12:00:00.000Z', nextDueAt: '2026-10-27T12:00:00.000Z' },
      { activity: 'credentialRotation', status: 'current', due: false, completedAt: '2026-10-01T12:00:00.000Z', nextDueAt: '2026-11-01T12:00:00.000Z' },
    ]);
  });

  it.each([
    ['2026-01-31T12:00:00Z', '2026-02-28T12:00:00.000Z'],
    ['2028-01-31T12:00:00Z', '2028-02-29T12:00:00.000Z'],
    ['2026-12-31T12:00:00Z', '2027-01-31T12:00:00.000Z'],
  ])('uses calendar months with a clamped UTC day from %s', (completedAt, nextDueAt) => {
    const result = assessSecurityPolicy({ now: new Date(nextDueAt), completedAt: { credentialRotation: completedAt } });
    expect(result.activities[2]).toMatchObject({ due: true, nextDueAt });
  });

  it.each(['not-a-date', '2026-02-30T00:00:00Z', '2026-11-01T00:00:00Z', '2026-10-20'])('fails closed on invalid or future evidence: %s', (completedAt) => {
    const result = assessSecurityPolicy({ now: new Date('2026-10-21T00:00:00Z'), completedAt: { credentialRotation: completedAt } });
    expect(result.activities[2]).toEqual({ activity: 'credentialRotation', status: 'invalid-evidence', due: true });
    expect(JSON.stringify(result)).not.toContain(completedAt);
  });

  it('rejects an invalid clock instead of producing a current assessment', () => {
    expect(() => assessSecurityPolicy({ now: new Date('invalid') })).toThrow('Security policy assessment requires a valid clock.');
  });
});
