import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderAdapter } from '../render.adapter.js';

describe('RenderAdapter logs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('maps service logs from Render API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        logs: [
          { timestamp: '2026-03-31T00:00:00Z', level: 'error', message: 'boom' },
          { timestamp: '2026-03-31T00:00:01Z', level: 'info', message: 'ok' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new RenderAdapter();
    await adapter.connect({ apiKey: 'rk_test' });

    const logs = await adapter.getServiceLogs('svc_123', 2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      { timestamp: '2026-03-31T00:00:00Z', severity: 'error', message: 'boom' },
      { timestamp: '2026-03-31T00:00:01Z', severity: 'info', message: 'ok' },
    ]);
  });
});

