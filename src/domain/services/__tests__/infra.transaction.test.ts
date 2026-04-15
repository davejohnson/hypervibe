import { describe, expect, it } from 'vitest';
import { InfraTransaction } from '../infra.transaction.js';

describe('InfraTransaction', () => {
  it('rolls back in reverse order', async () => {
    const tx = new InfraTransaction();
    const calls: string[] = [];

    tx.addStep({
      id: '1',
      label: 'first',
      resource: { provider: 'test', type: 'a', id: 'a1' },
      compensate: async () => {
        calls.push('first');
        return { success: true };
      },
    });
    tx.addStep({
      id: '2',
      label: 'second',
      resource: { provider: 'test', type: 'b', id: 'b1' },
      compensate: async () => {
        calls.push('second');
        return { success: true };
      },
    });

    const result = await tx.rollback();

    expect(result.success).toBe(true);
    expect(calls).toEqual(['second', 'first']);
    expect(result.rolledBack).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it('captures rollback failures', async () => {
    const tx = new InfraTransaction();
    tx.addStep({
      id: '1',
      label: 'fails',
      resource: { provider: 'test', type: 'resource', id: 'r1' },
      compensate: async () => ({ success: false, error: 'boom' }),
    });

    const result = await tx.rollback();

    expect(result.success).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain('boom');
  });
});
