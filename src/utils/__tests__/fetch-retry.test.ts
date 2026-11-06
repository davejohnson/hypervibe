import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../fetch-retry.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('fetchWithRetry', () => {
  it('retries reads through dropped connections but never repeats a write', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; if (calls < 3) throw new TypeError('fetch failed'); return new Response('ok'); }));
    vi.useFakeTimers();
    const read = fetchWithRetry('https://example.test/');
    await vi.runAllTimersAsync();
    expect(await (await read).text()).toBe('ok');
    expect(calls).toBe(3);
    vi.useRealTimers();

    calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; throw new TypeError('fetch failed'); }));
    await expect(fetchWithRetry('https://example.test/', { method: 'POST' })).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);
  });
});
