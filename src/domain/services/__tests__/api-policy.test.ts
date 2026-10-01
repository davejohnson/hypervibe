import { describe, expect, it, vi } from 'vitest';
import { apiReleaseSpecSchema } from '../../spec/spec.schema.js';
import { planApiPolicy, applyApiPolicy } from '../api-policy.js';

const policy = () => apiReleaseSpecSchema.parse({ service: 'api', versions: { v1: { path: '/v1', contract: 'api/v1.json' } }, compatibility: { command: 'npm test' } });

describe('retained API policy authority', () => {
  it('accepts a first policy then converges without writes', () => {
    const save = vi.fn();
    const action = planApiPolicy('production', undefined, policy()).action!;
    expect(applyApiPolicy('production', undefined, policy(), action, new Set(), save).success).toBe(true);
    const accepted = save.mock.calls[0][0];
    expect(planApiPolicy('production', accepted, policy()).action).toBeUndefined();
  });
  it('does not remove versions or the whole protection by omission', () => {
    const save = vi.fn();
    applyApiPolicy('production', undefined, policy(), planApiPolicy('production', undefined, policy()).action!, new Set(), save);
    const accepted = save.mock.calls[0][0];
    expect(planApiPolicy('production', accepted, undefined).error).toMatch(/retain/i);
    const next = policy(); next.versions = { v2: { ...next.versions.v1, path: '/v2' } };
    expect(planApiPolicy('production', accepted, next).error).toMatch(/v1/);
  });
  it('requires both fresh retirement evidence and the exact persisted action confirmation', () => {
    const first = vi.fn();
    applyApiPolicy('production', undefined, policy(), planApiPolicy('production', undefined, policy()).action!, new Set(), first);
    const accepted = first.mock.calls[0][0];
    const desired = policy();
    desired.versions.v1 = { ...desired.versions.v1, status: 'retired', retirement: { id: 'r1', reason: 'Replacement available' } };
    const action = planApiPolicy('production', accepted, desired).action!;
    expect(action.requiresConfirm).toBe(true);
    const save = vi.fn();
    expect(applyApiPolicy('production', accepted, desired, action, new Set(), save).success).toBe(false);
    expect(applyApiPolicy('production', accepted, desired, { ...action, requiresConfirm: false }, new Set([action.id]), save).success).toBe(false);
    expect(applyApiPolicy('staging', accepted, desired, action, new Set([action.id]), save).success).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(applyApiPolicy('production', accepted, desired, action, new Set([action.id]), save).success).toBe(true);
  });
  it('retries repository export when the local binding committed before its receipt failed', () => {
    let retained: unknown; let exported = false;
    const desired = policy(); const action = planApiPolicy('production', retained, desired).action!;
    expect(() => applyApiPolicy('production', retained, desired, action, new Set(), value => { retained = value; throw new Error('repository export failed'); })).toThrow('repository export failed');
    const recovered = applyApiPolicy('production', retained, desired, action, new Set(), () => { exported = true; });
    expect(recovered.success).toBe(true);
    expect(exported).toBe(true);
  });
  it('blocks corrupt retained state and changed route ownership', () => {
    expect(planApiPolicy('production', { invalid: true }, policy()).error).toMatch(/invalid/i);
    const save = vi.fn(); applyApiPolicy('production', undefined, policy(), planApiPolicy('production', undefined, policy()).action!, new Set(), save);
    const desired = policy(); desired.service = 'different';
    expect(planApiPolicy('production', save.mock.calls[0][0], desired).error).toMatch(/service/i);
  });
});
