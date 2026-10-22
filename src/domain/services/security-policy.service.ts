import { z } from 'zod';
import { securityPolicySpecSchema, type SecurityPolicySpec } from '../spec/spec.schema.js';

export type SecurityActivity = 'advisoryReview' | 'codeReview' | 'credentialRotation';
export interface SecurityActivityAssessment {
  activity: SecurityActivity;
  status: 'missing-evidence' | 'invalid-evidence' | 'due' | 'current';
  due: boolean;
  completedAt?: string;
  nextDueAt?: string;
}

/** Add UTC calendar months, clamping January 31 to February's final day. */
function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(result);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return result;
}

/**
 * Callers supply only independently verified full completion timestamps.
 * A scan with incomplete coverage, prepared rotation, scheduled workflow, or
 * provider write acknowledgement is not completion evidence. This function
 * neither records evidence nor verifies deployment of any automation.
 */
export function assessSecurityPolicy(input: {
  policy?: SecurityPolicySpec;
  now: Date;
  completedAt?: Partial<Record<SecurityActivity, string>>;
}): {
  policySource: 'declared' | 'suggested';
  policy: SecurityPolicySpec;
  automationStatus: 'unverified';
  activities: SecurityActivityAssessment[];
} {
  if (!Number.isFinite(input.now.getTime())) throw new Error('Security policy assessment requires a valid clock.');
  const parsed = securityPolicySpecSchema.safeParse(input.policy ?? {});
  if (!parsed.success) throw new Error('Security policy assessment requires a valid policy.');
  const policy = parsed.data;
  const activities: SecurityActivity[] = ['advisoryReview', 'codeReview', 'credentialRotation'];
  return {
    policySource: input.policy ? 'declared' : 'suggested',
    policy,
    automationStatus: 'unverified',
    activities: activities.map((activity): SecurityActivityAssessment => {
      const value = input.completedAt?.[activity];
      if (value === undefined) return { activity, status: 'missing-evidence', due: true };
      const parsedDate = z.string().datetime().safeParse(value);
      const completed = new Date(parsedDate.success ? parsedDate.data : NaN);
      if (!parsedDate.success || !Number.isFinite(completed.getTime()) || completed > input.now) {
        return { activity, status: 'invalid-evidence', due: true };
      }
      const next = activity === 'credentialRotation'
        ? addMonths(completed, policy.credentialRotation.intervalMonths)
        : new Date(completed.getTime() + policy[activity].intervalDays * 86_400_000);
      const due = next <= input.now;
      return { activity, status: due ? 'due' : 'current', due, completedAt: completed.toISOString(), nextDueAt: next.toISOString() };
    }),
  };
}
