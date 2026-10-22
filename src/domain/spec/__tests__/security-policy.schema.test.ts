import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

const base = { version: 1, project: 'security-policy', environments: {} };

describe('recurring security policy desired state', () => {
  it('leaves legacy desired state unchanged when the policy is absent', () => {
    expect(projectSpecSchema.parse(base)).toEqual({ ...base, secrets: {} });
  });

  it('defaults only an explicitly requested policy to daily advisories, weekly review and monthly rotation', () => {
    expect(projectSpecSchema.parse({ ...base, securityPolicy: {} }).securityPolicy).toEqual({
      advisoryReview: { intervalDays: 1 },
      codeReview: { intervalDays: 7 },
      credentialRotation: { intervalMonths: 1 },
    });
  });

  it('accepts reviewed cadence overrides without storing completion or credentials in desired state', () => {
    expect(projectSpecSchema.parse({ ...base, securityPolicy: {
      advisoryReview: { intervalDays: 2 }, codeReview: { intervalDays: 14 }, credentialRotation: { intervalMonths: 3 },
    } }).securityPolicy).toEqual({
      advisoryReview: { intervalDays: 2 }, codeReview: { intervalDays: 14 }, credentialRotation: { intervalMonths: 3 },
    });
  });

  it.each([
    { advisoryReview: { intervalDays: 0 } }, { codeReview: { intervalDays: 1.5 } },
    { advisoryReview: { intervalDays: 366 } }, { credentialRotation: { intervalMonths: 13 } },
    { credentialRotation: { intervalMonths: 0 } }, { credentialRotation: { generation: 2 } },
    { credentialRotation: { completedAt: '2026-10-21T00:00:00Z' } }, { automationActive: true },
  ])('rejects invalid cadence and invented completion or active-automation claims: %j', (securityPolicy) => {
    expect(projectSpecSchema.safeParse({ ...base, securityPolicy }).success).toBe(false);
  });
});
