import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';

describe('RailwayAdapter delete verification', () => {
  it('treats falsy projectDelete payload as failure', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ projectDelete: false })
      .mockResolvedValueOnce({ projectDelete: false })
      .mockResolvedValueOnce({ projectDelete: false });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteProject('proj-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('unsuccessful payload');
  });

  it('verifies service deletion before reporting success', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockRejectedValueOnce(new Error('Service not found'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1');

    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0]?.[0])).toContain('serviceDelete(id: $id)');
    expect(String(request.mock.calls[0]?.[0])).not.toContain('serviceDelete(input:');
  });

  it('deletes volumes by id', async () => {
    const request = vi.fn().mockResolvedValueOnce({ volumeDelete: true });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteVolume('vol-1');

    expect(result.success).toBe(true);
    expect(String(request.mock.calls[0]?.[0])).toContain('volumeDelete(volumeId: $volumeId)');
    expect(request.mock.calls[0]?.[1]).toEqual({ volumeId: 'vol-1' });
  });
});
