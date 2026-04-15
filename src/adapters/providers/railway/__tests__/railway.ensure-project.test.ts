import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function makeEnv(bindings: Record<string, unknown> = {}): Environment {
  return {
    id: 'env-1',
    projectId: 'proj-1',
    name: 'staging',
    platformBindings: bindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RailwayAdapter.ensureProject', () => {
  it('falls back to existing project by name when create attempts fail', async () => {
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = {
      request: vi.fn(),
    };
    vi.spyOn(adapter, 'findProjectByName').mockResolvedValue({ id: 'railway-1', name: 'billforge' });

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(true);
    expect(receipt.data?.projectId).toBe('railway-1');
    expect((adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client.request).toHaveBeenCalled();
  });

  it('falls back to alternate create mutation shapes when first create attempt fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        me: { workspaces: { edges: [{ node: { id: 'ws-1' } }] } },
      })
      .mockRejectedValueOnce(new Error('Unknown field "teamId"'))
      .mockResolvedValueOnce({
        projectCreate: { id: 'railway-2', name: 'billforge' },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    (adapter as unknown as { credentials: { teamId?: string } }).credentials = { teamId: 'team-1' };
    vi.spyOn(adapter, 'findProjectByName').mockResolvedValue(null);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(true);
    expect(receipt.data?.projectId).toBe('railway-2');
    expect(request).toHaveBeenCalledTimes(3);
  });
});
