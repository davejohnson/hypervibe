import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigitalOceanAdapter } from '../digitalocean.adapter.js';

describe('DigitalOceanAdapter logs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists deployments and normalizes status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        deployments: [
          { id: 'dep_1', phase: 'ACTIVE', created_at: '2026-03-31T00:00:00Z' },
          { id: 'dep_2', phase: 'PENDING_BUILD', created_at: '2026-03-31T01:00:00Z' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new DigitalOceanAdapter();
    await adapter.connect({ apiToken: 'do_test' });

    const deployments = await adapter.listDeployments('app_123', 2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deployments).toEqual([
      { id: 'dep_1', status: 'deployed', createdAt: '2026-03-31T00:00:00Z', updatedAt: undefined },
      { id: 'dep_2', status: 'building', createdAt: '2026-03-31T01:00:00Z', updatedAt: undefined },
    ]);
  });

  it('falls back to deployment metadata when direct logs endpoint is unavailable', async () => {
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
          deployment: {
            id: 'dep_1',
            phase: 'ERROR',
            created_at: '2026-03-31T00:00:00Z',
            updated_at: '2026-03-31T00:05:00Z',
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new DigitalOceanAdapter();
    await adapter.connect({ apiToken: 'do_test' });

    const logs = await adapter.getDeploymentLogs('app_123', 'dep_1', 100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs).toHaveLength(1);
    expect(logs[0].severity).toBe('error');
    expect(logs[0].message).toContain('status: failed');
  });
});
