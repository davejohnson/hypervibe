import { afterEach, describe, expect, it, vi } from 'vitest';
import { VercelAdapter } from '../vercel.adapter.js';

describe('VercelAdapter logs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists deployments for a project', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        deployments: [{ id: 'dpl_1', readyState: 'READY' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new VercelAdapter();
    await adapter.connect({ token: 'vercel_token' });

    const deployments = await adapter.listDeployments('prj_123', 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deployments).toEqual([{ id: 'dpl_1', readyState: 'READY' }]);
  });

  it('maps deployment events to unified log shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        events: [{ created: 1711843200000, level: 'error', text: 'build failed' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new VercelAdapter();
    await adapter.connect({ token: 'vercel_token' });

    const logs = await adapter.getDeploymentEvents('dpl_1', 10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      { timestamp: new Date(1711843200000).toISOString(), severity: 'error', message: 'build failed' },
    ]);
  });
});

