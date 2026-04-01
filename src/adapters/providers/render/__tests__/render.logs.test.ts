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

  it('lists service deployments from Render API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        deploys: [
          { id: 'dep_1', status: 'live', createdAt: '2026-03-31T00:00:00Z' },
          { id: 'dep_2', status: 'build_in_progress', createdAt: '2026-03-31T01:00:00Z' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new RenderAdapter();
    await adapter.connect({ apiKey: 'rk_test' });

    const deployments = await adapter.listServiceDeployments('svc_123', 2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deployments).toHaveLength(2);
    expect(deployments[0]).toMatchObject({ id: 'dep_1', status: 'live' });
  });

  it('falls back to service logs when deployment log endpoint is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'not found',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          logs: [{ timestamp: '2026-03-31T00:00:00Z', level: 'info', message: 'fallback' }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new RenderAdapter();
    await adapter.connect({ apiKey: 'rk_test' });

    const logs = await adapter.getDeploymentLogs('svc_123', 'dep_1', 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs).toEqual([{ timestamp: '2026-03-31T00:00:00Z', severity: 'info', message: 'fallback' }]);
  });
});
