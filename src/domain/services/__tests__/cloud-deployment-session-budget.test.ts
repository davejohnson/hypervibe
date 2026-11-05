import { describe, expect, it, vi } from 'vitest';
import { acquireDeploymentSession } from '../cloud-deployment-session-budget.js';

describe('hosted deployment session acquisition', () => {
  it('stops an uncooperative callback within one minute without retrying', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const work = vi.fn((current: AbortSignal) => { signal = current; return new Promise(() => {}); });
      const result = acquireDeploymentSession(work).catch(error => error);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await result).toMatchObject({ code: 'authorization_unavailable' });
      expect(signal?.aborted).toBe(true); expect(work).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('does not dispatch acquisition after cancellation', async () => {
    const controller = new AbortController(), work = vi.fn(async () => 'synthetic');
    const result = acquireDeploymentSession(work, { signal: controller.signal }).catch(error => error);
    controller.abort();
    expect(await result).toMatchObject({ code: 'authorization_unavailable' }); expect(work).not.toHaveBeenCalled();
  });
  it('discards a credential returned after caller cancellation', async () => {
    const controller = new AbortController(); let complete!: (value: string) => void;
    const work = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const result = acquireDeploymentSession(work, { signal: controller.signal }).catch(error => error);
    await Promise.resolve(); controller.abort(); complete('synthetic-credential');
    expect(await result).toMatchObject({ code: 'authorization_unavailable' }); expect(work).toHaveBeenCalledOnce();
  });
  it.each([0, -1, 60_001, Infinity])('rejects an invalid deadline %s before acquisition', async deadlineMs => {
    const work = vi.fn(async () => 'synthetic');
    await expect(acquireDeploymentSession(work, { deadlineMs })).rejects.toMatchObject({ code: 'authorization_unavailable' });
    expect(work).not.toHaveBeenCalled();
  });
});
