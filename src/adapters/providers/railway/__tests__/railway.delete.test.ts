import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';

describe('RailwayAdapter delete verification', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
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
      .mockResolvedValueOnce({ service: { id: 'svc-1' } })
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockRejectedValueOnce(new Error('Service not found'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1');

    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[1]?.[0])).toContain('serviceDelete(id: $id)');
    expect(String(request.mock.calls[1]?.[0])).not.toContain('serviceDelete(input:');
  });

  it('treats deletion of an already absent service as idempotent success', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Service not found'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-missing')).resolves.toEqual({
      success: true,
      alreadyAbsent: true,
    });
  });

  it('treats deletion of an already absent project as idempotent success', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Project not found'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteProject('project-missing')).resolves.toEqual({ success: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('deletes one exact environment and verifies absence without deleting shared services', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ project: { id: 'project-1', environments: { edges: [{ node: { id: 'environment-1' } }] } } })
      .mockResolvedValueOnce({ environmentDelete: true })
      .mockResolvedValueOnce({ project: { id: 'project-1', environments: { edges: [] } } });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteEnvironment('project-1', 'environment-1')).resolves.toEqual({ success: true });

    expect(String(request.mock.calls[1]?.[0])).toContain('environmentDelete(id: $id)');
    expect(String(request.mock.calls[1]?.[0])).not.toContain('serviceDelete');
    expect(request.mock.calls[1]?.[1]).toEqual({ id: 'environment-1' });
  });

  it('preserves an environment binding when post-delete absence is unknown', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ project: { id: 'project-1', environments: { edges: [{ node: { id: 'environment-1' } }] } } })
      .mockResolvedValueOnce({ environmentDelete: true })
      .mockRejectedValueOnce(new Error('Railway API unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteEnvironment('project-1', 'environment-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
  });

  it('keeps polling beyond the old three-second verification window', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_ATTEMPTS', '12');
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-slow-delete')).resolves.toEqual({ success: true });
    expect(request).toHaveBeenCalledTimes(9);
  });

  it('keeps polling when service deletion becomes visible after twenty observations', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({ service: { id: 'svc-eventually-deleted' } })
      .mockResolvedValueOnce({ serviceDelete: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      request.mockResolvedValueOnce({ service: { id: 'svc-eventually-deleted' } });
    }
    request.mockResolvedValueOnce({ service: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-eventually-deleted')).resolves.toEqual({ success: true });
    expect(request).toHaveBeenCalledTimes(23);
  });

  it('does not mistake an observation failure for successful deletion', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ service: { id: 'svc-unknown' } })
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockRejectedValueOnce(new Error('Railway API unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-unknown');

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
    expect(result.error).toContain('Railway API unavailable');
    expect(request).toHaveBeenCalledTimes(3);
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
